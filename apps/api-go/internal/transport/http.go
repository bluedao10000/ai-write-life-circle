// Package transport translates HTTP to application calls; it owns no persistence.
package transport

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"io"
	"math"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type Resolver func(*http.Request) *application.Actor
type Options struct {
	WorkerStatus func() any
	KnowledgeFor func(*application.Service) *knowledge.Service
	CreativeFor  func(*application.Service) *creative.Service
	// SessionOwned verifies a Thinking session belongs to the author and book.
	SessionOwned func(application.Actor, string, string) error
	Imports      *application.ImportService
	Management   *application.Management
	ReviewFor    func(*application.Service) *review.Service
	// Account returns the caller's AI-point allowance (GET /v1/account).
	Account      func(context.Context, application.Actor) (any, error)
	Service      *application.Service
	Environment  string
	ResolveActor Resolver
	Reviews      *review.Service
	Publications *publication.Service
}

const MaxBodyBytes int64 = 32 * 1024 * 1024

var decimalRE = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
var workspaceRE = regexp.MustCompile(`^/v1/projects/([^/]+)/workspace$`)
var chaptersRE = regexp.MustCompile(`^/v1/projects/([^/]+)/chapters$`)
var chapterRE = regexp.MustCompile(`^/v1/projects/([^/]+)/chapters/([^/]+)$`)
var revisionsRE = regexp.MustCompile(`^/v1/projects/([^/]+)/chapters/([^/]+)/revisions$`)
var notesRE = regexp.MustCompile(`^/v1/projects/([^/]+)/notes(?:/([^/]+))?$`)
var internalRE = regexp.MustCompile(`^/internal/projects/([^/]+)/harness-projection$`)

func write(w http.ResponseWriter, status int, body any, requestID string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if requestID != "" {
		w.Header().Set("x-request-id", requestID)
	}
	w.WriteHeader(status)
	data, _ := compat.Marshal(body, false)
	_, _ = w.Write(append(data, '\n'))
}
func problem(w http.ResponseWriter, e *application.Error, id string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	if id != "" {
		w.Header().Set("x-request-id", id)
	}
	body := map[string]any{"type": "about:blank", "title": e.Code, "status": e.Status, "detail": e.Detail, "code": e.Code}
	if e.Current != nil {
		body["current"] = e.Current
	}
	if id != "" {
		body["requestId"] = id
	}
	w.WriteHeader(e.Status)
	data, _ := compat.Marshal(body, false)
	_, _ = w.Write(append(data, '\n'))
}
func decode(s string) (string, bool) {
	v, e := url.PathUnescape(s)
	return v, e == nil && utf8.ValidString(v) && v != ""
}
func readBody(w http.ResponseWriter, r *http.Request) any {
	limited := http.MaxBytesReader(w, r.Body, MaxBodyBytes)
	defer limited.Close()
	data, e := io.ReadAll(limited)
	if e != nil {
		return nil
	}
	var value any
	if compat.Decode(data, &value) != nil || !json.Valid(data) {
		return nil
	}
	return value
}
func role(w http.ResponseWriter, a *application.Actor, allowed ...string) bool {
	for _, v := range allowed {
		if a.Role == v {
			return true
		}
	}
	code := "AUTHOR_DECISION_REQUIRED"
	if a.Role == "agent" {
		code = "AGENT_WRITE_FORBIDDEN"
	}
	problem(w, application.Fail(403, code, "The authenticated actor is not allowed to perform this operation."), "")
	return false
}
func headerValue(r *http.Request, name string) string {
	return strings.Join(r.Header.Values(name), ", ")
}
func correlation(r *http.Request) string {
	if id := compat.Trim(headerValue(r, "x-request-id")); application.SafeKey(id) {
		return id
	}
	return compat.UUID()
}
func jsNumber(s string) float64 {
	s = compat.Trim(s)
	if s == "" {
		return 0
	}
	for prefix, base := range map[string]int{"0x": 16, "0X": 16, "0b": 2, "0B": 2, "0o": 8, "0O": 8} {
		if strings.HasPrefix(s, prefix) {
			if !regexp.MustCompile(`^[0-9a-fA-F]+$`).MatchString(s[2:]) {
				return math.NaN()
			}
			n, ok := new(big.Int).SetString(s[2:], base)
			if !ok {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	if !decimalRE.MatchString(s) {
		return math.NaN()
	}
	f, e := strconv.ParseFloat(s, 64)
	if e != nil {
		return math.NaN()
	}
	return f
}
func Handler(o Options) http.Handler {
	if o.Management != nil {
		handler := managedHandler(o)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			controller := http.NewResponseController(w)
			defer func() {
				_ = controller.SetReadDeadline(time.Time{})
				_ = controller.SetWriteDeadline(time.Time{})
			}()
			path := r.URL.EscapedPath()
			timeout := 30 * time.Second
			if r.Method == "POST" && importRouteRE.MatchString(path) {
				timeout = 120 * time.Second
			}
			_ = controller.SetReadDeadline(time.Now().Add(timeout))
			_ = controller.SetWriteDeadline(time.Now().Add(timeout))
			handler.ServeHTTP(w, r)
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recover() != nil {
				problem(w, application.AsError(io.ErrUnexpectedEOF), "")
			}
		}()
		path := r.URL.EscapedPath()
		if path == "/v1/agent-runtime" && r.Method == "GET" {
			var actor *application.Actor
			if o.ResolveActor != nil {
				actor = o.ResolveActor(r)
			}
			if actor == nil {
				problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "Authentication required."), "")
				return
			}
			if !role(w, actor, "author") {
				return
			}
			if o.WorkerStatus == nil {
				problem(w, application.Fail(503, "WORKER_UNAVAILABLE", "Worker status unavailable."), "")
				return
			}
			write(w, 200, o.WorkerStatus(), "")
			return
		}
		if handleKnowledge(o, w, r, path) {
			return
		}
		if handleCreative(o, w, r, path) {
			return
		}
		method := r.Method
		if handlePublication(o, w, r, path) {
			return
		}
		if handleReview(o, w, r, path) {
			return
		}
		if path == "/healthz" && method == "GET" {
			write(w, 200, map[string]any{"status": "ok", "service": "writer-agent-api", "runtime": "separated"}, "")
			return
		}
		kind := ""
		var m []string
		for _, route := range []struct {
			name    string
			pattern *regexp.Regexp
		}{{"notes", notesRE}, {"internal", internalRE}, {"workspace", workspaceRE}, {"chapters", chaptersRE}, {"chapter", chapterRE}, {"revisions", revisionsRE}} {
			if match := route.pattern.FindStringSubmatch(path); match != nil {
				kind = route.name
				m = match
				break
			}
		}
		missing := func() { problem(w, application.Fail(404, "NOT_FOUND", "No API route matches this request."), "") }
		if kind == "" || (kind == "internal" && o.Environment != "development") {
			missing()
			return
		}
		project, ok := decode(m[1])
		if !ok {
			problem(w, application.Fail(400, "VALIDATION_FAILED", "The project ID is not valid URL encoding."), "")
			return
		}
		if project != o.Service.Project {
			problem(w, application.Fail(404, "NOT_FOUND", "The configured project does not match this request."), "")
			return
		}
		var actor *application.Actor
		if o.ResolveActor != nil {
			actor = o.ResolveActor(r)
		}
		if actor == nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="writer-agent"`)
			problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "A server-authenticated actor is required."), "")
			return
		}
		respond := func(body any, e error, status int, id string) {
			if e != nil {
				problem(w, application.AsError(e), id)
			} else {
				write(w, status, body, id)
			}
		}
		switch kind {
		case "notes":
			if !role(w, actor, "author") {
				return
			}
			var id *string
			if len(m) > 2 && m[2] != "" {
				v, ok := decode(m[2])
				if !ok {
					problem(w, application.Fail(400, "VALIDATION_FAILED", "Invalid note ID encoding."), "")
					return
				}
				id = &v
			}
			if method == "GET" {
				var b any
				var e error
				if id != nil {
					b, e = o.Service.Note(*id)
				} else {
					b, e = o.Service.Notes()
				}
				respond(b, e, 200, "")
				return
			}
			if (id == nil && method == "POST") || (id != nil && method == "PATCH") {
				body, e := o.Service.MutateNote(r.Context(), *actor, id, headerValue(r, "Idempotency-Key"), readBody(w, r))
				status := 201
				if id != nil {
					status = 200
				}
				respond(body, e, status, "")
				return
			}
			problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported note operation."), "")
			return
		case "internal":
			if method == "GET" {
				if !role(w, actor, "author", "agent") {
					return
				}
				p, e := o.Service.Projection()
				respond(p, e, 200, "")
				return
			}
		case "workspace":
			if method == "GET" || method == "PATCH" {
				if !role(w, actor, "author") {
					return
				}
				var b any
				var e error
				if method == "GET" {
					b, e = o.Service.Workspace(actor.ID)
				} else {
					b, e = o.Service.PatchWorkspace(r.Context(), *actor, readBody(w, r))
				}
				respond(b, e, 200, "")
				return
			}
		case "chapters":
			if method == "GET" {
				if !role(w, actor, "author", "agent") {
					return
				}
				b, e := o.Service.Chapters()
				respond(b, e, 200, "")
				return
			}
		case "chapter":
			if method == "GET" {
				if !role(w, actor, "author", "agent") {
					return
				}
				id, ok := decode(m[2])
				if !ok {
					problem(w, application.Fail(400, "VALIDATION_FAILED", "The chapter ID is not valid URL encoding."), "")
					return
				}
				b, rev, e := o.Service.Detail(r.Context(), id)
				if e == nil {
					w.Header().Set("ETag", compat.Quote(rev))
				}
				respond(b, e, 200, "")
				return
			}
		case "revisions":
			if method == "POST" {
				requestID := correlation(r)
				id, ok := decode(m[2])
				if !ok {
					problem(w, application.Fail(400, "VALIDATION_FAILED", "The chapter ID is not valid URL encoding."), requestID)
					return
				}
				var key *string
				if values, ok := r.Header[http.CanonicalHeaderKey("Idempotency-Key")]; ok {
					value := strings.Join(values, ", ")
					key = &value
				}
				saved, e := o.Service.Save(r.Context(), *actor, id, requestID, readBody(w, r), key)
				respond(saved.Revision, e, saved.Status, requestID)
				return
			}
			if method == "GET" {
				if !role(w, actor, "author") {
					return
				}
				id, ok := decode(m[2])
				if !ok {
					problem(w, application.Fail(400, "VALIDATION_FAILED", "The chapter ID is not valid URL encoding."), "")
					return
				}
				all, e := o.Service.History(r.Context(), id)
				if e != nil {
					respond(nil, e, 200, "")
					return
				}
				query := r.URL.Query()
				limit, offset := 50.0, 0.0
				if v, ok := query["limit"]; ok {
					limit = jsNumber(v[0])
				}
				if v, ok := query["cursor"]; ok {
					offset = jsNumber(v[0])
				}
				if math.IsNaN(limit) || math.IsInf(limit, 0) || math.Trunc(limit) != limit || limit < 1 || limit > 200 || math.IsNaN(offset) || math.IsInf(offset, 0) || math.Trunc(offset) != offset || offset < 0 {
					problem(w, application.Fail(422, "VALIDATION_FAILED", "The revision page cursor or limit is invalid."), "")
					return
				}
				start := len(all)
				if offset < float64(start) {
					start = int(offset)
				}
				end := min(start+int(limit), len(all))
				var next *string
				if end < len(all) {
					v := strconv.Itoa(end)
					next = &v
				}
				respond(map[string]any{"items": all[start:end], "nextCursor": next, "total": len(all)}, nil, 200, "")
				return
			}
		}
		problem(w, application.Fail(404, "NOT_FOUND", "No API route matches this method and path."), "")
	})
}

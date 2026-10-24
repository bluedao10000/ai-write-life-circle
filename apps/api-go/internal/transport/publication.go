package transport

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"io"
	"net/http"
	"regexp"
	"strconv"
)

var studioPublicationRE = regexp.MustCompile(`^/v1/studio/books/([A-Za-z0-9_-]+)/publication(?:/(preview|versions|unlist|relist))?$`)
var publicBookRE = regexp.MustCompile(`^/v1/public/books/([a-z0-9-]+)(?:/chapters/([a-z0-9-]+))?$`)
var publicAuthorRE = regexp.MustCompile(`^/v1/public/authors/([a-z0-9-]+)$`)

func handlePublication(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	studio := studioPublicationRE.FindStringSubmatch(path)
	public := path == "/v1/public/home" || path == "/v1/public/books" || path == "/v1/public/categories" || publicBookRE.MatchString(path) || publicAuthorRE.MatchString(path)
	if studio == nil && !public {
		return false
	}
	if o.Publications == nil {
		problem(w, application.Fail(404, "NOT_FOUND", "Publication API is not configured."), "")
		return true
	}
	respond := func(value any, err error, status int) {
		if err != nil {
			problem(w, application.AsError(err), "")
		} else {
			write(w, status, value, "")
		}
	}
	if public {
		if r.Method != "GET" {
			problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Public API is read-only."), "")
			return true
		}
		switch path {
		case "/v1/public/home":
			v, e := o.Publications.Home(r.Context())
			respond(v, e, 200)
		case "/v1/public/categories":
			v, e := o.Publications.Categories(r.Context())
			respond(map[string]any{"items": v}, e, 200)
		case "/v1/public/books":
			q := r.URL.Query()
			offset, limit := 0, 24
			var err error
			if v := q.Get("cursor"); v != "" {
				offset, err = strconv.Atoi(v)
			}
			if err == nil && q.Get("limit") != "" {
				limit, err = strconv.Atoi(q.Get("limit"))
			}
			if err != nil {
				problem(w, application.Fail(422, "VALIDATION_FAILED", "Invalid cursor or limit."), "")
				return true
			}
			v, e := o.Publications.Catalog(r.Context(), publication.Query{Search: q.Get("q"), Category: q.Get("category"), Status: q.Get("status"), Sort: q.Get("sort"), Offset: offset, Limit: limit})
			respond(v, e, 200)
		default:
			if m := publicBookRE.FindStringSubmatch(path); m != nil {
				if m[2] != "" {
					v, e := o.Publications.Chapter(r.Context(), m[1], m[2])
					respond(v, e, 200)
				} else {
					v, e := o.Publications.PublicBook(r.Context(), m[1])
					respond(v, e, 200)
				}
			} else {
				m := publicAuthorRE.FindStringSubmatch(path)
				v, e := o.Publications.Author(r.Context(), m[1])
				respond(v, e, 200)
			}
		}
		return true
	}
	var actor *application.Actor
	if o.ResolveActor != nil {
		actor = o.ResolveActor(r)
	}
	if actor == nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="writer-agent"`)
		problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "A server-authenticated author is required."), "")
		return true
	}
	if !role(w, actor, "author") {
		return true
	}
	id, op := studio[1], studio[2]
	if r.Method == "GET" && (op == "" || op == "versions") {
		if op == "versions" {
			versions, e := o.Publications.History(r.Context(), *actor, id)
			respond(map[string]any{"items": versions}, e, 200)
		} else {
			v, e := o.Publications.Manage(r.Context(), *actor, id)
			respond(v, e, 200)
		}
		return true
	}
	if r.Method != "POST" || op == "" {
		problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported publication operation."), "")
		return true
	}
	if r.Header.Get("Content-Type") != "application/json" && r.Header.Get("Content-Type") != "application/json; charset=utf-8" {
		problem(w, application.Fail(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json."), "")
		return true
	}
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
	if e != nil {
		problem(w, application.Fail(413, "PAYLOAD_TOO_LARGE", "Publication input is too large."), "")
		return true
	}
	decodeInput := func(v any) bool {
		err := publication.DecodeInput(data, v)
		if err != nil {
			respond(nil, err, 422)
			return false
		}
		return true
	}
	switch op {
	case "preview":
		var input publication.PreviewInput
		if decodeInput(&input) {
			v, e := o.Publications.Preview(r.Context(), *actor, id, input)
			respond(v, e, 200)
		}
	case "versions":
		var input publication.CommitInput
		if decodeInput(&input) {
			v, e := o.Publications.Publish(r.Context(), *actor, id, headerValue(r, "Idempotency-Key"), input)
			respond(v, e, 201)
		}
	case "unlist", "relist":
		var input publication.TransitionInput
		if decodeInput(&input) {
			v, e := o.Publications.Transition(r.Context(), *actor, id, headerValue(r, "Idempotency-Key"), op, input)
			respond(v, e, 201)
		}
	}
	return true
}

package transport

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

var analysisFindingIDRE = regexp.MustCompile(`^find-[0-9a-f]{24}$`)

func handleAnalysis(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) < 6 || parts[1] != "v1" || parts[2] != "studio" || parts[3] != "books" || parts[5] != "analysis" {
		return false
	}
	var actor *application.Actor
	if o.ResolveActor != nil {
		actor = o.ResolveActor(r)
	}
	if actor == nil {
		problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "Authentication required."), "")
		return true
	}
	if !role(w, actor, "author") {
		return true
	}
	if strings.ContainsAny(parts[4], "%.\\") || parts[4] == "" {
		problem(w, application.Fail(404, "NOT_FOUND", "Unknown book."), "")
		return true
	}
	var app *application.Service
	var err error
	if o.Management != nil {
		app, err = o.Management.Resolve(*actor, parts[4])
	} else if o.Service != nil && o.Service.Project == parts[4] {
		app = o.Service
	} else {
		err = application.Fail(404, "NOT_FOUND", "Unknown book.")
	}
	if err != nil {
		problem(w, application.AsError(err), "")
		return true
	}
	if o.AnalysisFor == nil {
		problem(w, application.Fail(503, "ANALYSIS_UNAVAILABLE", "Analysis service unavailable."), "")
		return true
	}
	s := o.AnalysisFor(app)
	respond := func(v any, e error) {
		if e != nil {
			problem(w, application.AsError(e), "")
			return
		}
		write(w, 200, v, "")
	}
	suffix := parts[6:]
	ctx := r.Context()
	if r.Method == "GET" {
		if len(suffix) != 0 {
			problem(w, application.Fail(404, "NOT_FOUND", "Unknown analysis route."), "")
			return true
		}
		v, e := s.View(ctx)
		respond(v, e)
		return true
	}
	if r.Method != "POST" {
		problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported analysis method."), "")
		return true
	}
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
	if e != nil {
		problem(w, application.Fail(413, "VALIDATION_FAILED", "Analysis request too large."), "")
		return true
	}
	decode := func(v any) bool {
		if !json.Valid(data) || strings.TrimSpace(string(data)) == "null" {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "A JSON object is required."), "")
			return false
		}
		d := json.NewDecoder(bytes.NewReader(data))
		d.DisallowUnknownFields()
		if d.Decode(v) != nil {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "Request does not match the analysis contract."), "")
			return false
		}
		if d.Decode(new(any)) != io.EOF {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "Exactly one JSON object is required."), "")
			return false
		}
		return true
	}
	switch {
	case len(suffix) == 0:
		var in struct {
			ChapterIDs []string `json:"chapterIds"`
		}
		if !decode(&in) {
			return true
		}
		v, e := s.Create(ctx, r.Header.Get("Idempotency-Key"), in.ChapterIDs)
		respond(v, e)
	case len(suffix) == 1 && suffix[0] == "pause":
		var in struct{}
		if decode(&in) {
			v, e := s.Pause(ctx)
			respond(v, e)
		}
	case len(suffix) == 1 && suffix[0] == "resume":
		var in struct{}
		if decode(&in) {
			v, e := s.Resume(ctx)
			respond(v, e)
		}
	case len(suffix) == 1 && suffix[0] == "cancel":
		var in struct{}
		if decode(&in) {
			v, e := s.Cancel(ctx)
			respond(v, e)
		}
	case len(suffix) == 3 && suffix[0] == "findings" && analysisFindingIDRE.MatchString(suffix[1]) && suffix[2] == "decision":
		var in struct {
			Decision string `json:"decision"`
			Note     string `json:"note"`
		}
		if decode(&in) {
			v, e := s.Decide(ctx, suffix[1], in.Decision, in.Note)
			respond(v, e)
		}
	default:
		problem(w, application.Fail(404, "NOT_FOUND", "Unknown analysis route."), "")
	}
	return true
}

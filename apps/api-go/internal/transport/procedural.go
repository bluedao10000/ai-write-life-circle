package transport

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/procedural"
)

func handleProcedural(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) < 6 || parts[1] != "v1" || parts[2] != "studio" || parts[3] != "books" || parts[5] != "procedural-memory" {
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
	if o.Management == nil || o.ProceduralFor == nil {
		problem(w, application.Fail(503, "MEMORY_UNAVAILABLE", "Procedural memory unavailable."), "")
		return true
	}
	app, e := o.Management.Resolve(*actor, parts[4])
	if e != nil {
		problem(w, application.AsError(e), "")
		return true
	}
	s := o.ProceduralFor(app)
	respond := func(value any, e error, status int) {
		if e != nil {
			problem(w, application.AsError(e), "")
		} else {
			write(w, status, value, "")
		}
	}
	if len(parts) == 9 && parts[6] == "evidence" && parts[8] == "outcome" && r.Method == "GET" {
		value, e := s.Tasks.MemoryOutcome(r.Context(), *actor, app.Project, parts[7])
		respond(value, e, 200)
		return true
	}
	if len(parts) == 8 && parts[6] == "evidence" && r.Method == "GET" {
		value, e := s.Tasks.MemorySource(r.Context(), *actor, app.Project, parts[7])
		respond(value, e, 200)
		return true
	}
	if len(parts) == 7 && parts[6] == "evidence" && r.Method == "GET" {
		snapshot, e := s.Tasks.MemoryEvidence(r.Context(), *actor, app.Project)
		respond(map[string]any{"items": snapshot.Recent(), "limit": 100}, e, 200)
		return true
	}
	if len(parts) == 6 && r.Method == "GET" {
		items, e := s.List(r.Context(), *actor)
		respond(map[string]any{"items": items}, e, 200)
		return true
	}
	if r.Method != "POST" || (len(parts) != 6 && len(parts) != 7 && !(len(parts) == 8 && (parts[7] == "merge" || parts[7] == "supersede"))) {
		problem(w, application.Fail(404, "NOT_FOUND", "Unknown memory route."), "")
		return true
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	decoder.DisallowUnknownFields()
	decode := func(value any) bool {
		if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "Invalid memory input."), "")
			return false
		}
		return true
	}
	key := r.Header.Get("Idempotency-Key")
	if len(parts) == 6 {
		var in procedural.Input
		if decode(&in) {
			value, e := s.Create(r.Context(), *actor, key, in)
			respond(value, e, 201)
		}
	} else if len(parts) == 8 && parts[7] == "merge" {
		var in procedural.MergeInput
		if decode(&in) {
			value, e := s.Merge(r.Context(), *actor, key, parts[6], in)
			respond(value, e, 200)
		}
	} else if len(parts) == 8 {
		var in procedural.SupersedeInput
		if decode(&in) {
			value, e := s.Supersede(r.Context(), *actor, key, parts[6], in)
			respond(value, e, 200)
		}
	} else {
		var in procedural.Decision
		if decode(&in) {
			value, e := s.Decide(r.Context(), *actor, key, parts[6], in)
			respond(value, e, 200)
		}
	}
	return true
}

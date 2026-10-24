package transport

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func handleKnowledge(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) < 6 || parts[1] != "v1" || parts[2] != "studio" || parts[3] != "books" || parts[5] != "knowledge" {
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
	var e error
	if o.Management != nil {
		app, e = o.Management.Resolve(*actor, parts[4])
	} else if o.Service != nil && o.Service.Project == parts[4] {
		app = o.Service
	} else {
		e = application.Fail(404, "NOT_FOUND", "Unknown book.")
	}
	if e != nil {
		problem(w, application.AsError(e), "")
		return true
	}
	if o.KnowledgeFor == nil {
		problem(w, application.Fail(503, "KNOWLEDGE_UNAVAILABLE", "Knowledge service unavailable."), "")
		return true
	}
	s := o.KnowledgeFor(app)
	respond := func(v any, e error) {
		if e != nil {
			problem(w, application.AsError(e), "")
		} else {
			write(w, 200, v, "")
		}
	}
	suffix := strings.Join(parts[6:], "/")
	if r.Method == "GET" {
		q := r.URL.Query()
		offset, limit := 0, 30
		if v := q.Get("cursor"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				offset = -1
			} else {
				offset = n
			}
		}
		if v := q.Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				limit = -1
			} else {
				limit = n
			}
		}
		if offset < 0 || limit < 1 || limit > 100 {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "Invalid pagination."), "")
			return true
		}
		assertionOffset := 0
		if v := q.Get("assertionCursor"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				problem(w, application.Fail(422, "VALIDATION_FAILED", "Invalid assertion cursor."), "")
				return true
			}
			assertionOffset = n
		}
		query := knowledge.Query{AssertionOffset: assertionOffset, Type: q.Get("type"), Name: q.Get("name"), ChapterID: q.Get("chapterId"), Status: q.Get("status"), Offset: offset, Limit: limit}
		switch {
		case suffix == "summary":
			v, e := s.Summary(r.Context())
			respond(v, e)
		case suffix == "" || suffix == "related":
			if suffix == "related" && query.ChapterID == "" {
				problem(w, application.Fail(422, "VALIDATION_FAILED", "Related query requires chapterId."), "")
				break
			}
			p, e := s.Query(r.Context(), query)
			respond(p, e)
		case strings.HasPrefix(suffix, "entities/") && len(parts) == 8:
			query.EntityID = parts[7]
			p, e := s.Query(r.Context(), query)
			if e == nil && p.Total == 0 {
				e = application.Fail(404, "NOT_FOUND", "Entity not found.")
			}
			respond(p, e)
		case suffix == "jobs" || suffix == "history" || suffix == "corrections":
			v, e := s.Records(r.Context(), suffix, offset, limit)
			respond(v, e)
		default:
			problem(w, application.Fail(404, "NOT_FOUND", "Unknown knowledge read route."), "")
		}
		return true
	}
	if r.Method != "POST" || !containsKnowledgeAction(suffix) {
		problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported knowledge action."), "")
		return true
	}
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 16*1024))
	if e != nil {
		problem(w, application.Fail(413, "VALIDATION_FAILED", "Knowledge request too large."), "")
		return true
	}
	var in knowledge.Mutation
	if e = publication.DecodeInput(data, &in); e != nil {
		problem(w, application.AsError(e), "")
		return true
	}
	v, e := s.Mutate(r.Context(), *actor, suffix, r.Header.Get("Idempotency-Key"), in)
	respond(v, e)
	return true
}
func containsKnowledgeAction(v string) bool {
	switch v {
	case "enable", "pause", "resume", "rebuild", "correct", "undo":
		return true
	}
	return false
}

package transport

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"io"
	"net/http"
	"strings"
)

func managedHandler(o Options) http.Handler {
	base := o
	base.Management = nil
	base.Imports = nil
	fallback := Handler(base)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.EscapedPath()
		if (path == "/v1/studio/imports" || strings.HasPrefix(path, "/v1/studio/imports/")) && handleImports(o, w, r, path) {
			return
		}
		if handleKnowledge(o, w, r, path) {
			return
		}
		if handleCreative(o, w, r, path) {
			return
		}
		isBooks := path == "/v1/studio/books" || strings.HasPrefix(path, "/v1/studio/books/")
		isProject := strings.HasPrefix(path, "/v1/projects/")
		if !isBooks && !isProject {
			fallback.ServeHTTP(w, r)
			return
		}
		var actor *application.Actor
		if o.ResolveActor != nil {
			actor = o.ResolveActor(r)
		}
		if actor == nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="writer-agent"`)
			problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "Authentication required."), "")
			return
		}
		// Project selection is a trusted registry lookup, never a filesystem root.
		if isProject {
			parts := strings.Split(path, "/")
			if len(parts) < 5 {
				problem(w, application.Fail(404, "NOT_FOUND", "Unknown route."), "")
				return
			}
			id, ok := decode(parts[3])
			if !ok {
				problem(w, application.Fail(400, "VALIDATION_FAILED", "Invalid book ID."), "")
				return
			}
			app, e := o.Management.Resolve(*actor, id)
			if e != nil {
				problem(w, application.AsError(e), "")
				return
			}
			scoped := base
			scoped.Service = app
			if o.ReviewFor != nil {
				scoped.Reviews = o.ReviewFor(app)
			}
			Handler(scoped).ServeHTTP(w, r)
			return
		}
		// Existing publication endpoints perform the same owning-author lookup.
		if studioPublicationRE.MatchString(path) {
			fallback.ServeHTTP(w, r)
			return
		}
		if !role(w, actor, "author") {
			return
		}
		id := ""
		if path != "/v1/studio/books" {
			parts := strings.Split(path, "/")
			if len(parts) != 5 && !(len(parts) == 6 && parts[5] == "structure") {
				problem(w, application.Fail(404, "NOT_FOUND", "Unknown workspace route."), "")
				return
			}
			id = parts[4]
			if strings.ContainsAny(id, "%.\\") || id == "" {
				problem(w, application.Fail(404, "NOT_FOUND", "Invalid book ID."), "")
				return
			}
		}
		respond := func(v any, e error, status int) {
			if e != nil {
				problem(w, application.AsError(e), "")
			} else {
				write(w, status, v, "")
			}
		}
		if r.Method == "GET" && !strings.HasSuffix(path, "/structure") {
			if id == "" {
				items, e := o.Management.List(*actor)
				respond(map[string]any{"items": items}, e, 200)
			} else {
				b, e := o.Management.Get(*actor, id)
				respond(b, e, 200)
			}
			return
		}
		if id != "" && r.Method == "DELETE" && !strings.HasSuffix(path, "/structure") {
			data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
			if e != nil {
				problem(w, application.Fail(413, "VALIDATION_FAILED", "Delete request too large."), "")
				return
			}
			var input application.DeleteBookInput
			if e := publication.DecodeInput(data, &input); e != nil {
				problem(w, application.AsError(e), "")
				return
			}
			_, e = o.Management.Delete(r.Context(), *actor, id, r.Header.Get("Idempotency-Key"), input)
			if e != nil {
				problem(w, application.AsError(e), "")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		validMethod := id == "" && r.Method == "POST" || id != "" && r.Method == "PUT" && strings.HasSuffix(path, "/structure")
		if !validMethod {
			problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported structure method."), "")
			return
		}
		var input application.StructureInput
		data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
		if e != nil {
			problem(w, application.Fail(413, "VALIDATION_FAILED", "Structure request too large."), "")
			return
		}
		// Reuse the existing strict typed JSON decoder: missing required fields,
		// null scalars, unknown owner/path fields and trailing JSON all fail.
		if e := publication.DecodeInput(data, &input); e != nil {
			problem(w, application.AsError(e), "")
			return
		}
		b, e := o.Management.Mutate(r.Context(), *actor, id, r.Header.Get("Idempotency-Key"), input)
		status := 200
		if id == "" {
			status = 201
		}
		respond(b, e, status)
	})
}

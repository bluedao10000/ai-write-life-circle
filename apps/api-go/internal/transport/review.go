package transport

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"net/http"
	"regexp"
)

var reviewChapterRE = regexp.MustCompile(`^/v1/projects/([^/]+)/chapters/([^/]+)/(review-preview|reviews)$`)
var reviewRunRE = regexp.MustCompile(`^/v1/projects/([^/]+)/reviews/([^/]+)(?:/(cancel|findings/([^/]+)/feedback))?$`)

func handleReview(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	chapter := reviewChapterRE.FindStringSubmatch(path)
	run := reviewRunRE.FindStringSubmatch(path)
	if chapter == nil && run == nil {
		return false
	}
	if o.Reviews == nil {
		problem(w, application.Fail(404, "NOT_FOUND", "Review API is not available on this server."), "")
		return true
	}
	match := chapter
	if match == nil {
		match = run
	}
	project, ok := decode(match[1])
	if !ok {
		problem(w, application.Fail(400, "VALIDATION_FAILED", "Invalid project encoding."), "")
		return true
	}
	if project != o.Service.Project {
		problem(w, application.Fail(404, "NOT_FOUND", "Project does not match this server."), "")
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
	id, ok := decode(match[2])
	if !ok {
		problem(w, application.Fail(400, "VALIDATION_FAILED", "Invalid review identifier encoding."), "")
		return true
	}
	respond := func(body any, e error, status int) {
		if e != nil {
			problem(w, application.AsError(e), "")
		} else {
			write(w, status, body, "")
		}
	}
	body := func() any { r.Body = http.MaxBytesReader(w, r.Body, 64*1024); return readBody(w, r) }
	if chapter != nil {
		if chapter[3] == "review-preview" && r.Method == "POST" {
			var input review.Input
			if e := review.DecodeInput(body(), &input); e != nil {
				respond(nil, e, 422)
				return true
			}
			result, e := o.Reviews.Preview(r.Context(), *actor, id, input)
			respond(result, e, 200)
			return true
		}
		if chapter[3] == "reviews" && r.Method == "POST" {
			var input review.CreateInput
			if e := review.DecodeInput(body(), &input); e != nil {
				respond(nil, e, 422)
				return true
			}
			result, e := o.Reviews.Start(r.Context(), *actor, id, headerValue(r, "Idempotency-Key"), input)
			respond(review.PublicRun(result), e, 202)
			return true
		}
		if chapter[3] == "reviews" && r.Method == "GET" {
			items, e := o.Reviews.List(r.Context(), *actor, id)
			respond(map[string]any{"items": review.PublicRuns(items)}, e, 200)
			return true
		}
	} else {
		if run[3] == "" && r.Method == "GET" {
			result, e := o.Reviews.Get(r.Context(), *actor, id)
			respond(review.PublicRun(result), e, 200)
			return true
		}
		if run[3] == "cancel" && r.Method == "POST" {
			result, e := o.Reviews.Cancel(r.Context(), *actor, id, headerValue(r, "Idempotency-Key"))
			respond(review.PublicRun(result), e, 200)
			return true
		}
		if run[4] != "" && r.Method == "POST" {
			finding, ok := decode(run[4])
			if !ok {
				problem(w, application.Fail(400, "VALIDATION_FAILED", "Invalid finding identifier."), "")
				return true
			}
			var input review.FeedbackInput
			if e := review.DecodeInput(body(), &input); e != nil {
				respond(nil, e, 422)
				return true
			}
			result, e := o.Reviews.Feedback(r.Context(), *actor, id, finding, headerValue(r, "Idempotency-Key"), input)
			respond(review.PublicRun(result), e, 200)
			return true
		}
	}
	problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported review operation."), "")
	return true
}

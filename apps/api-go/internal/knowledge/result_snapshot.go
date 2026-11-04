package knowledge

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

// JobResultSnapshot relates retained observations to an input revision. It is
// not an archive of a particular model response: repeat jobs can share evidence.
type JobResultSnapshot struct {
	Version    int
	Job        Job
	Assertions []Assertion
}

func (s *Service) ResultSnapshot(ctx context.Context, id string) (JobResultSnapshot, error) {
	var out JobResultSnapshot
	if e := ctx.Err(); e != nil {
		return out, e
	}
	st, e := s.load()
	if e != nil {
		return out, e
	}
	for _, job := range st.Jobs {
		if job.ID == id && job.Status == "completed" {
			out.Job = job
			break
		}
	}
	if out.Job.ID == "" {
		return out, application.Fail(404, "MEMORY_RESULT_UNAVAILABLE", "Completed job result unavailable.")
	}
	out.Version = st.Version
	out.Assertions = []Assertion{}
	selected := map[string]Assertion{}
	for _, assertion := range st.Assertions {
		sources := []Source{}
		for _, source := range assertion.Sources {
			if source.ChapterID == out.Job.ChapterID && source.RevisionID == out.Job.RevisionID && source.ContentHash == out.Job.Hash {
				sources = append(sources, source)
			}
		}
		if len(sources) > 0 {
			assertion.Sources = sources
			selected[assertion.ID] = assertion
		}
	}
	st.Assertions = selected
	s.freshen(ctx, &st)
	for _, assertion := range st.Assertions {
		out.Assertions = append(out.Assertions, assertion)
	}
	return out, ctx.Err()
}

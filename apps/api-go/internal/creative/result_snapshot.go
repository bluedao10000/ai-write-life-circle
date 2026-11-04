package creative

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type JobResultSnapshot struct {
	Version     int
	Job         Job
	Proposals   []ProposalView
	Divergences []DivergenceView
}

// ResultSnapshot reads author-visible results and current review state for one job.
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
	out.Proposals = []ProposalView{}
	out.Divergences = []DivergenceView{}
	for _, set := range st.ChangeSets {
		if set.JobID != id {
			continue
		}
		for _, pid := range set.Proposals {
			if p, ok := st.Proposals[pid]; ok && !p.Source.Deleted {
				out.Proposals = append(out.Proposals, proposalView(st, p))
			}
		}
	}
	headID := ""
	if out.Job.Kind == "plan_check" {
		head, e := s.App.SavedRevisionAt(ctx, out.Job.ChapterID, "")
		if e != nil {
			return out, e
		}
		headID = head.ID
	}
	for _, d := range st.Divergences {
		if d.JobID != id {
			continue
		}
		asset, exists := st.Assets[d.AssetID]
		out.Divergences = append(out.Divergences, DivergenceView{Divergence: d, Stale: headID != d.RevisionID || !exists || asset.Version != d.AssetVersion, AssetName: asset.Name})
	}
	return out, nil
}

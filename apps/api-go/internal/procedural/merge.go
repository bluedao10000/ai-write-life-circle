package procedural

import (
	"context"
	"sort"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type MergeSource struct {
	ID          string `json:"id"`
	BaseVersion int    `json:"baseVersion"`
}
type MergeInput struct {
	BaseVersion int           `json:"baseVersion"`
	Sources     []MergeSource `json:"sources"`
}

func (s *Service) Merge(ctx context.Context, actor application.Actor, key, id string, in MergeInput) (Record, error) {
	return s.mutate(ctx, actor, key, "merge", struct {
		ID string `json:"id"`
		MergeInput
	}{id, in}, func(st *state) (Record, error) {
		if in.BaseVersion < 1 || len(in.Sources) < 1 || len(in.Sources) > 7 {
			return Record{}, problem(422, "INVALID_MEMORY_MERGE", "Choose between two and eight candidates.")
		}
		refs := append([]MergeSource{{id, in.BaseVersion}}, in.Sources...)
		seen, taskIDs := map[string]bool{}, map[string]bool{}
		records := []Record{}
		origins := []Extraction{}
		originIDs := map[string]bool{}
		var expires time.Time
		now := s.now()
		snapshot, e := s.Tasks.MemoryEvidence(ctx, actor, s.App.Project)
		if e != nil {
			return Record{}, e
		}
		resolver := newAvailabilityResolver(ctx, s, actor, *st, snapshot)
		for _, ref := range refs {
			if seen[ref.ID] || ref.BaseVersion < 1 {
				return Record{}, problem(422, "INVALID_MEMORY_MERGE", "Duplicate or invalid candidate.")
			}
			seen[ref.ID] = true
			r, ok := st.Records[ref.ID]
			if !ok || r.Status == "deleted" {
				return Record{}, problem(404, "NOT_FOUND", "Memory not found.")
			}
			if r.Version != ref.BaseVersion {
				return Record{}, problem(409, "MEMORY_VERSION_CONFLICT", "Read current candidates before merging.")
			}
			if r.Status != "candidate" {
				return Record{}, problem(409, "MEMORY_NOT_PENDING", "Only candidates can be merged.")
			}
			if len(records) > 0 && r.Content != records[0].Content {
				return Record{}, problem(422, "MEMORY_CONTENT_MISMATCH", "Only identical content can be merged.")
			}
			view, e := resolver.evaluate(r.ID)
			if e != nil {
				return Record{}, e
			}
			if view.UnavailableReason == "source_unavailable" {
				return Record{}, problem(409, "MEMORY_SOURCE_CHANGED", "A merged extraction or compared experience changed.")
			}
			for _, origin := range r.Extractions {
				if !originIDs[origin.RunID] {
					originIDs[origin.RunID] = true
					origins = append(origins, origin)
				}
			}
			if len(origins) > 8 {
				return Record{}, problem(422, "INVALID_MEMORY_MERGE", "Merged evidence exceeds eight extraction runs.")
			}
			expiry, e := time.Parse(time.RFC3339Nano, r.ExpiresAt)
			if e != nil || !expiry.After(now) {
				return Record{}, problem(409, "MEMORY_EXPIRED", "Candidate expired.")
			}
			if expires.IsZero() || expiry.Before(expires) {
				expires = expiry
			}
			for _, source := range r.Evidence {
				taskIDs[source.TaskID] = true
			}
			records = append(records, r)
		}
		if len(taskIDs) > 8 {
			return Record{}, problem(422, "INVALID_MEMORY_MERGE", "Merged evidence exceeds eight tasks.")
		}
		ids := make([]string, 0, len(taskIDs))
		for id := range taskIDs {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		evidence, e := s.Tasks.Evidence(ctx, actor, s.App.Project, ids)
		if e != nil {
			return Record{}, e
		}
		stamp := now.Format(time.RFC3339Nano)
		target := records[0]
		target.Evidence = evidence
		target.Extractions = origins
		target.ExpiresAt = expires.Format(time.RFC3339Nano)
		target.UpdatedAt = stamp
		target.Version++
		for _, r := range records[1:] {
			r.Status = "rejected"
			r.Version++
			r.UpdatedAt = stamp
			r.ReviewedBy = actor.ID
			st.Records[r.ID] = r
		}
		return target, nil
	})
}

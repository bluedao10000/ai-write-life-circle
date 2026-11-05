package procedural

import (
	"context"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type ReplaceSource struct {
	ID          string `json:"id"`
	BaseVersion int    `json:"baseVersion"`
}

type SupersedeInput struct {
	BaseVersion int             `json:"baseVersion"`
	Replaces    []ReplaceSource `json:"replaces"`
}

// Supersede confirms one independently supported candidate and retires the
// explicitly selected active rules in the same book-state transaction.
func (s *Service) Supersede(ctx context.Context, actor application.Actor, key, id string, in SupersedeInput) (Record, error) {
	return s.mutate(ctx, actor, key, "supersede", struct {
		ID string `json:"id"`
		SupersedeInput
	}{id, in}, func(st *state) (Record, error) {
		if in.BaseVersion < 1 || len(in.Replaces) < 1 || len(in.Replaces) > 7 {
			return Record{}, problem(422, "INVALID_MEMORY_SUPERSEDE", "Choose between one and seven confirmed experiences to replace.")
		}
		target, ok := st.Records[id]
		if !ok || target.Status == "deleted" {
			return Record{}, problem(404, "NOT_FOUND", "Memory not found.")
		}
		if target.Version != in.BaseVersion {
			return Record{}, problem(409, "MEMORY_VERSION_CONFLICT", "Read current experiences before replacing.")
		}
		if e := s.confirm(ctx, actor, &target); e != nil {
			return Record{}, e
		}

		seen := map[string]bool{id: true}
		replaced := make([]Record, 0, len(in.Replaces))
		replacedIDs := make([]string, 0, len(in.Replaces))
		now := s.now()
		for _, ref := range in.Replaces {
			if seen[ref.ID] || ref.BaseVersion < 1 {
				return Record{}, problem(422, "INVALID_MEMORY_SUPERSEDE", "Duplicate or invalid replacement target.")
			}
			seen[ref.ID] = true
			old, ok := st.Records[ref.ID]
			if !ok || old.Status == "deleted" {
				return Record{}, problem(404, "NOT_FOUND", "Memory not found.")
			}
			if old.Version != ref.BaseVersion {
				return Record{}, problem(409, "MEMORY_VERSION_CONFLICT", "Read current experiences before replacing.")
			}
			if old.Status != "confirmed" || old.SupersededBy != "" {
				return Record{}, problem(409, "MEMORY_NOT_CONFIRMED", "Only an active confirmed experience can be replaced.")
			}
			if old.Content == target.Content {
				return Record{}, problem(422, "MEMORY_REPLACEMENT_SAME_CONTENT", "Use duplicate merging for identical experiences.")
			}
			expiry, e := time.Parse(time.RFC3339Nano, old.ExpiresAt)
			if e != nil || !expiry.After(now) {
				return Record{}, problem(409, "MEMORY_EXPIRED", "Replaced experience expired.")
			}
			if e := s.validateExtractions(ctx, actor, old); e != nil {
				return Record{}, e
			}
			evidence, e := s.Tasks.Evidence(ctx, actor, s.App.Project, ids(old))
			if e != nil {
				return Record{}, e
			}
			if !independent(evidence) {
				return Record{}, problem(409, "MEMORY_SOURCE_UNAVAILABLE", "Replaced experience no longer has current independent evidence.")
			}
			old.Evidence = evidence
			replaced = append(replaced, old)
			replacedIDs = append(replacedIDs, old.ID)
		}

		stamp := now.Format(time.RFC3339Nano)
		target.Status = "confirmed"
		target.ReviewedBy = actor.ID
		target.Supersedes = replacedIDs
		target.Version++
		target.UpdatedAt = stamp
		for _, old := range replaced {
			old.Status = "rejected"
			old.SupersededBy = target.ID
			old.ReviewedBy = actor.ID
			old.Version++
			old.UpdatedAt = stamp
			st.Records[old.ID] = old
		}
		return target, nil
	})
}

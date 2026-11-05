package agenttasks

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"sort"
	"strings"
)

type MemoryResult struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Status    string `json:"status"`
	Text      string `json:"text"`
	Epistemic string `json:"epistemic,omitempty"`
	Feedback  string `json:"feedback,omitempty"`
}
type MemoryOutcome struct {
	Evidence      TaskEvidence   `json:"evidence"`
	Basis         string         `json:"basis"`
	Version       string         `json:"version"`
	LegacyVersion int64          `json:"-"`
	Items         []MemoryResult `json:"items"`
	Total         int            `json:"total"`
	Truncated     bool           `json:"truncated"`
}

// MemoryOutcome projects current business results without retaining model output.
func (s *Service) MemoryOutcome(ctx context.Context, actor application.Actor, book, id string) (MemoryOutcome, error) {
	var out MemoryOutcome
	r, app, e := s.memoryRecord(ctx, actor, book, id)
	if e != nil {
		return out, e
	}
	source, e := s.memorySource(ctx, app, r)
	if e != nil {
		return out, e
	}
	out = MemoryOutcome{Evidence: source.Evidence, Basis: "task_result", Items: []MemoryResult{}}
	items := []MemoryResult{}
	switch r.Task.Kind {
	case "knowledge.extract":
		result, err := s.knowledge(app).ResultSnapshot(ctx, r.Knowledge.Claim.Job.ID)
		if err != nil {
			return out, err
		}
		out.Basis = "revision_observations"
		out.LegacyVersion = int64(result.Version)
		for _, a := range result.Assertions {
			items = append(items, MemoryResult{ID: a.ID, Kind: "knowledge_observation", Status: a.Status, Text: a.Text, Epistemic: a.Epistemic})
		}
	case "review.execute":
		reviewer := s.review(app)
		defer reviewer.Close()
		result, err := reviewer.Get(ctx, actor, r.Review.Run.RunID)
		if err != nil {
			return out, err
		}
		if result.Status != "completed" {
			return out, application.Fail(404, "MEMORY_RESULT_UNAVAILABLE", "Completed review result unavailable.")
		}
		out.LegacyVersion = result.Version
		for _, finding := range result.Findings {
			item := MemoryResult{ID: finding.FindingID, Kind: "review_finding", Status: "proposed", Text: strings.Join([]string{finding.Title, finding.Inference, finding.Question, finding.Alternative}, "\n")}
			if finding.Feedback != nil {
				item.Feedback = finding.Feedback.Choice
			}
			if result.Stale {
				item.Status = "stale"
			}
			items = append(items, item)
		}
	case "creative.organize", "creative.plan_check":
		result, err := s.creative(app).ResultSnapshot(ctx, r.Creative.Claim.Job.ID)
		if err != nil {
			return out, err
		}
		out.LegacyVersion = int64(result.Version)
		for _, proposal := range result.Proposals {
			text := proposal.Reason
			if proposal.Draft != nil {
				text = proposal.Draft.Name + "\n" + proposal.Draft.Summary + "\n" + text
				for _, field := range proposal.Draft.Fields {
					text += "\n" + field.Key + "：" + field.Value
				}
			}
			// Current reconstructed asset content is not the original proposed patch.
			if proposal.Patch != nil {
				for _, field := range proposal.Patch.SetFields {
					text += "\n" + field.Key + "：" + field.Value
				}
				for _, field := range proposal.Patch.RemoveFields {
					text += "\n删除字段：" + field
				}
				if proposal.Patch.Name != nil {
					text = *proposal.Patch.Name + "\n" + text
				}
				if proposal.Patch.Summary != nil {
					text = *proposal.Patch.Summary + "\n" + text
				}
			}
			item := MemoryResult{ID: proposal.ID, Kind: "creative_proposal", Status: proposal.Status, Text: text, Epistemic: proposal.Stance}
			if proposal.Stale {
				item.Status = "stale"
			}
			if proposal.Decision != nil {
				item.Feedback = proposal.Decision.Action
			}
			items = append(items, item)
		}
		for _, d := range result.Divergences {
			item := MemoryResult{ID: d.ID, Kind: "plan_assessment", Status: d.Status, Text: strings.Join([]string{d.PlanText, d.Explanation, d.Question}, "\n"), Epistemic: d.Assessment}
			if d.Stale {
				item.Status = "stale"
			}
			if d.Decision != nil {
				item.Feedback = d.Decision.Action
			}
			items = append(items, item)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	out.Total = len(items)
	remaining := MemorySourceBytes
	for _, item := range items {
		if len(out.Items) == 20 || remaining == 0 {
			out.Truncated = true
			break
		}
		text := sourcePrefix(item.Text, remaining)
		out.Truncated = out.Truncated || len(text) < len(item.Text)
		item.Text = text
		remaining -= len(text)
		out.Items = append(out.Items, item)
		if out.Truncated {
			break
		}
	}
	version, err := compat.Marshal(struct {
		Basis     string         `json:"basis"`
		Items     []MemoryResult `json:"items"`
		Total     int            `json:"total"`
		Truncated bool           `json:"truncated"`
	}{out.Basis, out.Items, out.Total, out.Truncated}, false)
	if err != nil {
		return MemoryOutcome{}, err
	}
	out.Version = compat.Hash(string(version))
	return out, ctx.Err()
}

package review

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"strings"
	"unicode/utf8"
)

func bounds(text, quote string, offset int) (*int, *int, string) {
	at := strings.Index(text, quote)
	if at < 0 {
		return nil, nil, "missing"
	}
	// Count overlapping occurrences as well, rather than arbitrarily choosing a repeated quote.
	if strings.Contains(text[at+1:], quote) {
		return nil, nil, "ambiguous"
	}
	start := offset + compat.UTF16Len(text[:at])
	end := start + compat.UTF16Len(quote)
	return &start, &end, "unique"
}
func parseCandidates(text string) ([]candidate, error) {
	var value candidateOutput
	if len(text) > 64*1024 || strict([]byte(text), &value) != nil || value.Findings == nil || len(value.Findings) > 20 {
		return nil, failure(502, "LLM_INVALID_OUTPUT", "The model did not return a valid structured review.")
	}
	for _, f := range value.Findings {
		if f.Type != "character_consistency" && f.Type != "timeline_consistency" {
			return nil, failure(502, "LLM_INVALID_OUTPUT", "Unsupported model review type.")
		}
		for _, field := range []struct {
			v   string
			max int
		}{{f.Title, 120}, {f.Inference, 2000}, {f.Question, 1000}, {f.Alternative, 1000}} {
			if strings.TrimSpace(field.v) == "" || utf8.RuneCountInString(field.v) > field.max {
				return nil, failure(502, "LLM_INVALID_OUTPUT", "Model review text failed validation.")
			}
		}
		if len(f.Evidence) < 2 || len(f.Evidence) > 4 {
			return nil, failure(502, "LLM_INVALID_OUTPUT", "Model evidence shape failed validation.")
		}
		for _, e := range f.Evidence {
			if e.SourceID == "" || len(e.SourceID) > 200 || strings.TrimSpace(e.Quote) == "" || utf8.RuneCountInString(e.Quote) > 600 {
				return nil, failure(502, "LLM_INVALID_OUTPUT", "Model evidence shape failed validation.")
			}
		}
	}
	return value.Findings, nil
}
func Validate(p Plan, text string) ([]Finding, []string, error) {
	candidates, e := parseCandidates(text)
	if e != nil {
		return nil, nil, e
	}
	sources := map[string]Source{}
	for _, s := range p.Sources {
		sources[s.SourceID] = s
	}
	out := []Finding{}
	reasons := []string{}
	for _, c := range candidates {
		if !contains(p.ReviewTypes, c.Type) {
			reasons = append(reasons, "unrequested_review_type")
			continue
		}
		evidence := []Evidence{}
		used := map[string]bool{}
		var anchor *Anchor
		reason := ""
		for _, quote := range c.Evidence {
			src, ok := sources[quote.SourceID]
			if !ok {
				reason = "unknown_source"
				break
			}
			if src.ProjectID != p.ProjectID || src.ExcerptHash != compat.Hash(src.Excerpt) || (src.Kind == "target" && (src.RevisionID == nil || *src.RevisionID != p.RevisionID || src.ContentHash != p.ContentHash)) {
				reason = "invalid_source_hash"
				break
			}
			start, end, ambiguity := bounds(src.Excerpt, quote.Quote, src.StartUTF16)
			if ambiguity == "missing" {
				reason = "quote_missing"
				break
			}
			evidence = append(evidence, Evidence{src.SourceID, quote.Quote, true, src.ContentHash, src.SourceHash, start, end, ambiguity})
			used[src.SourceID] = true
			if src.Kind == "target" && anchor == nil {
				anchor = &Anchor{p.RevisionID, p.ContentHash, quote.Quote, "utf16", ambiguity, start, end}
			}
		}
		if reason == "" && anchor == nil {
			reason = "missing_target"
		}
		if reason == "" && len(used) < 2 {
			reason = "insufficient_sources"
		}
		if reason != "" {
			reasons = append(reasons, reason)
			continue
		}
		out = append(out, Finding{FindingID: compat.UUID(), Type: c.Type, Title: c.Title, Inference: c.Inference, Question: c.Question, Alternative: c.Alternative, Evidence: evidence, Anchor: *anchor})
	}
	return out, reasons, nil
}
func contains(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
func (s *Service) freshen(ctx context.Context, r Run) Run {
	r.Stale = false
	r.StaleReasons = []string{}
	r.Sources = append([]Source{}, r.Sources...)
	p, e := s.App.Projection()
	chapters := map[string]application.Chapter{}
	docs := map[string]harness.Document{}
	collisions := map[string]bool{}
	if e == nil {
		for _, c := range p.Collisions {
			collisions[c.ID] = true
		}
		all, err := application.Sources(p)
		if err == nil {
			for _, c := range all {
				chapters[c.ID] = c
			}
		}
		for _, d := range p.Knowledge {
			docs[d.Path] = d
		}
	}
	for i, source := range r.Sources {
		state := "current"
		if e != nil {
			state = "missing"
		} else if source.Kind == "confirmed_knowledge" {
			d, ok := docs[source.Path]
			if !ok {
				state = "missing"
			} else if !strictKnowledge(d, collisions) || d.SHA256 != source.SourceHash || compat.Hash(d.Body) != source.ContentHash {
				state = "changed"
			}
		} else if source.ChapterID == nil {
			state = "missing"
		} else {
			c, ok := chapters[*source.ChapterID]
			if !ok {
				state = "missing"
			} else if collisions[c.ID] || c.SourceHash != source.SourceHash || c.StructureHash != source.StructureHash {
				state = "changed"
			} else {
				revision, err := s.App.ReviewRevision(ctx, c)
				if err != nil || source.RevisionID == nil || revision.ID != *source.RevisionID || revision.Hash != source.ContentHash {
					state = "changed"
				}
			}
		}
		r.Sources[i].Freshness = state
		if state != "current" {
			r.Stale = true
			r.StaleReasons = append(r.StaleReasons, source.SourceID+":"+state)
		}
	}
	return r
}

package application

import (
	"context"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"sort"
)

type Revision struct {
	ID        string        `json:"revisionId"`
	Parent    *string       `json:"parentRevisionId"`
	Hash      string        `json:"contentHash"`
	Words     int           `json:"wordCount"`
	CreatedAt string        `json:"createdAt,omitempty"`
	CreatedBy RevisionActor `json:"createdBy"`
	CommitRef *string       `json:"commitRef"`
}
type StoredRevision struct {
	Revision
	Markdown    string `json:"markdown"`
	Key         string `json:"idempotencyKey,omitempty"`
	RequestHash string `json:"requestHash"`
}
type NoopRecord struct {
	Key      string   `json:"idempotencyKey"`
	Hash     string   `json:"requestHash"`
	Base     *string  `json:"baseRevisionId"`
	Revision Revision `json:"revision"`
}
type DraftState struct {
	KnowledgeIntent *Revision        `json:"knowledgeExtractionIntent,omitempty"`
	SourceHash      string           `json:"sourceHash"`
	Source          *StoredRevision  `json:"sourceRevision,omitempty"`
	History         []StoredRevision `json:"sourceRevisionHistory,omitempty"`
	Adopted         string           `json:"adoptedDraftRevisionId,omitempty"`
	Revisions       []StoredRevision `json:"revisions"`
	Noops           []NoopRecord     `json:"noOpIdempotencyRecords,omitempty"`
}
type SavedRevision struct {
	Revision Revision
	Status   int
	Result   string
}

func (s *Service) draftPath(c Chapter) string {
	return filepath.Join(s.State, "chapter-drafts", compat.Key(s.Project), compat.Key(c.ID)+".json")
}
func sourceRevision(c Chapter, parent *string) StoredRevision {
	return StoredRevision{Revision: Revision{ID: c.SourceRevisionID, Parent: parent, Hash: compat.Hash(c.Markdown), Words: compat.Words(c.Markdown), CreatedBy: RevisionActor{Type: "system", ID: pointer("harness-reader"), Label: pointer("Harness 源文件")}}, Markdown: c.Markdown}
}
func head(c Chapter, state *DraftState) StoredRevision {
	if state != nil {
		if n := len(state.Revisions); n > 0 {
			last := state.Revisions[n-1]
			if state.Adopted == last.ID && state.Source != nil {
				return *state.Source
			}
			return last
		}
		if state.Source != nil {
			return *state.Source
		}
	}
	return sourceRevision(c, nil)
}
func (s *Service) loadDraft(ctx context.Context, c Chapter) (*DraftState, error) {
	var state *DraftState
	found, e := storage.Read(s.draftPath(c), &state)
	if e != nil {
		return nil, e
	}
	if !found || state == nil {
		return nil, nil
	}
	if state.SourceHash == "" || state.Revisions == nil {
		return nil, errors.New("invalid chapter draft state")
	}
	if state.SourceHash == c.SourceHash {
		return state, nil
	}
	if n := len(state.Revisions); n > 0 && state.Revisions[n-1].Hash == compat.Hash(c.Markdown) {
		last := state.Revisions[n-1]
		parent := last.ID
		if state.Adopted == last.ID && state.Source != nil {
			parent = state.Source.ID
		}
		source := sourceRevision(c, &parent)
		if state.Source != nil {
			exists := false
			for _, r := range state.History {
				if r.ID == state.Source.ID {
					exists = true
				}
			}
			if !exists {
				state.History = append(state.History, *state.Source)
			}
		}
		state.SourceHash = c.SourceHash
		state.Source = &source
		state.Adopted = last.ID
		if e = s.writeState(ctx, s.draftPath(c), state); e != nil {
			return nil, e
		}
		return state, nil
	}
	var expected *string
	if len(state.Revisions) > 0 {
		expected = pointer(state.Revisions[len(state.Revisions)-1].ID)
	}
	return nil, conflict(expected, pointer(c.SourceRevisionID))
}
func (s *Service) Head(ctx context.Context, c Chapter) (StoredRevision, error) {
	var r StoredRevision
	e := s.StateLock(ctx, s.draftPath(c)+".lock", func() error {
		state, e := s.loadDraft(ctx, c)
		if e == nil {
			r = head(c, state)
		}
		return e
	})
	return r, e
}
func (s *Service) Detail(ctx context.Context, id string) (any, string, error) {
	c, e := s.Source(id)
	if e != nil {
		return nil, "", e
	}
	h, e := s.Head(ctx, c)
	if e != nil {
		return nil, "", e
	}
	v := map[string]any{"chapterId": c.ID, "title": c.Title, "headRevision": struct {
		Revision
		Markdown string `json:"markdown"`
	}{h.Revision, h.Markdown}}
	if c.VolumeID != "" {
		v["volumeId"] = c.VolumeID
	}
	if c.Meta != "" {
		v["meta"] = c.Meta
	}
	return v, h.ID, nil
}
func (s *Service) History(ctx context.Context, id string) ([]Revision, error) {
	c, e := s.Source(id)
	if e != nil {
		return nil, e
	}
	out := []Revision{}
	e = s.StateLock(ctx, s.draftPath(c)+".lock", func() error {
		state, e := s.loadDraft(ctx, c)
		if e != nil {
			return e
		}
		source := sourceRevision(c, nil)
		all := []StoredRevision{}
		if state != nil {
			all = append(all, state.History...)
			if state.Source != nil {
				source = *state.Source
			}
		}
		all = append(all, source)
		if state != nil {
			all = append(all, state.Revisions...)
		}
		byID := map[string]StoredRevision{}
		ids := []string{}
		for _, r := range all {
			if old, ok := byID[r.ID]; ok {
				if old.Hash != r.Hash {
					return errors.New("revision ID refers to multiple contents")
				}
			} else {
				ids = append(ids, r.ID)
			}
			byID[r.ID] = r
		}
		visited := map[string]bool{}
		appendLineage := func(start StoredRevision) error {
			current := start
			lineage := map[string]bool{}
			for {
				if lineage[current.ID] {
					return errors.New("chapter revision history contains a cycle")
				}
				if visited[current.ID] {
					break
				}
				lineage[current.ID] = true
				visited[current.ID] = true
				out = append(out, current.Revision)
				if current.Parent == nil {
					break
				}
				parent, ok := byID[*current.Parent]
				if !ok {
					break
				}
				current = parent
			}
			return nil
		}
		if e = appendLineage(head(c, state)); e != nil {
			return e
		}
		for len(visited) < len(byID) {
			remaining := []StoredRevision{}
			parents := map[string]bool{}
			for _, id := range ids {
				r := byID[id]
				if !visited[id] {
					remaining = append(remaining, r)
					if r.Parent != nil {
						parents[*r.Parent] = true
					}
				}
			}
			leaves := []StoredRevision{}
			for _, r := range remaining {
				if !parents[r.ID] {
					leaves = append(leaves, r)
				}
			}
			if len(leaves) == 0 {
				return errors.New("chapter revision history contains a cycle")
			}
			sort.SliceStable(leaves, func(i, j int) bool {
				if leaves[i].CreatedAt != leaves[j].CreatedAt {
					return harness.LocaleCompare(leaves[i].CreatedAt, leaves[j].CreatedAt) > 0
				}
				return harness.LocaleCompare(leaves[i].ID, leaves[j].ID) > 0
			})
			if e = appendLineage(leaves[0]); e != nil {
				return e
			}
		}
		return nil
	})
	return out, e
}
func (s *Service) saveRevision(ctx context.Context, c Chapter, a Actor, input RevisionInput, key *string) (SavedRevision, error) {
	var saved SavedRevision
	e := s.StateLock(ctx, s.draftPath(c)+".lock", func() error {
		state, e := s.loadDraft(ctx, c)
		if e != nil {
			return e
		}
		hash := compat.Hash(input.Markdown)
		if key != nil && *key != "" && state != nil {
			for _, prior := range state.Revisions {
				if prior.Key == *key {
					if prior.RequestHash != hash || !same(prior.Parent, input.Base) {
						return reuse()
					}
					saved = SavedRevision{prior.Revision, 200, "idempotent_replay"}
					return nil
				}
			}
			for _, prior := range state.Noops {
				if prior.Key == *key {
					if prior.Hash != hash || !same(prior.Base, input.Base) {
						return reuse()
					}
					saved = SavedRevision{prior.Revision, 200, "idempotent_replay"}
					return nil
				}
			}
		}
		h := head(c, state)
		if !same(pointer(h.ID), input.Base) {
			return conflict(input.Base, pointer(h.ID))
		}
		if state == nil {
			source := sourceRevision(c, nil)
			state = &DraftState{SourceHash: c.SourceHash, Source: &source, Revisions: []StoredRevision{}}
		}
		if state.Source == nil {
			source := sourceRevision(c, nil)
			state.Source = &source
		}
		if h.Hash == hash {
			if key != nil && *key != "" {
				state.Noops = append(state.Noops, NoopRecord{*key, hash, input.Base, h.Revision})
				if e = s.writeState(ctx, s.draftPath(c), state); e != nil {
					return e
				}
			}
			saved = SavedRevision{h.Revision, 200, "already_current"}
			return nil
		}
		r := StoredRevision{Revision: Revision{ID: "draft:" + compat.UUID(), Parent: pointer(h.ID), Hash: hash, Words: compat.Words(input.Markdown), CreatedAt: compat.Now(), CreatedBy: RevisionActor{Type: a.Role, ID: pointer(a.ID)}}, Markdown: input.Markdown, RequestHash: hash}
		if key != nil {
			r.Key = *key
		}
		state.Revisions = append(state.Revisions, r)
		state.KnowledgeIntent = &r.Revision
		if e = s.writeState(ctx, s.draftPath(c), state); e != nil {
			return e
		}
		saved = SavedRevision{r.Revision, 201, "created"}
		return nil
	})
	return saved, e
}
func (s *Service) Save(ctx context.Context, a Actor, id, requestID string, body any, key *string) (SavedRevision, error) {
	var empty SavedRevision
	audit := func(action string, fields map[string]any) error {
		return s.Audit(ctx, a, id, requestID, action, fields)
	}
	if e := audit("chapter.revision.save_requested", nil); e != nil {
		return empty, Fail(500, "AUDIT_WRITE_FAILED", "The save request could not be audited, so no revision was written.")
	}
	if a.Role != "author" {
		if e := audit("chapter.revision.save_failed", map[string]any{"failureType": "permission", "result": "rejected"}); e != nil {
			return empty, Fail(500, "AUDIT_WRITE_FAILED", "The denied save attempt could not be finalized in the audit log.")
		}
		return empty, Fail(403, "AGENT_WRITE_FORBIDDEN", "Only the author can save chapter prose.")
	}
	var before, after any
	failed := func(e error) (SavedRevision, error) {
		pe := AsError(e)
		kind, result, action := "storage", "storage_failed", "chapter.revision.save_failed"
		switch pe.Kind {
		case "conflict":
			kind, result, action = "conflict", "revision_conflict", "chapter.revision.conflict"
		case "validation":
			kind, result = "validation", "validation_failed"
		case "not_found":
			kind, result = "not_found", "chapter_not_found"
		}
		if err := audit(action, map[string]any{"beforeHash": before, "afterHash": after, "failureType": kind, "result": result}); err != nil {
			return empty, Fail(500, "AUDIT_WRITE_FAILED", "The save failed and its failure audit could not be written.")
		}
		return empty, e
	}
	c, e := s.Source(id)
	if e != nil {
		return failed(e)
	}
	input, valid := revisionInput(body)
	if !valid {
		if e = audit("chapter.revision.save_failed", map[string]any{"failureType": "validation", "result": "invalid_contract_payload"}); e != nil {
			return failed(e)
		}
		return empty, Fail(422, "VALIDATION_FAILED", "The chapter revision does not match the V0.4 contract.")
	}
	after = compat.Hash(input.Markdown)
	if key != nil && compat.UTF16Len(*key) > 128 {
		if e = audit("chapter.revision.save_failed", map[string]any{"failureType": "validation", "result": "invalid_idempotency_key"}); e != nil {
			return failed(e)
		}
		return empty, Fail(422, "VALIDATION_FAILED", "Idempotency-Key must not exceed 128 characters.")
	}
	h, e := s.Head(ctx, c)
	if e != nil {
		return failed(e)
	}
	before = h.Hash
	saved, e := s.saveRevision(ctx, c, a, input, key)
	if e != nil {
		return failed(e)
	}
	if e = audit("chapter.revision.saved", map[string]any{"beforeHash": before, "afterHash": after, "result": saved.Result}); e != nil {
		return empty, Fail(500, "AUDIT_WRITE_FAILED", "The draft was stored, but its completion audit could not be written. Retry with the same Idempotency-Key.")
	}
	return saved, nil
}

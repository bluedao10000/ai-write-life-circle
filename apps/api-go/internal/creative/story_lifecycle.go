package creative

import (
	"context"
	"reflect"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func (s *Service) saveStoryChanges(ctx context.Context, actor application.Actor, key, session, message string, in RecordStoryChangesInput, messages []TurnMessage, offer bool) (StoryChangeReceipt, error) {
	if actor.Role != "author" {
		return StoryChangeReceipt{}, application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author may change creative assets.")
	}
	if !application.SafeKey(key) {
		return StoryChangeReceipt{}, application.Fail(422, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key required.")
	}
	priorState, err := s.load()
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	for _, r := range priorState.StoryChanges {
		if r.SessionID == session && r.MessageID == message {
			return storyReceiptView(priorState, r), nil
		}
	}
	if session == "" || message == "" || len(session) > 128 || len(message) > 128 {
		return StoryChangeReceipt{}, validation("A conversation and current message are required.")
	}
	if len(in.Changes) < 1 || len(in.Changes) > 8 {
		return StoryChangeReceipt{}, validation("Record 1-8 changes in one batch.")
	}
	evidence := make([][]Evidence, len(in.Changes))
	for i, c := range in.Changes {
		evidence[i], err = storyEvidence(c.Evidence, message, messages)
		if err != nil {
			return StoryChangeReceipt{}, err
		}
		if c.Intent != "decide" && c.Intent != "explore" && c.Intent != "reject" && c.Intent != "defer" {
			return StoryChangeReceipt{}, validation("Unknown story change intent.")
		}
	}
	var changeID string
	op := "story.record:"
	if offer {
		op = "story.offer:"
	}
	err = s.idempotent(ctx, actor, op+session+":"+message, key, in, &changeID, func(st *State) error {
		for _, r := range st.StoryChanges {
			if r.SessionID == session && r.MessageID == message {
				changeID = r.ChangeID
				return nil
			}
		}
		if !offer {
			if e := recordingEnabled(st); e != nil {
				return e
			}
		}
		if len(st.StoryChanges) >= MaxTurns {
			return application.Fail(429, "CREATIVE_TURN_LIMIT", "Story change history is full.")
		}
		target := st
		if offer {
			preview := clone(*st)
			target = &preview
		}
		r, e := s.applyStoryBatch(target, actor, session, message, in, evidence, nil)
		if e != nil {
			return e
		}
		r.ChangeID = "sc-" + newID()
		if offer {
			r.Status = "offered"
		}
		st.StoryChanges[r.ChangeID] = r
		changeID = r.ChangeID
		return nil
	})
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	return s.storyChange(ctx, changeID)
}

func (s *Service) applyStoryBatch(st *State, actor application.Actor, session, message string, in RecordStoryChangesInput, evidence [][]Evidence, planned []StoryChange) (storedStoryChange, error) {
	now := s.stamp()
	r := storedStoryChange{StoryChangeReceipt: StoryChangeReceipt{SessionID: session, MessageID: message, CreatedAt: now, Status: "applied", Changes: []StoryChange{}}, Proposals: map[string]proposalChange{}, Input: &in, Evidence: evidence}
	before := clone(*st)
	touched := map[string]bool{}
	for i, c := range in.Changes {
		var ids *StoryChange
		if len(planned) > i {
			ids = &planned[i]
		}
		change, e := s.applyStoryChange(st, actor, session, message, now, c, evidence[i], ids)
		if e != nil {
			return r, e
		}
		for _, id := range []string{change.AssetID, change.ProposalID, c.TargetProposalID} {
			if id != "" && touched[id] {
				return r, validation("Combine changes to the same target in one patch.")
			}
		}
		for _, id := range []string{change.AssetID, change.ProposalID, c.TargetProposalID} {
			if id != "" {
				touched[id] = true
			}
		}
		if prior, ok := before.Proposals[c.TargetProposalID]; ok {
			v := proposalView(before, prior)
			change.ProposalBefore = &v
		}
		if p, ok := st.Proposals[change.ProposalID]; ok {
			v := proposalView(*st, p)
			change.ProposalAfter = &v
		}
		r.Changes = append(r.Changes, change)
	}
	for id, p := range st.Proposals {
		prior, ok := before.Proposals[id]
		if ok && reflect.DeepEqual(prior, p) {
			continue
		}
		item := proposalChange{After: p}
		if ok {
			item.Before = &prior
		}
		r.Proposals[id] = item
	}
	return r, nil
}

func (s *Service) storyChange(ctx context.Context, id string) (StoryChangeReceipt, error) {
	st, err := s.load()
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	r, ok := st.StoryChanges[id]
	if !ok {
		return StoryChangeReceipt{}, application.Fail(404, "NOT_FOUND", "Story change receipt not found.")
	}
	return storyReceiptView(st, r), nil
}

func storyUndoConflict(st State, r storedStoryChange) error {
	for _, c := range r.Changes {
		if c.After == nil {
			continue
		}
		a, ok := st.Assets[c.AssetID]
		if !ok || a.Version != c.After.Version || !reflect.DeepEqual(a, *c.After) {
			return conflict("STORY_UNDO_CONFLICT", "这条设定后来有了新的修改，无法直接撤销。", map[string]any{"assetId": c.AssetID, "version": a.Version})
		}
	}
	for id, p := range r.Proposals {
		if !reflect.DeepEqual(st.Proposals[id], p.After) {
			return conflict("STORY_UNDO_CONFLICT", "这项备选方向后来有了新的修改，无法直接撤销。", map[string]any{"proposalId": id})
		}
	}
	return nil
}

func storyReceiptView(st State, r storedStoryChange) StoryChangeReceipt {
	out := r.StoryChangeReceipt
	out.Changes = append([]StoryChange{}, r.Changes...)
	// Existing receipts retain the internal proposal snapshots needed for a diff.
	for i, c := range out.Changes {
		if c.ProposalID == "" || c.ProposalAfter != nil {
			continue
		}
		p, ok := r.Proposals[c.ProposalID]
		if !ok {
			continue
		}
		v := proposalView(st, p.After)
		out.Changes[i].ProposalAfter = &v
		prior := p.Before
		if prior == nil && p.After.Replaces != "" {
			item := r.Proposals[p.After.Replaces]
			prior = item.Before
		}
		if prior != nil {
			v := proposalView(st, *prior)
			out.Changes[i].ProposalBefore = &v
		}
	}
	undoable := false
	out.UndoConflict = ""
	if out.Status == "applied" {
		if err := storyUndoConflict(st, r); err != nil {
			out.UndoConflict = application.AsError(err).Detail
		} else {
			undoable = true
		}
	}
	out.Undoable = &undoable
	return out
}

// ApplyStoryChange requires an explicit author action. Offered previews never
// write story content until this transaction succeeds.
func (s *Service) ApplyStoryChange(ctx context.Context, actor application.Actor, key, id string) (StoryChangeReceipt, error) {
	var changeID string
	err := s.idempotent(ctx, actor, "story.apply:"+id, key, struct{}{}, &changeID, func(st *State) error {
		r, ok := st.StoryChanges[id]
		if !ok {
			return application.Fail(404, "NOT_FOUND", "Story change receipt not found.")
		}
		changeID = id
		if r.Status == "applied" {
			return nil
		}
		if r.SourceDeleted {
			return conflict("STORY_SOURCE_DELETED", "原始讨论已删除，无法再记下这条记录。", nil)
		}
		if r.Status == "undone" {
			return s.reapplyStoryChange(st, actor, &r)
		}
		if r.Status != "offered" || r.Input == nil || len(r.Evidence) != len(r.Input.Changes) {
			return conflict("STORY_APPLY_CONFLICT", "这条记录不能直接应用，请重新讨论当前设定。", nil)
		}
		for pid, p := range r.Proposals {
			if p.Before != nil && !reflect.DeepEqual(st.Proposals[pid], *p.Before) {
				return conflict("STORY_APPLY_CONFLICT", "这项备选方向后来有了新的修改，请查看当前状态。", map[string]any{"proposalId": pid})
			}
		}
		applied, e := s.applyStoryBatch(st, actor, r.SessionID, r.MessageID, *r.Input, r.Evidence, r.Changes)
		if e != nil {
			if application.AsError(e).Status == 409 {
				return conflict("STORY_APPLY_CONFLICT", "故事后来有了新的修改，无法直接记下这条记录。", application.AsError(e).Current)
			}
			return e
		}
		applied.ChangeID = id
		applied.CreatedAt = r.CreatedAt
		st.StoryChanges[id] = applied
		return nil
	})
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	return s.storyChange(ctx, changeID)
}

func (s *Service) UndoStoryChange(ctx context.Context, actor application.Actor, key, id string) (StoryChangeReceipt, error) {
	var out StoryChangeReceipt
	err := s.idempotent(ctx, actor, "story.undo:"+id, key, struct{}{}, &out, func(st *State) error {
		r, ok := st.StoryChanges[id]
		if !ok {
			return application.Fail(404, "NOT_FOUND", "Story change receipt not found.")
		}
		out = r.StoryChangeReceipt
		if r.Status == "undone" {
			return nil
		}
		if r.Status != "applied" {
			return conflict("STORY_NOT_APPLIED", "这条记录尚未记下，无需撤销。", nil)
		}
		if e := storyUndoConflict(*st, r); e != nil {
			return e
		}
		now := s.stamp()
		r.UndoAssets = map[string]Asset{}
		r.UndoProposals = map[string]Proposal{}
		for _, c := range r.Changes {
			if c.After == nil {
				continue
			}
			a := st.Assets[c.AssetID]
			if c.Before == nil {
				a.Status = "archived"
			} else {
				a.Content = c.Before.Content
				a.Status = c.Before.Status
				a.SupersededBy = c.Before.SupersededBy
			}
			a.Version++
			a.UpdatedAt = now
			st.Assets[a.ID] = a
			r.UndoAssets[a.ID] = a
			appendVersion(st, a, Version{ActorID: actor.ID, At: now, Origin: "dialogue_undo"})
		}
		for pid, p := range r.Proposals {
			next := p.After
			if p.Before != nil {
				next = *p.Before
			} else {
				next.Status = "rejected"
				next.Decision = &Decision{Action: "reject", ActorID: actor.ID, At: now}
				next.StatusReason = "DIALOGUE_CHANGE_UNDONE"
			}
			if next.Status == "proposed" && next.TargetAssetID != "" {
				for _, c := range r.Changes {
					if c.AssetID == next.TargetAssetID && c.Before != nil {
						next.BaseVersion = st.Assets[c.AssetID].Version
					}
				}
			}
			st.Proposals[pid] = next
			r.UndoProposals[pid] = next
		}
		r.Status = "undone"
		r.UndoneAt = now
		st.StoryChanges[id] = r
		out = r.StoryChangeReceipt
		return nil
	})
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	return s.storyChange(ctx, id)
}

func (s *Service) reapplyStoryChange(st *State, actor application.Actor, r *storedStoryChange) error {
	if r.UndoAssets == nil || r.UndoProposals == nil {
		return conflict("STORY_APPLY_CONFLICT", "缺少撤销后的完整状态，请重新讨论当前设定。", nil)
	}
	for id, a := range r.UndoAssets {
		if !reflect.DeepEqual(st.Assets[id], a) {
			return conflict("STORY_APPLY_CONFLICT", "这条设定在撤销后有了新的修改，无法直接重新记下。", map[string]any{"assetId": id})
		}
	}
	for id, p := range r.UndoProposals {
		if !reflect.DeepEqual(st.Proposals[id], p) {
			return conflict("STORY_APPLY_CONFLICT", "这项备选方向在撤销后有了新的修改，无法直接重新记下。", map[string]any{"proposalId": id})
		}
	}
	for _, c := range r.Changes {
		if c.After == nil {
			continue
		}
		if c.After.Status != "archived" && c.After.Status != "superseded" {
			if e := s.checkPlan(c.After.Plan); e != nil {
				return conflict("STORY_APPLY_CONFLICT", "关联章节已被移除，请查看当前设定。", map[string]any{"assetId": c.AssetID})
			}
		}
		if other, ok := matchAsset(st, c.After.Kind, c.After.Name, c.After.Aliases); ok && other.ID != c.AssetID {
			return conflict("STORY_APPLY_CONFLICT", "同名设定已经存在，请查看当前状态。", map[string]any{"assetId": other.ID})
		}
	}
	for _, p := range r.Proposals {
		if p.After.Status == "accepted" {
			if e := alternativeAllowed(st, p.After); e != nil {
				return e
			}
		}
		if p.After.TargetAssetID != "" {
			a, ok := st.Assets[p.After.TargetAssetID]
			_, changedAsset := r.UndoAssets[p.After.TargetAssetID]
			if !ok || a.Status == "archived" || a.Status == "superseded" || (!changedAsset && a.Version != p.After.BaseVersion) {
				return conflict("STORY_APPLY_CONFLICT", "备选方向对应的设定已改变，请查看当前状态。", map[string]any{"assetId": p.After.TargetAssetID})
			}
		}
	}
	before := clone(*st)
	now := s.stamp()
	for i, c := range r.Changes {
		if c.After == nil {
			continue
		}
		current := st.Assets[c.AssetID]
		a := *c.After
		a.Version = current.Version + 1
		a.UpdatedAt = now
		st.Assets[a.ID] = a
		if c.Before != nil {
			r.Changes[i].Before = &current
		}
		r.Changes[i].After = &a
		source := ConversationSource{Type: "conversation", SessionID: r.SessionID, MessageID: r.MessageID, BookID: st.BookID, CapturedAt: now, Strategy: "dialogue-story-v1"}
		var evidence []Evidence
		if len(r.Evidence) > i {
			evidence = r.Evidence[i]
		}
		appendVersion(st, a, Version{ActorID: actor.ID, At: now, Origin: "dialogue_decision", Source: &source, Evidence: evidence, ProposalID: c.ProposalID})
	}
	for id, p := range r.Proposals {
		next := p.After
		if next.Decision != nil {
			d := *next.Decision
			d.At = now
			next.Decision = &d
		}
		if next.ResultAssetID != "" {
			if a, ok := st.Assets[next.ResultAssetID]; ok {
				next.ResultVersion = a.Version
			}
		}
		if next.TargetAssetID != "" {
			if a, ok := r.UndoAssets[next.TargetAssetID]; ok {
				next.BaseVersion = a.Version
			}
		}
		if p.Before != nil {
			prior := before.Proposals[id]
			p.Before = &prior
		}
		p.After = next
		r.Proposals[id] = p
		st.Proposals[id] = next
	}
	for i, c := range r.Changes {
		if c.ProposalBefore != nil {
			p, ok := before.Proposals[c.ProposalBefore.ID]
			if ok {
				v := proposalView(before, p)
				r.Changes[i].ProposalBefore = &v
			}
		}
		if p, ok := st.Proposals[c.ProposalID]; ok {
			v := proposalView(*st, p)
			r.Changes[i].ProposalAfter = &v
		}
	}
	r.Status = "applied"
	r.UndoneAt = ""
	r.UndoAssets = nil
	r.UndoProposals = nil
	st.StoryChanges[r.ChangeID] = *r
	return nil
}

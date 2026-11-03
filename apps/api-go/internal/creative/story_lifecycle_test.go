package creative

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

func offerStory(t *testing.T, s *Service, session, message, text string, changes ...StoryChangeInput) StoryChangeReceipt {
	t.Helper()
	for i := range changes {
		changes[i].Evidence = []StoryEvidence{{MessageID: message, Quote: text}}
	}
	r, e := s.OfferStoryChanges(context.Background(), author, "story:"+session+":"+message, session, message, RecordStoryChangesInput{Changes: changes}, []TurnMessage{{ID: message, Role: "user", Text: text}})
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func TestStoryOfferManualApplyStableIDsAndReapply(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	offered := offerStory(t, f.s, "s1", "m1", "林舟是记者，父亲也许活着",
		StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), SetFields: []Field{{Key: "职业", Value: "记者"}}}},
		StoryChangeInput{Intent: "explore", Kind: "plot_line", Patch: Patch{Name: storyString("父亲来信"), Summary: storyString("父亲也许还活着")}},
	)
	st, _ := f.s.load()
	if offered.Status != "offered" || offered.Undoable == nil || *offered.Undoable || len(st.Assets) != 0 || len(st.Proposals) != 0 || len(st.Versions) != 0 {
		t.Fatalf("offer wrote settings: %+v", st)
	}
	if offered.Changes[1].ProposalAfter == nil || offered.Changes[1].ProposalAfter.Result.Summary != "父亲也许还活着" {
		t.Fatal(offered)
	}
	replay, e := f.s.RecordStoryChanges(ctx, author, "retry:new-key", "s1", "m1", RecordStoryChangesInput{}, nil)
	if e != nil || replay.ChangeID != offered.ChangeID || replay.Status != "offered" {
		t.Fatalf("record replay changed offered receipt: %+v %v", replay, e)
	}
	applied, e := f.s.ApplyStoryChange(ctx, author, "apply:one", offered.ChangeID)
	if e != nil {
		t.Fatal(e)
	}
	if applied.ChangeID != offered.ChangeID || applied.Status != "applied" || applied.Undoable == nil || !*applied.Undoable || applied.Changes[0].AssetID != offered.Changes[0].AssetID || applied.Changes[1].ProposalID != offered.Changes[1].ProposalID {
		t.Fatal(applied)
	}
	st, _ = f.s.load()
	if st.Settings.DialogueRecording || len(st.Assets) != 1 || len(st.Proposals) != 1 {
		t.Fatal(st)
	}
	if _, e = f.s.ApplyStoryChange(ctx, author, "apply:one", offered.ChangeID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.UndoStoryChange(ctx, author, "undo:one", offered.ChangeID); e != nil {
		t.Fatal(e)
	}
	replay, e = f.s.ApplyStoryChange(ctx, author, "apply:one", offered.ChangeID)
	if e != nil || replay.Status != "undone" {
		t.Fatalf("old apply retry repeated write: %+v %v", replay, e)
	}
	reapplied, e := f.s.ApplyStoryChange(ctx, author, "apply:two", offered.ChangeID)
	if e != nil {
		t.Fatal(e)
	}
	if reapplied.Changes[0].After.Version != 3 || reapplied.Changes[0].AssetID != offered.Changes[0].AssetID || !*reapplied.Undoable {
		t.Fatal(reapplied)
	}
	if _, e = f.s.UndoStoryChange(ctx, author, "undo:two", offered.ChangeID); e != nil {
		t.Fatal(e)
	}
	st, _ = f.s.load()
	if st.Assets[offered.Changes[0].AssetID].Version != 4 || st.Assets[offered.Changes[0].AssetID].Status != "archived" || st.Proposals[offered.Changes[1].ProposalID].Status != "rejected" {
		t.Fatal("second undo did not restore full pre-apply state")
	}
}

func TestStoryOfferAndReapplyConflictsAreAtomic(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	a, e := f.s.CreateAsset(ctx, author, compat.UUID(), AssetInput{Kind: "character", Status: "accepted", Content: Content{Name: "林舟", Fields: []Field{{Key: "职业", Value: "法医"}}}})
	if e != nil {
		t.Fatal(e)
	}
	offered := offerStory(t, f.s, "s1", "m1", "设定北城并改成记者",
		StoryChangeInput{Intent: "decide", Kind: "place", Patch: Patch{Name: storyString("北城")}},
		StoryChangeInput{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(1), Patch: Patch{SetFields: []Field{{Key: "职业", Value: "记者"}}}},
	)
	newer := a.Content
	newer.Summary = "作者后来的补充"
	if _, e = f.s.UpdateAsset(ctx, author, compat.UUID(), a.ID, AssetUpdate{BaseVersion: 1, Content: &newer}); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.ApplyStoryChange(ctx, author, "apply:stale", offered.ChangeID)
	if code(e) != "STORY_APPLY_CONFLICT" {
		t.Fatal(e)
	}
	st, _ := f.s.load()
	if len(st.Assets) != 1 || st.StoryChanges[offered.ChangeID].Status != "offered" {
		t.Fatal("partial stale offer committed")
	}
	next := offerStory(t, f.s, "s1", "m2", "改成记者", StoryChangeInput{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(2), Patch: Patch{SetFields: []Field{{Key: "职业", Value: "记者"}}}})
	if _, e = f.s.ApplyStoryChange(ctx, author, "apply:next", next.ChangeID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.s.UndoStoryChange(ctx, author, "undo:next", next.ChangeID); e != nil {
		t.Fatal(e)
	}
	newer.Summary = "撤销后作者又改了"
	if _, e = f.s.UpdateAsset(ctx, author, compat.UUID(), a.ID, AssetUpdate{BaseVersion: 4, Content: &newer}); e != nil {
		t.Fatal(e)
	}
	_, e = f.s.ApplyStoryChange(ctx, author, "reapply:stale", next.ChangeID)
	if code(e) != "STORY_APPLY_CONFLICT" {
		t.Fatal(e)
	}
	st, _ = f.s.load()
	if st.Assets[a.ID].Version != 5 || st.Assets[a.ID].Summary != "撤销后作者又改了" {
		t.Fatal("reapply overwrote later author edit")
	}
}

func TestStoryReceiptUndoabilityChangesAndProposalDiffIsHistorical(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	original := recordStory(t, f.s, "s1", "m1", "也许父亲还活着", StoryChangeInput{Intent: "explore", Kind: "plot_line", Patch: Patch{Name: storyString("父亲来信"), Summary: storyString("父亲还活着")}})
	revision := recordStory(t, f.s, "s1", "m2", "也许信是过去寄出的", StoryChangeInput{Intent: "explore", TargetProposalID: original.Changes[0].ProposalID, Patch: Patch{Summary: storyString("信从过去寄出")}})
	if revision.Changes[0].ProposalBefore == nil || revision.Changes[0].ProposalBefore.Result.Summary != "父亲还活着" || revision.Changes[0].ProposalAfter.Result.Summary != "信从过去寄出" {
		t.Fatal(revision)
	}
	items, e := f.s.StoryChanges(ctx, "s1")
	if e != nil {
		t.Fatal(e)
	}
	for _, r := range items {
		if r.ChangeID == original.ChangeID && (r.Undoable == nil || *r.Undoable || r.UndoConflict == "") {
			t.Fatalf("late proposal edit not reflected: %+v", r)
		}
	}
	if _, e = f.s.UndoStoryChange(ctx, author, "undo:revision", revision.ChangeID); e != nil {
		t.Fatal(e)
	}
	reapplied, e := f.s.ApplyStoryChange(ctx, author, "reapply:revision", revision.ChangeID)
	if e != nil {
		t.Fatal(e)
	}
	if reapplied.Changes[0].ProposalAfter.Result.Summary != "信从过去寄出" || !*reapplied.Undoable {
		t.Fatal(reapplied)
	}
}

func TestStoryOfferDeletionPurgesEvidenceAndBlocksApply(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	quote := "只作为原话证据的私密句子"
	r := offerStory(t, f.s, "s1", "m1", quote, StoryChangeInput{Intent: "explore", Kind: "plot_line", Patch: Patch{Name: storyString("父亲来信")}})
	if e := f.s.CancelSession(ctx, "s1"); e != nil {
		t.Fatal(e)
	}
	st, _ := f.s.load()
	raw, _ := json.Marshal(st)
	if strings.Contains(string(raw), quote) || st.StoryChanges[r.ChangeID].Input != nil || len(st.StoryChanges[r.ChangeID].Evidence) > 0 {
		t.Fatal("deleted source survives in offer")
	}
	if _, e := f.s.ApplyStoryChange(ctx, author, "apply:deleted", r.ChangeID); code(e) != "STORY_SOURCE_DELETED" {
		t.Fatal(e)
	}
	if len(st.Assets) != 0 || len(st.Proposals) != 0 {
		t.Fatal("deleted offer created story state")
	}
}

func TestStoryAuthorFocusOffAndAgentCAS(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	focus, e := f.s.EditDiscussionFocus(ctx, author, "author:focus", "s1", DiscussionFocusInput{Goal: "确认北城的秘密", AssetIDs: []string{}, QuestionIDs: []string{}, SuggestedNextStep: "讨论父亲来信"})
	if e != nil {
		t.Fatal(e)
	}
	if focus.Version != 1 || focus.UpdatedFromMessageID != "" {
		t.Fatalf("manual note fabricated AI evidence: %+v", focus)
	}
	_, e = f.s.UpdateDiscussionFocus(ctx, author, "agent:stale", "s1", "m1", DiscussionFocusInput{Goal: "过期焦点", AssetIDs: []string{}, QuestionIDs: []string{}, BaseVersion: storyInt(0)})
	if code(e) != "FOCUS_VERSION_CONFLICT" {
		t.Fatal(e)
	}
	updated, e := f.s.UpdateDiscussionFocus(ctx, author, "agent:focus", "s1", "m2", DiscussionFocusInput{Goal: "讨论来信来源", AssetIDs: []string{}, QuestionIDs: []string{}, BaseVersion: storyInt(1)})
	if e != nil || updated.Version != 2 || updated.UpdatedFromMessageID != "m2" {
		t.Fatalf("%+v %v", updated, e)
	}
	st, _ := f.s.load()
	if st.Settings.DialogueRecording || len(st.Assets) != 0 || len(st.Proposals) != 0 {
		t.Fatal("focus changed story state")
	}
}

func TestStoryRejectedDirectionReopenAndAdoptedDirectionAbandon(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	proposed := recordStory(t, f.s, "s1", "m1", "也许父亲仍然活着", StoryChangeInput{Intent: "explore", Kind: "plot_line", Patch: Patch{Name: storyString("父亲来信"), Summary: storyString("父亲仍然活着")}})
	recordStory(t, f.s, "s1", "m2", "不采用这个方向", StoryChangeInput{Intent: "reject", TargetProposalID: proposed.Changes[0].ProposalID})
	reopen := recordStory(t, f.s, "s1", "m3", "重新考虑父亲来信", StoryChangeInput{Intent: "explore", TargetProposalID: proposed.Changes[0].ProposalID})
	if reopen.Changes[0].ProposalBefore.Status != "rejected" || reopen.Changes[0].ProposalAfter.Status != "proposed" || reopen.Changes[0].ProposalAfter.Replaces != proposed.Changes[0].ProposalID {
		t.Fatal(reopen)
	}
	if _, e := f.s.UndoStoryChange(ctx, author, "undo:reopen", reopen.ChangeID); e != nil {
		t.Fatal(e)
	}
	st, _ := f.s.load()
	if st.Proposals[proposed.Changes[0].ProposalID].Status != "rejected" {
		t.Fatal("undo did not restore original rejection")
	}
	if _, e := f.s.ApplyStoryChange(ctx, author, "reapply:reopen", reopen.ChangeID); e != nil {
		t.Fatal(e)
	}
	adopted := recordStory(t, f.s, "s1", "m4", "就采用这个方向", StoryChangeInput{Intent: "decide", TargetProposalID: reopen.Changes[0].ProposalID})
	a := adopted.Changes[0].After
	abandoned := recordStory(t, f.s, "s1", "m5", "放弃父亲仍然活着的方向", StoryChangeInput{Intent: "reject", TargetAssetID: a.ID, BaseVersion: storyInt(a.Version)})
	if abandoned.Changes[0].After.Status != "archived" {
		t.Fatal(abandoned)
	}
	view, _ := f.s.StoryContext(ctx, "s1", "")
	for _, a := range view.Confirmed {
		if a.ID == abandoned.Changes[0].AssetID {
			t.Fatal("abandoned direction remains confirmed")
		}
	}
	if _, e := f.s.UndoStoryChange(ctx, author, "undo:abandon", abandoned.ChangeID); e != nil {
		t.Fatal(e)
	}
	st, _ = f.s.load()
	restored := st.Assets[a.ID]
	if restored.Status != "accepted" || !reflect.DeepEqual(restored.Content, a.Content) || restored.Version != 3 {
		t.Fatal(restored)
	}
}

func TestStoryOrganizerDoesNotDuplicateOfferedBatch(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	turn := f.say("s1", "主角林舟是记者", "可以从调查案子展开。")
	offerStory(t, f.s, "s1", turn.MessageID, "主角林舟是记者", StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), SetFields: []Field{{Key: "职业", Value: "记者"}}}})
	f.client.f = reply(func(in organizeInput) organizeOutput {
		return organizeOutput{Summary: "人物", Changes: []outChange{{Ref: "person", Operation: "CREATE", Kind: "character", Name: "林舟", Fields: []Field{{Key: "职业", Value: "记者"}}, Stance: "author_decision", Evidence: ev(turn.MessageID, "林舟是记者")}}}
	})
	f.process()
	st, _ := f.s.load()
	if len(st.Assets) != 0 || len(st.Proposals) != 0 || st.Turns[turn.Key].Status != "no_change" {
		t.Fatalf("organizer duplicated offered change: %+v", st.Turns[turn.Key])
	}
	receipts, e := f.s.StoryChanges(ctx, "s1")
	if e != nil || len(receipts) != 1 || receipts[0].Status != "offered" {
		t.Fatalf("%+v %v", receipts, e)
	}
}

func TestStoryOrganizerKeepsSupplementaryFieldsOnRecordedAsset(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	turn := f.say("s1", "林舟是记者，他想查明父亲的死因。", "可以从调查案子展开。")
	recorded := recordStory(t, f.s, "s1", turn.MessageID, "林舟是记者", StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), SetFields: []Field{{Key: "职业", Value: "记者"}}}})
	assetID := recorded.Changes[0].AssetID
	f.client.f = reply(func(in organizeInput) organizeOutput {
		return organizeOutput{Summary: "补充目标", Changes: []outChange{{Operation: "UPDATE", TargetAssetID: assetID, Stance: "author_decision", Fields: []Field{{Key: "职业", Value: "记者"}, {Key: "目标", Value: "查明父亲的死因"}}, Evidence: ev(turn.MessageID, "他想查明父亲的死因")}}}
	})
	f.process()
	pending := f.pending()
	if len(pending) != 1 || pending[0].TargetAssetID != assetID || pending[0].Result == nil || len(pending[0].Result.Fields) != 2 {
		t.Fatalf("supplementary detail discarded: %+v", pending)
	}
	st, _ := f.s.load()
	if len(st.Assets[assetID].Fields) != 1 {
		t.Fatal("background supplement changed canon")
	}
}

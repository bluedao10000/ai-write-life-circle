package creative

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

func storyString(v string) *string { return &v }
func storyInt(v int) *int          { return &v }
func enableRecording(t *testing.T, s *Service) {
	t.Helper()
	on := true
	if _, e := s.Configure(context.Background(), author, "recording", compat.UUID(), SettingsInput{DialogueRecording: &on}); e != nil {
		t.Fatal(e)
	}
}
func recordStory(t *testing.T, s *Service, session, message, text string, changes ...StoryChangeInput) StoryChangeReceipt {
	t.Helper()
	for i := range changes {
		changes[i].Evidence = []StoryEvidence{{MessageID: message, Quote: text}}
	}
	r, e := s.RecordStoryChanges(context.Background(), author, "story:"+session+":"+message, session, message, RecordStoryChangesInput{Changes: changes}, []TurnMessage{{ID: message, Role: "user", Text: text}})
	if e != nil {
		t.Fatal(e)
	}
	return r
}

func TestStoryRecordingIndependentOfOrganizerAndScope(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	f.s.Config = llm.Config{}
	overview, e := f.s.Overview(ctx)
	if e != nil || overview.Settings.DialogueRecording {
		t.Fatalf("recording must opt in: %+v %v", overview.Settings, e)
	}
	enableRecording(t, f.s)
	if _, e = f.s.Configure(ctx, author, "pause", compat.UUID(), SettingsInput{}); e != nil {
		t.Fatal(e)
	}
	r := recordStory(t, f.s, "s1", "m1", "写一个关于放下复仇的故事", StoryChangeInput{Intent: "decide", Kind: "story_intent", Patch: Patch{Name: storyString("核心主题"), Summary: storyString("放下复仇")}})
	if len(r.Changes) != 1 || r.Changes[0].After.Kind != "story_intent" {
		t.Fatalf("%+v", r)
	}
	overview, _ = f.s.Overview(ctx)
	if !overview.Settings.DialogueRecording || !overview.Settings.Paused || overview.Settings.Enabled {
		t.Fatalf("recording wrongly depends on background: %+v", overview.Settings)
	}
	off := false
	_, e = f.s.Configure(ctx, author, "recording", compat.UUID(), SettingsInput{DialogueRecording: &off})
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.s.RecordStoryChanges(ctx, author, "story:m2", "s1", "m2", RecordStoryChangesInput{Changes: []StoryChangeInput{{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟")}, Evidence: []StoryEvidence{{MessageID: "m2", Quote: "林舟"}}}}}, []TurnMessage{{ID: "m2", Role: "user", Text: "林舟"}})
	if code(e) != "DIALOGUE_RECORDING_DISABLED" {
		t.Fatalf("%v", e)
	}
}

func TestStoryMultiTurnRevisionCrossSessionAndEvidence(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	r := recordStory(t, f.s, "s1", "m1", "林舟是守塔人，叫阿舟", StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), AddAliases: []string{"阿舟"}, SetFields: []Field{{Key: "身份", Value: "守塔人"}}}})
	a := *r.Changes[0].After
	r2 := recordStory(t, f.s, "s1", "m2", "他想找回妹妹", StoryChangeInput{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(a.Version), Patch: Patch{SetFields: []Field{{Key: "目标", Value: "找回妹妹"}}}})
	a = *r2.Changes[0].After
	r3 := recordStory(t, f.s, "s1", "m3", "改成渡船人", StoryChangeInput{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(a.Version), Patch: Patch{SetFields: []Field{{Key: "身份", Value: "渡船人"}}}})
	a = *r3.Changes[0].After
	focus, e := f.s.UpdateDiscussionFocus(ctx, author, "focus:m3", "s1", "m3", DiscussionFocusInput{Goal: "找妹妹的代价", AssetIDs: []string{a.ID}, QuestionIDs: []string{}})
	if e != nil {
		t.Fatal(e)
	}
	if focus.Version != 1 {
		t.Fatal(focus)
	}
	view, e := f.s.StoryContext(ctx, "s2", "阿舟后面怎么办")
	if e != nil {
		t.Fatal(e)
	}
	if view.Focus != nil || len(view.Confirmed) != 1 || view.Confirmed[0].Version != 3 || len(view.Confirmed[0].Fields) != 2 || view.Confirmed[0].Fields[0].Value != "渡船人" {
		t.Fatalf("cross session context: %+v", view)
	}
	_, e = f.s.UpdateDiscussionFocus(ctx, author, "focus:stale", "s1", "m4", DiscussionFocusInput{Goal: "过时目标", AssetIDs: []string{}, QuestionIDs: []string{}})
	if code(e) != "FOCUS_VERSION_CONFLICT" {
		t.Fatalf("%v", e)
	}
	_, e = f.s.UpdateDiscussionFocus(ctx, author, "focus:m4", "s1", "m4", DiscussionFocusInput{Goal: "确定代价", AssetIDs: []string{a.ID}, QuestionIDs: []string{}, BaseVersion: storyInt(1)})
	if e != nil {
		t.Fatal(e)
	}
	// Prior author statements and assistant suggestions cannot authorize this turn.
	for _, test := range []struct {
		quote, id string
		messages  []TurnMessage
	}{
		{"他是王子", "old", []TurnMessage{{ID: "old", Role: "user", Text: "他是王子"}, {ID: "m5", Role: "user", Text: "再想想"}}},
		{"他是王子", "m5", []TurnMessage{{ID: "m5", Role: "assistant", Text: "他是王子"}}},
		{"他是王子", "m5", []TurnMessage{{ID: "m5", Role: "user", Text: "他是守塔人"}}},
	} {
		_, e = f.s.RecordStoryChanges(ctx, author, compat.UUID(), "s1", "m5", RecordStoryChangesInput{Changes: []StoryChangeInput{{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(3), Patch: Patch{Summary: storyString("王子")}, Evidence: []StoryEvidence{{MessageID: test.id, Quote: test.quote}}}}}, test.messages)
		if code(e) != "VALIDATION_FAILED" {
			t.Fatalf("unverified author evidence accepted: %v", e)
		}
	}
}

func TestStoryHypothesisRevisionAdoptionRejectionAndQuestions(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	r := recordStory(t, f.s, "s1", "m1", "也许妹妹已经死了", StoryChangeInput{Intent: "explore", Kind: "plot_line", Patch: Patch{Name: storyString("妹妹的去向"), Summary: storyString("妹妹已经死了")}})
	p := r.Changes[0].ProposalID
	view, _ := f.s.StoryContext(ctx, "s1", "")
	if len(view.Confirmed) != 0 || len(view.Alternatives) != 1 || view.Alternatives[0].Result.Summary != "妹妹已经死了" {
		t.Fatalf("hypothesis became canon: %+v", view)
	}
	r = recordStory(t, f.s, "s1", "m2", "也许她只是失忆了", StoryChangeInput{Intent: "explore", TargetProposalID: p, Patch: Patch{Summary: storyString("妹妹失忆了")}})
	p2 := r.Changes[0].ProposalID
	view, _ = f.s.StoryContext(ctx, "s1", "")
	if len(view.Alternatives) != 1 || view.Alternatives[0].ID != p2 {
		t.Fatalf("superseded candidate leaked: %+v", view)
	}
	accepted := recordStory(t, f.s, "s1", "m3", "就定失忆了", StoryChangeInput{Intent: "decide", TargetProposalID: p2, Patch: Patch{}})
	if accepted.Changes[0].After.Summary != "妹妹失忆了" {
		t.Fatal(accepted)
	}
	view, _ = f.s.StoryContext(ctx, "s1", "")
	if len(view.Alternatives) != 0 || len(view.Confirmed) != 1 {
		t.Fatal(view)
	}
	r = recordStory(t, f.s, "s1", "m4", "也许设一个反派", StoryChangeInput{Intent: "explore", Kind: "character", Patch: Patch{Name: storyString("反派")}})
	rejected := recordStory(t, f.s, "s1", "m5", "不要这个反派", StoryChangeInput{Intent: "reject", TargetProposalID: r.Changes[0].ProposalID, Patch: Patch{}})
	view, _ = f.s.StoryContext(ctx, "s1", "")
	if len(view.Rejected) != 1 || len(view.Alternatives) != 0 {
		t.Fatal(view)
	}
	if _, e := f.s.UndoStoryChange(ctx, author, "undo:rejection", rejected.ChangeID); e != nil {
		t.Fatal(e)
	}
	view, _ = f.s.StoryContext(ctx, "s1", "")
	if len(view.Rejected) != 0 || len(view.Alternatives) != 1 {
		t.Fatal(view)
	}
	question := recordStory(t, f.s, "s1", "m6", "先不决定何时重逢", StoryChangeInput{Intent: "defer", Kind: "open_question", Patch: Patch{Name: storyString("何时重逢")}}).Changes[0].After
	view, _ = f.s.StoryContext(ctx, "s1", "")
	if len(view.Questions) != 1 || view.Questions[0].QuestionStatus != "deferred" {
		t.Fatal(view)
	}
	resolved := recordStory(t, f.s, "s1", "m7", "定在结尾重逢", StoryChangeInput{Intent: "decide", TargetAssetID: question.ID, BaseVersion: storyInt(question.Version), Patch: Patch{Summary: storyString("结尾重逢"), QuestionStatus: storyString("resolved")}})
	if resolved.Changes[0].After.QuestionStatus != "resolved" {
		t.Fatal(resolved)
	}
	_, e := f.s.CreateAsset(ctx, author, compat.UUID(), AssetInput{Kind: "character", Content: Content{Name: "不合法", QuestionStatus: "pending"}, Status: "accepted"})
	if code(e) != "VALIDATION_FAILED" {
		t.Fatal(e)
	}
}

func TestStoryAtomicCASIdempotenceUndoAndLaterEdits(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	first := recordStory(t, f.s, "s1", "m1", "林舟守塔，妹妹叫林雪", StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), SetFields: []Field{{Key: "身份", Value: "守塔人"}}}}, StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林雪")}})
	a, b := *first.Changes[0].After, *first.Changes[1].After
	// A retry from a recovered assistant turn returns the original atomic receipt.
	replay, e := f.s.RecordStoryChanges(ctx, author, "different-retry-key", "s1", "m1", RecordStoryChangesInput{}, nil)
	if e != nil || replay.ChangeID != first.ChangeID {
		t.Fatalf("%+v %v", replay, e)
	}
	_, e = f.s.RecordStoryChanges(ctx, author, "story:stale", "s1", "m2", RecordStoryChangesInput{Changes: []StoryChangeInput{
		{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(1), Patch: Patch{Summary: storyString("第一项会成功")}, Evidence: []StoryEvidence{{MessageID: "m2", Quote: "修改两人"}}},
		{Intent: "decide", TargetAssetID: b.ID, BaseVersion: storyInt(99), Patch: Patch{Summary: storyString("第二项版本过期")}, Evidence: []StoryEvidence{{MessageID: "m2", Quote: "修改两人"}}},
	}}, []TurnMessage{{ID: "m2", Role: "user", Text: "修改两人"}})
	if code(e) != "ASSET_VERSION_CONFLICT" {
		t.Fatal(e)
	}
	st, _ := f.s.load()
	if st.Assets[a.ID].Version != 1 || st.Assets[a.ID].Summary != "" || len(st.StoryChanges) != 1 {
		t.Fatal("partial batch committed")
	}
	update := recordStory(t, f.s, "s1", "m2", "改成渡船人", StoryChangeInput{Intent: "decide", TargetAssetID: a.ID, BaseVersion: storyInt(1), Patch: Patch{SetFields: []Field{{Key: "身份", Value: "渡船人"}}}})
	undone, e := f.s.UndoStoryChange(ctx, author, "undo:m2", update.ChangeID)
	if e != nil || undone.Status != "undone" {
		t.Fatalf("%+v %v", undone, e)
	}
	st, _ = f.s.load()
	if st.Assets[a.ID].Version != 3 || st.Assets[a.ID].Fields[0].Value != "守塔人" {
		t.Fatal(st.Assets[a.ID])
	}
	replay, e = f.s.RecordStoryChanges(ctx, author, "retry:undone", "s1", "m2", RecordStoryChangesInput{}, nil)
	if e != nil || replay.Status != "undone" {
		t.Fatalf("%+v %v", replay, e)
	}
	if _, e = f.s.UndoStoryChange(ctx, author, "undo:again", update.ChangeID); e != nil {
		t.Fatal(e)
	}
	st, _ = f.s.load()
	if st.Assets[a.ID].Version != 3 {
		t.Fatal("undo incremented twice")
	}
	_, e = f.s.UndoStoryChange(ctx, author, "undo:create", first.ChangeID)
	if code(e) != "STORY_UNDO_CONFLICT" {
		t.Fatal(e)
	}
	st, _ = f.s.load()
	if st.Assets[b.ID].Status != "accepted" {
		t.Fatal("partial undo archived second asset")
	}
	fresh := recordStory(t, f.s, "s1", "m3", "增加渔港", StoryChangeInput{Intent: "decide", Kind: "place", Patch: Patch{Name: storyString("渔港")}})
	if _, e = f.s.UndoStoryChange(ctx, author, "undo:place", fresh.ChangeID); e != nil {
		t.Fatal(e)
	}
	st, _ = f.s.load()
	archived := st.Assets[fresh.Changes[0].AssetID]
	if archived.Status != "archived" || archived.Version != 2 {
		t.Fatal(archived)
	}
}

func TestStoryUndoProposalRevisionAndAdoption(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	first := recordStory(t, f.s, "s1", "m1", "也许做守塔人", StoryChangeInput{Intent: "explore", Kind: "character", Patch: Patch{Name: storyString("林舟"), Summary: storyString("守塔人")}})
	revised := recordStory(t, f.s, "s1", "m2", "也许改渡船人", StoryChangeInput{Intent: "explore", TargetProposalID: first.Changes[0].ProposalID, Patch: Patch{Summary: storyString("渡船人")}})
	if _, e := f.s.UndoStoryChange(ctx, author, "undo:revision", revised.ChangeID); e != nil {
		t.Fatal(e)
	}
	view, _ := f.s.StoryContext(ctx, "s1", "")
	if len(view.Alternatives) != 1 || view.Alternatives[0].Result.Summary != "守塔人" {
		t.Fatal(view)
	}
	adopted := recordStory(t, f.s, "s1", "m3", "就定守塔人", StoryChangeInput{Intent: "decide", TargetProposalID: first.Changes[0].ProposalID, Patch: Patch{}})
	if _, e := f.s.UndoStoryChange(ctx, author, "undo:adopt", adopted.ChangeID); e != nil {
		t.Fatal(e)
	}
	view, _ = f.s.StoryContext(ctx, "s1", "")
	if len(view.Confirmed) != 0 || len(view.Alternatives) != 1 {
		t.Fatal(view)
	}
}

func TestStorySessionDeletionScrubsSourcesAndFocus(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	secretQuote := "原话不要留在来源里"
	accepted := recordStory(t, f.s, "s1", "m1", secretQuote, StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟")}})
	recordStory(t, f.s, "s1", "m2", secretQuote, StoryChangeInput{Intent: "explore", Kind: "place", Patch: Patch{Name: storyString("渔港")}})
	_, e := f.s.UpdateDiscussionFocus(ctx, author, "focus:m2", "s1", "m2", DiscussionFocusInput{Goal: secretQuote, AssetIDs: []string{accepted.Changes[0].AssetID}, QuestionIDs: []string{}})
	if e != nil {
		t.Fatal(e)
	}
	if e = f.s.CancelSession(ctx, "s1"); e != nil {
		t.Fatal(e)
	}
	st, _ := f.s.load()
	raw, _ := json.Marshal(st)
	if strings.Contains(string(raw), secretQuote) {
		t.Fatal("deleted conversation quote remains in storage")
	}
	if len(st.Focuses) != 0 || st.Assets[accepted.Changes[0].AssetID].Status != "accepted" {
		t.Fatal("author setting lost or focus retained")
	}
	for _, p := range st.Proposals {
		if p.Status != "expired" || !p.Source.Deleted {
			t.Fatal(p)
		}
	}
}

func TestStoryContextBudgetPrioritiesAndLegacyState(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	st := empty(f.book.ID)
	st.Focuses = nil
	st.StoryChanges = nil
	if e := storage.Write(ctx, f.s.path(), st); e != nil {
		t.Fatal(e)
	}
	enableRecording(t, f.s)
	now := time.Now()
	f.s.Clock = func() time.Time { return now }
	intent := recordStory(t, f.s, "s1", "m1", "写放下复仇", StoryChangeInput{Intent: "decide", Kind: "story_intent", Patch: Patch{Name: storyString("主题"), Summary: storyString("放下复仇")}})
	named := recordStory(t, f.s, "s1", "m2", "林舟也叫阿舟", StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), AddAliases: []string{"阿舟"}}})
	recordStory(t, f.s, "s1", "m3", "也许她是船长", StoryChangeInput{Intent: "explore", Kind: "character", Patch: Patch{Name: storyString("船长")}})
	// Fill background state through normal author writes; the named older asset wins.
	for i := 0; i < 30; i++ {
		now = now.Add(time.Second)
		_, e := f.s.CreateAsset(ctx, author, compat.UUID(), AssetInput{Kind: "place", Status: "accepted", Content: Content{Name: compat.UUID(), Summary: strings.Repeat("地", 500)}})
		if e != nil {
			t.Fatal(e)
		}
	}
	view, e := f.s.StoryContext(ctx, "s1", "阿舟现在怎么样")
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(view)
	if len(raw) > 16*1024 || len(view.Intent) != 1 || view.Intent[0].ID != intent.Changes[0].AssetID || len(view.Confirmed) == 0 || view.Confirmed[0].ID != named.Changes[0].AssetID || len(view.Alternatives) != 1 {
		t.Fatalf("context priorities lost: bytes=%d %+v", len(raw), view)
	}
}

func TestStoryOrganizerSkipsRecordedDetails(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	turn := f.say("s1", "林舟是守塔人，也许妹妹失忆了", "可以从重逢展开。")
	recordStory(t, f.s, "s1", turn.MessageID, "林舟是守塔人，也许妹妹失忆了",
		StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), SetFields: []Field{{Key: "身份", Value: "守塔人"}}}},
		StoryChangeInput{Intent: "explore", Kind: "plot_line", Patch: Patch{Name: storyString("妹妹去向"), Summary: storyString("妹妹失忆了")}},
	)
	f.client.f = reply(func(in organizeInput) organizeOutput {
		if len(in.RecordedChanges) != 2 {
			t.Fatalf("recorded changes missing: %+v", in)
		}
		return organizeOutput{Summary: "已整理的决定", Changes: []outChange{
			{Ref: "character", Operation: "CREATE", Kind: "character", Stance: "author_decision", Name: "林舟", Fields: []Field{{Key: "身份", Value: "守塔人"}}, Evidence: ev(turn.MessageID, "林舟是守塔人")},
			{Ref: "plot", Operation: "CREATE", Kind: "plot_line", Stance: "author_hypothesis", Name: "妹妹去向", Summary: "妹妹失忆了", Evidence: ev(turn.MessageID, "也许妹妹失忆了")},
		}}
	})
	f.process()
	st, err := f.s.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Assets) != 1 || len(st.Proposals) != 1 || st.Turns[turn.Key].Status != "no_change" {
		t.Fatalf("recorded content proposed again: assets=%d proposals=%d turn=%+v", len(st.Assets), len(st.Proposals), st.Turns[turn.Key])
	}
	view, err := f.s.StoryContext(ctx, "s1", "")
	if err != nil || len(view.Alternatives) != 1 {
		t.Fatalf("%+v %v", view, err)
	}
}

func TestStoryAliasIdentityRetractionAndAdoptUpdateUndo(t *testing.T) {
	f := setup(t)
	enableRecording(t, f.s)
	ctx := context.Background()
	a := recordStory(t, f.s, "s1", "m1", "林舟又叫阿舟，守塔找妹妹", StoryChangeInput{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString("林舟"), AddAliases: []string{"阿舟"}, SetFields: []Field{{Key: "身份", Value: "守塔人"}, {Key: "目标", Value: "找妹妹"}}}}).Changes[0].After
	_, err := f.s.RecordStoryChanges(ctx, author, "story:duplicate", "s1", "m2", RecordStoryChangesInput{Changes: []StoryChangeInput{{Intent: "decide", Kind: "character", Patch: Patch{Name: storyString(" 阿 舟 ")}, Evidence: []StoryEvidence{{MessageID: "m2", Quote: "阿舟"}}}}}, []TurnMessage{{ID: "m2", Role: "user", Text: "阿舟"}})
	if code(err) != "DUPLICATE_ASSET" {
		t.Fatal(err)
	}
	a = recordStory(t, f.s, "s1", "m2", "不再找妹妹", StoryChangeInput{Intent: "reject", TargetAssetID: a.ID, BaseVersion: storyInt(a.Version), Patch: Patch{RemoveFields: []string{"目标"}}}).Changes[0].After
	if a.Status != "accepted" || len(a.Fields) != 1 || a.Fields[0].Key != "身份" {
		t.Fatal(a)
	}
	candidate := recordStory(t, f.s, "s1", "m3", "也许改成渡船人", StoryChangeInput{Intent: "explore", TargetAssetID: a.ID, BaseVersion: storyInt(a.Version), Patch: Patch{SetFields: []Field{{Key: "身份", Value: "渡船人"}}}})
	adopted := recordStory(t, f.s, "s1", "m4", "定为渡船人", StoryChangeInput{Intent: "decide", TargetProposalID: candidate.Changes[0].ProposalID, Patch: Patch{}})
	if _, err = f.s.UndoStoryChange(ctx, author, "undo:update-adoption", adopted.ChangeID); err != nil {
		t.Fatal(err)
	}
	view, err := f.s.StoryContext(ctx, "s1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Alternatives) != 1 || view.Alternatives[0].Stale || view.Alternatives[0].BaseVersion != 4 || view.Confirmed[0].Fields[0].Value != "守塔人" {
		t.Fatal(view)
	}
}

func TestStoryContextPreservesOversizedNamedAssetAndSignalsTruncation(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	fields := []Field{}
	for i := 0; i < 20; i++ {
		fields = append(fields, Field{Key: compat.UUID(), Value: strings.Repeat("设定", 1000)})
	}
	asset, err := f.s.CreateAsset(ctx, author, compat.UUID(), AssetInput{Kind: "character", Status: "accepted", Content: Content{Name: "林舟", Summary: strings.Repeat("背景", 1000), Fields: fields}})
	if err != nil {
		t.Fatal(err)
	}
	view, err := f.s.StoryContext(ctx, "s1", "林舟的故事")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(view)
	if !view.Truncated || len(raw) > 16*1024 || len(view.Confirmed) != 1 || view.Confirmed[0].ID != asset.ID || len(view.Confirmed[0].Fields) != 20 {
		t.Fatalf("oversized named setting missing: bytes=%d %+v", len(raw), view)
	}
	detail, err := f.s.Asset(ctx, asset.ID)
	if err != nil || detail.Asset.Summary != asset.Summary || detail.Asset.Fields[0].Value != asset.Fields[0].Value {
		t.Fatal("prompt compaction changed stored setting")
	}
}

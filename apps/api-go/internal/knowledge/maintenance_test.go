package knowledge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackfillBoundedBudgetRestartAndFailures(t *testing.T) {
	s, m, b, c := setup(t)
	a := application.Actor{ID: "synthetic", Role: "author"}
	ctx := context.Background()
	for i := 1; i < 105; i++ {
		var e error
		b, e = m.Mutate(ctx, a, b.ID, fmt.Sprintf("add-%d", i), application.StructureInput{Operation: "chapter", BaseVersion: b.Version})
		if e != nil {
			t.Fatal(e)
		}
	}
	for _, chapter := range b.Chapters {
		save(t, s, chapter.ID, "林舟来自北港。")
	}
	enable(t, s)
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	process(t, s)
	st, _ := s.load()
	if len(st.Jobs) != 105 || st.Jobs[0].Status != "completed" || st.Jobs[1].ChapterID != b.Chapters[1].ID {
		t.Fatal("backfill order/bound", len(st.Jobs))
	}
	// Exhaust the current day's conservative ledger; even retries must not bypass it.
	_ = s.transaction(ctx, func(st *State) (bool, error) { st.BudgetTokens = st.Settings.DailyTokenBudget; return true, nil })
	process(t, s)
	if c.calls.Load() != 1 {
		t.Fatal("budget bypass")
	}
	_ = s.transaction(ctx, func(st *State) (bool, error) {
		st.BudgetTokens = 0
		st.Jobs[1].Status = "running"
		st.Jobs[1].Attempts = 1
		st.Jobs[1].Deadline = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		return true, nil
	})
	process(t, New(s.App, s.Config, c))
	st, _ = s.load()
	if st.Jobs[1].Status != "completed" || st.Jobs[1].Attempts != 2 {
		t.Fatal("restart lease not recovered")
	}
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{}, errors.New("timeout")
	}
	for attempt := 0; attempt < 3; attempt++ {
		_ = s.transaction(ctx, func(st *State) (bool, error) {
			st.Jobs[2].Due = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
			return true, nil
		})
		process(t, s)
	}
	st, _ = s.load()
	if st.Jobs[2].Status != "failed" || st.Jobs[2].Attempts != 3 {
		t.Fatal("unbounded retries", st.Jobs[2])
	}
}
func TestSaveFailureNoopNoModelAndArchiveIsolation(t *testing.T) {
	s, m, b, c := setup(t)
	id := b.Chapters[0].ID
	save(t, s, id, "林舟来自北港。")
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	process(t, s)
	key := "save-invalid-base"
	_, e := s.App.Save(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, id, key, map[string]any{"baseRevisionId": "draft:invalid", "markdown": "林舟不再存在。"}, &key)
	if e == nil {
		t.Fatal("bad save succeeded")
	}
	process(t, s)
	save(t, s, id, "林舟来自北港。")
	process(t, s)
	if c.calls.Load() != 1 {
		t.Fatal("failed/noop save triggered model")
	}
	other, e := m.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "", "other", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	otherApp, _ := m.Resolve(application.Actor{ID: "synthetic", Role: "author"}, other.ID)
	if len(query(t, New(otherApp, s.Config, c)).Entities) != 0 {
		t.Fatal("book leak")
	}
	b.Chapters[0].Archived = true
	_, e = m.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, b.ID, "archive", application.StructureInput{Operation: "structure", BaseVersion: b.Version, Chapters: b.Chapters, Volumes: b.Volumes})
	if e != nil {
		t.Fatal(e)
	}
	p := query(t, s)
	if p.Assertions[0].Sources[0].Validity != "unavailable" || p.Entities[0].Status != "stale" {
		t.Fatal("archive still current")
	}
}
func TestUTF16AmbiguousAndNarrativeBoundaries(t *testing.T) {
	s, _, b, _ := setup(t)
	r := save(t, s, b.Chapters[0].ID, "🌧️林舟来自北港。")
	a := CandidateAssertion{Quote: "林舟来自北港。", Kind: "narration"}
	source, e := evidence(s.App.Project, b.Chapters[0].ID, r, a)
	if e != nil || source.Start != 3 {
		t.Fatal(source, e)
	}
	r.Markdown = "林舟。林舟。"
	r.Hash = "invalid"
	if _, e = evidence(s.App.Project, b.Chapters[0].ID, r, CandidateAssertion{Quote: "林舟。"}); e == nil {
		t.Fatal("forged hash/ambiguous accepted")
	}
}
func TestInFlightPauseCancelsAndNoPartialEntities(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	enable(t, s)
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	c.f = func(ctx context.Context, _ llm.Request) (llm.Response, error) {
		close(entered)
		<-ctx.Done()
		close(cancelled)
		return llm.Response{}, ctx.Err()
	}
	done := make(chan error, 1)
	go func() { done <- s.ProcessOne(context.Background()) }()
	<-entered
	st, _ := s.load()
	_, e := s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "pause", "pause-running", Mutation{BaseVersion: st.Version})
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("model context not cancelled")
	}
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if len(query(t, s).Entities) != 0 {
		t.Fatal("cancelled output persisted")
	}
	// Idempotent mutations do not create another override or bypass CAS.
	st, _ = s.load()
	model := s.Config.Info()
	in := Mutation{BaseVersion: st.Version, Consent: true, Model: &model, DailyTokenBudget: 1000000, DailyJobBudget: 100}
	actor := application.Actor{ID: "synthetic", Role: "author"}
	if _, e = s.Mutate(context.Background(), actor, "enable", "enable-again", in); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Mutate(context.Background(), actor, "enable", "enable-again", in); e != nil {
		t.Fatal(e)
	}
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		out, _ := Decode(output("林舟", "林舟来自北港。", "来自北港", ""))
		out.Entities = append(out.Entities, CandidateEntity{Key: "x", Type: "place", Name: "南港", Aliases: []string{}})
		out.Assertions = append(out.Assertions, CandidateAssertion{EntityKey: "x", Predicate: "地点", Text: "南港", Epistemic: "observation", Kind: "narration", Quote: "林舟来自北港。"})
		raw, _ := json.Marshal(out)
		return llm.Response{Text: string(raw)}, nil
	}
	process(t, s)
	p := query(t, s)
	if len(p.Entities) != 1 || p.Entities[0].Name != "林舟" {
		t.Fatalf("valid candidate was lost with invalid sibling: %+v", p.Entities)
	}
	st, _ = s.load()
	found := false
	for _, job := range st.Jobs {
		if job.Status == "completed" && job.DiscardedEntities == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("partial extraction was not durably recorded: %+v", st.Jobs)
	}
}
func TestReadOnlyReviewRetrievalRetainsTrustAndNoWrite(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟说：我来自北港。")
	enable(t, s)
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		out, _ := Decode(output("林舟", "林舟说：我来自北港。", "来自北港", ""))
		out.Assertions[0].Kind = "dialogue"
		raw, _ := json.Marshal(out)
		return llm.Response{Text: string(raw)}, nil
	}
	process(t, s)
	before, _ := s.load()
	items, e := s.Retrieve(context.Background(), b.Chapters[0].ID)
	if e != nil || len(items) != 1 || items[0].Epistemic != "claim" {
		t.Fatal(items, e)
	}
	ids, e := s.RelatedChapters(context.Background(), b.Chapters[0].ID)
	if e != nil || len(ids) != 1 {
		t.Fatal(ids, e)
	}
	after, _ := s.load()
	if before.Version != after.Version {
		t.Fatal("read wrote state")
	}
	if strings.Contains(items[0].Epistemic, "confirmed") {
		t.Fatal("AI became canon")
	}
}
func TestDistinctHomonymsRelationsAndInferenceSources(t *testing.T) {
	s, _, b, _ := setup(t)
	id := b.Chapters[0].ID
	r := save(t, s, id, "医师林舟是船工林舟的兄长。两人后来结伴去北港。")
	st, _ := s.load()
	out := Output{Entities: []CandidateEntity{{Key: "doctor", Type: "character", Name: "林舟", Aliases: []string{}, Identity: "医师"}, {Key: "sailor", Type: "character", Name: "林舟", Aliases: []string{}, Identity: "船工"}, {Key: "event", Type: "event", Name: "结伴", Aliases: []string{}, Identity: ""}}, Assertions: []CandidateAssertion{{EntityKey: "doctor", TargetKey: "sailor", Predicate: "兄长", Text: "医师林舟是船工林舟的兄长", Epistemic: "observation", Kind: "narration", Quote: "医师林舟是船工林舟的兄长。"}, {EntityKey: "sailor", Predicate: "身份", Text: "船工", Epistemic: "observation", Kind: "narration", Quote: "医师林舟是船工林舟的兄长。"}, {EntityKey: "event", Predicate: "事件", Text: "后来结伴去北港", Epistemic: "observation", Kind: "narration", Time: "后来", Quote: "两人后来结伴去北港。"}}}
	if e := apply(&st, Job{ID: "test", ChapterID: id}, r, out); e != nil {
		t.Fatal(e)
	}
	if len(st.Entities) != 3 {
		t.Fatal("homonyms merged")
	}
	hasRelation := false
	for _, a := range st.Assertions {
		if a.TargetID != "" {
			hasRelation = true
			if _, ok := st.Entities[a.TargetID]; !ok {
				t.Fatal("dangling relation")
			}
		}
	}
	if !hasRelation {
		t.Fatal("lost relation")
	}
}
func TestPersistentClaimOverrideSurvivesParaphraseAndUndo(t *testing.T) {
	s, _, b, c := setup(t)
	id := b.Chapters[0].ID
	save(t, s, id, "林舟说自己来自北港。")
	c.f = func(context.Context, llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟说自己来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	process(t, s)
	p := query(t, s)
	actor := application.Actor{ID: "synthetic", Role: "author"}
	_, e := s.Mutate(context.Background(), actor, "correct", "claim", Mutation{BaseVersion: p.Version, Action: "claim", AssertionID: p.Assertions[0].ID, Reason: "这是人物说法"})
	if e != nil {
		t.Fatal(e)
	}
	st, _ := s.load()
	_, e = s.Mutate(context.Background(), actor, "rebuild", "rephrase", Mutation{BaseVersion: st.Version})
	if e != nil {
		t.Fatal(e)
	}
	c.f = func(context.Context, llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟说自己来自北港。", "林舟的故乡是北港", "")}, nil
	}
	process(t, s)
	for _, a := range query(t, s).Assertions {
		if a.Status == "current" && a.Epistemic != "claim" {
			t.Fatal("paraphrase erased author correction")
		}
	}
	st, _ = s.load()
	_, e = s.Mutate(context.Background(), actor, "undo", "undo", Mutation{BaseVersion: st.Version, CorrectionID: st.Corrections[0].ID})
	if e != nil {
		t.Fatal(e)
	}
	found := false
	for _, a := range query(t, s).Assertions {
		if a.Status == "current" && a.Epistemic == "observation" {
			found = true
		}
	}
	if !found {
		t.Fatal("undo failed")
	}
}
func TestBudgetUTCResetAndMutationRateLimit(t *testing.T) {
	s, _, _, _ := setup(t)
	enable(t, s)
	ctx := context.Background()
	_ = s.transaction(ctx, func(st *State) (bool, error) {
		st.BudgetDay = "2000-01-01"
		st.BudgetTokens = 999999
		st.BudgetAttempts = 99
		return true, nil
	})
	process(t, s)
	st, _ := s.load()
	if st.BudgetDay == "2000-01-01" || st.BudgetTokens != 0 || st.BudgetAttempts != 0 {
		t.Fatal("UTC day ledger did not reset")
	}
	actor := application.Actor{ID: "synthetic", Role: "author"}
	var e error
	for i := 0; i < 21; i++ {
		st, _ = s.load()
		_, e = s.Mutate(ctx, actor, "pause", fmt.Sprintf("rate-%d", i), Mutation{BaseVersion: st.Version})
		if e != nil {
			if application.AsError(e).Status != 429 {
				t.Fatal(e)
			}
			break
		}
	}
	if e == nil {
		t.Fatal("unlimited mutations")
	}
}

func TestExpiredUnstartedAttemptsRefundBeforeCancellationOrReplacement(t *testing.T) {
	for _, action := range []string{"cancel", "supersede"} {
		t.Run(action, func(t *testing.T) {
			s, _, b, c := setup(t)
			ctx := context.Background()
			actor := application.Actor{ID: "synthetic", Role: "author"}
			chapterID := b.Chapters[0].ID
			save(t, s, chapterID, "林舟来自北港。")
			st, _ := s.load()
			model := s.Config.Info()
			_, e := s.Mutate(ctx, actor, "enable", "enable-one", Mutation{
				BaseVersion:      st.Version,
				Consent:          true,
				Model:            &model,
				DailyTokenBudget: s.reserve(),
				DailyJobBudget:   1,
			})
			if e != nil {
				t.Fatal(e)
			}

			first, e := s.Claim(ctx)
			if e != nil || first == nil {
				t.Fatal("first claim failed", e)
			}
			st, _ = s.load()
			if st.BudgetAttempts != 1 || st.BudgetTokens != s.reserve() || first.Job.AttemptReserve != s.reserve() {
				t.Fatal("first attempt was not conservatively debited", st.BudgetAttempts, st.BudgetTokens, first.Job)
			}

			if action == "cancel" {
				_, e = s.Mutate(ctx, actor, "pause", "cancel", Mutation{BaseVersion: st.Version})
				if e != nil {
					t.Fatal(e)
				}
				st, _ = s.load()
				_, e = s.Mutate(ctx, actor, "resume", "resume", Mutation{BaseVersion: st.Version})
				if e != nil {
					t.Fatal(e)
				}
			} else {
				save(t, s, chapterID, "林舟已经离开北港。")
				if e = s.sync(ctx); e != nil {
					t.Fatal(e)
				}
			}

			_ = s.transaction(ctx, func(st *State) (bool, error) {
				for i, job := range st.Jobs {
					if job.ID == first.Job.ID {
						st.Jobs[i].Deadline = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
						return true, nil
					}
				}
				return false, nil
			})

			replacement := "林舟来自北港。"
			if action == "supersede" {
				replacement = "林舟已经离开北港。"
			}
			c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
				return llm.Response{
					Text:  output("林舟", replacement, replacement, ""),
					Usage: &llm.Usage{InputTokens: 10, OutputTokens: 20},
				}, nil
			}
			process(t, s)
			st, _ = s.load()
			if c.calls.Load() != 1 || st.BudgetAttempts != 1 || st.BudgetTokens != 30 {
				t.Fatal("replacement did not execute on the refunded daily allowance", c.calls.Load(), st.BudgetAttempts, st.BudgetTokens)
			}
			replacementCompleted := false
			for _, job := range st.Jobs {
				if job.ID == first.Job.ID && (job.Lease != "" || job.AttemptReserve != 0 || job.DebitedDay != "") {
					t.Fatal("expired terminal lease was not settled", job)
				}
				if job.ID != first.Job.ID && job.Status == "completed" {
					replacementCompleted = true
				}
			}
			if !replacementCompleted {
				t.Fatal("replacement task did not complete", st.Jobs)
			}
		})
	}
}

func TestSourcedEventLabelNeedNotBeVerbatimAndForeshadowingLevels(t *testing.T) {
	s, _, b, _ := setup(t)
	id := b.Chapters[0].ID
	r := save(t, s, id, "林舟十五岁时离开故乡。铜铃之谜终于解开：阿宁在梁上拉线。")
	st, _ := s.load()
	out := Output{Entities: []CandidateEntity{{Key: "event", Type: "event", Name: "林舟离乡", Aliases: []string{}}, {Key: "mystery", Type: "foreshadowing", Name: "铜铃谜底", Aliases: []string{}}}, Assertions: []CandidateAssertion{{EntityKey: "event", Predicate: "离乡", Text: "十五岁离开故乡", Epistemic: "observation", Kind: "narration", Time: "十五岁时", Quote: "林舟十五岁时离开故乡。"}, {EntityKey: "mystery", Predicate: "explicit_resolution", Text: "阿宁在梁上拉线解释了响声", Epistemic: "observation", Kind: "narration", Quote: "铜铃之谜终于解开：阿宁在梁上拉线。"}}}
	if e := apply(&st, Job{ID: "fixture", ChapterID: id}, r, out); e != nil {
		t.Fatal("sourced AI event label rejected", e)
	}
	for _, a := range st.Assertions {
		if a.Predicate == "explicit_resolution" && a.Epistemic != "observation" {
			t.Fatal("lost explicit resolution distinction")
		}
	}
	out.Entities[0].Type = "character"
	if e := apply(&st, Job{ID: "fixture", ChapterID: id}, r, out); e == nil {
		t.Fatal("invented person name admitted")
	}
}

func TestKnowledgeCommitDoesNotAdoptHarnessOrRewriteDraft(t *testing.T) {
	s, _, b, c := setup(t)
	id := b.Chapters[0].ID
	r := save(t, s, id, "林舟来自北港。")
	path := filepath.Join(s.App.State, "chapter-drafts", compat.Key(s.App.Project), compat.Key(id)+".json")
	before, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	projection, e := s.App.Projection()
	if e != nil {
		t.Fatal(e)
	}
	for i, d := range projection.Chapters {
		if d.StableID != nil && *d.StableID == id {
			projection.Chapters[i].Body = r.Markdown
			projection.Chapters[i].SHA256 = compat.Hash("new imported envelope")
			projection.Chapters[i].Blob = "imported-source"
		}
	}
	s.App.ProjectionProvider = func() (harness.Projection, error) { return projection, nil }
	c.f = func(context.Context, llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	process(t, s)
	after, e := os.ReadFile(path)
	if e != nil || string(before) != string(after) {
		t.Fatal("knowledge adopted or rewrote manuscript revision metadata", e)
	}
	if len(query(t, s).Entities) != 1 {
		t.Fatal("compatible imported revision not analyzed")
	}
}
func TestAttemptUsageAccumulatesRatherThanOverwritingRetryCost(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	enable(t, s)
	attempt := 0
	c.f = func(context.Context, llm.Request) (llm.Response, error) {
		attempt++
		if attempt == 1 {
			return llm.Response{Text: "invalid-json", Usage: &llm.Usage{InputTokens: 10, OutputTokens: 20}}, nil
		}
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", ""), Usage: &llm.Usage{InputTokens: 15, OutputTokens: 25}}, nil
	}
	process(t, s)
	_ = s.transaction(context.Background(), func(st *State) (bool, error) {
		st.Jobs[0].Due = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
		return true, nil
	})
	process(t, s)
	st, _ := s.load()
	j := st.Jobs[0]
	if j.Attempts != 2 || j.Usage == nil || j.Usage.InputTokens != 25 || j.Usage.OutputTokens != 45 || j.UsageIncomplete || st.BudgetTokens != 70 {
		t.Fatal("retry usage lost", j)
	}
}
func TestOversizeLocalFailureMakesNoModelCallOrBudgetCharge(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, strings.Repeat("林舟", 7000))
	enable(t, s)
	process(t, s)
	st, e := s.load()
	if e != nil {
		t.Fatal(e)
	}
	if c.calls.Load() != 0 || st.BudgetAttempts != 0 || st.BudgetTokens != 0 || st.Jobs[0].Status != "failed" || st.Jobs[0].ModelCalls != 0 {
		t.Fatal("local validation charged a model call", st.Jobs, st.BudgetAttempts, st.BudgetTokens)
	}
}
func TestEventOrderingUsesExplicitDatesAndKeepsUnresolvedInNarrativeOrder(t *testing.T) {
	s, _, b, _ := setup(t)
	id := b.Chapters[0].ID
	r := save(t, s, id, "2020-01-03晚宴散场。2020-01-01林舟启程。数日后林舟抵港。")
	st, _ := s.load()
	out := Output{Entities: []CandidateEntity{{Key: "late", Type: "event", Name: "晚宴", Aliases: []string{}}, {Key: "early", Type: "event", Name: "启程", Aliases: []string{}}, {Key: "relative", Type: "event", Name: "抵港", Aliases: []string{}}}, Assertions: []CandidateAssertion{{EntityKey: "late", Predicate: "发生", Text: "晚宴散场", Epistemic: "observation", Kind: "narration", Time: "2020-01-03", Quote: "2020-01-03晚宴散场。"}, {EntityKey: "early", Predicate: "发生", Text: "林舟启程", Epistemic: "observation", Kind: "narration", Time: "2020-01-01", Quote: "2020-01-01林舟启程。"}, {EntityKey: "relative", Predicate: "发生", Text: "林舟抵港", Epistemic: "observation", Kind: "narration", Time: "数日后", Quote: "数日后林舟抵港。"}}}
	if e := apply(&st, Job{ID: "dates", ChapterID: id}, r, out); e != nil {
		t.Fatal(e)
	}
	entities := orderedEntities(st.Entities)
	s.sortEvents(st, entities)
	if entities[0].Name != "启程" || entities[1].Name != "晚宴" || entities[2].Name != "抵港" {
		t.Fatal("fabricated unresolved chronology", entities)
	}
}

func TestDeadEntityIsNotAProvidedOrAcceptedMergeTarget(t *testing.T) {
	s, _, b, _ := setup(t)
	first := b.Chapters[0].ID
	r1 := save(t, s, first, "医师林舟坐诊北港。")
	st, _ := s.load()
	// First chapter establishes one 林舟 (北港医师).
	outA := Output{Entities: []CandidateEntity{{Key: "a", Type: "character", Name: "林舟", Aliases: []string{}, Identity: "北港医师"}}, Assertions: []CandidateAssertion{{EntityKey: "a", Predicate: "身份", Text: "医师", Epistemic: "observation", Kind: "narration", Quote: "医师林舟坐诊北港。"}}}
	if e := apply(&st, Job{ID: "job-a", ChapterID: first}, r1, outA); e != nil {
		t.Fatal(e)
	}
	var deadID string
	for id := range st.Entities {
		deadID = id
	}
	if !liveEntity(&st, deadID) {
		t.Fatal("fresh entity should be live")
	}
	// Simulate the chapter revision that retired every source for this entity.
	for id, a := range st.Assertions {
		for i := range a.Sources {
			a.Sources[i].Validity = "stale"
			a.Sources[i].Retired = true
		}
		a.Status = "stale"
		st.Assertions[id] = a
	}
	if liveEntity(&st, deadID) {
		t.Fatal("retired entity should be dead")
	}

	// A later chapter introduces a different 林舟. The model links the dead
	// entity as its merge target, but the dead entity must not be reused.
	second := "CH-000002"
	// Same name and matching identity would previously merge; only the dead
	// source guard keeps these distinct.
	outB := Output{Entities: []CandidateEntity{{Key: "b", Type: "character", Name: "林舟", Aliases: []string{}, Identity: "北港医师", ExistingID: deadID}}, Assertions: []CandidateAssertion{{EntityKey: "b", Predicate: "身份", Text: "船工", Epistemic: "observation", Kind: "narration", Quote: "江宁船工林舟泊船。"}}}
	r2 := application.StoredRevision{Revision: application.Revision{ID: "draft:b", Hash: compat.Hash("江宁船工林舟泊船。")}, Markdown: "江宁船工林舟泊船。"}
	if e := apply(&st, Job{ID: "job-b", ChapterID: second}, r2, outB); e != nil {
		t.Fatal(e)
	}
	if len(st.Entities) != 2 {
		t.Fatal("distinct 林舟 merged into a dead entity", st.Entities)
	}
	if _, ok := st.Entities[deadID]; !ok {
		t.Fatal("historical dead entity should remain in history")
	}
}

func TestEnableRejectsBudgetBelowOneReserve(t *testing.T) {
	s, _, _, _ := setup(t)
	model := s.Config.Info()
	actor := application.Actor{ID: "synthetic", Role: "author"}
	st, _ := s.load()
	// Just below one conservative reserve must be rejected, not silently
	// enable a book that can never run its first job.
	_, e := s.Mutate(context.Background(), actor, "enable", compat.UUID(), Mutation{BaseVersion: st.Version, Consent: true, Model: &model, DailyTokenBudget: s.reserve() - 1, DailyJobBudget: 20})
	if e == nil || application.AsError(e).Status != 422 {
		t.Fatal("sub-reserve budget accepted", e)
	}
	// Exactly one reserve is the floor.
	_, e = s.Mutate(context.Background(), actor, "enable", compat.UUID(), Mutation{BaseVersion: st.Version, Consent: true, Model: &model, DailyTokenBudget: s.reserve(), DailyJobBudget: 20})
	if e != nil {
		t.Fatal("exact-reserve budget rejected", e)
	}
}

// The Studio shows backfill progress as completed/chapterTotal. The denominator
// must be the chapters that can actually be analysed (non-empty), and a stale
// superseded job must never count as finished work.
func TestViewReportsBackfillProgressFromAnalysableChapters(t *testing.T) {
	s, m, b, c := setup(t)
	a := application.Actor{ID: "synthetic", Role: "author"}
	ctx := context.Background()
	for i := 1; i < 3; i++ {
		var e error
		b, e = m.Mutate(ctx, a, b.ID, fmt.Sprintf("progress-add-%d", i), application.StructureInput{Operation: "chapter", BaseVersion: b.Version})
		if e != nil {
			t.Fatal(e)
		}
	}
	// Two chapters have text; the third stays empty and must not enter the denominator.
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	save(t, s, b.Chapters[1].ID, "林舟来自北港。")
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	if v := query(t, s).View; v.ChapterTotal != 2 || v.Completed != 0 || v.Pending != 2 {
		t.Fatalf("before work: total=%d completed=%d pending=%d", v.ChapterTotal, v.Completed, v.Pending)
	}
	process(t, s)
	if v := query(t, s).View; v.ChapterTotal != 2 || v.Completed != 1 || v.Pending != 1 {
		t.Fatalf("after one job: total=%d completed=%d pending=%d", v.ChapterTotal, v.Completed, v.Pending)
	}
	process(t, s)
	if v := query(t, s).View; v.ChapterTotal != 2 || v.Completed != 2 || v.Pending != 0 {
		t.Fatalf("after all jobs: total=%d completed=%d pending=%d", v.ChapterTotal, v.Completed, v.Pending)
	}
	// Editing a finished chapter supersedes its job: progress must drop, not stay at 2/2.
	save(t, s, b.Chapters[0].ID, "林舟来自北港，又去了江宁。")
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	if v := query(t, s).View; v.Completed != 1 || v.Pending != 1 || v.ChapterTotal != 2 {
		t.Fatalf("after edit: total=%d completed=%d pending=%d", v.ChapterTotal, v.Completed, v.Pending)
	}
}

func TestManagedSyncUsesDraftStampAndDetectsNewRevision(t *testing.T) {
	s, _, b, c := setup(t)
	ctx := context.Background()
	chapterID := b.Chapters[0].ID
	save(t, s, chapterID, "林舟来自北港。")
	c.f = func(context.Context, llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	before, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if before.ScanStamp == "" || len(before.Jobs) != 1 {
		t.Fatalf("initial scan was not persisted: %+v", before)
	}

	draft := filepath.Join(s.App.State, "chapter-drafts", compat.Key(s.App.Project), compat.Key(chapterID)+".json")
	beforeDraft, err := os.Stat(draft)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	afterDraft, err := os.Stat(draft)
	if err != nil || !os.SameFile(beforeDraft, afterDraft) || !beforeDraft.ModTime().Equal(afterDraft.ModTime()) || beforeDraft.Size() != afterDraft.Size() {
		t.Fatalf("unchanged sync touched draft metadata: %v", err)
	}
	after, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if after.Version != before.Version || len(after.Jobs) != 1 {
		t.Fatal("unchanged heads mutated durable knowledge")
	}

	save(t, s, chapterID, "林舟已经离开北港。")
	savedDraft, err := os.Stat(draft)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(beforeDraft, savedDraft) {
		t.Fatal("atomic draft save did not replace the file")
	}
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	after, err = s.load()
	if err != nil {
		t.Fatal(err)
	}
	if after.ScanStamp == before.ScanStamp || len(after.Jobs) != 2 {
		t.Fatalf("new revision did not create a successor job: %+v", after.Jobs)
	}
}

func TestBoundedBackfillContinuesBeyondFirstQueueAfterDrain(t *testing.T) {
	s, _, _, _ := setup(t)
	ctx := context.Background()
	projection, err := s.App.Projection()
	if err != nil {
		t.Fatal(err)
	}
	// Supply a large immutable saved-head set directly. Registry creation and
	// individual Save behavior are covered separately; this tests discovery batches.
	projection.Chapters = nil
	for i := 0; i < MaxQueue+2; i++ {
		id := fmt.Sprintf("CH-%06d", i+1)
		doc := harness.Parse("manuscript/"+id+".md", "# 第一章\n\nID: "+id+"\n\n林舟来自北港。", map[string]string{})
		doc.Metadata["order"] = fmt.Sprint(i + 1)
		projection.Chapters = append(projection.Chapters, doc)
	}
	s.App.ProjectionProvider = func() (harness.Projection, error) { return projection, nil }
	enable(t, s)
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if st.ScanComplete || st.ScanRetryAt != "" || len(st.Jobs) != MaxQueue {
		t.Fatalf("capped scan did not remain discoverable: complete=%v retry=%q jobs=%d", st.ScanComplete, st.ScanRetryAt, len(st.Jobs))
	}
	for i := 0; i < MaxQueue*3/4; i++ {
		st.Jobs[i].Status = "completed"
	}
	if err := s.transaction(ctx, func(current *State) (bool, error) {
		*current = st
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	st, err = s.load()
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Jobs) != len(projection.Chapters) || !st.ScanComplete {
		t.Fatalf("drained batch did not reveal remaining chapters: jobs=%d chapters=%d complete=%v", len(st.Jobs), len(projection.Chapters), st.ScanComplete)
	}
}

func TestUnreadableRevisionDoesNotBlockReadableChapter(t *testing.T) {
	s, _, _, c := setup(t)
	ctx := context.Background()
	projection, err := s.App.Projection()
	if err != nil {
		t.Fatal(err)
	}
	first := projection.Chapters[0]
	firstID := "CH-000001"
	first.StableID = &firstID
	second := first
	secondID := "CH-000002"
	second.StableID = &secondID
	second.Path = "manuscript/CH-000002.md"
	projection.Chapters = []harness.Document{first, second}
	s.App.ProjectionProvider = func() (harness.Projection, error) { return projection, nil }
	good := "CH-000001"
	bad := "CH-000002"
	save(t, s, good, "林舟来自北港。")
	badPath := filepath.Join(s.App.State, "chapter-drafts", compat.Key(s.App.Project), compat.Key(bad)+".json")
	if err := os.MkdirAll(filepath.Dir(badPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badPath, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	c.f = func(context.Context, llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	if err := s.sync(ctx); err != nil {
		t.Fatal(err)
	}
	st, err := s.load()
	if err != nil {
		t.Fatal(err)
	}
	if st.ScanComplete || len(st.Jobs) != 1 || st.Jobs[0].ChapterID != good {
		t.Fatalf("unreadable chapter blocked readable work: %+v", st)
	}
	x := &Executor{Config: s.Config, Client: c, Resolve: func(string) (*application.Service, error) { return s.App, nil }}
	if ready, err := x.Ready(ctx, s.App.Project); err != nil || !ready {
		t.Fatal("runnable readable chapter was not ready")
	}
}

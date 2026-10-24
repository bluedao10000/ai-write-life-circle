package knowledge

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fixtureClient struct {
	f     func(context.Context, llm.Request) (llm.Response, error)
	calls atomic.Int32
}

func (c *fixtureClient) Generate(ctx context.Context, r llm.Request) (llm.Response, error) {
	c.calls.Add(1)
	return c.f(ctx, r)
}
func setup(t *testing.T) (*Service, *application.Management, application.ManagedBook, *fixtureClient) {
	t.Helper()
	a := application.Actor{ID: "synthetic", Role: "author"}
	m := application.NewManagement(&application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}, a.ID)
	b, e := m.Mutate(context.Background(), a, "", "create", application.StructureInput{Operation: "create"})
	if e != nil {
		t.Fatal(e)
	}
	app, e := m.Resolve(a, b.ID)
	if e != nil {
		t.Fatal(e)
	}
	c := &fixtureClient{}
	s := New(app, llm.Config{Provider: "openai-compatible", Model: "fixture", BaseURL: "http://localhost", Timeout: time.Second, MaxContextBytes: 12000, MaxOutputTokens: 2048}, c)
	return s, m, b, c
}
func save(t *testing.T, s *Service, id, text string) application.StoredRevision {
	t.Helper()
	ctx := context.Background()
	c, e := s.App.Source(id)
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.App.Head(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	key := compat.UUID()
	_, e = s.App.Save(ctx, application.Actor{ID: "synthetic", Role: "author"}, id, key, map[string]any{"baseRevisionId": r.ID, "markdown": text}, &key)
	if e != nil {
		t.Fatal(e)
	}
	r, e = s.App.Head(ctx, c)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func enable(t *testing.T, s *Service) {
	t.Helper()
	st, _ := s.load()
	model := s.Config.Info()
	_, e := s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "enable", compat.UUID(), Mutation{BaseVersion: st.Version, Consent: true, Model: &model, DailyTokenBudget: 1000000, DailyJobBudget: 100})
	if e != nil {
		t.Fatal(e)
	}
}
func output(name, quote, text, existing string) string {
	v := Output{[]CandidateEntity{{Key: "p", Type: "character", Name: name, Aliases: []string{}, ExistingID: existing}}, []CandidateAssertion{{EntityKey: "p", Predicate: "经历", Text: text, Epistemic: "observation", Kind: "narration", Quote: quote}}}
	b, _ := json.Marshal(v)
	return string(b)
}
func process(t *testing.T, s *Service) {
	t.Helper()
	if e := s.ProcessOne(context.Background()); e != nil {
		t.Fatal(e)
	}
}
func query(t *testing.T, s *Service) Page {
	t.Helper()
	p, e := s.Query(context.Background(), Query{Limit: 100})
	if e != nil {
		t.Fatal(e)
	}
	return p
}
func TestConsentSaveDedupUpdateAndRecovery(t *testing.T) {
	s, _, b, c := setup(t)
	id := b.Chapters[0].ID
	r := save(t, s, id, "林舟十五岁离开北港。")
	c.f = func(_ context.Context, req llm.Request) (llm.Response, error) {
		var in map[string]any
		_ = json.Unmarshal([]byte(req.Input), &in)
		body := in["targetMarkdown"].(string)
		return llm.Response{Text: output("林舟", body, body, "")}, nil
	}
	process(t, s)
	if c.calls.Load() != 0 {
		t.Fatal("sent without consent")
	}
	enable(t, s)
	process(t, s)
	p := query(t, s)
	if len(p.Entities) != 1 || len(p.Assertions) != 1 || p.Assertions[0].Sources[0].RevisionID != r.ID {
		t.Fatal(p)
	}
	process(t, s)
	if c.calls.Load() != 1 {
		t.Fatal("duplicate extraction")
	}
	save(t, s, id, "林舟十六岁离开北港。")
	p = query(t, s)
	if p.Assertions[0].Status != "stale" {
		t.Fatal("old source falsely current")
	}
	// A reconstructed service resumes solely from durable heads and persisted consent.
	restarted := New(s.App, s.Config, c)
	process(t, restarted)
	p = query(t, restarted)
	current := 0
	for _, a := range p.Assertions {
		if a.Status == "current" {
			current++
			if strings.Contains(a.Text, "十五") {
				t.Fatal("old fact active")
			}
		}
	}
	if current != 1 || len(p.Assertions) != 2 {
		t.Fatal(p)
	}
	var draft application.DraftState
	path := fmt.Sprintf("%s/chapter-drafts/%s/%s.json", s.App.State, compat.Key(s.App.Project), compat.Key(id))
	_, e := storage.Read(path, &draft)
	if e != nil || draft.KnowledgeIntent == nil {
		t.Fatal("no durable revision intent", e)
	}
}
func TestSecondChapterLinkHomonymAndCorrectionPersistence(t *testing.T) {
	s, m, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来自北港。", "来自北港", "")}, nil
	}
	enable(t, s)
	process(t, s)
	entity := query(t, s).Entities[0].ID
	var e error
	b, e = m.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, b.ID, "chapter2", application.StructureInput{Operation: "chapter", BaseVersion: b.Version})
	if e != nil {
		t.Fatal(e)
	}
	id := b.Chapters[1].ID
	save(t, s, id, "林舟来到江宁。")
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "林舟来到江宁。", "来到江宁", entity)}, nil
	}
	process(t, s)
	if len(query(t, s).Entities) != 1 {
		t.Fatal("duplicate character")
	}
	st, _ := s.load()
	_, e = s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "correct", "separate", Mutation{BaseVersion: st.Version, Action: "separate", EntityID: entity, ChapterID: id, Reason: "同名不同人"})
	if e != nil {
		t.Fatal(e)
	}
	process(t, s)
	p := query(t, s)
	active := 0
	for _, ent := range p.Entities {
		if ent.Status != "stale" {
			active++
		}
	}
	if active != 2 {
		t.Fatal("correction ignored", p)
	}
	st, _ = s.load()
	_, e = s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "rebuild", "rebuild", Mutation{BaseVersion: st.Version, ChapterID: id})
	if e != nil {
		t.Fatal(e)
	}
	process(t, s)
	p = query(t, s)
	if len(p.Entities) != 2 {
		t.Fatal("rebuild changed split IDs")
	}
}
func TestStrictEvidenceAndNoPartialCommit(t *testing.T) {
	for _, bad := range []string{`{"entities":[],"assertions":[],"ownerId":"attacker"}`, `{"entities":[],"assertions":[]} {}`, `{"entities":null,"assertions":[]}`} {
		if _, e := Decode(bad); e == nil {
			t.Fatal("accepted", bad)
		}
	}
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟来自北港。")
	enable(t, s)
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: output("林舟", "捏造的引文", "来自南港", "")}, nil
	}
	process(t, s)
	if len(query(t, s).Entities) != 0 {
		t.Fatal("invalid evidence committed")
	}
	// A later invalid alias must not persist earlier valid entities in the same output.
	st, _ := s.load()
	j := st.Jobs[0]
	rev := save(t, s, b.Chapters[0].ID, "林舟来自北港。阿舟并非已公布的别名。")
	out, _ := Decode(output("林舟", "林舟来自北港。", "来自北港", ""))
	out.Entities[0].Aliases = []string{"不存在的别名"}
	copy := st
	if e := apply(&copy, j, rev, out); e == nil {
		t.Fatal("alias accepted")
	}
}

func TestValidationDiscardsOnlyUnsupportedCandidates(t *testing.T) {
	r := application.StoredRevision{
		Revision: application.Revision{ID: "draft:partial", Hash: compat.Hash("林舟来自北港。阿宁来到江宁。")},
		Markdown: "林舟来自北港。阿宁来到江宁。",
	}
	out := Output{
		Entities: []CandidateEntity{
			{Key: "lin", Type: "character", Name: "林舟", Aliases: []string{"阿宁"}},
			{Key: "ning", Type: "character", Name: "阿宁", Aliases: []string{}},
			{Key: "ghost", Type: "character", Name: "鬼影", Aliases: []string{}},
		},
		Assertions: []CandidateAssertion{
			{EntityKey: "lin", Predicate: "称呼", Text: "阿舟是林舟的称呼", Epistemic: "observation", Kind: "narration", Quote: "林舟来自北港。阿宁来到江宁。"},
			{EntityKey: "lin", Predicate: "伪造", Text: "不存在的证据", Epistemic: "observation", Kind: "narration", Quote: "林舟来自南海。"},
			{EntityKey: "ning", Predicate: "去向", Text: "来到江宁", Epistemic: "observation", Kind: "narration", Quote: "阿宁来到江宁。"},
			{EntityKey: "ghost", Predicate: "出现", Text: "无有效引文", Epistemic: "observation", Kind: "narration", Quote: "鬼影出现。"},
		},
	}
	got, discarded := ValidateCandidates(r, out)
	if len(got.Entities) != 2 || len(got.Assertions) != 2 {
		t.Fatalf("unexpected retained candidates: %+v", got)
	}
	if !contains(got.Entities[0].Aliases, "阿宁") || discarded.Aliases != 0 {
		t.Fatal("alias present in evidence was not retained")
	}
	if discarded.Assertions != 2 || discarded.Entities != 1 {
		t.Fatalf("unexpected discard counts: %+v", discarded)
	}
}
func TestLateResponseDoesNotOverrideNewRevisionAndPause(t *testing.T) {
	s, _, b, c := setup(t)
	id := b.Chapters[0].ID
	save(t, s, id, "林舟十五岁。")
	enable(t, s)
	entered := make(chan struct{})
	release := make(chan struct{})
	c.f = func(ctx context.Context, _ llm.Request) (llm.Response, error) {
		close(entered)
		select {
		case <-release:
			return llm.Response{Text: output("林舟", "林舟十五岁。", "十五岁", "")}, nil
		case <-ctx.Done():
			return llm.Response{}, ctx.Err()
		}
	}
	done := make(chan error, 1)
	go func() { done <- s.ProcessOne(context.Background()) }()
	<-entered
	save(t, s, id, "林舟十六岁。")
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if len(query(t, s).Entities) != 0 {
		t.Fatal("late source committed")
	}
	st, _ := s.load()
	_, e := s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "pause", "pause", Mutation{BaseVersion: st.Version})
	if e != nil {
		t.Fatal(e)
	}
	process(t, s)
	if c.calls.Load() != 1 {
		t.Fatal("called while paused")
	}
}
func TestSameRevisionRerunRetiresOmittedFactsAndClaimCorrection(t *testing.T) {
	s, _, b, c := setup(t)
	save(t, s, b.Chapters[0].ID, "林舟说：我来自北港。")
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		out, _ := Decode(output("林舟", "林舟说：我来自北港。", "来自北港", ""))
		out.Assertions[0].Kind = "dialogue"
		v, _ := json.Marshal(out)
		return llm.Response{Text: string(v)}, nil
	}
	enable(t, s)
	process(t, s)
	p := query(t, s)
	if p.Assertions[0].Epistemic != "claim" {
		t.Fatal("dialogue became world fact")
	}
	st, _ := s.load()
	_, e := s.Mutate(context.Background(), application.Actor{ID: "synthetic", Role: "author"}, "rebuild", "again", Mutation{BaseVersion: st.Version})
	if e != nil {
		t.Fatal(e)
	}
	c.f = func(_ context.Context, _ llm.Request) (llm.Response, error) {
		return llm.Response{Text: `{"entities":[],"assertions":[]}`}, nil
	}
	process(t, s)
	if query(t, s).Assertions[0].Status != "stale" {
		t.Fatal("omitted old extraction resurrected")
	}
}

func TestCredentialFreeAPICanEnableAndQueueButCannotExecute(t *testing.T) {
	s, _, b, client := setup(t)
	s.Config.ResponseFormat = "none"
	s.Config.TokenParameter = "max_tokens"
	s.Config.MaxResponseBytes = 256 * 1024
	s.Client = nil
	s.QueueOnly = true
	st, _ := s.load()
	if !s.view(st).Available || s.view(st).WorkerStatus != "offline" {
		t.Fatal("public capability or worker freshness missing")
	}
	enable(t, s)
	save(t, s, b.Chapters[0].ID, "林舟来到北港。")
	if err := s.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	st, _ = s.load()
	if len(st.Jobs) != 1 || st.Jobs[0].Status != "pending" {
		t.Fatal("saved head not durably queued")
	}
	worked, err := s.processOne(context.Background())
	if err != nil || worked || client.calls.Load() != 0 {
		t.Fatal("API executed LLM", err)
	}
}

func TestDeletedManagedBookRejectsLateKnowledgeCommit(t *testing.T) {
	service, m, b, _ := setup(t)
	ctx := context.Background()
	actor := application.Actor{ID: "synthetic", Role: "author"}
	if _, err := m.Delete(ctx, actor, b.ID, "delete", application.DeleteBookInput{BaseVersion: b.Version}); err != nil {
		t.Fatal(err)
	}
	if err := service.transaction(ctx, func(st *State) (bool, error) { return true, nil }); err == nil || application.AsError(err).Status != 404 {
		t.Fatal("late knowledge commit accepted", err)
	}
	if _, err := os.Stat(service.path()); !os.IsNotExist(err) {
		t.Fatal("knowledge state recreated", err)
	}
}

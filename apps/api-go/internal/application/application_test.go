package application

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func fixture(t *testing.T) *Service {
	t.Helper()
	root := t.TempDir()
	if e := os.Mkdir(filepath.Join(root, "manuscript"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(root, "manuscript/CH-001.md"), []byte("# Fixture\nID: CH-001\n\nInitial fixture.\n"), 0600); e != nil {
		t.Fatal(e)
	}
	return &Service{Root: root, State: t.TempDir(), Project: "test/中文"}
}
func payload(base, markdown string) any {
	return map[string]any{"baseRevisionId": base, "markdown": markdown}
}
func stateHead(t *testing.T, s *Service) StoredRevision {
	t.Helper()
	c, e := s.Source("CH-001")
	if e != nil {
		t.Fatal(e)
	}
	h, e := s.Head(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	return h
}
func TestNodeFingerprintGolden(t *testing.T) {
	b, e := os.ReadFile("../testdata/node-golden.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixture struct {
		Fingerprints []struct {
			ID    *string `json:"noteId"`
			Input any     `json:"input"`
			Value string  `json:"value"`
		} `json:"fingerprints"`
	}
	if e = compat.Decode(b, &fixture); e != nil {
		t.Fatal(e)
	}
	for _, c := range fixture.Fingerprints {
		input, ok := noteInput(c.Input, c.ID != nil)
		if !ok || input.Fingerprint(c.ID) != c.Value {
			t.Fatalf("fingerprint differs: %s / %s", input.Fingerprint(c.ID), c.Value)
		}
	}
}
func TestRevisionNoopReplayCASAndAdoption(t *testing.T) {
	s := fixture(t)
	ctx := context.Background()
	a := Actor{"writer", "author"}
	h := stateHead(t, s)
	noopKey := "noop"
	if r, e := s.Save(ctx, a, "CH-001", "noop", payload(h.ID, h.Markdown), &noopKey); e != nil || r.Status != 200 {
		t.Fatal(r, e)
	}
	key := "draft"
	r, e := s.Save(ctx, a, "CH-001", "draft", payload(h.ID, "Draft 😀\r\n\r\n> quote  \r\n"), &key)
	if e != nil || r.Status != 201 {
		t.Fatal(r, e)
	}
	if stale, e := s.Save(ctx, a, "CH-001", "stale", payload(h.ID, "bad"), nil); e == nil || AsError(e).Status != 409 {
		t.Fatal(stale, e)
	}
	s = &Service{Root: s.Root, State: s.State, Project: s.Project}
	again, e := s.Save(ctx, a, "CH-001", "replay", payload(h.ID, "Draft 😀\r\n\r\n> quote  \r\n"), &key)
	if e != nil || again.Revision.ID != r.Revision.ID || again.Status != 200 {
		t.Fatal(again, e)
	}
	// Replay of the successful no-op remains valid even after the head moved.
	if no, e := s.Save(ctx, a, "CH-001", "noop-replay", payload(h.ID, h.Markdown), &noopKey); e != nil || no.Revision.ID != h.ID {
		t.Fatal(no, e)
	}
	source := filepath.Join(s.Root, "manuscript/CH-001.md")
	if e = os.WriteFile(source, []byte("# Fixture\nID: CH-001\n\nDraft 😀\r\n\r\n> quote  \r\n"), 0600); e != nil {
		t.Fatal(e)
	}
	adopted := stateHead(t, s)
	if !strings.HasPrefix(adopted.ID, "source:") || *adopted.Parent != r.Revision.ID {
		t.Fatal(adopted)
	}
	last, e := s.Save(ctx, a, "CH-001", "last", payload(adopted.ID, "Next"), nil)
	if e != nil {
		t.Fatal(e)
	}
	history, e := s.History(ctx, "CH-001")
	if e != nil {
		t.Fatal(e)
	}
	ids := []string{}
	for _, v := range history {
		ids = append(ids, v.ID)
	}
	if !reflect.DeepEqual(ids, []string{last.Revision.ID, adopted.ID, r.Revision.ID, h.ID}) {
		t.Fatal(ids)
	}
	if e = os.WriteFile(source, []byte("# Fixture\nID: CH-001\n\nDivergent source"), 0600); e != nil {
		t.Fatal(e)
	}
	c, _ := s.Source("CH-001")
	if _, e = s.Head(ctx, c); e == nil || AsError(e).Code != "REVISION_CONFLICT" {
		t.Fatal(e)
	}
}
func TestNoteTransactionRestartAndUniquePlan(t *testing.T) {
	s := fixture(t)
	ctx := context.Background()
	a := Actor{"writer", "author"}
	created, e := s.MutateNote(ctx, a, nil, "note", map[string]any{"content": "Idea"})
	if e != nil {
		t.Fatal(e)
	}
	n := created.(Note)
	edit := map[string]any{"content": "Plan", "purpose": "next_writing", "baseVersion": json.Number("1"), "status": "active"}
	saved, e := s.MutateNote(ctx, a, &n.ID, "edit", edit)
	if e != nil {
		t.Fatal(e)
	}
	s = &Service{Root: s.Root, State: s.State, Project: s.Project}
	replay, e := s.MutateNote(ctx, a, &n.ID, "edit", edit)
	if e != nil || !reflect.DeepEqual(saved, replay) {
		t.Fatal(replay, e)
	}
	if _, e = s.MutateNote(ctx, a, &n.ID, "stale", edit); e == nil || AsError(e).Code != "NOTE_VERSION_CONFLICT" {
		t.Fatal(e)
	}
	if _, e = s.MutateNote(ctx, a, nil, "other", map[string]any{"content": "Other", "purpose": "next_writing"}); e == nil || AsError(e).Code != "NEXT_WRITING_EXISTS" {
		t.Fatal(e)
	}
	edit["baseVersion"] = json.Number("2")
	edit["status"] = "archived"
	if _, e = s.MutateNote(ctx, a, &n.ID, "archive", edit); e != nil {
		t.Fatal(e)
	}
	state, e := s.loadNotes()
	if e != nil || len(state.Items) != 1 || len(state.Requests) != 3 || len(state.Audit) != 3 {
		t.Fatalf("transaction inconsistent: %+v %v", state, e)
	}
}
func TestConcurrentWorkspacePatchPreservesFields(t *testing.T) {
	s := fixture(t)
	var wg sync.WaitGroup
	for _, p := range []map[string]any{{"theme": "dark"}, {"lastView": "kb"}, {"layout": map[string]any{"focus": true}}} {
		wg.Add(1)
		go func(p map[string]any) {
			defer wg.Done()
			if _, e := s.PatchWorkspace(context.Background(), Actor{"writer", "author"}, p); e != nil {
				t.Error(e)
			}
		}(p)
	}
	wg.Wait()
	state, e := s.loadWorkspace("writer")
	if e != nil || state["theme"] != "dark" || state["lastView"] != "kb" || state["layout"].(map[string]any)["focus"] != true {
		t.Fatal(state, e)
	}
}
func TestStorageFailureCannotReportSuccess(t *testing.T) {
	s := fixture(t)
	if e := os.Remove(s.State); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(s.State, []byte("blocked"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := s.MutateNote(context.Background(), Actor{"a", "author"}, nil, "note", map[string]any{"content": "Idea"}); e == nil {
		t.Fatal("false note success")
	}
	if _, e := s.Save(context.Background(), Actor{"a", "author"}, "CH-001", "failure", payload("source:unknown", "body"), nil); e == nil || AsError(e).Code != "AUDIT_WRITE_FAILED" {
		t.Fatal(e)
	}
}
func TestRevisionCompletionAuditFailureAndRetry(t *testing.T) {
	s := fixture(t)
	h := stateHead(t, s)
	calls := 0
	s.auditAppend = func(ctx context.Context, path string, v any) error {
		calls++
		if calls == 2 {
			return errors.New("completion audit failed")
		}
		return storage.Append(ctx, path, v)
	}
	key := "retry"
	if _, e := s.Save(context.Background(), Actor{"writer", "author"}, "CH-001", "first", payload(h.ID, "Stored despite failed completion audit"), &key); e == nil || AsError(e).Code != "AUDIT_WRITE_FAILED" {
		t.Fatal(e)
	}
	s.auditAppend = nil
	result, e := s.Save(context.Background(), Actor{"writer", "author"}, "CH-001", "retry", payload(h.ID, "Stored despite failed completion audit"), &key)
	if e != nil || result.Status != 200 || result.Result != "idempotent_replay" {
		t.Fatal(result, e)
	}
}
func TestRevisionHistoryRejectsCycle(t *testing.T) {
	s := fixture(t)
	c, _ := s.Source("CH-001")
	r := sourceRevision(c, pointer(c.SourceRevisionID))
	state := DraftState{SourceHash: c.SourceHash, Source: &r, Revisions: []StoredRevision{}}
	if e := storage.Write(context.Background(), s.draftPath(c), state); e != nil {
		t.Fatal(e)
	}
	if _, e := s.History(context.Background(), c.ID); e == nil {
		t.Fatal("cycle silently accepted")
	}
}
func TestApplicationProcessHelper(t *testing.T) {
	if os.Getenv("WRITER_TEST_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	s := &Service{Root: os.Getenv("WRITER_TEST_ROOT"), State: os.Getenv("WRITER_TEST_STATE"), Project: "test/中文"}
	mode := os.Getenv("WRITER_TEST_MODE")
	var e error
	status := 200
	if mode == "revision" {
		_, e = s.Save(context.Background(), Actor{"writer", "author"}, "CH-001", compat.UUID(), payload(os.Getenv("WRITER_TEST_BASE"), os.Getenv("WRITER_TEST_VALUE")), nil)
		status = 201
	} else {
		_, e = s.MutateNote(context.Background(), Actor{"writer", "author"}, pointer(os.Getenv("WRITER_TEST_NOTE")), os.Getenv("WRITER_TEST_VALUE"), map[string]any{"content": os.Getenv("WRITER_TEST_VALUE"), "baseVersion": json.Number("1"), "status": "active"})
	}
	if e != nil {
		status = AsError(e).Status
	}
	b, _ := json.Marshal(status)
	os.Stdout.Write(b)
	os.Exit(0)
}
func TestCrossProcessOptimisticWrites(t *testing.T) {
	for _, mode := range []string{"revision", "note"} {
		t.Run(mode, func(t *testing.T) {
			s := fixture(t)
			h := stateHead(t, s)
			n, e := s.MutateNote(context.Background(), Actor{"writer", "author"}, nil, "seed", map[string]any{"content": "Initial"})
			if e != nil {
				t.Fatal(e)
			}
			note := n.(Note)
			commands := []*exec.Cmd{}
			for _, value := range []string{"writer-a", "writer-b"} {
				cmd := exec.Command(os.Args[0], "-test.run=^TestApplicationProcessHelper$")
				cmd.Env = append(os.Environ(), "WRITER_TEST_HELPER=1", "WRITER_TEST_ROOT="+s.Root, "WRITER_TEST_STATE="+s.State, "WRITER_TEST_MODE="+mode, "WRITER_TEST_BASE="+h.ID, "WRITER_TEST_NOTE="+note.ID, "WRITER_TEST_VALUE="+value)
				commands = append(commands, cmd)
			}
			results := make(chan int, 2)
			for _, cmd := range commands {
				go func(cmd *exec.Cmd) {
					output, e := cmd.CombinedOutput()
					if e != nil {
						t.Error(e, string(output))
						results <- 0
						return
					}
					var status int
					if e = json.Unmarshal(output, &status); e != nil {
						t.Error(string(output), e)
					}
					results <- status
				}(cmd)
			}
			first, second := <-results, <-results
			want := 201
			if mode == "note" {
				want = 200
			}
			if !((first == want && second == 409) || (first == 409 && second == want)) {
				t.Fatalf("lost CAS protection: %d %d", first, second)
			}
		})
	}
}

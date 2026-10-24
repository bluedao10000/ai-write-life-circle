package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAtomicFailurePreservesPriorState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "value.json")
	ctx := context.Background()
	if e := Write(ctx, path, map[string]int{"version": 1}); e != nil {
		t.Fatal(e)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if e := Write(cancelled, path, map[string]int{"version": 2}); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
	var state map[string]int
	if _, e := Read(path, &state); e != nil || state["version"] != 1 {
		t.Fatal(state, e)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatal("temporary file leaked")
		}
	}
}
func TestLegacyExclusiveLockAndCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.lock")
	if e := os.WriteFile(path, []byte("legacy holder"), 0600); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	called := false
	e := Lock(ctx, path, func() error { called = true; return nil })
	if !errors.Is(e, context.DeadlineExceeded) || called {
		t.Fatal(e, called)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "legacy holder" {
		t.Fatal("removed someone else's lock")
	}
}
func TestCorruptJSONIsNotAnEmptyDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if e := os.WriteFile(path, []byte("{broken"), 0600); e != nil {
		t.Fatal(e)
	}
	var state map[string]any
	if _, e := Read(path, &state); e == nil {
		t.Fatal("corruption treated as empty state")
	}
}

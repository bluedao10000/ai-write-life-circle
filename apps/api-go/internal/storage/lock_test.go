package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLockShortRecoversALockLeftByAnExitedProcess(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "account.json.lock")
	if e := os.WriteFile(path, nil, 0600); e != nil {
		t.Fatal(e)
	}
	old := time.Now().Add(-time.Minute)
	if e := os.Chtimes(path, old, old); e != nil {
		t.Fatal(e)
	}
	ran := false
	if e := LockShort(ctx, 30*time.Second, path, func() error { ran = true; return nil }); e != nil || !ran {
		t.Fatal("stale lock not recovered", e)
	}
	if _, e := os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("lock not released", e)
	}
	// A fresh lock is respected: the waiter times out instead of entering.
	if e := os.WriteFile(path, nil, 0600); e != nil {
		t.Fatal(e)
	}
	short, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if e := LockShort(short, 30*time.Second, path, func() error { t.Fatal("entered a held lock"); return nil }); e == nil {
		t.Fatal("held lock ignored")
	}
}

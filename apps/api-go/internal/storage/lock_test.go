package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLockShortNeverStealsAnOldLock(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "account.json.lock")
	if e := os.WriteFile(path, nil, 0600); e != nil {
		t.Fatal(e)
	}
	old := time.Now().Add(-time.Minute)
	if e := os.Chtimes(path, old, old); e != nil {
		t.Fatal(e)
	}
	shortOld, cancelOld := context.WithTimeout(ctx, 80*time.Millisecond)
	defer cancelOld()
	if e := LockShort(shortOld, time.Millisecond, path, func() error { t.Fatal("entered old lock"); return nil }); e == nil {
		t.Fatal("old lock stolen")
	}
	if info, e := os.Stat(path); e != nil || !info.ModTime().Equal(old) {
		t.Fatal("changed another holder's lock", e)
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

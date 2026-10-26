package storage

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestProcessLockHelper(t *testing.T) {
	path := os.Getenv("PROCESS_LOCK_PATH")
	if path == "" {
		return
	}
	err := ProcessLock(context.Background(), path, func() error {
		if err := os.WriteFile(path+".ready", nil, 0600); err != nil {
			return err
		}
		for {
			time.Sleep(time.Hour)
		}
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestProcessLockSurvivesAgeAndRecoversAfterSIGKILL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ledger.mutex")
	child := exec.Command(os.Args[0], "-test.run=^TestProcessLockHelper$")
	child.Env = append(os.Environ(), "PROCESS_LOCK_PATH="+path)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(path + ".ready"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("holder not ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := ProcessLock(ctx, path, func() error { t.Fatal("stole live lock"); return nil }); err == nil {
		t.Fatal("expected cancellation")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := ProcessLock(ctx2, path, func() error { return nil }); err != nil {
		t.Fatal("dead holder retained lock", err)
	}
}

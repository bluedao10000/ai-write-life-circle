// Package storage coordinates processes using the legacy Node O_EXCL lock protocol.
package storage

import (
	"context"

	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"os"
	"path/filepath"
	"time"
)

func Read(path string, v any) (bool, error) {
	b, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if e = compat.Decode(b, v); e != nil {
		return false, fmt.Errorf("invalid application state %s: %w", path, e)
	}
	return true, nil
}
func Lock(ctx context.Context, path string, fn func() error) error {
	return lock(ctx, path, fn)
}

// LockShort preserves the legacy exclusive-file protocol. File age cannot
// establish that a holder has exited; orphan locks require operator recovery.
func LockShort(ctx context.Context, _ time.Duration, path string, fn func() error) error {
	return Lock(ctx, path, fn)
}

func lock(ctx context.Context, path string, fn func() error) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	for i := 0; i < 300; i++ {
		if e := ctx.Err(); e != nil {
			return e
		}
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e == nil {
			defer func() { _ = f.Close(); _ = os.Remove(path) }()
			return fn()
		}
		if !errors.Is(e, os.ErrExist) {
			return e
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	return errors.New("timed out waiting for application-state lock")
}
func Write(ctx context.Context, path string, v any) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	b, e := compat.Marshal(v, true)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	tmp := path + "." + compat.UUID() + ".tmp"
	f, e := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(tmp)
	if _, e = f.Write(append(b, '\n')); e != nil {
		_ = f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		_ = f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	if e = os.Rename(tmp, path); e != nil {
		return e
	}
	// Rename is the commit point. Directory syncing is best effort on filesystems that don't support it.
	if d, e := os.Open(filepath.Dir(path)); e == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func Append(ctx context.Context, path string, v any) error {
	return Lock(ctx, path+".lock", func() error {
		b, e := compat.Marshal(v, false)
		if e != nil {
			return e
		}
		f, e := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		defer f.Close()
		if _, e = f.Write(append(b, '\n')); e != nil {
			return e
		}
		return f.Sync()
	})
}

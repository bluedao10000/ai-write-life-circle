package executorpolicy

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestDrainSwitchAndPersistentFencing(t *testing.T) {
	ctx := context.Background()
	c := Controller{State: t.TempDir()}
	var epoch uint64
	if e := c.Claim(ctx, "review", "go", func(v uint64) (string, string, error) {
		epoch = v
		return "lease", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano), nil
	}); e != nil {
		t.Fatal(e)
	}
	if e := c.Claim(ctx, "review", "pi", func(uint64) (string, string, error) {
		t.Fatal("wrong owner entered domain transaction")
		return "", "", nil
	}); !errors.Is(e, ErrFenced) {
		t.Fatal(e)
	}
	if e := c.Drain(ctx, "review"); e != nil {
		t.Fatal(e)
	}
	if e := c.Switch(ctx, "review", "pi"); e == nil {
		t.Fatal("live lease switch permitted")
	}
	if e := c.Claim(ctx, "review", "go", func(uint64) (string, string, error) { t.Fatal("draining owner claimed"); return "", "", nil }); !errors.Is(e, ErrFenced) {
		t.Fatal(e)
	}
	// Drain stops new claims, not an existing valid commit.
	if e := c.Guard(ctx, "review", "go", epoch, "lease", true, func() error { return nil }); e != nil {
		t.Fatal(e)
	}
	if e := c.Switch(ctx, "review", "pi"); e != nil {
		t.Fatal(e)
	}
	restarted := Controller{State: c.State}
	if restarted.Valid("review", "go", epoch, "lease") {
		t.Fatal("old process revived")
	}
	called := false
	if e := restarted.Guard(ctx, "review", "go", epoch, "lease", true, func() error { called = true; return nil }); !errors.Is(e, ErrFenced) || called {
		t.Fatal(e)
	}
	if e := restarted.Claim(ctx, "review", "pi", func(v uint64) (string, string, error) {
		if v <= epoch {
			t.Fatal("generation not advanced")
		}
		return "new", time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano), nil
	}); e != nil {
		t.Fatal(e)
	}
	s, _ := c.Read()
	if s.Kinds["knowledge"].Owner != "go" {
		t.Fatal("unrelated domain switched")
	}
}
func TestExpiredLeaseCannotSettleOrPreventSwitch(t *testing.T) {
	ctx := context.Background()
	c := Controller{State: t.TempDir()}
	var epoch uint64
	_ = c.Claim(ctx, "knowledge", "go", func(v uint64) (string, string, error) {
		epoch = v
		return "expired", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano), nil
	})
	if e := c.Guard(ctx, "knowledge", "go", epoch, "expired", true, func() error { t.Fatal("expired commit accepted"); return nil }); !errors.Is(e, ErrFenced) {
		t.Fatal(e)
	}
	_ = c.Drain(ctx, "knowledge")
	if e := c.Switch(ctx, "knowledge", "pi"); e != nil {
		t.Fatal(e)
	}
}

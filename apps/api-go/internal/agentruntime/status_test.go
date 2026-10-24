package agentruntime

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"strings"
	"testing"
	"time"
)

func TestStatusFreshnessCompatibilityAndSecretIsolation(t *testing.T) {
	root := t.TempDir()
	c := llm.Config{Model: "fixture", APIKey: "must-never-persist"}
	if strings.Contains(c.Fingerprint(), c.APIKey) {
		t.Fatal("key fingerprint leak")
	}
	value := Status{Protocol: Protocol, Online: true, Config: c.Fingerprint(), At: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := WriteStatus(context.Background(), root, value); err != nil {
		t.Fatal(err)
	}
	if s := ReadStatus(root, c); !s.Online || !s.Compatible {
		t.Fatal(s)
	}
	c.Model = "changed"
	if s := ReadStatus(root, c); s.Compatible {
		t.Fatal("mixed config accepted")
	}
	value.At = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	WriteStatus(context.Background(), root, value)
	if s := ReadStatus(root, c); s.Online {
		t.Fatal("stale worker reported online")
	}
}

func TestThinkingDoesNotImplyDomainWorkerReadiness(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9999", Model: "fixture"}
	c := executorpolicy.Controller{State: dir}
	_ = c.Drain(ctx, "knowledge")
	if e := c.Switch(ctx, "knowledge", "pi"); e != nil {
		t.Fatal(e)
	}
	at := time.Now().UTC().Format(time.RFC3339Nano)
	p := PiWorkerStatus{Status: Status{Protocol: executorpolicy.Protocol, At: at, Online: true, Config: cfg.Fingerprint()}, Ready: true, Kinds: []string{"review"}, ByKind: map[string]Counts{}}
	if e := storage.Write(ctx, PiStatusPath(dir), p); e != nil {
		t.Fatal(e)
	}
	if ReadExecutionStatus(dir, cfg, "knowledge").Ready {
		t.Fatal("Review-only worker reported Knowledge online")
	}
	if ReadExecutionStatus(dir, cfg, "review").Ready {
		t.Fatal("Pi status bypassed Go ownership")
	}
}

func TestSuccessHeartbeatIsScopedToExecutorKind(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	cfg := llm.Config{Model: "fixture"}
	c := executorpolicy.Controller{State: dir}
	for _, kind := range []string{"review", "knowledge"} {
		if e := c.Drain(ctx, kind); e != nil {
			t.Fatal(e)
		}
		if e := c.Switch(ctx, kind, "pi"); e != nil {
			t.Fatal(e)
		}
	}
	p := PiWorkerStatus{Status: Status{Protocol: executorpolicy.Protocol, At: time.Now().UTC().Format(time.RFC3339Nano), Online: true, Config: cfg.Fingerprint(), LastSuccess: "knowledge-success", SuccessByKind: map[string]string{"review": "review-success", "knowledge": "knowledge-success"}}, Ready: true, Kinds: []string{"review", "knowledge"}}
	if e := storage.Write(ctx, PiStatusPath(dir), p); e != nil {
		t.Fatal(e)
	}
	for kind, want := range p.SuccessByKind {
		if got := ReadExecutionStatus(dir, cfg, kind).LastSuccess; got != want {
			t.Fatalf("%s: %q", kind, got)
		}
	}
}

package agentruntime

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"testing"
	"time"
)

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
	if !ReadExecutionStatus(dir, cfg, "review").Ready {
		t.Fatal("Pi status not surfaced for Pi ownership")
	}
	if e := c.Drain(ctx, "review"); e != nil {
		t.Fatal(e)
	}
	if e := c.Switch(ctx, "review", "disabled"); e != nil {
		t.Fatal(e)
	}
	if ReadExecutionStatus(dir, cfg, "review").Ready {
		t.Fatal("disabled executor reported ready")
	}
}

func TestSuccessHeartbeatIsScopedToExecutorKind(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	cfg := llm.Config{Model: "fixture"}
	c := executorpolicy.Controller{State: dir}
	for _, kind := range []string{"review", "knowledge", "creative", "memory"} {
		if e := c.Drain(ctx, kind); e != nil {
			t.Fatal(e)
		}
		if e := c.Switch(ctx, kind, "pi"); e != nil {
			t.Fatal(e)
		}
	}
	p := PiWorkerStatus{Status: Status{Protocol: executorpolicy.Protocol, At: time.Now().UTC().Format(time.RFC3339Nano), Online: true, Config: cfg.Fingerprint(), LastSuccess: "memory-success", SuccessByKind: map[string]string{"review": "review-success", "knowledge": "knowledge-success", "creative": "creative-success", "memory": "memory-success"}}, Ready: true, Kinds: []string{"review", "knowledge", "creative", "memory"}}
	if e := storage.Write(ctx, PiStatusPath(dir), p); e != nil {
		t.Fatal(e)
	}
	for kind, want := range p.SuccessByKind {
		if got := ReadExecutionStatus(dir, cfg, kind).LastSuccess; got != want {
			t.Fatalf("%s: %q", kind, got)
		}
	}
	unified := ReadUnifiedStatus(dir, cfg)
	if unified.Protocol != executorpolicy.Protocol || len(unified.Executors) != 4 || unified.Executors["creative"].LastSuccess != "creative-success" || unified.Executors["memory"].LastSuccess != "memory-success" {
		t.Fatalf("creative status was not unified: %+v", unified)
	}
}

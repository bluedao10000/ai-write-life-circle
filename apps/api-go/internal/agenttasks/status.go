package agenttasks

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"time"
)

type WorkerHeartbeat struct {
	Instance string   `json:"instance"`
	Version  string   `json:"version"`
	Config   string   `json:"configFingerprint"`
	Kinds    []string `json:"kinds"`
	Active   []string `json:"activeTasks"`
	Ready    bool     `json:"ready"`
}

func (s *Service) WorkerStatus() agentruntime.PiWorkerStatus {
	return agentruntime.ReadPiStatus(s.State, s.Config)
}
func (s *Service) ReportWorker(ctx context.Context, in WorkerHeartbeat) error {
	if in.Config != s.Config.Fingerprint() {
		return application.Fail(409, "AGENT_CONFIG_CHANGED", "Worker capability changed.")
	}
	if len(in.Instance) < 1 || len(in.Instance) > 128 || len(in.Version) < 1 || len(in.Version) > 128 || len(in.Active) > 8 || len(in.Kinds) < 1 || len(in.Kinds) > 2 {
		return application.Fail(422, "VALIDATION_FAILED", "Invalid Worker heartbeat.")
	}
	for _, kind := range in.Kinds {
		if kind != "review" && kind != "knowledge" {
			return application.Fail(422, "VALIDATION_FAILED", "Invalid executor kind.")
		}
	}
	byKind := map[string]agentruntime.Counts{}
	books, e := s.Management.List(s.Actor)
	if e != nil {
		return e
	}
	resolve := func(id string) (*application.Service, error) { return s.Management.Resolve(s.Actor, id) }
	for _, kind := range in.Kinds {
		counts := agentruntime.Counts{}
		for _, book := range books {
			var got agentruntime.Counts
			if kind == "review" {
				got, e = (&review.Executor{Config: s.Config, Resolve: resolve}).Inspect(ctx, book.ID)
			} else {
				got, e = (&knowledge.Executor{Config: s.Config, Resolve: resolve}).Inspect(ctx, book.ID)
			}
			if e != nil {
				continue
			}
			counts.Pending += got.Pending
			counts.Running += got.Running
			counts.Completed += got.Completed
			counts.Failed += got.Failed
			counts.Cancelled += got.Cancelled
			counts.Retried += got.Retried
			counts.Interrupted += got.Interrupted
		}
		byKind[kind] = counts
	}
	registry, e := s.load()
	if e != nil {
		return e
	}
	active := 0
	for _, r := range registry.Tasks {
		if !r.Finished && (executorpolicy.Controller{State: s.State}).Valid(domain(r.Task.Kind), "pi", r.Task.Epoch, r.Task.Lease) {
			active++
		}
	}
	last := ""
	successByKind := map[string]string{}
	for _, record := range registry.Tasks {
		if record.Outcome == "completed" {
			if record.CompletedAt > last {
				last = record.CompletedAt
			}
			kind := domain(record.Task.Kind)
			if record.CompletedAt > successByKind[kind] {
				successByKind[kind] = record.CompletedAt
			}
		}
	}
	status := agentruntime.PiWorkerStatus{Status: agentruntime.Status{SuccessByKind: successByKind, Protocol: Protocol, Version: in.Version, Instance: in.Instance, At: time.Now().UTC().Format(time.RFC3339Nano), Online: in.Ready, Model: s.Config.Info(), Config: in.Config, Active: active, LastSuccess: last}, Ready: in.Ready, Kinds: in.Kinds, ByKind: byKind}
	return storage.Write(ctx, agentruntime.PiStatusPath(s.State), status)
}

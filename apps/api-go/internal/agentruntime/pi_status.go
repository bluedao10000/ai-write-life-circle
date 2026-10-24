package agentruntime

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"time"
)

type PiWorkerStatus struct {
	Status
	Ready  bool              `json:"ready"`
	Kinds  []string          `json:"kinds"`
	ByKind map[string]Counts `json:"byKind"`
}

func PiStatusPath(state string) string { return filepath.Join(state, "agent-runtime/pi-worker.json") }
func ReadPiStatus(state string, c llm.Config) PiWorkerStatus {
	var s PiWorkerStatus
	ok, e := storage.Read(PiStatusPath(state), &s)
	at, parse := time.Parse(time.RFC3339Nano, s.At)
	s.Online = ok && e == nil && parse == nil && time.Since(at) < 5*time.Second && time.Since(at) >= -time.Second && s.Online
	s.Compatible = s.Protocol == executorpolicy.Protocol && s.Config == c.Fingerprint()
	s.Ready = s.Ready && s.Online && s.Compatible
	return s
}

type ExecutionStatus struct {
	Status
	ExecutorKind  string `json:"executorKind"`
	ExecutorOwner string `json:"executorOwner"`
	Epoch         uint64 `json:"executorEpoch"`
	Ready         bool   `json:"ready"`
	Draining      bool   `json:"draining"`
}

func ReadExecutionStatus(state string, c llm.Config, kind string) ExecutionStatus {
	policy, e := (executorpolicy.Controller{State: state}).Read()
	if e != nil {
		return ExecutionStatus{ExecutorKind: kind}
	}
	a := policy.Kinds[kind]
	out := ExecutionStatus{ExecutorKind: kind, ExecutorOwner: a.Owner, Epoch: a.Epoch, Draining: a.Draining}
	if a.Owner == "go" {
		out.Status = ReadStatus(state, c)
		out.LastSuccess = out.SuccessByKind[kind]
		if by, ok := out.ByKind[kind]; ok {
			out.Counts = by
			out.Active = by.Running
		}
		out.Ready = out.Online && out.Compatible && !a.Draining
		return out
	}
	if a.Owner == "pi" {
		p := ReadPiStatus(state, c)
		out.Status = p.Status
		out.LastSuccess = p.SuccessByKind[kind]
		out.Counts = p.ByKind[kind]
		out.Active = out.Counts.Running
		supported := false
		for _, v := range p.Kinds {
			if v == kind {
				supported = true
			}
		}
		out.Online = p.Online && supported
		out.Ready = p.Ready && supported && !a.Draining
	}
	return out
}

type UnifiedStatus struct {
	Status
	Executors map[string]ExecutionStatus `json:"executors"`
}

func ReadUnifiedStatus(state string, c llm.Config) UnifiedStatus {
	r, k := ReadExecutionStatus(state, c, "review"), ReadExecutionStatus(state, c, "knowledge")
	base := r.Status
	if r.ExecutorOwner == "disabled" || (!r.Online && k.Online) {
		base = k.Status
	}
	base.Online = r.Online || k.Online
	base.Compatible = (r.Compatible || r.ExecutorOwner == "disabled") && (k.Compatible || k.ExecutorOwner == "disabled")
	if k.LastSuccess > base.LastSuccess {
		base.LastSuccess = k.LastSuccess
	}
	base.SuccessByKind = map[string]string{}
	for kind, value := range map[string]string{"review": r.LastSuccess, "knowledge": k.LastSuccess} {
		if value != "" {
			base.SuccessByKind[kind] = value
		}
	}
	base.Active = r.Active + k.Active
	base.Counts = Counts{Pending: r.Counts.Pending + k.Counts.Pending, Running: r.Counts.Running + k.Counts.Running, Completed: r.Counts.Completed + k.Counts.Completed, Failed: r.Counts.Failed + k.Counts.Failed, Cancelled: r.Counts.Cancelled + k.Counts.Cancelled, Retried: r.Counts.Retried + k.Counts.Retried, Interrupted: r.Counts.Interrupted + k.Counts.Interrupted}
	return UnifiedStatus{Status: base, Executors: map[string]ExecutionStatus{"review": r, "knowledge": k}}
}

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
	kinds := []string{"review", "knowledge", "creative", "memory"}
	executors := make(map[string]ExecutionStatus, len(kinds))
	base := Status{Protocol: executorpolicy.Protocol}
	for _, kind := range kinds {
		current := ReadExecutionStatus(state, c, kind)
		executors[kind] = current
		if base.At == "" || (current.Online && !base.Online) {
			base = current.Status
		}
	}
	base.Protocol = executorpolicy.Protocol
	base.Online = false
	base.Compatible = true
	base.Active = 0
	base.Counts = Counts{}
	base.SuccessByKind = map[string]string{}
	base.LastSuccess = ""
	for _, kind := range kinds {
		current := executors[kind]
		base.Online = base.Online || current.Online
		if current.ExecutorOwner != "disabled" {
			base.Compatible = base.Compatible && current.Compatible
		}
		base.Active += current.Active
		base.Counts.Pending += current.Counts.Pending
		base.Counts.Running += current.Counts.Running
		base.Counts.Completed += current.Counts.Completed
		base.Counts.Failed += current.Counts.Failed
		base.Counts.Cancelled += current.Counts.Cancelled
		base.Counts.Retried += current.Counts.Retried
		base.Counts.Interrupted += current.Counts.Interrupted
		if current.LastSuccess != "" {
			base.SuccessByKind[kind] = current.LastSuccess
		}
		if current.LastSuccess > base.LastSuccess {
			base.LastSuccess = current.LastSuccess
		}
	}
	return UnifiedStatus{Status: base, Executors: executors}
}

package agentruntime

import (
	"context"
	"path/filepath"
	"runtime/debug"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

const Protocol = "agent-runtime-v1"

type Counts struct {
	LastSuccess string `json:"-"`
	Pending     int    `json:"pending"`
	Running     int    `json:"running"`
	Completed   int    `json:"completed"`
	Failed      int    `json:"failed"`
	Cancelled   int    `json:"cancelled"`
	Retried     int    `json:"retried"`
	Interrupted int    `json:"interrupted"`
}

type Status struct {
	SuccessByKind map[string]string `json:"successByKind,omitempty"`
	ByKind        map[string]Counts `json:"byKind,omitempty"`
	Protocol      string            `json:"protocol"`
	Version       string            `json:"version"`
	Instance      string            `json:"instance"`
	At            string            `json:"at"`
	Online        bool              `json:"online"`
	Compatible    bool              `json:"compatible"`
	Model         llm.ModelInfo     `json:"model"`
	Config        string            `json:"configFingerprint"`
	Active        int               `json:"active"`
	LastSuccess   string            `json:"lastSuccessAt,omitempty"`
	Counts        Counts            `json:"tasks"`
}

type Inspector interface {
	Inspect(context.Context, string) (Counts, error)
}

func StatusPath(state string) string { return filepath.Join(state, "agent-runtime", "worker.json") }
func WriteStatus(ctx context.Context, state string, value Status) error {
	return storage.Write(ctx, StatusPath(state), value)
}
func ReadStatus(state string, c llm.Config) Status {
	var s Status
	ok, err := storage.Read(StatusPath(state), &s)
	if !ok || err != nil {
		return Status{Protocol: Protocol}
	}
	at, err := time.Parse(time.RFC3339Nano, s.At)
	s.Online = err == nil && time.Since(at) < 5*time.Second && time.Since(at) >= -time.Second && s.Online
	s.Compatible = s.Protocol == Protocol && s.Config == c.Fingerprint()
	return s
}

// Revision reports the code embedded by go build, not a deployment label supplied by a client.
func Revision() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return "development"
}

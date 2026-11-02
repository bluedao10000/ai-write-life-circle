package agentruntime

import (
	"context"
	"runtime/debug"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

const APIProtocol = "writer-agent-api-v1"

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

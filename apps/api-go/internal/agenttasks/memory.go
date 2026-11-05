package agenttasks

import (
	"context"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type MemorySourceBinding struct {
	TaskID        string `json:"taskId"`
	ResultVersion string `json:"resultVersion"`
}

func ValidResultVersion(value string) bool {
	if len(value) != len("sha256:")+64 || !strings.HasPrefix(value, "sha256:") {
		return false
	}
	for _, char := range value[len("sha256:"):] {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

type MemoryComparison struct {
	MemoryID      string `json:"memoryId"`
	MemoryVersion int    `json:"memoryVersion"`
}

// PreparedMemory is the durable, bounded execution binding for background
// consolidation. It retains source identities and result versions, not copies
// of manuscript or discussion text.
type PreparedMemory struct {
	Strategy          string                `json:"strategyVersion"`
	Sources           []MemorySourceBinding `json:"sources"`
	Comparisons       []MemoryComparison    `json:"comparisons"`
	ComparisonOmitted int                   `json:"comparisonOmitted"`
	ReservedTokens    int                   `json:"reservedTokens"`
	BudgetDay         string                `json:"budgetDay,omitempty"`
	Request           llm.Request           `json:"request"`
}

type MemoryInspection struct {
	Pending     int `json:"pending"`
	Running     int `json:"running"`
	Completed   int `json:"completed"`
	Failed      int `json:"failed"`
	Cancelled   int `json:"cancelled"`
	Retried     int `json:"retried"`
	Interrupted int `json:"interrupted"`
}

// MemoryCoordinator is implemented outside this package so Agent tasks remain
// the only queue and lease authority while the memory domain retains ownership
// of source validation and candidate publication.
type MemoryCoordinator interface {
	Contract() string
	Prepare(context.Context, *application.Service, []PreparedMemory) (*PreparedMemory, error)
	Start(context.Context, *application.Service, string, *PreparedMemory) error
	Complete(context.Context, *application.Service, string, PreparedMemory, llm.Response, bool, error) error
	Check(context.Context, *application.Service, PreparedMemory) error
	Inspect(context.Context, *application.Service) (MemoryInspection, error)
}

func memoryTaskIDs(value PreparedMemory) []string {
	out := make([]string, 0, len(value.Sources))
	for _, source := range value.Sources {
		out = append(out, source.TaskID)
	}
	return out
}

func (s *Service) InspectMemoryTasks(book string) (MemoryInspection, error) {
	st, err := s.load()
	if err != nil {
		return MemoryInspection{}, err
	}
	out := MemoryInspection{}
	for _, record := range st.Tasks {
		if record.Memory == nil || record.Task.Book != book {
			continue
		}
		switch {
		case record.Outcome == "completed":
			out.Completed++
		case record.Outcome == "interrupted":
			out.Interrupted++
		case record.Outcome == "failed" || record.ResultHash == "expired":
			out.Failed++
		case record.Started:
			out.Running++
		case !record.Finished:
			out.Pending++
		}
	}
	return out, nil
}

package agentruntime

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"log/slog"
	"time"
)

// TaskEvent deliberately excludes source text, prompts, credentials and model output.
func TaskEvent(event, kind, book, id, model string, attempts int, started time.Time, usage *llm.Usage, failure string) {
	input, output := 0, 0
	if usage != nil {
		input = usage.InputTokens
		output = usage.OutputTokens
	}
	duration := int64(0)
	if !started.IsZero() {
		duration = time.Since(started).Milliseconds()
	}
	slog.Info(event, "kind", kind, "bookHash", compat.Hash(book), "jobId", id, "attempts", attempts, "durationMs", duration, "model", model, "inputTokens", input, "outputTokens", output, "failureCode", failure)
}

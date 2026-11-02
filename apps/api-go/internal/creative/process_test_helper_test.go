package creative

import (
	"context"
	"errors"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

// ProcessOne preserves the pre-migration in-process executor for tests.
func (s *Service) ProcessOne(ctx context.Context) (bool, error) {
	c, err := s.Claim(ctx)
	if err != nil || c == nil {
		return false, err
	}
	run, cancel := context.WithTimeout(ctx, s.timeout())
	defer cancel()
	prepared, err := s.Prepare(run, c)
	var response llm.Response
	sent := false
	if err == nil {
		sent = true
		response, err = s.Client.Generate(run, prepared.Request)
	}
	if err != nil && errors.Is(err, context.DeadlineExceeded) {
		err = llm.Fail("LLM_TIMEOUT")
	}
	return true, s.Complete(ctx, prepared, response, sent, err)
}

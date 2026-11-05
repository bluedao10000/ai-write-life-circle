package creative

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func (s *Service) MemoryConsolidationReady(ctx context.Context) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	st, err := s.load()
	if err != nil {
		return false, err
	}
	return s.runnable(st) && st.Settings.AutoMemoryConsolidation, nil
}

// ReserveMemoryAttempt consumes the same per-book background budget as
// conversation organizing. The caller retains the Go points reservation until
// reported usage is known.
func (s *Service) ReserveMemoryAttempt(ctx context.Context, taskID string, reserved int) (string, error) {
	if taskID == "" || len(taskID) > 128 {
		return "", application.Fail(422, "INVALID_MEMORY_TASK", "Memory task identity is required.")
	}
	day := ""
	err := s.transaction(ctx, func(st *State) (bool, error) {
		key := memoryBudgetKey("reserve", taskID)
		fingerprint := compat.Hash(fmt.Sprintf("reserve\x00%s\x00%d", taskID, reserved))
		if prior, ok := st.Requests[key]; ok {
			if prior.Fingerprint != fingerprint {
				return false, application.Fail(409, "MEMORY_BUDGET_CONFLICT", "Memory task budget identity changed.")
			}
			var receipt struct {
				Day string `json:"day"`
			}
			if json.Unmarshal([]byte(prior.Result), &receipt) != nil || receipt.Day == "" {
				return false, application.Fail(500, "CREATIVE_STORAGE_INVALID", "Invalid memory budget receipt.")
			}
			day = receipt.Day
			return false, nil
		}
		if !s.runnable(*st) || !st.Settings.AutoMemoryConsolidation {
			return false, application.Fail(409, "MEMORY_CONSOLIDATION_DISABLED", "Background memory consolidation is disabled.")
		}
		if len(st.Requests) >= 20000 {
			return false, application.Fail(429, "CREATIVE_REQUEST_LIMIT", "Creative request history is full.")
		}
		now := s.now()
		day = now.Format("2006-01-02")
		changed := false
		if st.BudgetDay != day {
			st.BudgetDay, st.BudgetTokens, st.BudgetAttempts = day, 0, 0
			changed = true
		}
		if reserved < 1 || reserved > st.Settings.DailyTokenBudget-st.BudgetTokens || st.BudgetAttempts >= st.Settings.DailyJobBudget {
			return changed, application.Fail(429, "CREATIVE_BUDGET_EXHAUSTED", "Background memory budget is exhausted.")
		}
		st.BudgetTokens += reserved
		st.BudgetAttempts++
		encoded, _ := json.Marshal(map[string]string{"day": day})
		st.Requests[key] = receipt{Fingerprint: fingerprint, Result: string(encoded)}
		return true, nil
	})
	return day, err
}

func (s *Service) SettleMemoryAttempt(ctx context.Context, taskID, day string, reserved int, response llm.Response, sent bool) error {
	if taskID == "" || len(taskID) > 128 || day == "" || reserved < 1 {
		return application.Fail(422, "INVALID_MEMORY_TASK", "Memory task settlement identity is required.")
	}
	return s.transaction(ctx, func(st *State) (bool, error) {
		if _, ok := st.Requests[memoryBudgetKey("reserve", taskID)]; !ok {
			return false, application.Fail(409, "MEMORY_BUDGET_CONFLICT", "Memory task reservation is unavailable.")
		}
		key := memoryBudgetKey("settle", taskID)
		identity := struct {
			TaskID   string `json:"taskId"`
			Day      string `json:"day"`
			Reserved int    `json:"reserved"`
		}{taskID, day, reserved}
		raw, _ := json.Marshal(identity)
		fingerprint := compat.Hash(string(raw))
		if prior, ok := st.Requests[key]; ok {
			if prior.Fingerprint != fingerprint {
				return false, application.Fail(409, "MEMORY_BUDGET_CONFLICT", "Memory task settlement changed.")
			}
			// The first terminal report owns settlement. Worker retries may
			// report a different action or usage after a lost acknowledgement;
			// neither can rewrite the budget already committed here.
			return false, nil
		}
		if st.BudgetDay != day {
			st.Requests[key] = receipt{Fingerprint: fingerprint}
			return true, nil
		}
		if !sent {
			st.BudgetTokens = max(0, st.BudgetTokens-reserved)
			st.BudgetAttempts = max(0, st.BudgetAttempts-1)
		} else if response.Usage != nil {
			actual := response.Usage.InputTokens + response.Usage.OutputTokens
			st.BudgetTokens = max(0, st.BudgetTokens+actual-reserved)
		}
		// Unknown usage retains the full reservation. The receipt still makes
		// a duplicate completion idempotent.
		st.Requests[key] = receipt{Fingerprint: fingerprint}
		return true, nil
	})
}

func memoryBudgetKey(action, taskID string) string {
	return compat.Hash("memory-budget\x00" + action + "\x00" + taskID)
}

func MemoryMeterOperation(taskID string) string {
	return fmt.Sprintf("memory-consolidation:%s", taskID)
}

package review

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
)

const FreeReviewPolicy = "free-review-v1"
const freeContextBytes = 64 * 1024
const freeOutputTokens = 32768

type Cost struct {
	Policy          string `json:"policy"`
	MaxOutputTokens int    `json:"maxOutputTokens"`
	ReservedPoints  int    `json:"reservedPoints"`
}

func (s *Service) freeAuthor(ctx context.Context) (bool, error) {
	if s.App.Meter == nil || s.App.Owner == "" {
		return false, nil
	}
	rights, e := s.App.Meter.Entitlements(ctx, s.App.Owner)
	return rights.Plan == "free", e
}
func (s *Service) planReserve(p Plan) int {
	if p.Cost != nil {
		return p.Cost.ReservedPoints
	}
	return s.reservePoints()
}
func (s *Service) validateCost(p Plan) bool {
	if p.Cost == nil {
		return true
	}
	return p.Cost.Policy == FreeReviewPolicy && p.BudgetBytes == min(s.Config.MaxContextBytes, freeContextBytes) && p.ContextBytes <= p.BudgetBytes && p.Cost.MaxOutputTokens == min(s.Config.MaxOutputTokens, freeOutputTokens) && p.Cost.ReservedPoints == billing.PointsFor(p.BudgetBytes+20000, p.Cost.MaxOutputTokens)
}

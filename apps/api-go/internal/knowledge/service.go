package knowledge

import (
	"context"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"time"
)

type Service struct {
	ExecutorOwner string
	claimEpoch    uint64
	App           *application.Service
	Config        llm.Config
	Client        llm.Client
	QuietPeriod   time.Duration
	QueueOnly     bool
}

func New(app *application.Service, c llm.Config, client llm.Client) *Service {
	return &Service{App: app, Config: c, Client: client}
}
func (s *Service) contextLimit() int {
	if s.Config.MaxContextBytes > 0 {
		return s.Config.MaxContextBytes
	}
	return 64 * 1024
}

// reserve is the conservative per-attempt token debit: an upper bound of one
// extraction's input plus model output. The daily budget must cover at least
// one reserve, otherwise a freshly enabled book can never process its first
// chapter.
func (s *Service) reserve() int {
	return s.contextLimit() + 20000 + max(s.Config.MaxOutputTokens, 2048)
}
func (s *Service) Mutate(ctx context.Context, a application.Actor, action, key string, in Mutation) (View, error) {
	if a.Role != "author" {
		return View{}, application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author may change knowledge settings.")
	}
	if in.BaseVersion < 0 {
		return View{}, application.Fail(422, "VALIDATION_FAILED", "baseVersion must be nonnegative.")
	}
	if action == "rebuild" && in.ChapterID != "" {
		if _, e := s.App.Source(in.ChapterID); e != nil {
			return View{}, e
		}
	}
	if !application.SafeKey(key) {
		return View{}, application.Fail(422, "VALIDATION_FAILED", "Idempotency-Key required.")
	}
	raw, _ := json.Marshal(struct {
		Actor, Action string
		Input         Mutation
	}{a.ID, action, in})
	fp := compat.Hash(string(raw))
	var result View
	e := s.transaction(ctx, func(st *State) (bool, error) {
		if prior, ok := st.Requests[key]; ok {
			if prior.Fingerprint != fp {
				return false, application.Fail(422, "IDEMPOTENCY_KEY_REUSED", "Key reused for a different operation.")
			}
			result = s.view(*st)
			return false, nil
		}
		if in.BaseVersion != st.Version {
			return false, application.Fail(409, "KNOWLEDGE_CONFLICT", "Knowledge changed. Reload and retry.")
		}
		if len(st.Requests) >= 10000 {
			return false, application.Fail(429, "KNOWLEDGE_REQUEST_LIMIT", "Knowledge mutation history is full.")
		}
		now := compat.Now()
		recent := []string{}
		for _, at := range st.MutationTimes {
			parsed, _ := time.Parse(time.RFC3339Nano, at)
			if time.Since(parsed) < time.Minute {
				recent = append(recent, at)
			}
		}
		if len(recent) >= 20 {
			return false, application.Fail(429, "KNOWLEDGE_RATE_LIMIT", "Too many knowledge actions. Try again shortly.")
		}
		st.MutationTimes = append(recent, now)
		switch action {
		case "enable":
			if !in.Consent || in.Model == nil || *in.Model != s.Config.Info() {
				return false, application.Fail(422, "KNOWLEDGE_CONSENT_REQUIRED", "Confirm the displayed provider, model and disclosed scope.")
			}
			if s.Client == nil && (!s.QueueOnly || s.Config.ValidatePublic() != nil) {
				return false, application.Fail(503, "LLM_NOT_CONFIGURED", "Model not configured.")
			}
			if in.DailyTokenBudget < s.reserve() || in.DailyTokenBudget > 100000000 || in.DailyJobBudget < 1 || in.DailyJobBudget > 1000 {
				return false, application.Fail(422, "VALIDATION_FAILED", "Set a daily token budget that covers at least one reserved extraction, and bounded daily job budgets.")
			}
			st.Settings = Settings{Enabled: true, Paused: false, ConsentAt: now, Model: *in.Model, DailyTokenBudget: in.DailyTokenBudget, DailyJobBudget: in.DailyJobBudget, ConfigFingerprint: s.Config.Fingerprint()}
			st.ScanStamp = ""
			st.ScanComplete = false
			st.ScanRetryAt = ""
		case "pause":
			st.Settings.Paused = true
		case "resume":
			if !st.Settings.Enabled || st.Settings.Model != s.Config.Info() {
				return false, application.Fail(422, "KNOWLEDGE_CONSENT_REQUIRED", "Enable with the current model disclosure first.")
			}
			if st.Settings.ConfigFingerprint != "" && st.Settings.ConfigFingerprint != s.Config.Fingerprint() {
				return false, application.Fail(422, "KNOWLEDGE_CONSENT_REQUIRED", "The model capability changed. Confirm the current disclosure.")
			}
			st.Settings.Paused = false
			st.ScanStamp = ""
			st.ScanComplete = false
			st.ScanRetryAt = ""
		case "rebuild":
			if !st.Settings.Enabled {
				return false, application.Fail(422, "KNOWLEDGE_CONSENT_REQUIRED", "Enable knowledge maintenance first.")
			}
			for i, j := range st.Jobs {
				if in.ChapterID == "" || j.ChapterID == in.ChapterID {
					if j.Status == "completed" || j.Status == "failed" || j.Status == "running" {
						st.Jobs[i].Status = "superseded"
					}
				}
			}
			st.ScanStamp = ""
			st.ScanComplete = false
			st.ScanRetryAt = ""
			st.Changes = append(st.Changes, Change{compat.UUID(), now, "reanalysis_requested", in.ChapterID, "", ""})
		case "correct":
			if !short(in.Reason, 1000) {
				return false, application.Fail(422, "VALIDATION_FAILED", "A short correction explanation is required.")
			}
			switch in.Action {
			case "claim", "dispute":
				if _, ok := st.Assertions[in.AssertionID]; !ok {
					return false, application.Fail(404, "NOT_FOUND", "Assertion not found.")
				}
			case "separate":
				if _, ok := st.Entities[in.EntityID]; !ok || in.ChapterID == "" {
					return false, application.Fail(422, "VALIDATION_FAILED", "Choose an entity and a source chapter to separate.")
				}
			default:
				return false, application.Fail(422, "VALIDATION_FAILED", "Unknown correction.")
			}
			fix := Correction{ID: compat.UUID(), EntityID: in.EntityID, AssertionID: in.AssertionID, ChapterID: in.ChapterID, Action: in.Action, Reason: in.Reason, ActorID: a.ID, Active: true, Version: 1, CreatedAt: now}
			if assertion, ok := st.Assertions[in.AssertionID]; ok {
				fix.EntityID = assertion.EntityID
				for _, src := range assertion.Sources {
					if !src.Retired {
						fix.AnchorQuote = src.Quote
						fix.ChapterID = src.ChapterID
						break
					}
				}
			}
			st.Corrections = append(st.Corrections, fix)
			if in.Action == "separate" {
				supported := false
				for _, a := range st.Assertions {
					if a.EntityID == in.EntityID {
						for _, src := range a.Sources {
							if src.ChapterID == in.ChapterID {
								supported = true
							}
						}
					}
				}
				if !supported {
					return false, application.Fail(422, "VALIDATION_FAILED", "Choose a chapter that supports this entity.")
				}
				for i, j := range st.Jobs {
					if j.ChapterID == in.ChapterID {
						st.Jobs[i].Status = "superseded"
					}
				}
				st.ScanStamp = ""
				st.ScanComplete = false
				st.ScanRetryAt = ""
			}
		case "undo":
			found := false
			for i, c := range st.Corrections {
				if c.ID == in.CorrectionID {
					st.Corrections[i].Active = false
					st.Corrections[i].Version++
					found = true
				}
			}
			if !found {
				return false, application.Fail(404, "NOT_FOUND", "Correction not found.")
			}
		default:
			return false, application.Fail(404, "NOT_FOUND", "Unknown knowledge operation.")
		}
		if st.Settings.Paused {
			for i, j := range st.Jobs {
				if j.Status == "running" {
					st.Jobs[i].Status = "cancelled"
				}
			}
		}
		st.Requests[key] = receipt{fp, st.Version + 1}
		st.Version++
		result = s.view(*st)
		st.Version--
		return true, nil
	})
	return result, e
}

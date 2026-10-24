package creative

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type SettingsInput struct {
	Consent          bool           `json:"consent,omitempty"`
	Model            *llm.ModelInfo `json:"model,omitempty"`
	DailyTokenBudget int            `json:"dailyTokenBudget,omitempty"`
	DailyJobBudget   int            `json:"dailyJobBudget,omitempty"`
	AutoOrganize     *bool          `json:"autoOrganize,omitempty"`
}

func (s *Service) contextLimit() int {
	if s.Config.MaxContextBytes > 0 {
		return s.Config.MaxContextBytes
	}
	return 64 * 1024
}

func (s *Service) outputLimit() int {
	if s.Config.MaxOutputTokens > 0 {
		return s.Config.MaxOutputTokens
	}
	return 4096
}

// reserve is the conservative per-attempt token debit (input upper bound plus
// output limit plus fixed overhead), mirroring knowledge maintenance.
func (s *Service) reserve() int { return s.contextLimit() + s.outputLimit() + 8192 }

func consentRequired(detail string) error {
	return application.Fail(422, "CREATIVE_CONSENT_REQUIRED", detail)
}

// Configure is the only path that changes model consent. Enabling requires the
// author to confirm exactly the model the server will use.
func (s *Service) Configure(ctx context.Context, a application.Actor, action, key string, in SettingsInput) (SettingsView, error) {
	var out SettingsView
	switch action {
	case "enable", "pause", "resume", "auto":
	default:
		return out, application.Fail(404, "NOT_FOUND", "Unknown creative setting action.")
	}
	e := s.idempotent(ctx, a, "settings."+action, key, in, &out, func(st *State) error {
		now := s.stamp()
		switch action {
		case "enable":
			if !in.Consent || in.Model == nil || *in.Model != s.Config.Info() {
				return consentRequired("Confirm the displayed provider, model and disclosed scope.")
			}
			if s.Config.ValidatePublic() != nil {
				return application.Fail(503, "LLM_NOT_CONFIGURED", "Model not configured.")
			}
			if in.DailyTokenBudget < s.reserve() || in.DailyTokenBudget > 100000000 || in.DailyJobBudget < 1 || in.DailyJobBudget > 1000 {
				return validation("Set a daily token budget that covers at least one reserved call, and a bounded daily job budget.")
			}
			auto := true
			if in.AutoOrganize != nil {
				auto = *in.AutoOrganize
			}
			st.Settings = Settings{Enabled: true, AutoOrganize: auto, ConsentAt: now, Model: *in.Model, ConfigFingerprint: s.Config.Fingerprint(), DailyTokenBudget: in.DailyTokenBudget, DailyJobBudget: in.DailyJobBudget}
		case "pause":
			st.Settings.Paused = true
			for i, j := range st.Jobs {
				if j.Status == "running" {
					st.Jobs[i].Status = "retry"
					st.Jobs[i].Failure = "CREATIVE_PAUSED"
					st.Jobs[i].Lease = ""
				}
			}
		case "resume":
			if !st.Settings.Enabled || st.Settings.Model != s.Config.Info() || (st.Settings.ConfigFingerprint != "" && st.Settings.ConfigFingerprint != s.Config.Fingerprint()) {
				return consentRequired("The model changed. Confirm the current disclosure.")
			}
			st.Settings.Paused = false
		case "auto":
			if in.AutoOrganize == nil {
				return validation("autoOrganize is required.")
			}
			st.Settings.AutoOrganize = *in.AutoOrganize
		}
		out = s.settingsView(*st)
		return nil
	})
	return out, e
}

func (s *Service) runnable(st State) bool {
	return st.Settings.Enabled && !st.Settings.Paused && st.Settings.Model == s.Config.Info() && (st.Settings.ConfigFingerprint == "" || st.Settings.ConfigFingerprint == s.Config.Fingerprint())
}

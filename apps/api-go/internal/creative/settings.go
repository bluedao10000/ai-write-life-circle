package creative

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type SettingsInput struct {
	DialogueRecording   *bool          `json:"dialogueRecording,omitempty"`
	Consent             bool           `json:"consent,omitempty"`
	Model               *llm.ModelInfo `json:"model,omitempty"`
	DailyTokenBudget    int            `json:"dailyTokenBudget,omitempty"`
	DailyJobBudget      int            `json:"dailyJobBudget,omitempty"`
	AutoOrganize        *bool          `json:"autoOrganize,omitempty"`
	MultiAgentPlanCheck *bool          `json:"multiAgentPlanCheck,omitempty"`
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

// Configure changes organizing preferences and the selected model.
func (s *Service) Configure(ctx context.Context, a application.Actor, action, key string, in SettingsInput) (SettingsView, error) {
	var out SettingsView
	switch action {
	case "enable", "pause", "resume", "auto", "recording", "orchestration":
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
			if in.DailyTokenBudget == 0 {
				in.DailyTokenBudget = 100000000
			}
			if in.DailyJobBudget == 0 {
				in.DailyJobBudget = 200
			}
			multiAgent := st.Settings.MultiAgentPlanCheck
			if in.MultiAgentPlanCheck != nil {
				multiAgent = *in.MultiAgentPlanCheck
			}
			minimum := s.reserve()
			if multiAgent {
				minimum *= PlanCheckModelCalls
			}
			if in.DailyTokenBudget < minimum || in.DailyTokenBudget > 100000000 || in.DailyJobBudget < 1 || in.DailyJobBudget > 1000 {
				return validation("Set a daily token budget that covers at least one reserved call, and a bounded daily job budget.")
			}
			auto := true
			if in.AutoOrganize != nil {
				auto = *in.AutoOrganize
			}
			st.Settings = Settings{DialogueRecording: st.Settings.DialogueRecording, Enabled: true, AutoOrganize: auto, MultiAgentPlanCheck: multiAgent, ConsentAt: now, Model: *in.Model, ConfigFingerprint: s.Config.Fingerprint(), DailyTokenBudget: in.DailyTokenBudget, DailyJobBudget: in.DailyJobBudget}
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
			if !st.Settings.Enabled || st.Settings.Model != s.Config.Info() {
				return consentRequired("The model changed. Confirm the current disclosure.")
			}
			st.Settings.Paused = false
		case "recording":
			if in.DialogueRecording == nil {
				return validation("dialogueRecording is required.")
			}
			st.Settings.DialogueRecording = *in.DialogueRecording
		case "auto":
			if in.AutoOrganize == nil {
				return validation("autoOrganize is required.")
			}
			st.Settings.AutoOrganize = *in.AutoOrganize
		case "orchestration":
			if in.MultiAgentPlanCheck == nil {
				return validation("multiAgentPlanCheck is required.")
			}
			if *in.MultiAgentPlanCheck && st.Settings.DailyTokenBudget < s.reserve()*PlanCheckModelCalls {
				return validation("The daily token budget must cover one read-only plan review before enabling multi-agent comparison.")
			}
			st.Settings.MultiAgentPlanCheck = *in.MultiAgentPlanCheck
		}
		out = s.settingsView(*st)
		return nil
	})
	return out, e
}

func (s *Service) runnable(st State) bool {
	return st.Settings.Enabled && !st.Settings.Paused && st.Settings.Model == s.Config.Info()
}

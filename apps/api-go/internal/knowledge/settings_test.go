package knowledge

import (
	"context"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestDefaultKnowledgeAndPausedPreferences(t *testing.T) {
	s, _, _, c := setup(t)
	s.Config.ResponseFormat = "none"
	s.Config.TokenParameter = "max_tokens"
	s.Config.MaxResponseBytes = 256 * 1024
	ctx := context.Background()
	actor := application.Actor{ID: "synthetic", Role: "author"}
	st, err := s.load()
	if err != nil || !s.maintenanceEligible(st) || st.Settings.DailyTokenBudget != 100000000 || st.Settings.DailyJobBudget != 200 {
		t.Fatal("unexpected knowledge defaults", st.Settings, err)
	}
	if _, err = s.Mutate(ctx, actor, "pause", compat.UUID(), Mutation{BaseVersion: st.Version}); err != nil {
		t.Fatal(err)
	}
	restarted := New(s.App, s.Config, c)
	st, err = restarted.load()
	if err != nil || !st.Settings.Paused || restarted.maintenanceEligible(st) {
		t.Fatal("pause was not retained", err)
	}
	model := restarted.Config.Info()
	v, err := restarted.Mutate(ctx, actor, "enable", compat.UUID(), Mutation{BaseVersion: st.Version, Consent: true, Model: &model})
	if err != nil || !v.Settings.Enabled || v.Settings.Paused || v.Settings.DailyTokenBudget != 100000000 || v.Settings.DailyJobBudget != 200 {
		t.Fatal("enable did not use system quotas", v.Settings, err)
	}
	unconfigured, _, _, _ := setup(t)
	unconfigured.Config = llm.Config{}
	st, err = unconfigured.load()
	if err != nil || st.Settings.Enabled {
		t.Fatal("unconfigured model enabled knowledge", err)
	}
}

func TestKnowledgeKeepsModelConsentAcrossRuntimeSettings(t *testing.T) {
	s, _, _, _ := setup(t)
	enable(t, s)
	ctx := context.Background()
	if err := s.transaction(ctx, func(st *State) (bool, error) {
		st.Settings.ConfigFingerprint = "previous-full-config"
		st.Settings.Paused = true
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	s.Config.MaxOutputTokens *= 2
	s.Config.MaxContextBytes *= 2
	s.Config.Timeout += time.Second
	st, _ := s.load()
	v, err := s.Mutate(ctx, application.Actor{ID: "synthetic", Role: "author"}, "resume", compat.UUID(), Mutation{BaseVersion: st.Version})
	if err != nil || v.NeedsModelConsent {
		t.Fatal("runtime settings invalidated consent", err)
	}
	st, err = s.load()
	if err != nil || !s.maintenanceEligible(st) {
		t.Fatal("runtime settings blocked knowledge", err)
	}
	s.Config.Model = "new-model"
	if s.maintenanceEligible(st) || !s.view(st).NeedsModelConsent {
		t.Fatal("new model did not require a new choice")
	}
}

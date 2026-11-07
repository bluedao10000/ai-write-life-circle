package creative

import (
	"context"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestDefaultOrganizingAndPausedPreferences(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	st, err := f.s.load()
	if err != nil {
		t.Fatal(err)
	}
	if !f.s.runnable(st) || !st.Settings.AutoOrganize || st.Settings.MultiAgentPlanCheck || st.Settings.DailyTokenBudget != 100000000 || st.Settings.DailyJobBudget != 200 {
		t.Fatalf("unexpected defaults: %+v", st.Settings)
	}
	if _, err = f.s.Configure(ctx, author, "pause", compat.UUID(), SettingsInput{}); err != nil {
		t.Fatal(err)
	}
	restarted := New(f.s.App, f.s.Config, f.client)
	st, err = restarted.load()
	if err != nil || !st.Settings.Paused || restarted.runnable(st) {
		t.Fatal("pause was not retained", err)
	}
	model := restarted.Config.Info()
	v, err := restarted.Configure(ctx, author, "enable", compat.UUID(), SettingsInput{Consent: true, Model: &model})
	if err != nil || !v.Enabled || v.Paused || v.DailyTokenBudget != 100000000 || v.DailyJobBudget != 200 {
		t.Fatal("enable did not use system quotas", v, err)
	}
	unconfigured := setup(t)
	unconfigured.s.Config = llm.Config{}
	st, err = unconfigured.s.load()
	if err != nil || st.Settings.Enabled {
		t.Fatal("unconfigured model enabled organizing", err)
	}
}

func TestReadonlyPlanPilotRequiresMeaningfulBudgetAndPersists(t *testing.T) {
	f := setup(t)
	f.enable()
	ctx := context.Background()
	if err := f.s.transaction(ctx, func(st *State) (bool, error) {
		st.Settings.DailyTokenBudget = f.s.reserve() - 1
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	on := true
	if _, err := f.s.Configure(ctx, author, "orchestration", compat.UUID(), SettingsInput{MultiAgentPlanCheck: &on}); err == nil {
		t.Fatal("multi-agent mode accepted a budget below one parent reservation")
	}
	if err := f.s.transaction(ctx, func(st *State) (bool, error) {
		st.Settings.DailyTokenBudget = f.s.reserve()
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	view, err := f.s.Configure(ctx, author, "orchestration", compat.UUID(), SettingsInput{MultiAgentPlanCheck: &on})
	if err != nil || !view.MultiAgentPlanCheck || view.ReserveTokens != f.s.reserve() {
		t.Fatalf("enable readonly plan pilot: %+v %v", view, err)
	}
	restarted := New(f.s.App, f.s.Config, nil)
	st, err := restarted.load()
	if err != nil || !st.Settings.MultiAgentPlanCheck {
		t.Fatal("readonly plan pilot setting was not retained", err)
	}
}

func TestOrganizingKeepsModelConsentAcrossRuntimeSettings(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	if err := f.s.transaction(ctx, func(st *State) (bool, error) {
		st.Settings.ConfigFingerprint = "previous-full-config"
		st.Settings.Paused = true
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	f.s.Config.MaxOutputTokens *= 2
	f.s.Config.MaxContextBytes *= 2
	f.s.Config.Timeout += time.Second
	v, err := f.s.Configure(ctx, author, "resume", compat.UUID(), SettingsInput{})
	if err != nil || v.NeedsModelConsent {
		t.Fatal("runtime settings invalidated consent", err)
	}
	st, err := f.s.load()
	if err != nil || !f.s.runnable(st) {
		t.Fatal("runtime settings blocked organizing", err)
	}
	f.s.Config.Model = "new-model"
	if f.s.runnable(st) || !f.s.settingsView(st).NeedsModelConsent {
		t.Fatal("new model did not require a new choice")
	}
}

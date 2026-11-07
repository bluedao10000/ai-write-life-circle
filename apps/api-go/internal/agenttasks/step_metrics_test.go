package agenttasks

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func TestStepMetricsAreDerivedFromAdmissionsAndTerminalResults(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	role := func(parent string, index int) ModelStepReceipt {
		return ModelStepReceipt{ModelStep: ModelStep{
			Role: modelStepRoles[index], CallIndex: index + 1, ParentTaskID: parent, MaxTokens: 100,
		}, At: "2026-11-06T00:00:00Z"}
	}
	usage := func(input, output int) *llm.Usage {
		return &llm.Usage{InputTokens: input, OutputTokens: output}
	}
	const firstID, secondID = "00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012"
	records := map[string]Record{
		firstID: {
			Task:        Task{ID: firstID, Book: "book", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
			Creative:    &creative.PreparedJob{},
			ModelSteps:  []ModelStepReceipt{role(firstID, 0), role(firstID, 1)},
			StepResults: []llm.StepResult{{CallIndex: 1, Status: "completed", DurationMs: 10, Usage: usage(10, 2)}, {CallIndex: 2, Status: "completed", DurationMs: 30, Usage: usage(20, 4)}},
			Audit:       []ExecutionAudit{{Action: "claimed", At: "2026-11-06T00:00:00Z"}, {Action: "started", At: "2026-11-06T00:00:01Z"}, {Action: "terminal", At: "2026-11-06T00:00:03Z"}},
			Outcome:     "completed",
			Finished:    true,
		},
		secondID: {
			Task:        Task{ID: secondID, Book: "book", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
			Creative:    &creative.PreparedJob{},
			ModelSteps:  []ModelStepReceipt{role(secondID, 0)},
			StepResults: []llm.StepResult{{CallIndex: 1, Status: "failed", DurationMs: 20, Usage: nil}},
			Audit:       []ExecutionAudit{{Action: "claimed", At: "2026-11-06T00:00:00Z"}, {Action: "started", At: "2026-11-06T00:00:02Z"}, {Action: "terminal", At: "2026-11-06T00:00:06Z"}},
			Outcome:     "failed",
			Finished:    true,
		},
	}
	if err := s.transaction(ctx, func(st *Registry) error {
		for id, record := range records {
			st.Tasks[id] = record
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sampledAt := time.Date(2026, 11, 6, 0, 1, 0, 0, time.UTC)
	got, err := s.stepMetricsAt(ctx, sampledAt)
	if err != nil {
		t.Fatal(err)
	}
	if got.SchemaVersion != 1 || got.SampledAt != sampledAt.Format(time.RFC3339Nano) || got.Tasks != 2 || got.Samples != 3 || len(got.Roles) != 5 || len(got.Windows) != 2 || got.Windows[0].Window != "24h" || got.Windows[1].Window != "7d" || len(got.Windows[0].Roles) != 5 || len(got.Windows[0].TaskKinds) != len(taskMetricKinds) {
		t.Fatalf("metrics=%+v", got)
	}
	planner := got.Roles[0]
	if planner.Admissions != 2 || planner.Results != 2 || planner.Completed != 1 || planner.Failed != 1 || planner.KnownUsage != 1 || planner.InputTokens != 10 || planner.OutputTokens != 2 || planner.DurationP50Ms == nil || *planner.DurationP50Ms != 10 || planner.DurationP95Ms == nil || *planner.DurationP95Ms != 20 {
		t.Fatalf("planner=%+v", planner)
	}
	var creativePlan TaskKindMetrics
	for _, kind := range got.TaskKinds {
		if kind.Kind == "creative.plan_check" {
			creativePlan = kind
		}
	}
	if creativePlan.Tasks != 2 || creativePlan.Completed != 1 || creativePlan.Failed != 1 || creativePlan.ClaimToStartedP50Ms == nil || *creativePlan.ClaimToStartedP50Ms != 1000 || creativePlan.ClaimToStartedP95Ms == nil || *creativePlan.ClaimToStartedP95Ms != 2000 || creativePlan.StartedToTerminalP50Ms == nil || *creativePlan.StartedToTerminalP50Ms != 2000 || creativePlan.StartedToTerminalP95Ms == nil || *creativePlan.StartedToTerminalP95Ms != 4000 {
		t.Fatalf("creative plan metrics=%+v", creativePlan)
	}
	windowPlanner := got.Windows[0].Roles[0]
	if windowPlanner.Admissions != 2 || windowPlanner.Results != 2 || windowPlanner.Completed != 1 || windowPlanner.Failed != 1 || windowPlanner.KnownUsage != 1 || windowPlanner.UnknownUsage != 1 || windowPlanner.ReservedTokens != 200 || windowPlanner.UnknownReservedTokens != 100 || windowPlanner.InputTokens != 10 || windowPlanner.OutputTokens != 2 || windowPlanner.DurationSamples != 2 || windowPlanner.DurationP50Ms == nil || *windowPlanner.DurationP50Ms != 10 || windowPlanner.DurationP95Ms == nil || *windowPlanner.DurationP95Ms != 20 {
		t.Fatalf("window planner=%+v", windowPlanner)
	}
	var planWindow TaskKindWindowMetrics
	for _, kind := range got.Windows[0].TaskKinds {
		if kind.Kind == "creative.plan_check" {
			planWindow = kind
		}
	}
	if planWindow.Claimed != 2 || planWindow.Started != 2 || planWindow.Completed != 1 || planWindow.Failed != 1 || planWindow.ClaimToStartedSamples != 2 || planWindow.StartedToTerminalSamples != 2 {
		t.Fatalf("window task metrics=%+v", planWindow)
	}
	exported, err := s.RuntimeMetrics(ctx)
	if err != nil || exported.Tasks != 2 || exported.Samples != 3 || len(exported.Roles) != 5 || exported.Roles[0].Admissions != 2 || exported.Roles[0].InputTokens != 10 || len(exported.TaskKinds) != 5 || exported.TaskKinds[3].Kind != "creative.plan_check" || exported.TaskKinds[3].Completed != 1 || len(exported.Windows) != 2 || exported.Windows[0].Window != "24h" {
		t.Fatalf("exported metrics=%+v error=%v", exported, err)
	}
	raw, _ := json.Marshal(got)
	if strings.Contains(string(raw), firstID) || strings.Contains(string(raw), secondID) || strings.Contains(string(raw), `"task"`) {
		t.Fatal("metrics leaked task identity", string(raw))
	}
	reloaded, err := (&Service{State: s.State}).stepMetricsAt(ctx, sampledAt)
	if err != nil || !reflect.DeepEqual(got, reloaded) {
		t.Fatalf("reloaded metrics=%+v error=%v", reloaded, err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := (&Service{State: s.State}).StepMetrics(cancelled); err != context.Canceled {
		t.Fatal(err)
	}
	if _, err := (&Service{State: s.State}).RuntimeMetrics(cancelled); err != context.Canceled {
		t.Fatal(err)
	}
}

func TestTaskMetricWindowsUseEventTimestampsAndFixedBoundaries(t *testing.T) {
	sampledAt := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	lower24h := sampledAt.Add(-24 * time.Hour)
	window24 := newStepMetricWindow("24h", 24*time.Hour)
	window7d := newStepMetricWindow("7d", 7*24*time.Hour)
	dayOld := Record{
		Task: Task{Kind: "review.execute"},
		Audit: []ExecutionAudit{
			{Action: "claimed", At: lower24h.Add(-time.Second).Format(time.RFC3339Nano)},
			{Action: "started", At: lower24h.Format(time.RFC3339Nano)},
			{Action: "terminal", At: sampledAt.Format(time.RFC3339Nano)},
		},
		Outcome: "completed",
	}
	weekOld := Record{
		Task: Task{Kind: "review.execute"},
		Audit: []ExecutionAudit{
			{Action: "claimed", At: lower24h.Format(time.RFC3339Nano)},
			{Action: "started", At: sampledAt.Format(time.RFC3339Nano)},
			{Action: "terminal", At: sampledAt.Add(time.Second).Format(time.RFC3339Nano)},
		},
		Outcome: "completed",
	}
	longRun := Record{
		Task: Task{Kind: "knowledge.extract"},
		Audit: []ExecutionAudit{
			{Action: "claimed", At: sampledAt.Add(-32 * time.Hour).Format(time.RFC3339Nano)},
			{Action: "started", At: sampledAt.Add(-25 * time.Hour).Format(time.RFC3339Nano)},
			{Action: "terminal", At: sampledAt.Add(-23 * time.Hour).Format(time.RFC3339Nano)},
		},
		Outcome: "failed",
	}
	interrupted := Record{
		Task: Task{Kind: "review.execute"},
		Audit: []ExecutionAudit{
			{Action: "started", At: sampledAt.Add(-time.Second).Format(time.RFC3339Nano)},
			{Action: "terminal", At: sampledAt.Format(time.RFC3339Nano)},
		},
		Outcome: "interrupted",
	}
	unknown := Record{
		Task:     Task{Kind: "review.execute"},
		Started:  true,
		Finished: true,
		Audit: []ExecutionAudit{
			{Action: "started", At: sampledAt.Add(-time.Second).Format(time.RFC3339Nano)},
			{Action: "terminal", At: sampledAt.Format(time.RFC3339Nano)},
		},
	}
	invalid := Record{
		Task: Task{Kind: "creative.organize"},
		Audit: []ExecutionAudit{
			{Action: "claimed", At: "not-a-time"},
			{Action: "started", At: sampledAt.Add(time.Second).Format(time.RFC3339Nano)},
			{Action: "terminal", At: ""},
		},
		Outcome: "interrupted",
	}
	for _, record := range []Record{dayOld, weekOld, longRun, interrupted, unknown, invalid} {
		accumulateTaskKindWindow(&window24, record, sampledAt, 24*time.Hour)
		accumulateTaskKindWindow(&window7d, record, sampledAt, 7*24*time.Hour)
	}
	finishStepMetricWindow(&window24)
	finishStepMetricWindow(&window7d)
	find := func(window StepMetricWindow, kind string) TaskKindWindowMetrics {
		for _, metrics := range window.TaskKinds {
			if metrics.Kind == kind {
				return metrics
			}
		}
		return TaskKindWindowMetrics{}
	}
	day24 := find(window24.StepMetricWindow, "review.execute")
	if day24.Claimed != 1 || day24.Started != 4 || day24.Completed != 1 || day24.Interrupted != 1 || day24.Unknown != 1 || day24.ClaimToStartedSamples != 2 || day24.StartedToTerminalSamples != 3 || day24.ClaimToStartedP50Ms == nil || *day24.ClaimToStartedP50Ms != 1000 || day24.ClaimToStartedP95Ms == nil || *day24.ClaimToStartedP95Ms != 86400000 {
		t.Fatalf("24h review metrics=%+v", day24)
	}
	week7 := find(window7d.StepMetricWindow, "review.execute")
	if week7.Claimed != 2 || week7.Started != 4 || week7.Completed != 1 || week7.Interrupted != 1 || week7.Unknown != 1 || week7.ClaimToStartedSamples != 2 || week7.StartedToTerminalSamples != 3 {
		t.Fatalf("7d review metrics=%+v", week7)
	}
	long24 := find(window24.StepMetricWindow, "knowledge.extract")
	if long24.Claimed != 0 || long24.Started != 0 || long24.Failed != 1 || long24.StartedToTerminalSamples != 1 {
		t.Fatalf("24h long task metrics=%+v", long24)
	}
	long7 := find(window7d.StepMetricWindow, "knowledge.extract")
	if long7.Claimed != 1 || long7.Started != 1 || long7.Failed != 1 || long7.ClaimToStartedSamples != 1 || long7.StartedToTerminalSamples != 1 {
		t.Fatalf("7d long task metrics=%+v", long7)
	}
	invalid24 := find(window24.StepMetricWindow, "creative.organize")
	if invalid24.Claimed != 0 || invalid24.Started != 0 || invalid24.Interrupted != 0 || invalid24.ClaimToStartedSamples != 0 || invalid24.StartedToTerminalSamples != 0 {
		t.Fatalf("invalid/future timestamps entered window: %+v", invalid24)
	}
}

func TestRoleMetricWindowsSeparateAdmissionReservationsAndTerminalUsage(t *testing.T) {
	sampledAt := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	lower24h := sampledAt.Add(-24 * time.Hour)
	parent := "private-task-id"
	step := func(index int, at string, limit int) ModelStepReceipt {
		return ModelStepReceipt{ModelStep: ModelStep{Role: modelStepRoles[index], CallIndex: index + 1, ParentTaskID: parent, MaxTokens: limit}, At: at}
	}
	window24 := newStepMetricWindow("24h", 24*time.Hour)
	window7d := newStepMetricWindow("7d", 7*24*time.Hour)
	record := Record{
		Task:     Task{ID: parent, Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
		Creative: &creative.PreparedJob{},
		ModelSteps: []ModelStepReceipt{
			step(0, lower24h.Format(time.RFC3339Nano), 100),
			step(1, sampledAt.Add(-8*24*time.Hour).Format(time.RFC3339Nano), 50),
			step(2, "bad-time", 20),
			step(3, sampledAt.Format(time.RFC3339Nano), 30),
		},
		StepResults: []llm.StepResult{
			{CallIndex: 1, Status: "completed", DurationMs: 25, Usage: &llm.Usage{InputTokens: 100, OutputTokens: 10, CachedInputTokens: 25}},
			{CallIndex: 3, Status: "failed", DurationMs: 10},
			{CallIndex: 4, Status: "completed", DurationMs: 30, Usage: &llm.Usage{InputTokens: 20, OutputTokens: 5}},
		},
		Audit: []ExecutionAudit{{Action: "terminal", At: sampledAt.Format(time.RFC3339Nano)}},
	}
	open := Record{
		Task:       Task{ID: "open-task", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
		Creative:   &creative.PreparedJob{},
		ModelSteps: []ModelStepReceipt{{ModelStep: ModelStep{Role: modelStepRoles[4], CallIndex: 5, ParentTaskID: "open-task", MaxTokens: 40}, At: sampledAt.Format(time.RFC3339Nano)}},
	}
	future := Record{
		Task:       Task{ID: "future-task", Kind: "creative.plan_check", Strategy: creative.PlanStrategyReadonly},
		Creative:   &creative.PreparedJob{},
		ModelSteps: []ModelStepReceipt{{ModelStep: ModelStep{Role: modelStepRoles[1], CallIndex: 2, ParentTaskID: "future-task", MaxTokens: 40}, At: sampledAt.Add(time.Second).Format(time.RFC3339Nano)}},
		Audit:      []ExecutionAudit{{Action: "terminal", At: sampledAt.Add(time.Second).Format(time.RFC3339Nano)}},
	}
	for _, value := range []Record{record, open, future} {
		accumulateRoleWindow(&window24, value, sampledAt, 24*time.Hour)
		accumulateRoleWindow(&window7d, value, sampledAt, 7*24*time.Hour)
	}
	finishStepMetricWindow(&window24)
	finishStepMetricWindow(&window7d)
	role24 := func(window StepMetricWindow, name string) RoleStepWindowMetrics {
		for _, metrics := range window.Roles {
			if metrics.Role == name {
				return metrics
			}
		}
		return RoleStepWindowMetrics{}
	}
	planner := role24(window24.StepMetricWindow, modelStepRoles[0])
	if planner.Admissions != 1 || planner.Results != 1 || planner.KnownUsage != 1 || planner.UnknownUsage != 0 || planner.ReservedTokens != 100 || planner.UnknownReservedTokens != 0 || planner.InputTokens != 100 || planner.OutputTokens != 10 || planner.CachedInputTokens != 25 || planner.DurationSamples != 1 || planner.DurationP50Ms == nil || *planner.DurationP50Ms != 25 {
		t.Fatalf("planner window metrics=%+v", planner)
	}
	researcher := role24(window24.StepMetricWindow, modelStepRoles[1])
	if researcher.Admissions != 0 || researcher.Results != 0 || researcher.UnknownUsage != 1 || researcher.UnknownReservedTokens != 50 {
		t.Fatalf("researcher terminal unknown usage=%+v", researcher)
	}
	analyst := role24(window24.StepMetricWindow, modelStepRoles[2])
	if analyst.Admissions != 0 || analyst.Results != 1 || analyst.Failed != 1 || analyst.UnknownUsage != 1 || analyst.UnknownReservedTokens != 20 || analyst.DurationSamples != 1 {
		t.Fatalf("analyst metrics=%+v", analyst)
	}
	coordinator := role24(window24.StepMetricWindow, modelStepRoles[4])
	if coordinator.Admissions != 1 || coordinator.ReservedTokens != 40 || coordinator.UnknownUsage != 0 {
		t.Fatalf("open task was treated as terminal: %+v", coordinator)
	}
	weekResearcher := role24(window7d.StepMetricWindow, modelStepRoles[1])
	if weekResearcher.Admissions != 0 || weekResearcher.UnknownUsage != 1 || weekResearcher.UnknownReservedTokens != 50 {
		t.Fatalf("7d researcher metrics=%+v", weekResearcher)
	}
	critic := role24(window24.StepMetricWindow, modelStepRoles[3])
	if critic.Admissions != 1 || critic.ReservedTokens != 30 || critic.Results != 1 || critic.KnownUsage != 1 {
		t.Fatalf("critic metrics=%+v", critic)
	}
}

func TestTaskKindMetricsPreserveOpenAndTerminalOutcomes(t *testing.T) {
	tests := []struct {
		record Record
		field  func(TaskKindMetrics) int
	}{
		{Record{}, func(value TaskKindMetrics) int { return value.Accepted }},
		{Record{Started: true}, func(value TaskKindMetrics) int { return value.Running }},
		{Record{Finished: true}, func(value TaskKindMetrics) int { return value.Unknown }},
		{Record{Finished: true, ResultHash: "expired"}, func(value TaskKindMetrics) int { return value.Interrupted }},
		{Record{Finished: true, Outcome: "failed"}, func(value TaskKindMetrics) int { return value.Failed }},
	}
	for _, test := range tests {
		got := taskKindAccumulator{}
		accumulateTaskKind(&got, test.record)
		if got.Tasks != 1 || test.field(got.TaskKindMetrics) != 1 {
			t.Fatalf("record=%+v metrics=%+v", test.record, got)
		}
	}
}

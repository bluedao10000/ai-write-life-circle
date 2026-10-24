package creative

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

// Eval cases describe synthetic multi-turn conversations and the proposals an
// author would expect. Fixture outputs exercise the metric pipeline only; model
// quality requires a live run and human review of literary judgement.
type EvalExpect struct {
	Operation string `json:"operation"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Stance    string `json:"stance,omitempty"`
}
type EvalTurn struct {
	User        string          `json:"user"`
	Assistant   string          `json:"assistant"`
	Expect      []EvalExpect    `json:"expect"`
	AcceptAfter bool            `json:"acceptAfter,omitempty"`
	Fixture     json.RawMessage `json:"fixture,omitempty"`
}
type EvalRetain struct {
	Kind   string   `json:"kind"`
	Name   string   `json:"name"`
	Fields []string `json:"fields"`
}
type EvalCase struct {
	ID     string       `json:"id"`
	Turns  []EvalTurn   `json:"turns"`
	Retain []EvalRetain `json:"retain,omitempty"`
}

type EvalReport struct {
	Mode                     string             `json:"mode"`
	Cases                    int                `json:"cases"`
	Turns                    int                `json:"turns"`
	IntentAccuracy           float64            `json:"intentAccuracy"`
	CandidatePrecision       float64            `json:"candidatePrecision"`
	CandidateRecall          float64            `json:"candidateRecall"`
	DuplicateEntities        int                `json:"duplicateEntities"`
	NegationRecognized       *float64           `json:"negationRecognized"`
	UnconfirmedPromotionRate float64            `json:"unconfirmedPromotionRate"`
	TraceabilityRate         float64            `json:"traceabilityRate"`
	CrossTurnRetention       *float64           `json:"crossTurnRetention"`
	AuthorAcceptanceRate     *float64           `json:"authorAcceptanceRate"`
	ModelCalls               int                `json:"modelCalls"`
	PerCase                  map[string]float64 `json:"perCaseIntentAccuracy"`
	QualityClaim             bool               `json:"qualityClaim"`
	Notes                    []string           `json:"notes"`
}

type scripted struct {
	next  func() json.RawMessage
	calls int
}

func (s *scripted) Generate(_ context.Context, r llm.Request) (llm.Response, error) {
	s.calls++
	var in organizeInput
	_ = json.Unmarshal([]byte(r.Input), &in)
	raw := string(s.next())
	if len(in.FocusMessageIDs) == 2 {
		raw = strings.ReplaceAll(strings.ReplaceAll(raw, "$USER", in.FocusMessageIDs[0]), "$ANSWER", in.FocusMessageIDs[1])
	}
	for _, a := range in.Assets {
		raw = strings.ReplaceAll(raw, "$ASSET:"+a.Name, a.ID)
	}
	for _, p := range in.PendingProposals {
		raw = strings.ReplaceAll(raw, "$PENDING:"+p.Name, p.ID)
	}
	return llm.Response{Text: raw}, nil
}

type countingClient struct {
	llm.Client
	calls int
}

func (c *countingClient) Generate(ctx context.Context, r llm.Request) (llm.Response, error) {
	c.calls++
	return c.Client.Generate(ctx, r)
}

func ratio(n, d int) float64 {
	if d == 0 {
		return 1
	}
	return float64(n) / float64(d)
}

// RunEval runs every case in an isolated temporary state directory. With a nil
// live client, each turn's fixture output is replayed (engineering check only).
func RunEval(ctx context.Context, cases []EvalCase, cfg llm.Config, live llm.Client) (EvalReport, error) {
	rep := EvalReport{Mode: "fixture", PerCase: map[string]float64{}, Notes: []string{}}
	if live != nil {
		rep.Mode = "live"
	}
	author := application.Actor{ID: "eval-author", Role: "author"}
	intentOK, expected, matched, produced, correct, promoted, traceable := 0, 0, 0, 0, 0, 0, 0
	negTotal, negOK, retainTotal, retainOK, accepted, decided := 0, 0, 0, 0, 0, 0
	fixtures := []*scripted{}
	for _, c := range cases {
		dir, e := os.MkdirTemp("", "creative-eval-")
		if e != nil {
			return rep, e
		}
		defer os.RemoveAll(dir)
		m := application.NewManagement(&application.Service{Root: filepath.Join(dir, "h"), State: filepath.Join(dir, "s"), Project: "legacy"}, author.ID)
		b, e := m.Mutate(ctx, author, "", "create", application.StructureInput{Operation: "create"})
		if e != nil {
			return rep, e
		}
		app, _ := m.Resolve(author, b.ID)
		turn := 0
		var client llm.Client
		counter := &countingClient{}
		if live != nil {
			counter.Client = live
			client = counter
		} else {
			fx := &scripted{}
			fx.next = func() json.RawMessage { return c.Turns[turn].Fixture }
			client = fx
			fixtures = append(fixtures, fx)
		}
		s := New(app, cfg, client)
		model := cfg.Info()
		if _, e = s.Configure(ctx, author, "enable", compat.UUID(), SettingsInput{Consent: true, Model: &model, DailyTokenBudget: 100000000, DailyJobBudget: 1000}); e != nil {
			return rep, e
		}
		session := "th-" + compat.UUID()
		snap := &Snapshot{SessionID: session, BookID: b.ID}
		caseOK := 0
		for turn = range c.Turns {
			t := c.Turns[turn]
			mid := compat.UUID()
			if _, e = s.AcceptTurn(ctx, session, mid, "auto"); e != nil {
				return rep, e
			}
			snap.Messages = append(snap.Messages, SnapshotMessage{ID: mid, Role: "user", Text: t.User, Status: "completed"}, SnapshotMessage{ID: mid + "-answer", Role: "assistant", Text: t.Assistant, Status: "completed"})
			if e = s.Capture(ctx, TurnKey(session, mid), snap, false); e != nil {
				return rep, e
			}
			if _, e = s.ProcessOne(ctx); e != nil {
				return rep, e
			}
			st, _ := s.load()
			got := []Proposal{}
			for _, p := range st.Proposals {
				if p.Source.MessageID == mid {
					got = append(got, p)
				}
			}
			name := func(p Proposal) string {
				if p.Draft != nil {
					return p.Draft.Name
				}
				return st.Assets[p.TargetAssetID].Name
			}
			used := map[string]bool{}
			hit := 0
			for _, x := range t.Expect {
				expected++
				for _, p := range got {
					if !used[p.ID] && p.Kind == x.Kind && normalize(name(p)) == normalize(x.Name) && (x.Operation == "" || p.Operation == x.Operation) {
						used[p.ID] = true
						hit++
						if x.Stance != "" && x.Stance != "author_decision" && p.Stance == "author_decision" {
							promoted++
						}
						if x.Stance == "author_rejection" {
							negTotal++
							if p.Stance == "author_rejection" {
								negOK++
							}
						}
						break
					}
				}
			}
			matched += hit
			produced += len(got)
			correct += hit
			if hit == len(t.Expect) && len(got) == len(t.Expect) {
				intentOK++
				caseOK++
			}
			for _, p := range got {
				if len(p.Evidence) > 0 && p.Source.SessionID == session && p.Source.ExcerptHash != "" {
					traceable++
				}
			}
			if t.AcceptAfter {
				ds := []DecisionInput{}
				for _, p := range got {
					if p.Status == "proposed" && p.AlternativeGroup == "" {
						ds = append(ds, DecisionInput{ProposalID: p.ID, Action: "accept"})
					}
				}
				if len(ds) > 0 {
					if _, e := s.Decide(ctx, author, compat.UUID(), DecideInput{Decisions: ds}); e == nil {
						accepted += len(ds)
					}
					decided += len(ds)
				}
			}
		}
		st, _ := s.load()
		seen := map[string]bool{}
		for _, a := range st.Assets {
			k := a.Kind + "\x00" + normalize(a.Name)
			if seen[k] {
				rep.DuplicateEntities++
			}
			seen[k] = true
		}
		for _, r := range c.Retain {
			retainTotal++
			if a, ok := matchAsset(&st, r.Kind, r.Name, nil); ok {
				have := map[string]bool{}
				for _, f := range a.Fields {
					have[f.Key] = true
				}
				all := true
				for _, f := range r.Fields {
					all = all && have[f]
				}
				if all {
					retainOK++
				}
			}
		}
		rep.PerCase[c.ID] = ratio(caseOK, len(c.Turns))
		rep.Turns += len(c.Turns)
		rep.Cases++
		if live != nil {
			rep.ModelCalls += counter.calls
		}
	}
	for _, fx := range fixtures {
		rep.ModelCalls += fx.calls
	}
	rep.IntentAccuracy = ratio(intentOK, rep.Turns)
	rep.CandidatePrecision = ratio(correct, produced)
	rep.CandidateRecall = ratio(matched, expected)
	rep.UnconfirmedPromotionRate = 1 - ratio(produced-promoted, produced)
	rep.TraceabilityRate = ratio(traceable, produced)
	if negTotal > 0 {
		v := ratio(negOK, negTotal)
		rep.NegationRecognized = &v
	}
	if retainTotal > 0 {
		v := ratio(retainOK, retainTotal)
		rep.CrossTurnRetention = &v
	}
	if decided > 0 {
		v := ratio(accepted, decided)
		rep.AuthorAcceptanceRate = &v
	}
	rep.QualityClaim = false
	if rep.Mode == "fixture" {
		rep.Notes = append(rep.Notes, "Fixture outputs replay scripted model responses: these numbers check the pipeline and server-side validation, not model quality.")
	} else {
		rep.Notes = append(rep.Notes, "Synthetic cases only. Literary quality and real author acceptance require human review; acceptance here is simulated.")
	}
	rep.Notes = append(rep.Notes, "Author acceptance rate in production comes from overview decision counts, not from this eval.")
	return rep, nil
}

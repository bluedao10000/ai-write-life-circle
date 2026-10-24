package creative

import (
	"context"
	"sort"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type SettingsView struct {
	Settings
	Available         bool          `json:"available"`
	CurrentModel      llm.ModelInfo `json:"currentModel"`
	NeedsModelConsent bool          `json:"needsModelConsent"`
	Disclosure        string        `json:"disclosure"`
	ReserveTokens     int           `json:"reserveTokens"`
	BudgetDay         string        `json:"budgetDay"`
	BudgetTokens      int           `json:"budgetTokens"`
	BudgetAttempts    int           `json:"budgetAttempts"`
}

type Overview struct {
	BookID           string                    `json:"bookId"`
	Version          int                       `json:"version"`
	Settings         SettingsView              `json:"settings"`
	Counts           map[string]map[string]int `json:"counts"`
	PendingProposals int                       `json:"pendingProposals"`
	Jobs             map[string]int            `json:"jobs"`
	OpenDivergences  int                       `json:"openDivergences"`
}

const Disclosure = "启用后，每轮灵感对话完成时，Writer Agent 会把本轮作者消息、AI 回复及最多 6 条近期消息（不超过 24 KiB），连同本作品已有创作设定的名称、别名与摘要，发送给下列模型，整理为待审核的候选。作者发起计划核对时，还会发送目标章节的已保存正文与该章的规划设定。结果只作为候选，不会自动写入正式设定，也不会修改正文。"

func (s *Service) settingsView(st State) SettingsView {
	v := SettingsView{Settings: st.Settings, CurrentModel: s.Config.Info(), Disclosure: Disclosure, ReserveTokens: s.reserve(), BudgetDay: st.BudgetDay, BudgetTokens: st.BudgetTokens, BudgetAttempts: st.BudgetAttempts}
	v.Available = s.Config.ValidatePublic() == nil
	v.NeedsModelConsent = st.Settings.Enabled && (st.Settings.Model != s.Config.Info() || (st.Settings.ConfigFingerprint != "" && st.Settings.ConfigFingerprint != s.Config.Fingerprint()))
	return v
}

func (s *Service) Overview(ctx context.Context) (Overview, error) {
	st, e := s.load()
	if e != nil {
		return Overview{}, e
	}
	o := Overview{BookID: st.BookID, Version: st.Version, Settings: s.settingsView(st), Counts: map[string]map[string]int{}, Jobs: map[string]int{}}
	for kind := range Kinds {
		o.Counts[kind] = map[string]int{}
	}
	for _, a := range st.Assets {
		o.Counts[a.Kind][a.Status]++
	}
	for _, p := range st.Proposals {
		if p.Status == "proposed" {
			o.PendingProposals++
		}
	}
	for _, j := range st.Jobs {
		o.Jobs[j.Status]++
	}
	for _, d := range st.Divergences {
		if d.Status == "open" {
			o.OpenDivergences++
		}
	}
	return o, nil
}

type AssetQuery struct {
	Kind, Status, Q string
	Offset, Limit   int
}

type AssetSummary struct {
	Asset
	PendingProposals int `json:"pendingProposals"`
}

type AssetPage struct {
	Items      []AssetSummary `json:"items"`
	Total      int            `json:"total"`
	NextCursor *int           `json:"nextCursor"`
}

func page[T any](items []T, offset, limit int) ([]T, *int) {
	if offset > len(items) {
		offset = len(items)
	}
	end := min(len(items), offset+limit)
	var next *int
	if end < len(items) {
		next = &end
	}
	return items[offset:end], next
}

func matches(a Asset, q string) bool {
	if q == "" {
		return true
	}
	q = normalize(q)
	if strings.Contains(normalize(a.Name), q) || strings.Contains(normalize(a.Summary), q) {
		return true
	}
	for _, alias := range a.Aliases {
		if strings.Contains(normalize(alias), q) {
			return true
		}
	}
	for _, f := range a.Fields {
		if strings.Contains(normalize(f.Value), q) {
			return true
		}
	}
	return false
}

func sortedAssets(st State) []Asset {
	list := make([]Asset, 0, len(st.Assets))
	for _, a := range st.Assets {
		list = append(list, a)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].UpdatedAt != list[j].UpdatedAt {
			return list[i].UpdatedAt > list[j].UpdatedAt
		}
		return list[i].ID < list[j].ID
	})
	return list
}

func (s *Service) Assets(ctx context.Context, q AssetQuery) (AssetPage, error) {
	st, e := s.load()
	if e != nil {
		return AssetPage{}, e
	}
	pending := map[string]int{}
	for _, p := range st.Proposals {
		if p.Status == "proposed" && p.TargetAssetID != "" {
			pending[p.TargetAssetID]++
		}
	}
	kinds := map[string]bool{}
	for _, k := range strings.Split(q.Kind, ",") {
		if k != "" {
			kinds[k] = true
		}
	}
	items := []AssetSummary{}
	for _, a := range sortedAssets(st) {
		if len(kinds) > 0 && !kinds[a.Kind] {
			continue
		}
		if q.Status != "" && q.Status != a.Status {
			continue
		}
		if !matches(a, q.Q) {
			continue
		}
		items = append(items, AssetSummary{Asset: a, PendingProposals: pending[a.ID]})
	}
	out, next := page(items, q.Offset, q.Limit)
	return AssetPage{Items: out, Total: len(items), NextCursor: next}, nil
}

type AssetDetail struct {
	Asset     Asset          `json:"asset"`
	Versions  []Version      `json:"versions"`
	Links     []LinkView     `json:"links"`
	Proposals []ProposalView `json:"proposals"`
}

type LinkView struct {
	Link
	FromName string `json:"fromName"`
	ToName   string `json:"toName,omitempty"`
}

func linkView(st State, l Link) LinkView {
	v := LinkView{Link: l, FromName: st.Assets[l.From].Name}
	if l.To.Type == "asset" {
		v.ToName = st.Assets[l.To.ID].Name
	}
	return v
}

func (s *Service) Asset(ctx context.Context, id string) (AssetDetail, error) {
	st, e := s.load()
	if e != nil {
		return AssetDetail{}, e
	}
	a, ok := st.Assets[id]
	if !ok {
		return AssetDetail{}, application.Fail(404, "NOT_FOUND", "Asset not found.")
	}
	d := AssetDetail{Asset: a, Versions: append([]Version{}, st.Versions[id]...), Links: []LinkView{}, Proposals: []ProposalView{}}
	sort.Slice(d.Versions, func(i, j int) bool { return d.Versions[i].Version > d.Versions[j].Version })
	for _, l := range st.Links {
		if l.Status == "active" && (l.From == id || (l.To.Type == "asset" && l.To.ID == id)) {
			d.Links = append(d.Links, linkView(st, l))
		}
	}
	sort.Slice(d.Links, func(i, j int) bool { return d.Links[i].CreatedAt < d.Links[j].CreatedAt })
	for _, p := range st.Proposals {
		if p.TargetAssetID == id || p.ResultAssetID == id {
			d.Proposals = append(d.Proposals, proposalView(st, p))
		}
	}
	sort.Slice(d.Proposals, func(i, j int) bool { return d.Proposals[i].CreatedAt > d.Proposals[j].CreatedAt })
	return d, nil
}

// ProposalView adds what the review UI needs for a diff: the target's current
// content and the content that would result from accepting unchanged.
type ProposalView struct {
	Proposal
	Stale          bool     `json:"stale"`
	TargetName     string   `json:"targetName,omitempty"`
	CurrentVersion int      `json:"currentVersion,omitempty"`
	Current        *Content `json:"current,omitempty"`
	Result         *Content `json:"result,omitempty"`
	LinkTargetName string   `json:"linkTargetName,omitempty"`
}

func proposalView(st State, p Proposal) ProposalView {
	v := ProposalView{Proposal: p}
	if p.Draft != nil {
		c := *p.Draft
		v.Result = &c
	}
	if target, ok := st.Assets[p.TargetAssetID]; ok {
		v.TargetName = target.Name
		v.CurrentVersion = target.Version
		c := target.Content
		v.Current = &c
		if p.Operation == "UPDATE" || p.Operation == "SUPERSEDE" {
			v.Stale = p.Status == "proposed" && target.Version != p.BaseVersion
			if p.Patch != nil {
				if next, e := applyPatch(target.Kind, target.Content, *p.Patch); e == nil {
					v.Result = &next
				}
			}
		}
	} else if p.TargetAssetID != "" {
		v.Stale = p.Status == "proposed"
	}
	if p.Link != nil {
		if p.Link.ToAssetID != "" {
			v.LinkTargetName = st.Assets[p.Link.ToAssetID].Name
		} else if target, ok := st.Proposals[p.Link.ToProposalID]; ok && target.Draft != nil {
			v.LinkTargetName = target.Draft.Name
		}
	}
	return v
}

type ProposalQuery struct {
	Status, SessionID, AssetID, ChangeSetID string
	Offset, Limit                           int
}

type ProposalPage struct {
	Items      []ProposalView `json:"items"`
	Total      int            `json:"total"`
	NextCursor *int           `json:"nextCursor"`
}

func (s *Service) Proposals(ctx context.Context, q ProposalQuery) (ProposalPage, error) {
	st, e := s.load()
	if e != nil {
		return ProposalPage{}, e
	}
	list := []Proposal{}
	for _, p := range st.Proposals {
		if q.Status != "" && p.Status != q.Status {
			continue
		}
		if q.SessionID != "" && p.Source.SessionID != q.SessionID {
			continue
		}
		if q.ChangeSetID != "" && p.ChangeSetID != q.ChangeSetID {
			continue
		}
		if q.AssetID != "" && p.TargetAssetID != q.AssetID && p.ResultAssetID != q.AssetID {
			continue
		}
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].CreatedAt != list[j].CreatedAt {
			return list[i].CreatedAt > list[j].CreatedAt
		}
		return list[i].ID < list[j].ID
	})
	views := make([]ProposalView, 0, len(list))
	for _, p := range list {
		views = append(views, proposalView(st, p))
	}
	items, next := page(views, q.Offset, q.Limit)
	return ProposalPage{Items: items, Total: len(views), NextCursor: next}, nil
}

type TurnView struct {
	Turn
	Proposals int    `json:"proposals"`
	Pending   int    `json:"pending"`
	Summary   string `json:"summary,omitempty"`
}

// Turns lists organizing status per message for one session. Excerpts are omitted.
func (s *Service) Turns(ctx context.Context, session string) ([]TurnView, error) {
	st, e := s.load()
	if e != nil {
		return nil, e
	}
	out := []TurnView{}
	for _, t := range st.Turns {
		if t.SessionID != session {
			continue
		}
		v := TurnView{Turn: t}
		v.Excerpt = nil
		if cs, ok := st.ChangeSets[t.ChangeSetID]; ok {
			v.Summary = cs.Summary
			for _, id := range cs.Proposals {
				v.Proposals++
				if st.Proposals[id].Status == "proposed" {
					v.Pending++
				}
			}
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AcceptedAt < out[j].AcceptedAt })
	return out, nil
}

// WritingContext selects only author-confirmed assets relevant to a chapter:
// plans anchored to it, assets linked to it or to those plans, and accepted
// world rules. It never includes conversation transcripts or unreviewed
// proposals, so prompts and the writing panel stay bounded and authoritative.
type WritingContext struct {
	ChapterID   string       `json:"chapterId"`
	Plans       []Asset      `json:"plans"`
	Payoffs     []Asset      `json:"payoffs"`
	Characters  []Asset      `json:"characters"`
	Rules       []Asset      `json:"rules"`
	Related     []Asset      `json:"related"`
	Questions   []Asset      `json:"openQuestions"`
	Divergences []Divergence `json:"divergences"`
	Notice      string       `json:"notice"`
}

func (s *Service) WritingContext(ctx context.Context, chapter string) (WritingContext, error) {
	if _, e := s.App.Source(chapter); e != nil {
		return WritingContext{}, e
	}
	st, e := s.load()
	if e != nil {
		return WritingContext{}, e
	}
	out := WritingContext{ChapterID: chapter, Plans: []Asset{}, Payoffs: []Asset{}, Characters: []Asset{}, Rules: []Asset{}, Related: []Asset{}, Questions: []Asset{}, Divergences: []Divergence{}, Notice: "只包含作者确认的设定；未审核候选与对话原文不进入写作上下文。"}
	selected := map[string]bool{}
	for _, a := range sortedAssets(st) {
		if a.Status != "accepted" || a.Plan == nil {
			continue
		}
		if a.Plan.ChapterID == chapter {
			out.Plans = append(out.Plans, a)
			selected[a.ID] = true
		} else if a.Plan.PayoffChapterID == chapter {
			out.Payoffs = append(out.Payoffs, a)
			selected[a.ID] = true
		}
	}
	// One hop of author/accepted links from the chapter and its plans.
	for _, l := range st.Links {
		if l.Status != "active" {
			continue
		}
		var other string
		switch {
		case l.To.Type == "chapter" && l.To.ID == chapter:
			other = l.From
		case selected[l.From] && l.To.Type == "asset":
			other = l.To.ID
		case l.To.Type == "asset" && selected[l.To.ID]:
			other = l.From
		default:
			continue
		}
		a, ok := st.Assets[other]
		if !ok || a.Status != "accepted" || selected[a.ID] {
			continue
		}
		selected[a.ID] = true
		if a.Kind == "character" {
			out.Characters = append(out.Characters, a)
		} else {
			out.Related = append(out.Related, a)
		}
	}
	for _, a := range sortedAssets(st) {
		if a.Status == "accepted" && a.Kind == "world_rule" && !selected[a.ID] && len(out.Rules) < 12 {
			out.Rules = append(out.Rules, a)
		}
		if a.Kind == "open_question" && (a.Status == "accepted" || a.Status == "draft") && len(out.Questions) < 8 {
			out.Questions = append(out.Questions, a)
		}
	}
	for _, d := range st.Divergences {
		if d.ChapterID == chapter && d.Status == "open" {
			out.Divergences = append(out.Divergences, d)
		}
	}
	sort.Slice(out.Divergences, func(i, j int) bool { return out.Divergences[i].CreatedAt > out.Divergences[j].CreatedAt })
	return out, nil
}

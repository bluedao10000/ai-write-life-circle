package creative

import (
	"context"
	"encoding/json"
	"reflect"
	"sort"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type StoryEvidence struct {
	MessageID string `json:"messageId"`
	Quote     string `json:"quote"`
}
type StoryChangeInput struct {
	Intent           string          `json:"intent"`
	Kind             string          `json:"kind,omitempty"`
	TargetAssetID    string          `json:"targetAssetId,omitempty"`
	TargetProposalID string          `json:"targetProposalId,omitempty"`
	BaseVersion      *int            `json:"baseVersion,omitempty"`
	Patch            Patch           `json:"patch"`
	Evidence         []StoryEvidence `json:"evidence"`
}
type RecordStoryChangesInput struct {
	Changes []StoryChangeInput `json:"changes"`
}
type StoryChange struct {
	Intent     string `json:"intent"`
	Name       string `json:"name"`
	AssetID    string `json:"assetId,omitempty"`
	ProposalID string `json:"proposalId,omitempty"`
	Before     *Asset `json:"before,omitempty"`
	After      *Asset `json:"after,omitempty"`
}
type StoryChangeReceipt struct {
	ChangeID  string        `json:"changeId"`
	SessionID string        `json:"sessionId"`
	MessageID string        `json:"messageId"`
	CreatedAt string        `json:"createdAt"`
	Status    string        `json:"status"`
	Changes   []StoryChange `json:"changes"`
	UndoneAt  string        `json:"undoneAt,omitempty"`
}
type proposalChange struct {
	Before *Proposal `json:"before,omitempty"`
	After  Proposal  `json:"after"`
}
type storedStoryChange struct {
	StoryChangeReceipt
	Proposals map[string]proposalChange `json:"proposals,omitempty"`
}
type DiscussionFocusInput struct {
	Goal              string   `json:"goal"`
	AssetIDs          []string `json:"assetIds"`
	QuestionIDs       []string `json:"questionIds"`
	SuggestedNextStep string   `json:"suggestedNextStep,omitempty"`
	BaseVersion       *int     `json:"baseVersion,omitempty"`
}
type DiscussionFocus struct {
	SessionID            string   `json:"sessionId"`
	Goal                 string   `json:"goal"`
	AssetIDs             []string `json:"assetIds"`
	QuestionIDs          []string `json:"questionIds"`
	SuggestedNextStep    string   `json:"suggestedNextStep,omitempty"`
	UpdatedFromMessageID string   `json:"updatedFromMessageId"`
	Version              int      `json:"version"`
	UpdatedAt            string   `json:"updatedAt"`
}
type StoryContextView struct {
	Truncated         bool                 `json:"truncated,omitempty"`
	BookID            string               `json:"bookId"`
	StateVersion      int                  `json:"stateVersion"`
	DialogueRecording bool                 `json:"dialogueRecording"`
	Focus             *DiscussionFocus     `json:"focus"`
	Intent            []Asset              `json:"intent"`
	Confirmed         []Asset              `json:"confirmed"`
	Alternatives      []ProposalView       `json:"alternatives"`
	Rejected          []ProposalView       `json:"rejected"`
	Questions         []Asset              `json:"questions"`
	RecentChanges     []StoryChangeReceipt `json:"recentChanges"`
}

func recordingEnabled(st *State) error {
	if !st.Settings.DialogueRecording {
		return application.Fail(409, "DIALOGUE_RECORDING_DISABLED", "Enable recording of story decisions before updating story context.")
	}
	return nil
}

// Evidence confirms provenance. The Thinking model remains responsible for
// distinguishing a decision from a hypothesis in the author's language.
func storyEvidence(in []StoryEvidence, current string, messages []TurnMessage) ([]Evidence, error) {
	if len(in) < 1 || len(in) > 4 {
		return nil, validation("Each change needs 1-4 exact conversation quotes.")
	}
	out := []Evidence{}
	currentAuthor := false
	for _, e := range in {
		if e.Quote == "" || runes(e.Quote) > 1000 {
			return nil, validation("Evidence quotes must be 1-1000 characters.")
		}
		found := false
		for _, m := range messages {
			if m.ID == e.MessageID && (m.Role == "user" || m.Role == "assistant") && strings.Contains(m.Text, e.Quote) {
				out = append(out, Evidence{MessageID: m.ID, Role: m.Role, Quote: e.Quote})
				if m.ID == current && m.Role == "user" {
					currentAuthor = true
				}
				found = true
				break
			}
		}
		if !found {
			return nil, validation("Evidence must quote an actual message in this conversation.")
		}
	}
	if !currentAuthor {
		return nil, validation("A story change needs evidence from the current author message.")
	}
	return out, nil
}

// RecordStoryChanges commits one atomic batch per logical author message.
func (s *Service) RecordStoryChanges(ctx context.Context, actor application.Actor, key, session, message string, in RecordStoryChangesInput, messages []TurnMessage) (StoryChangeReceipt, error) {
	var changeID string
	if actor.Role != "author" {
		return StoryChangeReceipt{}, application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author may change creative assets.")
	}
	if !application.SafeKey(key) {
		return StoryChangeReceipt{}, application.Fail(422, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key required.")
	}
	priorState, loadErr := s.load()
	if loadErr != nil {
		return StoryChangeReceipt{}, loadErr
	}
	for _, prior := range priorState.StoryChanges {
		if prior.SessionID == session && prior.MessageID == message {
			return prior.StoryChangeReceipt, nil
		}
	}
	if session == "" || message == "" || len(session) > 128 || len(message) > 128 {
		return StoryChangeReceipt{}, validation("A conversation and current message are required.")
	}
	if len(in.Changes) < 1 || len(in.Changes) > 8 {
		return StoryChangeReceipt{}, validation("Record 1-8 changes in one batch.")
	}
	evidence := make([][]Evidence, len(in.Changes))
	for i, c := range in.Changes {
		var err error
		evidence[i], err = storyEvidence(c.Evidence, message, messages)
		if err != nil {
			return StoryChangeReceipt{}, err
		}
		if c.Intent != "decide" && c.Intent != "explore" && c.Intent != "reject" && c.Intent != "defer" {
			return StoryChangeReceipt{}, validation("Unknown story change intent.")
		}
	}
	err := s.idempotent(ctx, actor, "story.record:"+session+":"+message, key, in, &changeID, func(st *State) error {
		for _, r := range st.StoryChanges {
			if r.SessionID == session && r.MessageID == message {
				changeID = r.ChangeID
				return nil
			}
		}
		if e := recordingEnabled(st); e != nil {
			return e
		}
		if len(st.StoryChanges) >= MaxTurns {
			return application.Fail(429, "CREATIVE_TURN_LIMIT", "Story change history is full.")
		}
		now := s.stamp()
		r := storedStoryChange{StoryChangeReceipt: StoryChangeReceipt{ChangeID: "sc-" + newID(), SessionID: session, MessageID: message, CreatedAt: now, Status: "applied", Changes: []StoryChange{}}, Proposals: map[string]proposalChange{}}
		beforeProposals := map[string]Proposal{}
		for id, p := range st.Proposals {
			beforeProposals[id] = p
		}
		touched := map[string]bool{}
		for i, c := range in.Changes {
			change, e := s.applyStoryChange(st, actor, session, message, now, c, evidence[i])
			if e != nil {
				return e
			}
			for _, id := range []string{change.AssetID, change.ProposalID, c.TargetProposalID} {
				if id == "" {
					continue
				}
				if touched[id] {
					return validation("Combine changes to the same target in one patch.")
				}
			}
			for _, id := range []string{change.AssetID, change.ProposalID, c.TargetProposalID} {
				if id != "" {
					touched[id] = true
				}
			}
			r.Changes = append(r.Changes, change)
		}
		for id, p := range st.Proposals {
			prior, ok := beforeProposals[id]
			if ok && reflect.DeepEqual(prior, p) {
				continue
			}
			item := proposalChange{After: p}
			if ok {
				item.Before = &prior
			}
			r.Proposals[id] = item
		}
		st.StoryChanges[r.ChangeID] = r
		changeID = r.ChangeID
		return nil
	})
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	st, err := s.load()
	if err != nil {
		return StoryChangeReceipt{}, err
	}
	return st.StoryChanges[changeID].StoryChangeReceipt, nil
}

func hasStoryPatch(p Patch) bool {
	return p.Name != nil || p.Summary != nil || len(p.AddAliases) > 0 || len(p.SetFields) > 0 || len(p.RemoveFields) > 0 || p.Plan != nil || p.QuestionStatus != nil
}

func (s *Service) applyStoryChange(st *State, actor application.Actor, session, message, now string, c StoryChangeInput, evidence []Evidence) (StoryChange, error) {
	out := StoryChange{Intent: c.Intent}
	src := ConversationSource{Type: "conversation", SessionID: session, MessageID: message, BookID: st.BookID, CapturedAt: now, Strategy: "dialogue-story-v1"}
	var candidate *Proposal
	var target *Asset
	kind := c.Kind
	if c.TargetProposalID != "" {
		p, ok := st.Proposals[c.TargetProposalID]
		if !ok {
			return out, application.Fail(404, "NOT_FOUND", "Proposal not found.")
		}
		if p.Status != "proposed" {
			return out, conflict("PROPOSAL_NOT_PENDING", "The candidate was already decided or replaced.", map[string]any{"proposalId": p.ID, "status": p.Status})
		}
		if p.Operation != "CREATE" && p.Operation != "UPDATE" && p.Operation != "SUPERSEDE" {
			return out, validation("This candidate cannot be recorded as a story setting.")
		}
		if kind != "" && kind != p.Kind {
			return out, validation("The candidate kind cannot change.")
		}
		kind = p.Kind
		candidate = &p
		if c.TargetAssetID != "" && c.TargetAssetID != p.TargetAssetID {
			return out, validation("Candidate and asset targets do not match.")
		}
		c.TargetAssetID = p.TargetAssetID
	}
	if c.Intent == "reject" && candidate != nil {
		candidate.Status = "rejected"
		candidate.Decision = &Decision{Action: "reject", ActorID: actor.ID, At: now}
		st.Proposals[candidate.ID] = *candidate
		out.ProposalID = candidate.ID
		out.Name = proposalName(*candidate, st.Assets)
		return out, nil
	}
	if c.TargetAssetID != "" {
		a, ok := st.Assets[c.TargetAssetID]
		if !ok {
			return out, application.Fail(404, "NOT_FOUND", "Setting not found.")
		}
		if a.Status == "archived" || a.Status == "superseded" {
			return out, conflict("ASSET_INACTIVE", "Choose an active setting.", map[string]any{"assetId": a.ID})
		}
		if kind != "" && kind != a.Kind {
			return out, validation("The setting kind cannot change.")
		}
		kind = a.Kind
		expected := 0
		if candidate != nil {
			expected = candidate.BaseVersion
		}
		if c.BaseVersion != nil {
			expected = *c.BaseVersion
		}
		if expected != a.Version || (candidate != nil && candidate.BaseVersion != a.Version) {
			return out, conflict("ASSET_VERSION_CONFLICT", "This setting changed. Read it again before recording.", map[string]any{"assetId": a.ID, "version": a.Version})
		}
		target = &a
	}
	if Kinds[kind] == "" {
		return out, validation("A supported setting kind is required.")
	}

	if c.Intent == "reject" && (target == nil || !hasStoryPatch(c.Patch)) {
		return out, validation("Reject a candidate or explicitly patch the retracted setting fields.")
	}
	if c.Intent == "defer" && (kind != "open_question" || candidate != nil) {
		return out, validation("Only an open question can be deferred.")
	}
	content := Content{}
	if target != nil {
		content = target.Content
	}
	if candidate != nil {
		if candidate.Draft != nil {
			content = *candidate.Draft
		}
		if candidate.Patch != nil {
			var e error
			content, e = applyPatch(kind, content, *candidate.Patch)
			if e != nil {
				return out, e
			}
		}
	}
	if c.Intent == "defer" {
		status := "deferred"
		c.Patch.QuestionStatus = &status
	}
	var err error
	content, err = applyPatch(kind, content, c.Patch)
	if err != nil {
		return out, err
	}
	if err = s.checkPlan(content.Plan); err != nil {
		return out, err
	}
	if existing, ok := matchAsset(st, kind, content.Name, content.Aliases); ok && (target == nil || existing.ID != target.ID) && c.Intent != "explore" {
		return out, conflict("DUPLICATE_ASSET", "Use the existing setting and its current version.", map[string]any{"assetId": existing.ID, "version": existing.Version})
	}
	out.Name = content.Name
	if c.Intent == "explore" {
		if len(st.Proposals) >= MaxProposals {
			return out, application.Fail(429, "CREATIVE_PROPOSAL_LIMIT", "Proposal limit reached.")
		}
		p := Proposal{ID: "cp-" + newID(), BookID: st.BookID, Operation: "CREATE", Kind: kind, Stance: "author_hypothesis", Exploratory: true, Status: "proposed", Draft: &content, Evidence: evidence, Source: src, CreatedAt: now}
		if kind == "open_question" {
			p.Stance = "author_question"
		}
		if target != nil {
			p.Operation = "UPDATE"
			p.TargetAssetID = target.ID
			p.BaseVersion = target.Version
			p.Draft = nil
			patch := patchToContent(target.Content, content)
			p.Patch = &patch
		}
		if candidate != nil {
			p.Replaces = candidate.ID
			p.AlternativeGroup = candidate.AlternativeGroup
			candidate.Status = "superseded"
			candidate.ReplacedBy = p.ID
			st.Proposals[candidate.ID] = *candidate
		}
		st.Proposals[p.ID] = p
		out.ProposalID = p.ID
		return out, nil
	}
	if candidate != nil {
		if err = alternativeAllowed(st, *candidate); err != nil {
			return out, err
		}
	}
	var asset Asset
	if target != nil {
		out.Before = target
		asset = *target
		asset.Content = content
		asset.Version++
		asset.UpdatedAt = now
		asset.Status = "accepted"
	} else {
		if len(st.Assets) >= MaxAssets {
			return out, application.Fail(429, "CREATIVE_ASSET_LIMIT", "Asset limit reached.")
		}
		asset = Asset{ID: "ca-" + newID(), BookID: st.BookID, Kind: kind, Content: content, Status: "accepted", Origin: "conversation", Version: 1, CreatedAt: now, UpdatedAt: now}
	}
	st.Assets[asset.ID] = asset
	proposalID := ""
	if candidate != nil {
		candidate.Status = "accepted"
		candidate.Decision = &Decision{Action: "accept", ActorID: actor.ID, At: now, Edited: hasStoryPatch(c.Patch)}
		candidate.ResultAssetID = asset.ID
		candidate.ResultVersion = asset.Version
		st.Proposals[candidate.ID] = *candidate
		proposalID = candidate.ID
	}
	appendVersion(st, asset, Version{ActorID: actor.ID, At: now, Origin: "dialogue_decision", ProposalID: proposalID, Source: &src, Evidence: evidence})
	out.AssetID = asset.ID
	out.ProposalID = proposalID
	out.After = &asset
	return out, nil
}

func patchToContent(before, after Content) Patch {
	p := Patch{Name: &after.Name, Summary: &after.Summary, AddAliases: after.Aliases, SetFields: after.Fields, Plan: after.Plan}
	if after.QuestionStatus != "" {
		p.QuestionStatus = &after.QuestionStatus
	}
	for _, f := range before.Fields {
		found := false
		for _, next := range after.Fields {
			if f.Key == next.Key {
				found = true
				break
			}
		}
		if !found {
			p.RemoveFields = append(p.RemoveFields, f.Key)
		}
	}
	return p
}
func proposalName(p Proposal, assets map[string]Asset) string {
	if p.Draft != nil {
		return p.Draft.Name
	}
	if p.Patch != nil && p.Patch.Name != nil {
		return *p.Patch.Name
	}
	return assets[p.TargetAssetID].Name
}

func (s *Service) UpdateDiscussionFocus(ctx context.Context, actor application.Actor, key, session, message string, in DiscussionFocusInput) (DiscussionFocus, error) {
	var out DiscussionFocus
	if session == "" || message == "" || len(session) > 128 || len(message) > 128 || runes(in.Goal) > 500 || runes(in.SuggestedNextStep) > 500 || len(in.AssetIDs) > 12 || len(in.QuestionIDs) > 12 {
		return out, validation("Invalid discussion focus.")
	}
	err := s.idempotent(ctx, actor, "story.focus:"+session+":"+message, key, in, &out, func(st *State) error {
		if e := recordingEnabled(st); e != nil {
			return e
		}
		prior := st.Focuses[session]
		expected := 0
		if in.BaseVersion != nil {
			expected = *in.BaseVersion
		}
		if prior.Version != expected {
			return conflict("FOCUS_VERSION_CONFLICT", "The discussion focus changed. Read it again.", map[string]any{"version": prior.Version})
		}
		for _, id := range append(append([]string{}, in.AssetIDs...), in.QuestionIDs...) {
			a, ok := st.Assets[id]
			if !ok || a.Status == "archived" || a.Status == "superseded" {
				return validation("Discussion focus must reference active story settings.")
			}
		}
		for _, id := range in.QuestionIDs {
			if st.Assets[id].Kind != "open_question" {
				return validation("questionIds must reference open questions.")
			}
		}
		out = DiscussionFocus{SessionID: session, Goal: in.Goal, AssetIDs: append([]string{}, in.AssetIDs...), QuestionIDs: append([]string{}, in.QuestionIDs...), SuggestedNextStep: in.SuggestedNextStep, UpdatedFromMessageID: message, Version: prior.Version + 1, UpdatedAt: s.stamp()}
		st.Focuses[session] = out
		return nil
	})
	return out, err
}

func (s *Service) StoryChanges(ctx context.Context, session string) ([]StoryChangeReceipt, error) {
	st, err := s.load()
	if err != nil {
		return nil, err
	}
	return storyReceipts(st, session), nil
}
func storyReceipts(st State, session string) []StoryChangeReceipt {
	out := []StoryChangeReceipt{}
	for _, r := range st.StoryChanges {
		if session == "" || r.SessionID == session {
			out = append(out, r.StoryChangeReceipt)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].ChangeID < out[j].ChangeID
	})
	return out
}

func (s *Service) UndoStoryChange(ctx context.Context, actor application.Actor, key, id string) (StoryChangeReceipt, error) {
	var out StoryChangeReceipt
	err := s.idempotent(ctx, actor, "story.undo:"+id, key, struct{}{}, &out, func(st *State) error {
		r, ok := st.StoryChanges[id]
		if !ok {
			return application.Fail(404, "NOT_FOUND", "Story change receipt not found.")
		}
		if r.Status == "undone" {
			out = r.StoryChangeReceipt
			return nil
		}
		for _, c := range r.Changes {
			if c.After == nil {
				continue
			}
			a, ok := st.Assets[c.AssetID]
			if !ok || a.Version != c.After.Version {
				return conflict("STORY_UNDO_CONFLICT", "A setting was edited after this change. Keep the later edits and review it manually.", map[string]any{"assetId": c.AssetID, "version": a.Version})
			}
		}
		for id, p := range r.Proposals {
			if !reflect.DeepEqual(st.Proposals[id], p.After) {
				return conflict("STORY_UNDO_CONFLICT", "A candidate was changed after this receipt.", map[string]any{"proposalId": id})
			}
		}
		now := s.stamp()
		for _, c := range r.Changes {
			if c.After == nil {
				continue
			}
			a := st.Assets[c.AssetID]
			if c.Before == nil {
				a.Status = "archived"
			} else {
				a.Content = c.Before.Content
				a.Status = c.Before.Status
				a.SupersededBy = c.Before.SupersededBy
			}
			a.Version++
			a.UpdatedAt = now
			st.Assets[a.ID] = a
			appendVersion(st, a, Version{ActorID: actor.ID, At: now, Origin: "dialogue_undo"})
		}
		for id, p := range r.Proposals {
			next := p.After
			if p.Before != nil {
				next = *p.Before
			} else {
				next.Status = "rejected"
				next.Decision = &Decision{Action: "reject", ActorID: actor.ID, At: now}
				next.StatusReason = "DIALOGUE_CHANGE_UNDONE"
			}
			if next.Status == "proposed" && next.TargetAssetID != "" {
				for _, c := range r.Changes {
					if c.AssetID == next.TargetAssetID && c.Before != nil {
						next.BaseVersion = st.Assets[c.AssetID].Version
					}
				}
			}
			st.Proposals[id] = next
		}
		r.Status = "undone"
		r.UndoneAt = now
		st.StoryChanges[id] = r
		out = r.StoryChangeReceipt
		return nil
	})
	return out, err
}

// StoryContext keeps current author state and unconfirmed alternatives separate.
// Full entries are admitted by priority until the 16 KiB prompt budget is used.
func (s *Service) StoryContext(ctx context.Context, session, query string) (StoryContextView, error) {
	st, err := s.load()
	if err != nil {
		return StoryContextView{}, err
	}
	out := StoryContextView{BookID: st.BookID, StateVersion: st.Version, DialogueRecording: st.Settings.DialogueRecording, Intent: []Asset{}, Confirmed: []Asset{}, Alternatives: []ProposalView{}, Rejected: []ProposalView{}, Questions: []Asset{}, RecentChanges: []StoryChangeReceipt{}}
	focusIDs := map[string]bool{}
	if f, ok := st.Focuses[session]; ok {
		f.AssetIDs = activeFocusIDs(st, f.AssetIDs)
		f.QuestionIDs = activeFocusIDs(st, f.QuestionIDs)
		out.Focus = &f
		for _, id := range append(append([]string{}, f.AssetIDs...), f.QuestionIDs...) {
			focusIDs[id] = true
		}
	}
	named := map[string]bool{}
	q := normalize(query)
	for id, a := range st.Assets {
		if q != "" && strings.Contains(q, normalize(a.Name)) {
			named[id] = true
		}
		for _, alias := range a.Aliases {
			if q != "" && strings.Contains(q, normalize(alias)) {
				named[id] = true
			}
		}
	}
	linked := map[string]bool{}
	for _, l := range st.Links {
		if l.Status != "active" || l.To.Type != "asset" {
			continue
		}
		if named[l.From] || focusIDs[l.From] {
			linked[l.To.ID] = true
		}
		if named[l.To.ID] || focusIDs[l.To.ID] {
			linked[l.From] = true
		}
	}
	priority := func(a Asset) int {
		if a.Kind == "story_intent" {
			return 0
		}
		if named[a.ID] {
			return 1
		}
		if focusIDs[a.ID] {
			return 2
		}
		if linked[a.ID] {
			return 3
		}
		return 4
	}
	assets := sortedAssets(st)
	sort.SliceStable(assets, func(i, j int) bool { return priority(assets[i]) < priority(assets[j]) })
	fits := func() bool { b, _ := json.Marshal(out); return len(b) <= 16*1024-32 }
	addAsset := func(a Asset) {
		if a.Status != "accepted" {
			return
		}
		raw, _ := json.Marshal(a)
		if priority(a) < 4 && len(raw) > 6000 {
			a.Summary = clip(a.Summary, 500)
			a.Fields = append([]Field{}, a.Fields...)
			for i := range a.Fields {
				a.Fields[i].Value = clip(a.Fields[i].Value, 80)
			}
			out.Truncated = true
		}
		switch a.Kind {
		case "story_intent":
			out.Intent = append(out.Intent, a)
			if !fits() {
				out.Truncated = true
				out.Intent = out.Intent[:len(out.Intent)-1]
			}
		case "open_question":
			out.Questions = append(out.Questions, a)
			if !fits() {
				out.Truncated = true
				out.Questions = out.Questions[:len(out.Questions)-1]
			}
		default:
			out.Confirmed = append(out.Confirmed, a)
			if !fits() {
				out.Truncated = true
				out.Confirmed = out.Confirmed[:len(out.Confirmed)-1]
			}
		}
	}
	for _, a := range assets {
		if priority(a) < 4 {
			addAsset(a)
		}
	}
	for _, r := range storyReceipts(st, "") {
		if len(out.RecentChanges) >= 3 {
			out.Truncated = true
			break
		}
		raw, _ := json.Marshal(r)
		if len(raw) > 4096 {
			out.Truncated = true
			continue
		}
		out.RecentChanges = append(out.RecentChanges, r)
		if !fits() {
			out.Truncated = true
			out.RecentChanges = out.RecentChanges[:len(out.RecentChanges)-1]
		}
	}
	for _, a := range assets {
		if priority(a) == 4 && a.Kind == "open_question" {
			addAsset(a)
		}
	}
	proposals := []Proposal{}
	for _, p := range st.Proposals {
		if p.Status == "proposed" || p.Status == "rejected" {
			proposals = append(proposals, p)
		}
	}
	sort.Slice(proposals, func(i, j int) bool {
		pi, pj := proposals[i], proposals[j]
		ni, nj := named[pi.TargetAssetID] || focusIDs[pi.TargetAssetID], named[pj.TargetAssetID] || focusIDs[pj.TargetAssetID]
		if ni != nj {
			return ni
		}
		if pi.CreatedAt != pj.CreatedAt {
			return pi.CreatedAt > pj.CreatedAt
		}
		return pi.ID < pj.ID
	})
	for _, p := range proposals {
		if p.Source.Deleted || p.ReplacedBy != "" {
			continue
		}
		v := proposalView(st, p)
		if v.Stale {
			continue
		}
		if p.TargetAssetID != "" {
			a := st.Assets[p.TargetAssetID]
			if a.Status == "archived" || a.Status == "superseded" {
				continue
			}
		}
		if p.Status == "proposed" {
			out.Alternatives = append(out.Alternatives, v)
			if !fits() {
				out.Truncated = true
				out.Alternatives = out.Alternatives[:len(out.Alternatives)-1]
			}
		} else {
			out.Rejected = append(out.Rejected, v)
			if !fits() {
				out.Truncated = true
				out.Rejected = out.Rejected[:len(out.Rejected)-1]
			}
		}
	}
	for _, a := range assets {
		if priority(a) == 4 && a.Kind != "open_question" {
			addAsset(a)
		}
	}
	return out, nil
}
func activeFocusIDs(st State, ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if a, ok := st.Assets[id]; ok && a.Status != "archived" && a.Status != "superseded" {
			out = append(out, id)
		}
	}
	return out
}

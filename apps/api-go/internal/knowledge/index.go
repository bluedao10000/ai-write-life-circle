package knowledge

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"sort"
	"strings"
	"time"
)

func orderedEntities(m map[string]Entity) []Entity {
	out := []Entity{}
	for _, e := range m {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func stable(parts ...string) string {
	return strings.TrimPrefix(compat.Hash(strings.Join(parts, "\x00")), "sha256:")[:32]
}
func normalized(v string) string { return strings.ToLower(strings.TrimSpace(v)) }

// liveEntity reports whether an entity still has at least one non-retired,
// currently-valid source. Entities whose evidence was fully retired must not
// remain merge targets, otherwise a later same-named but distinct person could
// be folded into a dead identity.
func liveEntity(st *State, id string) bool {
	for _, a := range st.Assertions {
		if a.EntityID != id {
			continue
		}
		for _, src := range a.Sources {
			if !src.Retired && src.Validity == "current" {
				return true
			}
		}
	}
	return false
}
func apply(st *State, j Job, r application.StoredRevision, out Output) error {
	ids := map[string]string{}
	now := compat.Now()
	// Validate ALL evidence and references before mutating the transaction state.
	for _, a := range out.Assertions {
		if _, e := evidence(st.BookID, j.ChapterID, r, a); e != nil {
			return e
		}
	}
	for _, c := range out.Entities {
		id := "entity-" + stable(st.BookID, j.ChapterID, c.Type, normalized(c.Name), c.Identity)
		if existing, ok := st.Entities[c.ExistingID]; ok && existing.Type == c.Type {
			same := normalized(existing.Name) == normalized(c.Name)
			for _, alias := range append(existing.Aliases, c.Aliases...) {
				if normalized(alias) == normalized(existing.Name) || normalized(alias) == normalized(c.Name) {
					same = true
				}
			}
			blocked := false
			for _, fix := range st.Corrections {
				if fix.Active && fix.Action == "separate" && fix.EntityID == existing.ID && fix.ChapterID == j.ChapterID {
					blocked = true
				}
			}
			if same && !blocked && liveEntity(st, existing.ID) && (c.Identity == "" || existing.Identity == c.Identity) {
				id = existing.ID
			}
		}
		// Names and new aliases must occur in target evidence, not just model summaries.
		quotes := ""
		for _, a := range out.Assertions {
			if a.EntityKey == c.Key {
				quotes += a.Quote
			}
		}
		nameSeen := strings.Contains(quotes, c.Name)
		for _, alias := range c.Aliases {
			if !strings.Contains(quotes, alias) {
				return application.Fail(502, "LLM_UNSUPPORTED_ALIAS", "An alias lacks target evidence.")
			}
			nameSeen = nameSeen || strings.Contains(quotes, alias)
		}
		if !nameSeen && (c.Type == "character" || c.Type == "place" || c.Type == "organization") {
			return application.Fail(502, "LLM_UNSUPPORTED_ENTITY", "An entity name lacks target evidence.")
		}
		ids[c.Key] = id
		ent, exists := st.Entities[id]
		if !exists {
			ent = Entity{ID: id, BookID: st.BookID, Type: c.Type, Name: c.Name, Identity: c.Identity, Aliases: []string{}, CreatedAt: now}
		}
		if ent.Name != c.Name {
			if strings.Contains(quotes, ent.Name) && !contains(ent.Aliases, ent.Name) {
				ent.Aliases = append(ent.Aliases, ent.Name)
			}
			ent.Name = c.Name
		}
		for _, alias := range c.Aliases {
			if alias == ent.Name {
				continue
			}
			if !contains(ent.Aliases, alias) {
				ent.Aliases = append(ent.Aliases, alias)
			}
		}
		ent.UpdatedAt = now
		ent.Version++
		ent.Status = "observed"
		st.Entities[id] = ent
	}
	// Old source revisions remain in history, but cannot support current assertions.
	retiredRevisions := map[string]bool{}
	for id, a := range st.Assertions {
		for i, src := range a.Sources {
			if src.ChapterID == j.ChapterID {
				a.Sources[i].Validity = "stale"
				if !a.Sources[i].Retired {
					retiredRevisions[src.RevisionID] = true
				}
				a.Sources[i].Retired = true
			}
		}
		st.Assertions[id] = a
	}
	for _, c := range out.Assertions {
		epistemic := c.Epistemic
		if c.Kind != "narration" && epistemic != "inference" {
			epistemic = "claim"
		}
		if e := st.Entities[ids[c.EntityKey]]; e.Type == "plot_line" || (e.Type == "foreshadowing" && c.Predicate != "explicit_mystery" && c.Predicate != "explicit_resolution") {
			if epistemic == "observation" {
				epistemic = "inference"
			}
		}
		target := ids[c.TargetKey]
		id := "assertion-" + stable(ids[c.EntityKey], c.Predicate, c.Text, target, epistemic, c.Speaker, c.Time)
		a, ok := st.Assertions[id]
		if !ok {
			a = Assertion{ID: id, EntityID: ids[c.EntityKey], Predicate: c.Predicate, Text: c.Text, TargetID: target, Epistemic: epistemic, Speaker: c.Speaker, Time: c.Time, Sources: []Source{}}
		}
		src, _ := evidence(st.BookID, j.ChapterID, r, c)
		exists := false
		for i, old := range a.Sources {
			if old.ChapterID == src.ChapterID && old.RevisionID == src.RevisionID && old.Start == src.Start {
				a.Sources[i] = src
				exists = true
			}
		}
		if !exists {
			a.Sources = append(a.Sources, src)
		}
		if a.Time != "" && !strings.Contains(c.Quote, a.Time) {
			a.Time = ""
		}
		a.Status = "current"
		st.Assertions[id] = a
	}
	for revision := range retiredRevisions {
		st.Changes = append(st.Changes, Change{compat.UUID(), now, "sources_retired", j.ChapterID, revision, j.ID})
	}
	st.Changes = append(st.Changes, Change{compat.UUID(), now, "extracted", j.ChapterID, r.ID, j.ID})
	rebuildIndex(st)
	return nil
}
func contains(a []string, s string) bool {
	for _, v := range a {
		if v == s {
			return true
		}
	}
	return false
}
func rebuildIndex(st *State) {
	st.Index = map[string][]string{}
	for id, e := range st.Entities {
		for _, name := range append([]string{e.Name}, e.Aliases...) {
			key := normalized(name)
			if !contains(st.Index[key], id) {
				st.Index[key] = append(st.Index[key], id)
			}
		}
	}
}
func (s *Service) freshen(ctx context.Context, st *State) {
	revisions := map[string]application.StoredRevision{}
	p, e := s.App.Projection()
	chapters := map[string]application.Chapter{}
	if e == nil {
		all, err := application.Sources(p)
		if err == nil {
			for _, c := range all {
				chapters[c.ID] = c
			}
		}
	}
	for id, a := range st.Assertions {
		current := false
		for i, src := range a.Sources {
			if src.Retired {
				a.Sources[i].Validity = "stale"
				continue
			}
			state := "unavailable"
			if c, ok := chapters[src.ChapterID]; ok {
				r, known := revisions[c.ID]
				if !known {
					v, err := s.App.ReviewRevision(ctx, c)
					if err == nil {
						r = v
					}
					revisions[c.ID] = r
				}
				state = "stale"
				if r.ID == src.RevisionID && r.Hash == src.ContentHash && r.Hash == compat.Hash(r.Markdown) {
					verified, err := evidence(st.BookID, src.ChapterID, r, CandidateAssertion{Quote: src.Quote, Kind: src.Kind})
					if err == nil && verified.Start == src.Start && verified.End == src.End {
						state = "current"
					}
				}
			}
			a.Sources[i].Validity = state
			if state == "current" {
				current = true
			}
		}
		a.Status = "stale"
		if current {
			a.Status = "current"
		}
		for _, fix := range st.Corrections {
			sameAnchor := false
			if fix.EntityID == a.EntityID && fix.AnchorQuote != "" {
				for _, src := range a.Sources {
					if src.ChapterID == fix.ChapterID && src.Quote == fix.AnchorQuote {
						sameAnchor = true
					}
				}
			}
			if fix.Active && (fix.AssertionID == id || sameAnchor) {
				if fix.Action == "claim" {
					a.Epistemic = "claim"
				}
				if fix.Action == "dispute" && current {
					a.Status = "disputed"
				}
			}
		}
		st.Assertions[id] = a
	}
	for id, e := range st.Entities {
		e.Status = "stale"
		hasObservation, hasInference, disputed := false, false, false
		for _, a := range st.Assertions {
			if a.EntityID == id && a.Status != "stale" {
				if a.Epistemic == "inference" {
					hasInference = true
				} else {
					hasObservation = true
				}
				disputed = disputed || a.Status == "disputed"
			}
		}
		if hasInference {
			e.Status = "inferred"
		}
		if hasObservation {
			e.Status = "observed"
		}
		if disputed {
			e.Status = "disputed"
		}

		validAliases := []string{}
		for _, alias := range e.Aliases {
			supported := false
			for _, a := range st.Assertions {
				if a.EntityID == id && a.Status != "stale" {
					for _, src := range a.Sources {
						if src.Validity == "current" && strings.Contains(src.Quote, alias) {
							supported = true
						}
					}
				}
			}
			if supported {
				validAliases = append(validAliases, alias)
			}
		}
		e.Aliases = validAliases
		st.Entities[id] = e
	}
}

func (s *Service) view(st State) View {
	policy, _ := (executorpolicy.Controller{State: s.App.State}).Read()
	needsConsent := st.Settings.Enabled && ((st.Settings.ConfigFingerprint != "" && st.Settings.ConfigFingerprint != s.Config.Fingerprint()) || (policy.Kinds["knowledge"].Owner == "pi" && st.Settings.ConfigFingerprint == ""))
	v := View{NeedsModelConsent: needsConsent, BookID: st.BookID, Version: st.Version, BudgetDay: st.BudgetDay, BudgetTokens: st.BudgetTokens, BudgetAttempts: st.BudgetAttempts, Settings: st.Settings, Available: s.Client != nil || (s.QueueOnly && s.Config.ValidatePublic() == nil), Model: s.Config.Info(), Disclosure: "启用后，本作品已保存及以后保存的正文会逐章发送到所示模型；另包含最多80个人物/地点等名称、别名、身份区分与纠错，不发送历史章节全文。会产生模型费用；可随时暂停。逐字引文核验不代表模型理解正确。"}
	if s.QueueOnly {
		status := agentruntime.ReadExecutionStatus(s.App.State, s.Config, "knowledge")
		v.WorkerStatus = "offline"
		if status.Online {
			v.WorkerStatus = "online"
			if !status.Compatible {
				v.WorkerStatus = "incompatible"
			}
		}
	}
	latestJobs := map[string]Job{}
	for _, j := range st.Jobs {
		if j.Status != "superseded" && j.Status != "cancelled" {
			latestJobs[j.ChapterID] = j
		}
	}
	for _, j := range latestJobs {
		switch j.Status {
		case "pending", "retry":
			v.Pending++
		case "running":
			v.Running++
		case "failed":
			v.Failed++
		case "completed":
			v.Completed++
		}
	}
	// A chapter can only have finished if it is still analysable; never report
	// more completed than the denominator even if a chapter was emptied later.
	v.ChapterTotal = st.ChapterTotal
	if v.Completed > v.ChapterTotal {
		v.ChapterTotal = v.Completed
	}
	for _, a := range st.Assertions {
		if a.Status == "stale" {
			for _, src := range a.Sources {
				if !src.Retired {
					v.Stale = true
				}
			}
		}
	}
	return v
}

// Summary returns only the bounded control-plane state used by the global
// status chip and the panel header. It does not inspect assertions or sources.
func (s *Service) Summary(ctx context.Context) (View, error) {
	st, e := s.load()
	if e != nil {
		return View{}, e
	}
	return s.view(st), nil
}
func (s *Service) Query(ctx context.Context, q Query) (Page, error) {
	st, e := s.load()
	if e != nil {
		return Page{}, e
	}
	if q.Limit < 1 || q.Limit > 100 || q.Offset < 0 || q.AssertionOffset < 0 {
		return Page{}, application.Fail(422, "VALIDATION_FAILED", "Invalid page.")
	}
	candidates := map[string]bool{}
	for _, a := range st.Assertions {
		for _, src := range a.Sources {
			if q.ChapterID != "" && src.ChapterID == q.ChapterID {
				candidates[a.EntityID] = true
			}
		}
	}
	nameMatches := map[string]bool{}
	if q.Name != "" {
		for key, ids := range st.Index {
			if strings.Contains(key, normalized(q.Name)) {
				for _, id := range ids {
					nameMatches[id] = true
				}
			}
		}
	}
	// Validate only the source chapters represented by the selected entity page.
	// Calling freshen first inspected every assertion in the whole book, then
	// threw the work away. This bounded pass keeps read latency proportional to
	// the page being displayed while worker writes retain full validation.
	entities := []Entity{}
	for _, ent := range orderedEntities(st.Entities) {
		if q.EntityID != "" && q.EntityID != ent.ID {
			continue
		}
		if q.Type != "" && !contains(strings.Split(q.Type, ","), ent.Type) {
			continue
		}
		if q.Status != "" && ent.Status != q.Status {
			continue
		}
		if q.ChapterID != "" && !candidates[ent.ID] {
			continue
		}
		if q.Name != "" && !nameMatches[ent.ID] {
			continue
		}
		entities = append(entities, ent)
	}
	if q.Type == "event" {
		s.sortEvents(st, entities)
	}
	total := len(entities)
	start := min(q.Offset, total)
	end := min(start+q.Limit, total)
	entities = entities[start:end]
	selected := map[string]bool{}
	// Build the chapter map once. Source() reloads the full managed projection on
	// every call, which made a single knowledge page expensive for long books.
	chapters := map[string]application.Chapter{}
	if len(entities) > 0 {
		if p, projectionErr := s.App.Projection(); projectionErr == nil {
			if all, sourcesErr := application.Sources(p); sourcesErr == nil {
				for _, chapter := range all {
					chapters[chapter.ID] = chapter
				}
			}
		}
	}
	revisions := map[string]application.StoredRevision{}
	for _, entity := range entities {
		selected[entity.ID] = true
		for _, a := range st.Assertions {
			if a.EntityID != entity.ID {
				continue
			}
			for i, src := range a.Sources {
				if src.Retired {
					a.Sources[i].Validity = "stale"
					continue
				}
				c, sourceFound := chapters[src.ChapterID]
				state := "unavailable"
				if sourceFound {
					r, known := revisions[src.ChapterID]
					var revisionErr error
					if known {
						r = revisions[src.ChapterID]
					} else {
						r, revisionErr = s.App.ReviewRevision(ctx, c)
						if revisionErr == nil {
							revisions[src.ChapterID] = r
						} else if application.AsError(revisionErr).Status == 404 {
							// Archived and removed chapters no longer contribute a
							// current source. Keep their historical citation but do not
							// fail the entire page.
							revisionErr = nil
						}
					}
					if revisionErr == nil {
						state = "stale"
						if r.ID == src.RevisionID && r.Hash == src.ContentHash && r.Hash == compat.Hash(r.Markdown) {
							verified, verifyErr := evidence(st.BookID, src.ChapterID, r, CandidateAssertion{Quote: src.Quote, Kind: src.Kind})
							if verifyErr == nil && verified.Start == src.Start && verified.End == src.End {
								state = "current"
							}
						}
					}
				}
				a.Sources[i].Validity = state
				if state == "current" {
					a.Status = "current"
				}
			}
			st.Assertions[a.ID] = a
		}
	}
	// Repair derived state only for the current response page. Source validation
	// still runs against saved revisions, but read cost no longer grows with all
	// unrelated assertions in the book.
	st = refreshedState(st, entities)
	assertions := []Assertion{}
	for _, a := range st.Assertions {
		if selected[a.EntityID] {
			a.TargetName = st.Entities[a.TargetID].Name
			assertions = append(assertions, a)
		}
	}
	sort.Slice(assertions, func(i, j int) bool {
		if assertions[i].Status != assertions[j].Status {
			return assertions[i].Status == "current"
		}
		return assertions[i].ID < assertions[j].ID
	})
	var next *int
	if end < total {
		next = &end
	}
	assertionTotal := len(assertions)
	astart := min(q.AssertionOffset, assertionTotal)
	aend := min(astart+100, assertionTotal)
	var anext *int
	if aend < assertionTotal {
		anext = &aend
	}
	return Page{View: s.view(st), Entities: entities, Assertions: assertions[astart:aend], Total: total, Next: next, AssertionTotal: assertionTotal, NextAssertion: anext}, nil
}

func refreshedState(st State, current []Entity) State {
	selected := make(map[string]bool, len(current))
	for _, entity := range current {
		selected[entity.ID] = true
	}
	for index, entity := range current {
		if !selected[entity.ID] {
			continue
		}
		entity.Status = "stale"
		hasCurrent, hasInference, disputed := false, false, false
		for assertionID, assertion := range st.Assertions {
			if assertion.EntityID != entity.ID {
				continue
			}
			assertionCurrent := false
			for _, source := range assertion.Sources {
				if source.Validity == "current" && !source.Retired {
					assertionCurrent = true
				}
			}
			assertion.Status = "stale"
			if assertionCurrent {
				assertion.Status = "current"
				hasCurrent = true
				if assertion.Epistemic == "inference" {
					hasInference = true
				}
			}
			for _, correction := range st.Corrections {
				sameAnchor := correction.EntityID == entity.ID && correction.AnchorQuote != ""
				if sameAnchor {
					for _, source := range assertion.Sources {
						if source.ChapterID == correction.ChapterID && source.Quote == correction.AnchorQuote {
							sameAnchor = true
						}
					}
				}
				if !correction.Active || (correction.AssertionID != assertionID && !sameAnchor) {
					continue
				}
				if correction.Action == "claim" {
					assertion.Epistemic = "claim"
				}
				if correction.Action == "dispute" && assertionCurrent {
					assertion.Status = "disputed"
				}
			}
			disputed = disputed || assertion.Status == "disputed"
			st.Assertions[assertionID] = assertion
		}
		if hasCurrent {
			entity.Status = "observed"
			if hasInference {
				entity.Status = "inferred"
			}
		}
		if disputed {
			entity.Status = "disputed"
		}
		st.Entities[entity.ID] = entity
		current[index] = entity
	}
	return st
}

// Retrieve is the Review-facing read-only interface. It never elevates observations to confirmed canon.
func (s *Service) Retrieve(ctx context.Context, chapter string) ([]Assertion, error) {
	p, e := s.Query(ctx, Query{ChapterID: chapter, Limit: 30})
	if e != nil {
		return nil, e
	}
	out := []Assertion{}
	for _, a := range p.Assertions {
		if a.Status == "current" {
			out = append(out, a)
		}
	}
	return out, nil
}
func (s *Service) Records(ctx context.Context, kind string, offset, limit int) (RecordPage, error) {
	st, e := s.load()
	if e != nil {
		return RecordPage{}, e
	}
	view := s.view(st)
	items := []any{}
	switch kind {
	case "jobs":
		for i := len(st.Jobs) - 1; i >= 0; i-- {
			job := st.Jobs[i]
			job.ExecutorOwner = ""
			job.ExecutorEpoch = 0
			job.CompletionReceipts = nil
			job.AttemptReserve = 0
			job.DebitedDay = ""
			items = append(items, job)
		}
	case "history":
		for i := len(st.Changes) - 1; i >= 0; i-- {
			items = append(items, st.Changes[i])
		}
	case "corrections":
		for i := len(st.Corrections) - 1; i >= 0; i-- {
			items = append(items, st.Corrections[i])
		}
	}
	total := len(items)
	start := min(offset, total)
	end := min(start+limit, total)
	var next *int
	if end < total {
		next = &end
	}
	return RecordPage{Items: items[start:end], Total: total, NextCursor: next, View: &view}, nil
}

// RelatedChapters supplies Review only the IDs of current original evidence. No
// AI summary or inference is promoted to an author-confirmed knowledge source.
func (s *Service) RelatedChapters(ctx context.Context, chapter string) ([]string, error) {
	assertions, e := s.Retrieve(ctx, chapter)
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, a := range assertions {
		if a.Epistemic == "inference" {
			continue
		}
		for _, src := range a.Sources {
			if src.Validity == "current" && !contains(ids, src.ChapterID) {
				ids = append(ids, src.ChapterID)
				if len(ids) >= 16 {
					return ids, nil
				}
			}
		}
	}
	return ids, nil
}

// ISO dates are ordered only when literally present in a current narration quote.
// Unresolved/relative times remain in narrative order, never a fabricated chronology.
func (s *Service) sortEvents(st State, entities []Entity) {
	positions := map[string]int{}
	if p, e := s.App.Projection(); e == nil {
		if chapters, e := application.Sources(p); e == nil {
			for i, c := range application.OrderedChapters(chapters) {
				positions[c.ID] = i + 1
			}
		}
	}
	type ordering struct {
		date       string
		pos, start int
	}
	keys := map[string]ordering{}
	for _, ent := range entities {
		k := ordering{pos: 1 << 30}
		dates := map[string]bool{}
		for _, a := range st.Assertions {
			if a.EntityID != ent.ID || a.Status == "stale" {
				continue
			}
			for _, src := range a.Sources {
				if src.Validity != "current" {
					continue
				}
				p := positions[src.ChapterID]
				if p == 0 {
					p = 1 << 29
				}
				if p < k.pos || p == k.pos && src.Start < k.start {
					k.pos = p
					k.start = src.Start
				}
				if a.Status == "current" && a.Epistemic == "observation" && src.Kind == "narration" && strings.Contains(src.Quote, a.Time) {
					if date, e := time.Parse("2006-01-02", a.Time); e == nil {
						dates[date.Format("2006-01-02")] = true
					}
				}
			}
		}
		if len(dates) == 1 {
			for date := range dates {
				k.date = date
			}
		}
		keys[ent.ID] = k
	}
	sort.SliceStable(entities, func(i, j int) bool {
		a, b := keys[entities[i].ID], keys[entities[j].ID]
		if (a.date != "") != (b.date != "") {
			return a.date != ""
		}
		if a.date != b.date {
			return a.date < b.date
		}
		if a.pos != b.pos {
			return a.pos < b.pos
		}
		if a.start != b.start {
			return a.start < b.start
		}
		return entities[i].ID < entities[j].ID
	})
}

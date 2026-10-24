package creative

import (
	"context"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

type AssetInput struct {
	Kind    string  `json:"kind"`
	Content Content `json:"content"`
	Status  string  `json:"status"` // draft|accepted
	Note    string  `json:"note,omitempty"`
}

type AssetUpdate struct {
	BaseVersion  int      `json:"baseVersion"`
	Content      *Content `json:"content,omitempty"`
	Status       *string  `json:"status,omitempty"`
	SupersededBy *string  `json:"supersededBy,omitempty"`
	Note         string   `json:"note,omitempty"`
}

type LinkInput struct {
	From     string     `json:"fromAssetId"`
	To       LinkTarget `json:"to"`
	Relation string     `json:"relation"`
}

func runes(s string) int { return utf8.RuneCountInString(s) }

func normalize(s string) string {
	return strings.ToLower(strings.Join(strings.FieldsFunc(s, compat.Space), ""))
}

func validation(detail string) error { return application.Fail(422, "VALIDATION_FAILED", detail) }

// cleanContent trims and validates author-visible text. It never invents content.
func cleanContent(kind string, c Content) (Content, error) {
	c.Name = compat.Trim(c.Name)
	c.Summary = compat.Trim(c.Summary)
	if c.Name == "" || runes(c.Name) > 80 {
		return c, validation("Name is required and must be at most 80 characters.")
	}
	if runes(c.Summary) > 2000 {
		return c, validation("Summary must be at most 2000 characters.")
	}
	seen := map[string]bool{normalize(c.Name): true}
	aliases := []string{}
	for _, a := range c.Aliases {
		a = compat.Trim(a)
		if a == "" || runes(a) > 40 {
			return c, validation("Aliases must be 1-40 characters.")
		}
		if seen[normalize(a)] {
			continue
		}
		seen[normalize(a)] = true
		aliases = append(aliases, a)
	}
	if len(aliases) > MaxAliases {
		return c, validation("Too many aliases.")
	}
	c.Aliases = aliases
	keys := map[string]bool{}
	fields := []Field{}
	for _, f := range c.Fields {
		f.Key, f.Value = compat.Trim(f.Key), compat.Trim(f.Value)
		if f.Key == "" || runes(f.Key) > 40 || f.Value == "" || runes(f.Value) > 2000 {
			return c, validation("Each field needs a key (≤40) and a value (≤2000).")
		}
		if keys[f.Key] {
			return c, validation("Field keys must be unique.")
		}
		keys[f.Key] = true
		fields = append(fields, f)
	}
	if len(fields) > MaxFields {
		return c, validation("Too many fields.")
	}
	c.Fields = fields
	if c.Plan != nil {
		if !PlanKinds[kind] {
			return c, validation("Only plan assets can anchor to chapters.")
		}
		if c.Plan.ChapterID == "" && c.Plan.PayoffChapterID == "" {
			c.Plan = nil
		}
	}
	return c, nil
}

func (s *Service) checkPlan(p *Plan) error {
	if p == nil {
		return nil
	}
	for _, id := range []string{p.ChapterID, p.PayoffChapterID} {
		if id == "" {
			continue
		}
		if _, e := s.App.Source(id); e != nil {
			return validation("Plan chapter does not belong to this book.")
		}
	}
	return nil
}

func appendVersion(st *State, a Asset, v Version) {
	v.Version = a.Version
	v.Kind = a.Kind
	v.Content = a.Content
	v.Status = a.Status
	list := append(st.Versions[a.ID], v)
	if len(list) > MaxVersions {
		// Keep the first version for provenance and the most recent history.
		list = append([]Version{list[0]}, list[len(list)-MaxVersions+1:]...)
	}
	st.Versions[a.ID] = list
}

func activeAssets(st *State) int {
	n := 0
	for _, a := range st.Assets {
		if a.Status != "archived" {
			n++
		}
	}
	return n
}

func (s *Service) CreateAsset(ctx context.Context, a application.Actor, key string, in AssetInput) (Asset, error) {
	var out Asset
	if Kinds[in.Kind] == "" {
		return out, validation("Unknown asset kind.")
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	if in.Status != "draft" && in.Status != "accepted" {
		return out, validation("New assets start as draft or accepted.")
	}
	content, e := cleanContent(in.Kind, in.Content)
	if e != nil {
		return out, e
	}
	if e = s.checkPlan(content.Plan); e != nil {
		return out, e
	}
	if runes(in.Note) > 500 {
		return out, validation("Note too long.")
	}
	e = s.idempotent(ctx, a, "asset.create", key, in, &out, func(st *State) error {
		if len(st.Assets) >= MaxAssets {
			return application.Fail(429, "CREATIVE_ASSET_LIMIT", "Asset limit reached.")
		}
		now := s.stamp()
		out = Asset{ID: "ca-" + compat.UUID(), BookID: st.BookID, Kind: in.Kind, Content: content, Status: in.Status, Origin: "author", Version: 1, CreatedAt: now, UpdatedAt: now}
		st.Assets[out.ID] = out
		appendVersion(st, out, Version{ActorID: a.ID, At: now, Origin: "author_create", Note: in.Note})
		return nil
	})
	return out, e
}

func (s *Service) UpdateAsset(ctx context.Context, a application.Actor, key, id string, in AssetUpdate) (Asset, error) {
	var out Asset
	if in.Content == nil && in.Status == nil {
		return out, validation("Nothing to update.")
	}
	if in.Status != nil && !AssetStatuses[*in.Status] {
		return out, validation("Unknown asset status.")
	}
	if runes(in.Note) > 500 {
		return out, validation("Note too long.")
	}
	e := s.idempotent(ctx, a, "asset.update:"+id, key, in, &out, func(st *State) error {
		current, ok := st.Assets[id]
		if !ok {
			return application.Fail(404, "NOT_FOUND", "Asset not found.")
		}
		if current.Version != in.BaseVersion {
			return &application.Error{Status: 409, Code: "ASSET_VERSION_CONFLICT", Detail: "This setting changed. Reload and retry.", Current: map[string]any{"version": current.Version}}
		}
		origin := "author_edit"
		if in.Content != nil {
			content, e := cleanContent(current.Kind, *in.Content)
			if e != nil {
				return e
			}
			if e = s.checkPlan(content.Plan); e != nil {
				return e
			}
			current.Content = content
		}
		if in.Status != nil {
			if in.Content == nil {
				origin = "status_change"
			}
			current.Status = *in.Status
			current.SupersededBy = ""
			if *in.Status == "superseded" && in.SupersededBy != nil {
				target, ok := st.Assets[*in.SupersededBy]
				if !ok || target.ID == id {
					return validation("Choose an existing replacement asset.")
				}
				current.SupersededBy = target.ID
			}
		}
		current.Version++
		current.UpdatedAt = s.stamp()
		st.Assets[id] = current
		appendVersion(st, current, Version{ActorID: a.ID, At: current.UpdatedAt, Origin: origin, Note: in.Note})
		out = current
		return nil
	})
	return out, e
}

func (s *Service) CreateLink(ctx context.Context, a application.Actor, key string, in LinkInput) (Link, error) {
	var out Link
	in.Relation = compat.Trim(in.Relation)
	if in.Relation == "" || runes(in.Relation) > 40 {
		return out, validation("Relation must be 1-40 characters.")
	}
	switch in.To.Type {
	case "asset", "knowledge_entity":
	case "chapter":
		if _, e := s.App.Source(in.To.ID); e != nil {
			return out, validation("Chapter does not belong to this book.")
		}
	default:
		return out, validation("Unknown link target.")
	}
	if in.To.ID == "" || len(in.To.ID) > 128 {
		return out, validation("Link target is required.")
	}
	e := s.idempotent(ctx, a, "link.create", key, in, &out, func(st *State) error {
		var e error
		out, e = addLink(st, in, "author", "", a.ID, s.stamp())
		return e
	})
	return out, e
}

func addLink(st *State, in LinkInput, origin, proposal, actor, now string) (Link, error) {
	if _, ok := st.Assets[in.From]; !ok {
		return Link{}, application.Fail(404, "NOT_FOUND", "Asset not found.")
	}
	if in.To.Type == "asset" {
		if _, ok := st.Assets[in.To.ID]; !ok || in.To.ID == in.From {
			return Link{}, validation("Link target asset not found.")
		}
	}
	for _, l := range st.Links {
		if l.Status == "active" && l.From == in.From && l.To == in.To && l.Relation == in.Relation {
			return l, nil
		}
	}
	if len(st.Links) >= MaxLinks {
		return Link{}, application.Fail(429, "CREATIVE_LINK_LIMIT", "Link limit reached.")
	}
	l := Link{ID: "cl-" + compat.UUID(), From: in.From, To: in.To, Relation: in.Relation, Status: "active", Origin: origin, ProposalID: proposal, ActorID: actor, CreatedAt: now}
	st.Links[l.ID] = l
	return l, nil
}

func (s *Service) RemoveLink(ctx context.Context, a application.Actor, key, id string) (Link, error) {
	var out Link
	e := s.idempotent(ctx, a, "link.remove:"+id, key, struct{}{}, &out, func(st *State) error {
		l, ok := st.Links[id]
		if !ok {
			return application.Fail(404, "NOT_FOUND", "Link not found.")
		}
		if l.Status != "removed" {
			l.Status = "removed"
			l.RemovedAt = s.stamp()
			st.Links[id] = l
		}
		out = l
		return nil
	})
	return out, e
}

// matchAsset finds an active asset of the same kind whose name or alias matches.
func matchAsset(st *State, kind, name string, aliases []string) (Asset, bool) {
	wanted := map[string]bool{normalize(name): true}
	for _, a := range aliases {
		wanted[normalize(a)] = true
	}
	ids := make([]string, 0, len(st.Assets))
	for id := range st.Assets {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		a := st.Assets[id]
		if a.Kind != kind || a.Status == "archived" || a.Status == "superseded" {
			continue
		}
		if wanted[normalize(a.Name)] {
			return a, true
		}
		for _, alias := range a.Aliases {
			if wanted[normalize(alias)] {
				return a, true
			}
		}
	}
	return Asset{}, false
}

// applyPatch returns new content; it never touches status or provenance.
func applyPatch(kind string, c Content, p Patch) (Content, error) {
	next := c
	next.Aliases = append([]string{}, c.Aliases...)
	next.Fields = append([]Field{}, c.Fields...)
	if p.Name != nil {
		next.Name = *p.Name
	}
	if p.Summary != nil {
		next.Summary = *p.Summary
	}
	next.Aliases = append(next.Aliases, p.AddAliases...)
	remove := map[string]bool{}
	for _, k := range p.RemoveFields {
		remove[compat.Trim(k)] = true
	}
	fields := []Field{}
	for _, f := range next.Fields {
		if !remove[f.Key] {
			fields = append(fields, f)
		}
	}
	for _, f := range p.SetFields {
		replaced := false
		for i := range fields {
			if fields[i].Key == compat.Trim(f.Key) {
				fields[i].Value = f.Value
				replaced = true
			}
		}
		if !replaced {
			fields = append(fields, f)
		}
	}
	next.Fields = fields
	if p.Plan != nil {
		next.Plan = p.Plan
	}
	return cleanContent(kind, next)
}

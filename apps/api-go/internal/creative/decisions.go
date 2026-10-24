package creative

import (
	"context"
	"sort"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

type DecisionInput struct {
	ProposalID string `json:"proposalId"`
	Action     string `json:"action"` // accept|accept_edited|reject
	// Content is the full resulting content for accept_edited (CREATE/UPDATE/SUPERSEDE).
	Content *Content `json:"content,omitempty"`
	// Status chooses draft|accepted for CREATE, or promotes the target on UPDATE.
	Status string `json:"status,omitempty"`
	// ExpectedVersion lets an author re-base an edited acceptance on the asset's
	// current version after reading it. Unedited acceptance never re-bases.
	ExpectedVersion *int   `json:"expectedVersion,omitempty"`
	Note            string `json:"note,omitempty"`
}

type DecideInput struct {
	Decisions []DecisionInput `json:"decisions"`
}

type DecideResult struct {
	Proposals []Proposal `json:"proposals"`
	Assets    []Asset    `json:"assets"`
	Links     []Link     `json:"links"`
}

func conflict(code, detail string, current any) error {
	return &application.Error{Status: 409, Code: code, Detail: detail, Current: current}
}

func order(op, action string) int {
	if action == "reject" {
		return 4
	}
	switch op {
	case "CREATE":
		return 0
	case "UPDATE", "SUPERSEDE":
		return 1
	default:
		return 2
	}
}

// Decide applies a batch of author decisions atomically: either every decision
// is valid and committed, or nothing changes.
func (s *Service) Decide(ctx context.Context, a application.Actor, key string, in DecideInput) (DecideResult, error) {
	out := DecideResult{Proposals: []Proposal{}, Assets: []Asset{}, Links: []Link{}}
	if len(in.Decisions) == 0 || len(in.Decisions) > 50 {
		return out, validation("Choose 1-50 proposals.")
	}
	seen := map[string]bool{}
	for _, d := range in.Decisions {
		if seen[d.ProposalID] {
			return out, validation("Each proposal can be decided once per request.")
		}
		seen[d.ProposalID] = true
		if d.Action != "accept" && d.Action != "accept_edited" && d.Action != "reject" {
			return out, validation("Unknown decision.")
		}
		if (d.Action == "accept_edited") != (d.Content != nil) {
			return out, validation("Edited acceptance requires content; other decisions must not include it.")
		}
		if d.Status != "" && d.Status != "draft" && d.Status != "accepted" {
			return out, validation("Status must be draft or accepted.")
		}
		if runes(d.Note) > 500 {
			return out, validation("Note too long.")
		}
	}
	e := s.idempotent(ctx, a, "proposals.decide", key, in, &out, func(st *State) error {
		decisions := append([]DecisionInput{}, in.Decisions...)
		for _, d := range decisions {
			if _, ok := st.Proposals[d.ProposalID]; !ok {
				return application.Fail(404, "NOT_FOUND", "Proposal not found.")
			}
		}
		sort.SliceStable(decisions, func(i, j int) bool {
			pi, pj := st.Proposals[decisions[i].ProposalID], st.Proposals[decisions[j].ProposalID]
			return order(pi.Operation, decisions[i].Action) < order(pj.Operation, decisions[j].Action)
		})
		touchedAssets := map[string]bool{}
		touchedLinks := []Link{}
		for _, d := range decisions {
			p := st.Proposals[d.ProposalID]
			if p.Status != "proposed" {
				return conflict("PROPOSAL_NOT_PENDING", "This proposal was already decided or replaced.", map[string]any{"proposalId": p.ID, "status": p.Status})
			}
			now := s.stamp()
			p.Decision = &Decision{Action: d.Action, ActorID: a.ID, At: now, Note: d.Note, Edited: d.Action == "accept_edited"}
			if d.Action == "reject" {
				p.Status = "rejected"
				st.Proposals[p.ID] = p
				out.Proposals = append(out.Proposals, p)
				continue
			}
			if e := alternativeAllowed(st, p); e != nil {
				return e
			}
			switch p.Operation {
			case "CREATE":
				content := *p.Draft
				if d.Content != nil {
					content = *d.Content
				}
				content, e := cleanContent(p.Kind, content)
				if e != nil {
					return e
				}
				if e = s.checkPlan(content.Plan); e != nil {
					return e
				}
				if existing, dup := matchAsset(st, p.Kind, content.Name, content.Aliases); dup {
					return conflict("DUPLICATE_ASSET", "A setting with this name already exists. Edit the name or merge into it.", map[string]any{"assetId": existing.ID})
				}
				if len(st.Assets) >= MaxAssets {
					return application.Fail(429, "CREATIVE_ASSET_LIMIT", "Asset limit reached.")
				}
				status := d.Status
				if status == "" {
					status = "accepted"
				}
				asset := Asset{ID: "ca-" + newID(), BookID: st.BookID, Kind: p.Kind, Content: content, Status: status, Origin: "conversation", Version: 1, CreatedAt: now, UpdatedAt: now}
				st.Assets[asset.ID] = asset
				src := p.Source
				appendVersion(st, asset, Version{ActorID: a.ID, At: now, Origin: acceptOrigin(d), ProposalID: p.ID, Source: &src, Evidence: p.Evidence, Note: d.Note})
				p.ResultAssetID, p.ResultVersion = asset.ID, asset.Version
				touchedAssets[asset.ID] = true
			case "UPDATE", "SUPERSEDE":
				asset, ok := st.Assets[p.TargetAssetID]
				if !ok {
					return conflict("PROPOSAL_STALE", "The target setting no longer exists.", map[string]any{"proposalId": p.ID})
				}
				var content Content
				var e error
				switch {
				case asset.Version == p.BaseVersion && d.Content == nil:
					content, e = applyPatch(asset.Kind, asset.Content, *p.Patch)
				case d.Content != nil && (asset.Version == p.BaseVersion || (d.ExpectedVersion != nil && *d.ExpectedVersion == asset.Version)):
					content, e = cleanContent(asset.Kind, *d.Content)
				default:
					return conflict("PROPOSAL_STALE", "The setting changed after this proposal. Review the current version and accept with edits.", map[string]any{"proposalId": p.ID, "assetId": asset.ID, "version": asset.Version, "baseVersion": p.BaseVersion})
				}
				if e != nil {
					return e
				}
				if e = s.checkPlan(content.Plan); e != nil {
					return e
				}
				asset.Content = content
				if d.Status != "" && asset.Status == "draft" {
					asset.Status = d.Status
				}
				asset.Version++
				asset.UpdatedAt = now
				st.Assets[asset.ID] = asset
				src := p.Source
				appendVersion(st, asset, Version{ActorID: a.ID, At: now, Origin: acceptOrigin(d), ProposalID: p.ID, Source: &src, Evidence: p.Evidence, Note: d.Note})
				p.ResultAssetID, p.ResultVersion = asset.ID, asset.Version
				touchedAssets[asset.ID] = true
			case "LINK":
				to := p.Link.ToAssetID
				if p.Link.ToProposalID != "" {
					target := st.Proposals[p.Link.ToProposalID]
					if target.Status != "accepted" || target.ResultAssetID == "" {
						return conflict("LINK_TARGET_PENDING", "Accept the linked new setting first.", map[string]any{"proposalId": target.ID})
					}
					to = target.ResultAssetID
				}
				l, e := addLink(st, LinkInput{From: p.TargetAssetID, To: LinkTarget{Type: "asset", ID: to}, Relation: p.Link.Relation}, "conversation", p.ID, a.ID, now)
				if e != nil {
					return e
				}
				touchedLinks = append(touchedLinks, l)
			}
			p.Status = "accepted"
			st.Proposals[p.ID] = p
			out.Proposals = append(out.Proposals, p)
		}
		ids := []string{}
		for id := range touchedAssets {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			out.Assets = append(out.Assets, st.Assets[id])
		}
		out.Links = append(out.Links, touchedLinks...)
		return nil
	})
	return out, e
}

func acceptOrigin(d DecisionInput) string {
	if d.Action == "accept_edited" {
		return "proposal_edit_accept"
	}
	return "proposal_accept"
}

// alternativeAllowed enforces that mutually exclusive options never become
// canon together. Archiving the chosen option re-opens the group.
func alternativeAllowed(st *State, p Proposal) error {
	if p.AlternativeGroup == "" {
		return nil
	}
	for _, other := range st.Proposals {
		if other.ID == p.ID || other.AlternativeGroup != p.AlternativeGroup || other.Status != "accepted" {
			continue
		}
		if asset, ok := st.Assets[other.ResultAssetID]; ok && (asset.Status == "archived" || asset.Status == "superseded") {
			continue
		}
		return conflict("ALTERNATIVE_CONFLICT", "Another option from the same set of alternatives is already accepted.", map[string]any{"proposalId": other.ID})
	}
	return nil
}

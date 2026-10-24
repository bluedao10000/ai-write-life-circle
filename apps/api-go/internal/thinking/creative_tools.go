package thinking

import (
	"context"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

// creativeTools are read-only views of author assets, plus one controlled
// workflow that only queues organizing of the current turn. None writes assets.
var creativeTools = map[string]bool{
	"list_creative_assets":         true,
	"get_creative_asset":           true,
	"list_creative_proposals":      true,
	"list_open_questions":          true,
	"get_writing_context":          true,
	"compare_plan_with_manuscript": true,
	"request_turn_organize":        true,
}

const assetNotice = "status=accepted is author-confirmed canon; status=draft is an author draft. Plans describe intentions, not events that already happened in the manuscript."
const proposalNotice = "UNCONFIRMED AI proposals awaiting author review. Use them only as labelled possibilities for brainstorming, never as decided canon."

type toolAsset struct {
	ID      string           `json:"assetId"`
	Kind    string           `json:"kind"`
	Name    string           `json:"name"`
	Aliases []string         `json:"aliases,omitempty"`
	Status  string           `json:"status"`
	Summary string           `json:"summary,omitempty"`
	Fields  []creative.Field `json:"fields,omitempty"`
	Plan    *creative.Plan   `json:"plan,omitempty"`
	Version int              `json:"version"`
}

func compactAsset(a creative.Asset) toolAsset {
	fields := a.Fields
	if len(fields) > 12 {
		fields = fields[:12]
	}
	return toolAsset{ID: a.ID, Kind: a.Kind, Name: a.Name, Aliases: a.Aliases, Status: a.Status, Summary: a.Summary, Fields: fields, Plan: a.Plan, Version: a.Version}
}

func compactAssets(list []creative.Asset) []toolAsset {
	out := []toolAsset{}
	for _, a := range list {
		out = append(out, compactAsset(a))
	}
	return out
}

func (s *Service) creativeTool(ctx context.Context, rec Record, app *application.Service, name string, args toolArgs) (any, error) {
	c := creative.New(app, llm.Config{}, nil)
	switch name {
	case "list_creative_assets":
		if args.Kind != "" && creative.Kinds[args.Kind] == "" {
			return nil, fail(422, "INVALID_TOOL_ARGUMENTS")
		}
		page, e := c.Assets(ctx, creative.AssetQuery{Kind: args.Kind, Q: args.Query, Limit: 20})
		if e != nil {
			return nil, e
		}
		items := []toolAsset{}
		for _, a := range page.Items {
			if a.Status != "archived" {
				items = append(items, compactAsset(a.Asset))
			}
		}
		return map[string]any{"assets": items, "total": page.Total, "notice": assetNotice}, nil
	case "get_creative_asset":
		d, e := c.Asset(ctx, args.Asset)
		if e != nil {
			return nil, e
		}
		links := []map[string]string{}
		for _, l := range d.Links {
			links = append(links, map[string]string{"relation": l.Relation, "from": l.FromName, "to": l.ToName, "toType": l.To.Type})
		}
		pending := 0
		for _, p := range d.Proposals {
			if p.Status == "proposed" {
				pending++
			}
		}
		return map[string]any{"asset": compactAsset(d.Asset), "links": links, "versions": len(d.Versions), "pendingProposals": pending, "notice": assetNotice}, nil
	case "list_creative_proposals", "list_open_questions":
		page, e := c.Proposals(ctx, creative.ProposalQuery{Status: "proposed", Limit: 20})
		if e != nil {
			return nil, e
		}
		type item struct {
			ID          string `json:"proposalId"`
			Operation   string `json:"operation"`
			Kind        string `json:"kind"`
			Stance      string `json:"stance"`
			Exploratory bool   `json:"exploratory"`
			Group       string `json:"alternativeGroup,omitempty"`
			Name        string `json:"name,omitempty"`
			Target      string `json:"targetName,omitempty"`
			Reason      string `json:"reason,omitempty"`
		}
		items := []item{}
		for _, p := range page.Items {
			if name == "list_open_questions" && p.Kind != "open_question" {
				continue
			}
			v := item{ID: p.ID, Operation: p.Operation, Kind: p.Kind, Stance: p.Stance, Exploratory: p.Exploratory, Group: p.AlternativeGroup, Target: p.TargetName, Reason: p.Reason}
			if p.Result != nil {
				v.Name = p.Result.Name
			}
			items = append(items, v)
		}
		out := map[string]any{"unconfirmedProposals": items, "notice": proposalNotice}
		if name == "list_open_questions" {
			q, e := c.Assets(ctx, creative.AssetQuery{Kind: "open_question", Limit: 20})
			if e != nil {
				return nil, e
			}
			list := []creative.Asset{}
			for _, a := range q.Items {
				if a.Status == "accepted" || a.Status == "draft" {
					list = append(list, a.Asset)
				}
			}
			out["openQuestions"] = compactAssets(list)
		}
		return out, nil
	case "get_writing_context", "compare_plan_with_manuscript":
		w, e := c.WritingContext(ctx, args.Chapter)
		if e != nil {
			return nil, e
		}
		out := map[string]any{"chapterId": w.ChapterID, "plans": compactAssets(w.Plans), "payoffs": compactAssets(w.Payoffs), "characters": compactAssets(w.Characters), "rules": compactAssets(w.Rules), "related": compactAssets(w.Related), "openQuestions": compactAssets(w.Questions), "notice": w.Notice + " " + assetNotice}
		if name == "compare_plan_with_manuscript" {
			out["divergences"] = w.Divergences
			if contains(rec.Scopes, "knowledge") {
				k := knowledge.New(app, llm.Config{}, nil)
				k.QueueOnly = true
				if assertions, e := k.Retrieve(ctx, args.Chapter); e == nil {
					if len(assertions) > 30 {
						assertions = assertions[:30]
					}
					out["manuscriptObservations"] = assertions
					out["notice"] = "Plans are author intentions; manuscriptObservations are AI observations of saved text (observation/claim/inference). A difference is not an error: ask the author whether to update the plan, adjust later chapters or keep the change."
				}
			}
		}
		return out, nil
	case "request_turn_organize":
		if rec.LastMessage == "" {
			return nil, fail(409, "NO_TURN_TO_ORGANIZE")
		}
		t, e := c.AcceptTurn(ctx, rec.ID, rec.LastMessage, "manual")
		if e != nil {
			return nil, e
		}
		_ = app.Audit(ctx, application.Actor{ID: rec.Owner, Role: "agent"}, "", rec.ID, "creative.organize.requested", map[string]any{"sessionId": rec.ID, "messageId": rec.LastMessage})
		return map[string]any{"turnStatus": t.Status, "notice": "Organizing is queued after this reply completes. Results are proposals for the author to review; nothing becomes canon automatically."}, nil
	}
	return nil, fail(403, "TOOL_FORBIDDEN")
}

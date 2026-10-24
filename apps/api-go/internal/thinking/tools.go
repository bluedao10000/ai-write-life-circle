package thinking

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type toolArgs struct {
	Query    string `json:"query,omitempty"`
	Quote    string `json:"quote,omitempty"`
	Chapter  string `json:"chapterId,omitempty"`
	Revision string `json:"revisionId,omitempty"`
	Entity   string `json:"entityId,omitempty"`
	Start    int    `json:"startUTF16,omitempty"`
	Asset    string `json:"assetId,omitempty"`
	Kind     string `json:"kind,omitempty"`
}

func sliceUTF16(text string, start, end int) (string, bool) {
	r := utf16.Encode([]rune(text))
	if start < 0 || end < start || end > len(r) {
		return "", false
	}
	if start < len(r) && r[start] >= 0xdc00 && r[start] <= 0xdfff {
		return "", false
	}
	if end < len(r) && r[end] >= 0xdc00 && r[end] <= 0xdfff {
		return "", false
	}
	return string(utf16.Decode(r[start:end])), true
}
func makeSource(c application.Chapter, r application.StoredRevision, start, end int) (Source, error) {
	q, ok := sliceUTF16(r.Markdown, start, end)
	if !ok {
		return Source{}, fail(422, "INVALID_RANGE")
	}
	return Source{ID: "src-" + hash([]any{c.ID, r.ID, r.Hash, start, end})[:24], Chapter: c.ID, Title: c.Title, Revision: r.ID, Hash: r.Hash, Quote: q, Start: start, End: end, Validity: "current"}, nil
}
func (s *Service) validateSelection(ctx context.Context, rec Record, in Selection) error {
	app, e := s.Management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if e != nil {
		return e
	}
	r, e := app.SavedRevisionAt(ctx, in.Chapter, in.Revision)
	if e != nil {
		return e
	}
	if in.Revision == "" || r.Hash != in.Hash || in.Quote == "" || compat.UTF16Len(in.Quote) > 4000 || strings.Count(r.Markdown, in.Quote) != 1 {
		return fail(422, "INVALID_SELECTION")
	}
	return nil
}
func (s *Service) checkSource(ctx context.Context, rec Record, in Source) (Source, error) {
	app, e := s.Management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if e != nil {
		return in, e
	}
	c, e := app.Source(in.Chapter)
	if e != nil {
		return in, e
	}
	r, e := app.SavedRevisionAt(ctx, in.Chapter, in.Revision)
	if e != nil {
		return in, e
	}
	out, e := makeSource(c, r, in.Start, in.End)
	if e != nil || out.ID != in.ID || out.Hash != in.Hash || out.Quote != in.Quote {
		return in, fail(422, "INVALID_SOURCE")
	}
	head, e := app.SavedRevisionAt(ctx, in.Chapter, "")
	if e != nil {
		return in, e
	}
	if head.ID != in.Revision || head.Hash != in.Hash {
		out.Validity = "stale"
	}
	out.Epistemic = in.Epistemic
	return out, nil
}

// Only source cards, never model prose, carry a validated evidence label.
func (s *Service) validateResponseSources(ctx context.Context, rec Record, raw json.RawMessage) (json.RawMessage, error) {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil, fail(502, "AGENT_INVALID_RESPONSE")
	}
	var walk func(any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for key, val := range x {
				if key == "sources" {
					arr, ok := val.([]any)
					if !ok {
						continue
					}
					valid := []Source{}
					for _, item := range arr {
						b, _ := json.Marshal(item)
						var src Source
						if json.Unmarshal(b, &src) == nil {
							if out, e := s.checkSource(ctx, rec, src); e == nil {
								valid = append(valid, out)
							}
						}
					}
					x[key] = valid
				} else {
					walk(val)
				}
			}
		case []any:
			for _, item := range x {
				walk(item)
			}
		}
	}
	walk(v)
	return json.Marshal(v)
}

func (s *Service) PrivateHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			reply(w, nil, fail(404, "NOT_FOUND"), 0)
			return
		}
		rec, e := s.authorize(Bearer(r))
		if e != nil {
			reply(w, nil, e, 0)
			return
		}
		if r.URL.Path == "/internal/v1/agent/authorize" {
			reply(w, map[string]any{"sessionId": rec.ID, "authorId": rec.Owner, "bookId": rec.Book, "model": rec.Model, "scopes": rec.Scopes}, nil, 200)
			return
		}
		if r.URL.Path != "/internal/v1/agent/tools/execute" {
			reply(w, nil, fail(404, "NOT_FOUND"), 0)
			return
		}
		var in struct {
			Session string          `json:"sessionId"`
			Tool    string          `json:"tool"`
			Args    json.RawMessage `json:"arguments"`
		}
		if e = decode(w, r, &in); e != nil {
			reply(w, nil, e, 0)
			return
		}
		if in.Session != rec.ID {
			reply(w, nil, fail(403, "CAPABILITY_MISMATCH"), 0)
			return
		}
		var args toolArgs
		d := json.NewDecoder(bytes.NewReader(in.Args))
		d.DisallowUnknownFields()
		if d.Decode(&args) != nil || len(args.Query) > 256 || len(args.Asset) > 128 || len(args.Kind) > 40 {
			reply(w, nil, fail(422, "INVALID_TOOL_ARGUMENTS"), 0)
			return
		}
		e = s.tx(r.Context(), func(st *registry) error {
			v := st.Sessions[rec.ID]
			if v.Deleted || v.Nonce != rec.Nonce {
				return fail(403, "CAPABILITY_REVOKED")
			}
			if v.Calls >= v.Model.Limits.Tools {
				return fail(429, "TOOL_BUDGET_EXCEEDED")
			}
			v.Calls++
			st.Sessions[v.ID] = v
			return nil
		})
		if e != nil {
			reply(w, nil, e, 0)
			return
		}
		out, e := s.execute(r.Context(), rec, in.Tool, args)
		if e == nil {
			raw, _ := json.Marshal(out)
			if len(raw) > rec.Model.Limits.ResultBytes {
				e = fail(422, "TOOL_RESULT_TOO_LARGE")
			}
		}
		// Recheck the grant after I/O; revocation never returns late private data.
		if e == nil {
			_, e = s.authorize(Bearer(r))
		}
		reply(w, out, e, 200)
	})
}
func (s *Service) execute(ctx context.Context, rec Record, name string, args toolArgs) (any, error) {
	scope := "knowledge"
	if name == "read_chapter" || name == "find_related_chapters" {
		scope = "chapters"
	}
	if name == "get_author_notes" {
		scope = "notes"
	}
	if creativeTools[name] {
		scope = "creative"
	}
	if !contains(rec.Scopes, scope) {
		return nil, fail(403, "SCOPE_FORBIDDEN")
	}
	app, e := s.Management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if e != nil {
		return nil, e
	}
	switch name {
	case "read_chapter":
		c, e := app.Source(args.Chapter)
		if e != nil {
			return nil, e
		}
		r, e := app.SavedRevisionAt(ctx, c.ID, args.Revision)
		if e != nil {
			return nil, e
		}
		end := min(compat.UTF16Len(r.Markdown), args.Start+2400)
		if args.Quote != "" {
			if compat.UTF16Len(args.Quote) > 4000 || strings.Count(r.Markdown, args.Quote) != 1 {
				return nil, fail(422, "INVALID_SELECTION")
			}
			index := strings.Index(r.Markdown, args.Quote)
			args.Start = compat.UTF16Len(r.Markdown[:index])
			end = args.Start + compat.UTF16Len(args.Quote)
		}
		if _, ok := sliceUTF16(r.Markdown, args.Start, end); !ok && end > args.Start {
			end--
		}
		src, e := makeSource(c, r, args.Start, end)
		if e != nil {
			return nil, e
		}
		head, e := app.SavedRevisionAt(ctx, c.ID, "")
		if e != nil {
			return nil, e
		}
		if head.ID != r.ID {
			src.Validity = "stale"
		}
		return map[string]any{"sources": []Source{src}, "totalUTF16": compat.UTF16Len(r.Markdown), "truncated": end < compat.UTF16Len(r.Markdown)}, nil
	case "find_related_chapters":
		p, e := app.Projection()
		if e != nil {
			return nil, e
		}
		chapters, e := application.Sources(p)
		if e != nil {
			return nil, e
		}
		all := application.OrderedChapters(chapters)
		type hit struct {
			Chapter  string `json:"chapterId"`
			Title    string `json:"title"`
			Revision string `json:"revisionId"`
			Hash     string `json:"contentHash"`
			Score    int    `json:"score"`
		}
		items := []hit{}
		query := []rune(strings.ToLower(args.Query))
		terms := []string{}
		for i := 0; i+1 < len(query) && i < 128; i++ {
			terms = append(terms, string(query[i:i+2]))
		}
		for i, c := range all {
			if len(all) > 64 && i < len(all)-32 && i%(max(1, (len(all)-32)/32)) != 0 {
				continue
			}
			if len(items) >= 64 {
				break
			}
			rev, e := app.SavedRevisionAt(ctx, c.ID, "")
			if e != nil {
				continue
			}
			n := 0
			for _, term := range terms {
				if strings.Contains(strings.ToLower(c.Title+rev.Markdown), term) {
					n++
				}
			}
			items = append(items, hit{c.ID, c.Title, rev.ID, rev.Hash, n})
		}
		sort.SliceStable(items, func(i, j int) bool { return items[i].Score > items[j].Score })
		return map[string]any{"items": items[:min(8, len(items))], "candidateLimit": 64, "totalChapters": len(all)}, nil
	case "get_author_notes":
		return app.Notes()
	case "list_creative_assets", "get_creative_asset", "list_creative_proposals", "list_open_questions", "get_writing_context", "compare_plan_with_manuscript", "request_turn_organize":
		return s.creativeTool(ctx, rec, app, name, args)
	case "search_knowledge", "get_entity", "get_timeline", "get_plot_threads":
		k := knowledge.New(app, llm.Config{}, nil)
		k.QueueOnly = true
		q := knowledge.Query{Name: args.Query, EntityID: args.Entity, Limit: 8}
		if name == "get_timeline" {
			q.Type = "event"
		}
		if name == "get_plot_threads" {
			q.Type = "plot_line,foreshadowing"
		}
		page, e := k.Query(ctx, q)
		if e != nil {
			return nil, e
		}
		sources := []Source{}
		for _, a := range page.Assertions {
			for _, src := range a.Sources {
				if src.Retired || src.Validity != "current" {
					continue
				}
				c, e := app.Source(src.ChapterID)
				if e != nil {
					continue
				}
				r, e := app.SavedRevisionAt(ctx, c.ID, src.RevisionID)
				if e != nil || r.Hash != src.ContentHash {
					continue
				}
				out, e := makeSource(c, r, src.Start, src.End)
				if e == nil && out.Quote == src.Quote {
					out.Epistemic = a.Epistemic
					sources = append(sources, out)
				}
			}
		}
		return map[string]any{"entities": page.Entities, "assertions": page.Assertions, "sources": sources, "total": page.Total, "notice": "AI observations, claims and inferences are not author canon. Missing knowledge is not proof of absence."}, nil
	default:
		return nil, fail(403, "TOOL_FORBIDDEN")
	}
}

package thinking

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func (s *Service) storyContextHandler(w http.ResponseWriter, r *http.Request, rec Record) {
	var in struct {
		Session string `json:"sessionId"`
		Query   string `json:"query"`
	}
	if err := decode(w, r, &in); err != nil {
		reply(w, nil, err, 0)
		return
	}
	if in.Session != rec.ID {
		reply(w, nil, fail(403, "CAPABILITY_MISMATCH"), 0)
		return
	}
	if !contains(rec.Scopes, "creative") {
		reply(w, nil, fail(403, "SCOPE_FORBIDDEN"), 0)
		return
	}
	if len([]rune(in.Query)) > 2000 {
		reply(w, nil, fail(422, "INVALID_TOOL_ARGUMENTS"), 0)
		return
	}
	app, err := s.Management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if err != nil {
		reply(w, nil, err, 0)
		return
	}
	out, err := creative.New(app, llm.Config{}, nil).StoryContext(r.Context(), rec.ID, in.Query)
	if err == nil {
		_, err = s.authorize(Bearer(r))
	}
	reply(w, out, err, 200)
}

type storySnapshot struct {
	creative.Snapshot
	Run struct {
		ID                   string `json:"runId"`
		Message              string `json:"messageId"`
		Status               string `json:"status"`
		AuthorizationVersion int    `json:"authorizationVersion"`
	} `json:"run"`
}

func (s *Service) discussionSnapshot(ctx context.Context, rec Record, session string) (storySnapshot, error) {
	var snap storySnapshot
	if session == "" || len(session) > 128 {
		return snap, fail(422, "INVALID_TOOL_ARGUMENTS")
	}
	if err := s.Owned(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book, session); err != nil {
		return snap, err
	}
	raw, found, err := s.Snapshot(ctx, session)
	if err != nil {
		return snap, err
	}
	if !found {
		return snap, fail(404, "SESSION_NOT_FOUND")
	}
	if json.Unmarshal(raw, &snap) != nil || snap.SessionID != session || snap.BookID != rec.Book {
		return snap, fail(502, "AGENT_INVALID_RESPONSE")
	}
	return snap, nil
}

func (s *Service) currentStoryMessages(ctx context.Context, rec Record, message, run string, evidence []creative.StoryEvidence) ([]creative.TurnMessage, error) {
	if message == "" || run == "" || len(message) > 128 || len(run) > 128 {
		return nil, fail(422, "CURRENT_TURN_REQUIRED")
	}
	snap, err := s.discussionSnapshot(ctx, rec, rec.ID)
	if err != nil {
		return nil, err
	}
	if snap.Status != "running" || snap.Run.ID != run || snap.Run.Message != message || snap.Run.AuthorizationVersion != rec.AuthorizationVersion || !contains([]string{"accepted", "running", "checkpointed"}, snap.Run.Status) {
		return nil, fail(409, "STALE_STORY_TURN")
	}
	current := -1
	for i, m := range snap.Messages {
		if m.Role == "user" {
			current = i
		}
	}
	if current < 0 || snap.Messages[current].ID != message || snap.Messages[current].Status != "completed" {
		return nil, fail(409, "STALE_STORY_TURN")
	}
	// Current author evidence remains intact. Older originals are bounded and
	// incomplete assistant attempts never establish an option to be adopted.
	m := snap.Messages[current]
	out := []creative.TurnMessage{{ID: m.ID, Role: m.Role, Text: m.Text}}
	remaining := 24000
	for i := current - 1; i >= 0 && len(out) < 12 && remaining > 0; i-- {
		m = snap.Messages[i]
		if (m.Role != "user" && m.Role != "assistant") || m.Status != "completed" {
			continue
		}
		text := []rune(m.Text)
		if len(text) > remaining {
			text = text[:remaining]
		}
		remaining -= len(text)
		out = append(out, creative.TurnMessage{ID: m.ID, Role: m.Role, Text: string(text)})
	}
	// An explicitly cited older option may be outside the recent window. Only
	// exact excerpts verified against its original completed message are added.
	for _, ref := range evidence {
		if ref.MessageID == message || ref.Quote == "" || len([]rune(ref.Quote)) > 1000 {
			continue
		}
		for _, original := range snap.Messages[:current] {
			if original.ID == ref.MessageID && original.Status == "completed" && (original.Role == "user" || original.Role == "assistant") && strings.Contains(original.Text, ref.Quote) {
				out = append(out, creative.TurnMessage{ID: original.ID, Role: original.Role, Text: ref.Quote})
				break
			}
		}
	}
	return out, nil
}

func strictStoryArgs(raw json.RawMessage, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(out) != nil {
		return fail(422, "INVALID_TOOL_ARGUMENTS")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return fail(422, "INVALID_TOOL_ARGUMENTS")
	}
	return nil
}

func (s *Service) executeStoryTool(ctx context.Context, rec Record, name, message, run string, raw json.RawMessage) (any, error) {
	if !contains(rec.Scopes, "creative") {
		return nil, fail(403, "SCOPE_FORBIDDEN")
	}
	if name == "get_discussion_source" {
		var in struct {
			Session string `json:"sessionId"`
			Message string `json:"messageId"`
		}
		if err := strictStoryArgs(raw, &in); err != nil {
			return nil, err
		}
		if in.Message == "" || len(in.Message) > 128 {
			return nil, fail(422, "INVALID_TOOL_ARGUMENTS")
		}
		snap, err := s.discussionSnapshot(ctx, rec, in.Session)
		if err != nil {
			return nil, err
		}
		for _, m := range snap.Messages {
			if m.ID != in.Message || m.Status != "completed" || (m.Role != "user" && m.Role != "assistant") {
				continue
			}
			text := []rune(m.Text)
			truncated := len(text) > 4000
			if truncated {
				text = text[:4000]
			}
			return map[string]any{"sessionId": in.Session, "messageId": m.ID, "role": m.Role, "text": string(text), "truncated": truncated, "notice": "Original discussion, not automatic canon. Assistant text is a suggestion; character viewpoints are not world facts."}, nil
		}
		return nil, fail(404, "DISCUSSION_SOURCE_NOT_FOUND")
	}
	var changes creative.RecordStoryChangesInput
	var focus creative.DiscussionFocusInput
	if name == "record_story_changes" {
		if err := strictStoryArgs(raw, &changes); err != nil {
			return nil, err
		}
	} else if name == "update_discussion_focus" {
		if err := strictStoryArgs(raw, &focus); err != nil {
			return nil, err
		}
	} else {
		return nil, fail(403, "TOOL_FORBIDDEN")
	}
	evidence := []creative.StoryEvidence{}
	for _, change := range changes.Changes {
		evidence = append(evidence, change.Evidence...)
	}
	messages, err := s.currentStoryMessages(ctx, rec, message, run, evidence)
	if err != nil {
		return nil, err
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	app, err := s.Management.Resolve(actor, rec.Book)
	if err != nil {
		return nil, err
	}
	c := creative.New(app, llm.Config{}, nil)
	var out any
	// Hold the grant while committing local state, so a scope revocation cannot
	// cross a successful authorization check and then allow a late write.
	err = s.tx(ctx, func(st *registry) error {
		live, ok := st.Sessions[rec.ID]
		if !ok || live.Deleted || live.Nonce != rec.Nonce || !contains(live.Scopes, "creative") {
			return fail(403, "CAPABILITY_REVOKED")
		}
		var e error
		if name == "record_story_changes" {
			var receipt creative.StoryChangeReceipt
			receipt, e = c.RecordStoryChanges(ctx, actor, "story:"+message, rec.ID, message, changes, messages)
			// Full before/after versions remain available through the public receipt
			// API; the model only needs the committed result and current versions.
			items := []map[string]any{}
			for _, change := range receipt.Changes {
				item := map[string]any{"intent": change.Intent, "name": change.Name}
				if change.AssetID != "" {
					item["assetId"] = change.AssetID
				}
				if change.ProposalID != "" {
					item["proposalId"] = change.ProposalID
				}
				if change.After != nil {
					item["version"] = change.After.Version
				}
				items = append(items, item)
			}
			out = map[string]any{"changeId": receipt.ChangeID, "sessionId": receipt.SessionID, "messageId": receipt.MessageID, "status": receipt.Status, "changes": items}
		} else {
			out, e = c.UpdateDiscussionFocus(ctx, actor, "focus:"+message, rec.ID, message, focus)
		}
		return e
	})
	return out, err
}

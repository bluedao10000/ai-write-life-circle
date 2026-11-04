package agenttasks

import (
	"context"
	"unicode/utf8"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
)

const MemorySourceBytes = 16 * 1024

type MemorySource struct {
	Evidence  TaskEvidence        `json:"evidence"`
	Source    MemorySourceContent `json:"source"`
	Truncated bool                `json:"truncated"`
}
type MemorySourceContent struct {
	Type        string                 `json:"type"`
	ChapterID   string                 `json:"chapterId,omitempty"`
	RevisionID  string                 `json:"revisionId,omitempty"`
	ContentHash string                 `json:"contentHash,omitempty"`
	Text        string                 `json:"text,omitempty"`
	SessionID   string                 `json:"sessionId,omitempty"`
	MessageID   string                 `json:"messageId,omitempty"`
	Messages    []creative.TurnMessage `json:"messages,omitempty"`
}

// MemorySource reads the primary chapter or captured discussion, not the full model request.
func (s *Service) MemorySource(ctx context.Context, actor application.Actor, book, id string) (MemorySource, error) {
	var out MemorySource
	if actor.Role != "author" {
		return out, application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Author identity required.")
	}
	app, e := s.Management.Resolve(actor, book)
	if e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	st, e := s.load()
	if e != nil {
		return out, e
	}
	r, ok := st.Tasks[id]
	unavailable := func() (MemorySource, error) {
		return MemorySource{}, application.Fail(404, "MEMORY_SOURCE_UNAVAILABLE", "Original task source is unavailable.")
	}
	if !ok || r.Task.Author != actor.ID || r.Task.Book != book || !r.Finished || r.Outcome != "completed" || r.CompletedAt == "" || r.Task.InputHash == "" || r.Task.Strategy == "" {
		return unavailable()
	}
	out.Evidence = TaskEvidence{id, r.Task.Kind, r.Task.Strategy, r.Task.InputHash, r.CompletedAt}
	if r.Task.Kind == "creative.organize" {
		job := r.Creative.Claim.Job
		turn, err := s.creative(app).Excerpt(ctx, job.TurnKey)
		if err != nil {
			return out, err
		}
		if turn.JobID != job.ID || turn.SessionID != job.SessionID || (turn.Status != "organized" && turn.Status != "no_change") || len(turn.Excerpt) == 0 {
			return unavailable()
		}
		out.Source = MemorySourceContent{Type: "discussion", SessionID: turn.SessionID, MessageID: turn.MessageID, Messages: []creative.TurnMessage{}}
		remaining := MemorySourceBytes
		for _, message := range turn.Excerpt {
			if remaining == 0 {
				out.Truncated = true
				break
			}
			text := sourcePrefix(message.Text, remaining)
			out.Truncated = out.Truncated || len(text) < len(message.Text)
			message.Text = text
			out.Source.Messages = append(out.Source.Messages, message)
			remaining -= len(text)
			if out.Truncated {
				break
			}
		}
	} else {
		chapter := ""
		switch r.Task.Kind {
		case "knowledge.extract":
			chapter = r.Knowledge.Claim.Job.ChapterID
		case "review.execute":
			chapter = r.Review.Run.ChapterID
		case "creative.plan_check":
			chapter = r.Creative.Claim.Job.ChapterID
		}
		if chapter == "" || r.Task.Revision == "" || r.Task.ContentHash == "" {
			return unavailable()
		}
		revision, err := app.SavedRevisionAt(ctx, chapter, r.Task.Revision)
		if err != nil {
			return out, err
		}
		if revision.ID != r.Task.Revision || revision.Hash != r.Task.ContentHash {
			return unavailable()
		}
		text := sourcePrefix(revision.Markdown, MemorySourceBytes)
		out.Source = MemorySourceContent{Type: "chapter", ChapterID: chapter, RevisionID: revision.ID, ContentHash: revision.Hash, Text: text}
		out.Truncated = len(text) < len(revision.Markdown)
	}
	if e = ctx.Err(); e != nil {
		return MemorySource{}, e
	}
	return out, nil
}

func sourcePrefix(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	end := limit
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return text[:end]
}

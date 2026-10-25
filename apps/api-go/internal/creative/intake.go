package creative

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

// SnapshotMessage mirrors the Pi ThinkingMessage fields Go needs.
type SnapshotMessage struct {
	ID     string `json:"id"`
	Role   string `json:"role"`
	Text   string `json:"text"`
	Status string `json:"status"`
}

type Snapshot struct {
	SessionID string            `json:"sessionId"`
	BookID    string            `json:"bookId"`
	Status    string            `json:"status"`
	Messages  []SnapshotMessage `json:"messages"`
}

const turnTimeout = 15 * time.Minute

func TurnKey(session, message string) string { return session + ":" + message }

// AcceptTurn durably records that a Thinking message was accepted by Pi. It is
// called after Pi returns 202, never before, so a turn always refers to a
// persisted message. Auto triggers are silently ignored when organizing is off.
func (s *Service) AcceptTurn(ctx context.Context, session, message, trigger string) (Turn, error) {
	var out Turn
	if session == "" || message == "" || len(session) > 128 || len(message) > 128 {
		return out, validation("Session and message are required.")
	}
	e := s.transaction(ctx, func(st *State) (bool, error) {
		if !st.Settings.Enabled || st.Settings.Paused {
			if trigger == "auto" {
				return false, nil
			}
			return false, consentRequired("Enable creative organizing for this book first.")
		}
		if trigger == "auto" && !st.Settings.AutoOrganize {
			return false, nil
		}
		key := TurnKey(session, message)
		now := s.stamp()
		if t, ok := st.Turns[key]; ok {
			out = t
			// A manual retry re-arms only terminal, unproductive turns.
			if trigger == "manual" && (t.Status == "failed" || t.Status == "skipped" || t.Status == "expired") {
				t.Status, t.Reason, t.Trigger, t.UpdatedAt, t.JobID = "awaiting", "", "manual", now, ""
				t.AcceptedAt = now
				st.Turns[key] = t
				out = t
				return true, nil
			}
			return false, nil
		}
		if len(st.Turns) >= MaxTurns {
			return false, application.Fail(429, "CREATIVE_TURN_LIMIT", "Turn history is full.")
		}
		out = Turn{Key: key, SessionID: session, MessageID: message, AnswerID: message + "-answer", Status: "awaiting", Trigger: trigger, AcceptedAt: now, UpdatedAt: now}
		st.Turns[key] = out
		return true, nil
	})
	return out, e
}

// Awaiting lists turns whose Thinking answer has not been captured yet.
func (s *Service) Awaiting(ctx context.Context) ([]Turn, error) {
	st, e := s.load()
	if e != nil {
		return nil, e
	}
	out := []Turn{}
	for _, t := range st.Turns {
		if t.Status == "awaiting" {
			out = append(out, t)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AcceptedAt < out[j].AcceptedAt })
	return out, nil
}

func excerptHash(msgs []TurnMessage) string {
	b, _ := json.Marshal(msgs)
	return compat.Hash(string(b))
}

// buildExcerpt keeps the focus pair and as many preceding messages as the
// count and byte bounds allow. It never truncates the focus messages.
func buildExcerpt(msgs []SnapshotMessage, answer int) ([]TurnMessage, bool) {
	start := max(0, answer-MaxExcerptMsgs+1)
	out := []TurnMessage{}
	for i := start; i <= answer; i++ {
		m := msgs[i]
		if m.Status != "completed" || m.Text == "" {
			continue
		}
		out = append(out, TurnMessage{ID: m.ID, Role: m.Role, Text: m.Text})
	}
	size := func() int {
		n := 0
		for _, m := range out {
			n += len(m.Text) + len(m.ID) + 16
		}
		return n
	}
	for len(out) > 2 && size() > MaxExcerptBytes {
		out = out[1:]
	}
	return out, size() <= MaxExcerptBytes
}

// Capture inspects a Pi snapshot for an awaiting turn. A completed answer
// becomes a bounded excerpt and a pending job; an incomplete answer is skipped.
func (s *Service) Capture(ctx context.Context, key string, snap *Snapshot, missing bool) error {
	return s.transaction(ctx, func(st *State) (bool, error) {
		t, ok := st.Turns[key]
		if !ok || t.Status != "awaiting" {
			return false, nil
		}
		now := s.stamp()
		finish := func(status, reason string) (bool, error) {
			t.Status, t.Reason, t.UpdatedAt = status, reason, now
			st.Turns[key] = t
			return true, nil
		}
		if missing || (snap != nil && snap.Status == "deleted") {
			return finish("cancelled", "SESSION_DELETED")
		}
		accepted, _ := time.Parse(time.RFC3339Nano, t.AcceptedAt)
		expired := s.now().Sub(accepted) > turnTimeout
		if snap == nil {
			if expired {
				return finish("expired", "THINKING_UNAVAILABLE")
			}
			return false, nil
		}
		if snap.SessionID != t.SessionID || snap.BookID != st.BookID {
			return finish("skipped", "SESSION_MISMATCH")
		}
		user, answer := -1, -1
		for i, m := range snap.Messages {
			if m.ID == t.MessageID && m.Role == "user" {
				user = i
			}
			if m.ID == t.AnswerID && m.Role == "assistant" {
				answer = i
			}
		}
		if user < 0 || answer != user+1 {
			if expired {
				return finish("expired", "MESSAGE_NOT_FOUND")
			}
			return false, nil
		}
		switch snap.Messages[answer].Status {
		case "completed":
		case "failed", "cancelled", "interrupted":
			return finish("skipped", "ANSWER_"+snap.Messages[answer].Status)
		default:
			if expired {
				return finish("expired", "ANSWER_TIMEOUT")
			}
			return false, nil
		}
		excerpt, fits := buildExcerpt(snap.Messages, answer)
		if !fits || len(excerpt) < 2 {
			return finish("skipped", "TURN_TOO_LARGE")
		}
		if len(st.Jobs) >= MaxJobs {
			return finish("failed", "CREATIVE_JOB_LIMIT")
		}
		t.Excerpt, t.ExcerptHash, t.CapturedAt = excerpt, excerptHash(excerpt), now
		job := Job{ID: "cj-" + newID(), Kind: "organize", TurnKey: key, SessionID: t.SessionID, Strategy: Strategy, Model: st.Settings.Model, Status: "pending", Due: now, CreatedAt: now}
		st.Jobs = append(st.Jobs, job)
		t.JobID = job.ID
		return finish("queued", "")
	})
}

// CancelSession invalidates every derived artifact of a deleted conversation:
// queued work is cancelled, unreviewed proposals expire, and conversation text
// (excerpts and evidence quotes) is purged. Accepted asset content remains the
// author's, with provenance marked as deleted.
func (s *Service) CancelSession(ctx context.Context, session string) error {
	return s.transaction(ctx, func(st *State) (bool, error) {
		changed := false
		now := s.stamp()
		for key, t := range st.Turns {
			if t.SessionID != session {
				continue
			}
			if t.Status == "awaiting" || t.Status == "queued" {
				t.Status, t.Reason = "cancelled", "SESSION_DELETED"
			}
			t.Excerpt = nil
			t.UpdatedAt = now
			st.Turns[key] = t
			changed = true
		}
		for i, j := range st.Jobs {
			if j.SessionID == session && (j.Status == "pending" || j.Status == "retry" || j.Status == "running") {
				st.Jobs[i].Status = "cancelled"
				st.Jobs[i].Failure = "SESSION_DELETED"
				st.Jobs[i].Lease = ""
				changed = true
			}
		}
		for id, p := range st.Proposals {
			if p.Source.SessionID != session {
				continue
			}
			if p.Status == "proposed" {
				p.Status, p.StatusReason = "expired", "SESSION_DELETED"
			}
			p.Source.Deleted = true
			for k := range p.Evidence {
				p.Evidence[k].Quote = ""
			}
			st.Proposals[id] = p
			changed = true
		}
		for id, versions := range st.Versions {
			for k, v := range versions {
				if v.Source != nil && v.Source.SessionID == session {
					v.Source.Deleted = true
					for n := range v.Evidence {
						v.Evidence[n].Quote = ""
					}
					versions[k] = v
					changed = true
				}
			}
			st.Versions[id] = versions
		}
		return changed, nil
	})
}

// pruneExcerpts keeps conversation text only for recent turns and turns whose
// proposals still await review.
func pruneExcerpts(st *State) {
	keep := map[string]bool{}
	for _, p := range st.Proposals {
		if p.Status == "proposed" {
			if cs, ok := st.ChangeSets[p.ChangeSetID]; ok {
				keep[cs.TurnKey] = true
			}
		}
	}
	turns := []Turn{}
	for _, t := range st.Turns {
		if len(t.Excerpt) > 0 {
			turns = append(turns, t)
		}
	}
	sort.Slice(turns, func(i, j int) bool { return turns[i].AcceptedAt > turns[j].AcceptedAt })
	for i, t := range turns {
		if i >= ExcerptRetention && !keep[t.Key] && t.Status != "queued" {
			t.Excerpt = nil
			st.Turns[t.Key] = t
		}
	}
}

// Excerpt returns the captured conversation text for one turn so the author
// can review a proposal next to the discussion that produced it.
func (s *Service) Excerpt(ctx context.Context, key string) (Turn, error) {
	st, e := s.load()
	if e != nil {
		return Turn{}, e
	}
	t, ok := st.Turns[key]
	if !ok {
		return Turn{}, application.Fail(404, "NOT_FOUND", "Turn not found.")
	}
	return t, nil
}

// Reconciler runs in the API process, which holds the Pi service token but no
// model credential. It turns awaiting outbox entries into queued jobs by
// reading Pi snapshots; it never calls a model.
type Reconciler struct {
	// Management enumerates every author's books; each is resolved as its owner.
	Management *application.Management
	// Fetch returns found=false when the session is deleted or unknown.
	Fetch func(ctx context.Context, session string) (snap *Snapshot, found bool, err error)
	// For builds the per-book service.
	For func(*application.Service) *Service
	// MaxFetches bounds Pi reads per sweep.
	MaxFetches int
}

func (r *Reconciler) Sweep(ctx context.Context) error {
	if r.Management == nil || r.Fetch == nil || r.For == nil {
		return nil
	}
	books, e := r.Management.OwnedBooks()
	if e != nil {
		return e
	}
	budget := r.MaxFetches
	if budget <= 0 {
		budget = 20
	}
	for _, b := range books {
		app, e := r.Management.Resolve(b.Owner, b.Book.ID)
		if e != nil {
			continue
		}
		s := r.For(app)
		turns, e := s.Awaiting(ctx)
		if e != nil {
			continue
		}
		snaps := map[string]*Snapshot{}
		gone := map[string]bool{}
		for _, t := range turns {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			snap, cached := snaps[t.SessionID]
			if !cached && !gone[t.SessionID] {
				if budget == 0 {
					return nil
				}
				budget--
				var found bool
				snap, found, e = r.Fetch(ctx, t.SessionID)
				if e != nil {
					// Pi unavailable: let Capture apply the turn timeout only.
					snap = nil
				} else if !found {
					gone[t.SessionID] = true
				}
				snaps[t.SessionID] = snap
			}
			_ = s.Capture(ctx, t.Key, snap, gone[t.SessionID])
		}
	}
	return nil
}

package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
	"regexp"
)

type Note struct {
	ID        string  `json:"noteId"`
	Project   string  `json:"projectId"`
	Content   string  `json:"content"`
	Chapter   *string `json:"chapterId"`
	Purpose   string  `json:"purpose"`
	Status    string  `json:"status"`
	Version   int64   `json:"version"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
	CreatedBy string  `json:"createdBy"`
}

// Reject missing/null required fields rather than guessing values in an existing database.
func (n *Note) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, name := range []string{"noteId", "projectId", "content", "chapterId", "purpose", "status", "version", "createdAt", "updatedAt", "createdBy"} {
		raw, ok := fields[name]
		if !ok || (name != "chapterId" && bytes.Equal(bytes.TrimSpace(raw), []byte("null"))) {
			return errors.New("stored note is missing a required field")
		}
	}
	type alias Note
	var decoded alias
	if err := compat.Decode(data, &decoded); err != nil {
		return err
	}
	*n = Note(decoded)
	return nil
}

type NoteReplay struct {
	Fingerprint string `json:"fingerprint"`
	Result      Note   `json:"result"`
}
type NoteAudit struct {
	ActorID string `json:"actorId"`
	NoteID  string `json:"noteId"`
	Action  string `json:"action"`
	Version int64  `json:"version"`
	At      string `json:"at"`
}
type NoteState struct {
	Items    []Note                `json:"items"`
	Requests map[string]NoteReplay `json:"requests"`
	Audit    []NoteAudit           `json:"audit"`
}

var uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (s *Service) notesPath() string {
	return filepath.Join(s.State, "notes", compat.Key(s.Project)+".json")
}
func (s *Service) loadNotes() (NoteState, error) {
	state := NoteState{}
	found, e := storage.Read(s.notesPath(), &state)
	if e != nil {
		return state, e
	}
	if !found {
		return NoteState{Items: []Note{}, Requests: map[string]NoteReplay{}, Audit: []NoteAudit{}}, nil
	}
	if state.Items == nil || state.Requests == nil || state.Audit == nil {
		return state, errors.New("invalid note state")
	}
	for _, n := range state.Items {
		if !uuidRE.MatchString(n.ID) || n.Version < 1 || n.Version > 9007199254740991 || !member(n.Purpose, "note", "next_writing") || !member(n.Status, "active", "archived") || !compat.Date(n.CreatedAt) || !compat.Date(n.UpdatedAt) {
			return state, errors.New("invalid stored author note")
		}
	}
	return state, nil
}
func (s *Service) Notes() (any, error) {
	state, e := s.loadNotes()
	return map[string]any{"items": state.Items}, e
}
func (s *Service) Note(id string) (any, error) {
	state, e := s.loadNotes()
	if e != nil {
		return nil, e
	}
	for _, n := range state.Items {
		if n.ID == id {
			return n, nil
		}
	}
	return nil, Fail(404, "NOT_FOUND", "Note not found.")
}
func (s *Service) MutateNote(ctx context.Context, a Actor, id *string, key string, body any) (any, error) {
	if a.Role != "author" {
		code := "AUTHOR_DECISION_REQUIRED"
		if a.Role == "agent" {
			code = "AGENT_WRITE_FORBIDDEN"
		}
		return nil, Fail(403, code, "The authenticated actor is not allowed to perform this operation.")
	}
	input, valid := noteInput(body, id != nil)
	if !valid || !SafeKey(key) {
		return nil, Fail(422, "VALIDATION_FAILED", "Valid note content and an Idempotency-Key (1–128 safe characters) are required.")
	}
	if input.ChapterID != nil && *input.ChapterID != "" {
		if _, e := s.Source(*input.ChapterID); e != nil {
			return nil, e
		}
	}
	var saved Note
	e := s.StateLock(ctx, s.notesPath()+".lock", func() error {
		state, e := s.loadNotes()
		if e != nil {
			return e
		}
		replayKey := compat.Key("[" + compat.Quote(a.ID) + "," + compat.Quote(key) + "]")
		fingerprint := input.Fingerprint(id)
		if prior, ok := state.Requests[replayKey]; ok {
			if prior.Fingerprint != fingerprint {
				return Fail(422, "VALIDATION_FAILED", "Idempotency-Key was used with different note content.")
			}
			saved = prior.Result
			return nil
		}
		current := -1
		if id != nil {
			for i, n := range state.Items {
				if n.ID == *id {
					current = i
					break
				}
			}
			if current < 0 {
				return Fail(404, "NOT_FOUND", "Note not found.")
			}
		}
		if current >= 0 && state.Items[current].Version != input.BaseVersion {
			return Fail(409, "NOTE_VERSION_CONFLICT", "笔记已在其他位置更新；当前输入已保留，请读取最新笔记后再决定。")
		}
		if input.Purpose == "next_writing" && input.Status == "active" {
			for _, n := range state.Items {
				if (id == nil || n.ID != *id) && n.Purpose == "next_writing" && n.Status == "active" {
					return Fail(409, "NEXT_WRITING_EXISTS", "已有“下次要写”笔记，请先编辑或归档原计划。")
				}
			}
		}
		at := compat.Now()
		saved = Note{ID: compat.UUID(), Project: s.Project, Content: input.Content, Chapter: input.ChapterID, Purpose: input.Purpose, Status: input.Status, Version: 1, CreatedAt: at, UpdatedAt: at, CreatedBy: a.ID}
		action := "created"
		if current >= 0 {
			prior := state.Items[current]
			saved.ID = prior.ID
			saved.CreatedAt = prior.CreatedAt
			saved.CreatedBy = prior.CreatedBy
			saved.Version = prior.Version + 1
			state.Items[current] = saved
			action = "updated"
		} else {
			state.Items = append(state.Items, saved)
		}
		state.Requests[replayKey] = NoteReplay{fingerprint, saved}
		state.Audit = append(state.Audit, NoteAudit{a.ID, saved.ID, action, saved.Version, at})
		return s.writeState(ctx, s.notesPath(), state)
	})
	return saved, e
}

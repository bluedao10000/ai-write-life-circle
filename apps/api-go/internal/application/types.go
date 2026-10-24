package application

import (
	"context"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
)

type Actor struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}
type RevisionActor struct {
	Type  string  `json:"type"`
	ID    *string `json:"id,omitempty"`
	Label *string `json:"label,omitempty"`
}
type Error struct {
	Status             int
	Code, Detail, Kind string
	Current            any
}

func (e *Error) Error() string { return e.Detail }
func Fail(status int, code, detail string) *Error {
	return &Error{Status: status, Code: code, Detail: detail}
}
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return Fail(500, "HARNESS_WRITE_FAILED", "The request could not be completed. No Harness file was written.")
}
func conflict(expected, current *string) *Error {
	return &Error{Status: 409, Code: "REVISION_CONFLICT", Detail: "The chapter revision changed before this save. Reload or compare before retrying.", Kind: "conflict", Current: map[string]any{"expectedRevisionId": expected, "currentRevisionId": current}}
}
func reuse() *Error {
	return &Error{Status: 422, Code: "VALIDATION_FAILED", Detail: "The Idempotency-Key was already used with a different chapter revision request.", Kind: "validation"}
}
func pointer(s string) *string { return &s }
func same(a, b *string) bool   { return (a == nil && b == nil) || (a != nil && b != nil && *a == *b) }

type Service struct {
	Root, State, Project string
	ReviewsEnabled       bool
	DirectoryProvider    func() (any, error)
	ProjectTitle         func() (string, error)
	ProjectionProvider   func() (harness.Projection, error)
	auditAppend          func(context.Context, string, any) error
	managedExists        func() error
}

func (s *Service) Projection() (harness.Projection, error) {
	if s.ProjectionProvider != nil {
		return s.ProjectionProvider()
	}
	return harness.Load(s.Root, s.Project)
}
func (s *Service) Audit(ctx context.Context, actor Actor, chapterID, requestID, action string, fields map[string]any) error {
	row := map[string]any{"actor": actor, "objectRef": map[string]any{"type": "chapter", "id": chapterID}, "beforeHash": nil, "afterHash": nil, "requestId": requestID, "correlationId": requestID, "action": action, "auditId": compat.UUID(), "at": compat.Now()}
	for k, v := range fields {
		row[k] = v
	}
	appendRecord := s.auditAppend
	if appendRecord == nil {
		appendRecord = storage.Append
	}
	return appendRecord(ctx, filepath.Join(s.State, "audit.jsonl"), row)
}

// StateLock keeps managed resource locks outside directories removed by deletion.
// Resource transactions take this lock before the short final-write gate; deletion
// takes only the gate, and never waits for a resource lock while holding it.
func (s *Service) StateLock(ctx context.Context, path string, fn func() error) error {
	if s.managedExists != nil {
		path = filepath.Join(s.State, "works", "resource-locks", compat.Key(s.Project), compat.Key(compat.Hash(path))+".lock")
	}
	return storage.Lock(ctx, path, fn)
}

func (s *Service) bookCommitPath() string {
	return filepath.Join(s.State, "works", "book-commits", compat.Key(s.Project)+".lock")
}

// CommitBookState fences already-resolved API requests and late Agent results.
// Callbacks only persist state: never acquire resource/publication/catalog locks here.
func (s *Service) CommitBookState(ctx context.Context, fn func() error) error {
	if s.managedExists == nil {
		return fn()
	}
	return storage.Lock(ctx, s.bookCommitPath(), func() error {
		if err := s.managedExists(); err != nil {
			return err
		}
		return fn()
	})
}
func (s *Service) writeState(ctx context.Context, path string, value any) error {
	return s.CommitBookState(ctx, func() error { return storage.Write(ctx, path, value) })
}

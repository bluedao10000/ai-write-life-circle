package thinking

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/procedural"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

type MemoryExtractionInput struct {
	TaskIDs []string `json:"taskIds"`
}
type MemoryExtractionSource struct {
	TaskID        string `json:"taskId"`
	ResultVersion int64  `json:"resultVersion"`
}
type MemoryExtraction struct {
	Version int                      `json:"version"`
	Tasks   []MemoryExtractionSource `json:"tasks"`
}
type memoryExtractionItem struct {
	Source  agenttasks.MemorySource  `json:"source"`
	Outcome agenttasks.MemoryOutcome `json:"outcome"`
}

func (s *Service) memoryTasks() *agenttasks.Service {
	return &agenttasks.Service{Management: s.Management, State: s.State}
}
func (s *Service) bindMemoryExtraction(ctx context.Context, actor application.Actor, book string, in MemoryExtractionInput) (*MemoryExtraction, error) {
	if len(in.TaskIDs) < 1 || len(in.TaskIDs) > 4 {
		return nil, fail(422, "INVALID_MEMORY_EVIDENCE")
	}
	binding := &MemoryExtraction{Version: 1, Tasks: []MemoryExtractionSource{}}
	seen := map[string]bool{}
	for _, id := range in.TaskIDs {
		if seen[id] {
			return nil, fail(422, "INVALID_MEMORY_EVIDENCE")
		}
		seen[id] = true
		result, e := s.memoryTasks().MemoryOutcome(ctx, actor, book, id)
		if e != nil {
			return nil, e
		}
		binding.Tasks = append(binding.Tasks, MemoryExtractionSource{id, result.Version})
	}
	return binding, nil
}
func (s *Service) memoryExtractionContext(ctx context.Context, rec Record) ([]memoryExtractionItem, error) {
	binding := rec.MemoryExtraction
	if binding == nil || binding.Version != 1 || len(binding.Tasks) < 1 || len(binding.Tasks) > 4 || len(rec.Scopes) > 0 || rec.CancelPending || rec.ResumeBlocked {
		return nil, fail(403, "MEMORY_EXTRACTION_UNAVAILABLE")
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	items := []memoryExtractionItem{}
	for _, ref := range binding.Tasks {
		source, e := s.memoryTasks().MemorySource(ctx, actor, rec.Book, ref.TaskID)
		if e != nil {
			return nil, e
		}
		outcome, e := s.memoryTasks().MemoryOutcome(ctx, actor, rec.Book, ref.TaskID)
		if e != nil {
			return nil, e
		}
		if outcome.Version != ref.ResultVersion {
			return nil, fail(409, "MEMORY_SOURCE_CHANGED")
		}
		items = append(items, memoryExtractionItem{source, outcome})
	}
	return items, nil
}

// Only an author can import a completed, source-bound result into candidate storage.
func (s *Service) memoryCandidate(w http.ResponseWriter, r *http.Request, actor application.Actor, rec Record) {
	var in struct {
		RunID string `json:"runId"`
	}
	if e := decode(w, r, &in); e != nil {
		reply(w, nil, e, 0)
		return
	}
	var result procedural.Record
	e := storage.Lock(r.Context(), s.path()+"."+compat.Key(rec.ID)+".lock", func() error {
		current, e := s.owned(actor, rec.Book, rec.ID)
		if e != nil {
			return e
		}
		if _, e = s.memoryExtractionContext(r.Context(), current); e != nil {
			return e
		}
		raw, e := s.agent(r.Context(), "GET", "/internal/v1/sessions/"+rec.ID, nil)
		if e != nil {
			return e
		}
		var view struct {
			Status string `json:"status"`
			Run    struct {
				ID                   string `json:"runId"`
				Status               string `json:"status"`
				AuthorizationVersion int    `json:"authorizationVersion"`
			} `json:"run"`
			Messages []struct {
				Role   string `json:"role"`
				Status string `json:"status"`
				Text   string `json:"text"`
			} `json:"messages"`
		}
		if json.Unmarshal(raw, &view) != nil || in.RunID == "" || view.Status != "idle" || view.Run.ID != in.RunID || view.Run.Status != "completed" || view.Run.AuthorizationVersion != current.AuthorizationVersion || len(view.Messages) == 0 {
			return fail(409, "MEMORY_EXTRACTION_INCOMPLETE")
		}
		last := view.Messages[len(view.Messages)-1]
		if last.Role != "assistant" || last.Status != "completed" {
			return fail(409, "MEMORY_EXTRACTION_INCOMPLETE")
		}
		var output struct {
			Content string   `json:"content"`
			TaskIDs []string `json:"taskIds"`
		}
		decoder := json.NewDecoder(bytes.NewBufferString(last.Text))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&output) != nil || decoder.Decode(new(any)) != io.EOF || len(output.TaskIDs) < 1 || len(output.TaskIDs) > len(current.MemoryExtraction.Tasks) {
			return fail(422, "INVALID_MEMORY_EXTRACTION")
		}
		allowed := map[string]bool{}
		for _, ref := range current.MemoryExtraction.Tasks {
			allowed[ref.TaskID] = true
		}
		for _, id := range output.TaskIDs {
			if !allowed[id] {
				return fail(422, "INVALID_MEMORY_EVIDENCE")
			}
			delete(allowed, id)
		}
		// Source reads and Pi I/O may overlap a preference revocation.
		latest, e := s.owned(actor, rec.Book, rec.ID)
		if e != nil {
			return e
		}
		if latest.Nonce != current.Nonce || latest.AuthorizationVersion != current.AuthorizationVersion {
			return fail(403, "CAPABILITY_REVOKED")
		}
		if _, e = s.memoryExtractionContext(r.Context(), latest); e != nil {
			return e
		}
		app, e := s.Management.Resolve(actor, rec.Book)
		if e != nil {
			return e
		}
		memories := procedural.Service{App: app, Tasks: s.memoryTasks(), ValidateExtraction: s.ValidateMemoryExtraction}
		e = storage.Lock(r.Context(), s.path()+".lock", func() error {
			st, err := s.load()
			if err != nil {
				return err
			}
			fresh := st.Sessions[rec.ID]
			if fresh.Deleted || fresh.Nonce != current.Nonce || fresh.AuthorizationVersion != current.AuthorizationVersion || fresh.CancelPending || fresh.ResumeBlocked {
				return fail(403, "CAPABILITY_REVOKED")
			}
			result, e = memories.CreateExtracted(r.Context(), actor, "extract:"+view.Run.ID, procedural.Input{Content: output.Content, TaskIDs: output.TaskIDs}, procedural.Extraction{SessionID: rec.ID, RunID: view.Run.ID, Provider: current.Model.Provider, Model: current.Model.Model, PromptVersion: "memory-extraction-v1", AuthorizationVersion: current.AuthorizationVersion})
			return e
		})
		return e
	})
	reply(w, result, e, 201)
}

// ValidateMemoryExtraction keeps candidate confirmation and retrieval tied to the original grant.
func (s *Service) ValidateMemoryExtraction(ctx context.Context, actor application.Actor, book string, origin procedural.Extraction) error {
	rec, e := s.owned(actor, book, origin.SessionID)
	if e != nil {
		return e
	}
	if rec.AuthorizationVersion != origin.AuthorizationVersion || rec.MemoryExtraction == nil || origin.PromptVersion != "memory-extraction-v1" {
		return fail(403, "CAPABILITY_REVOKED")
	}
	_, e = s.memoryExtractionContext(ctx, rec)
	return e
}

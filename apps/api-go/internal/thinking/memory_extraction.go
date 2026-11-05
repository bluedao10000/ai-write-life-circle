package thinking

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/procedural"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

type MemoryExtractionInput struct {
	TaskIDs []string `json:"taskIds"`
}
type MemoryResultVersion string

func (v *MemoryResultVersion) UnmarshalJSON(data []byte) error {
	raw := bytes.TrimSpace(data)
	if len(raw) == 0 {
		return fmt.Errorf("memory result version is empty")
	}
	if raw[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		*v = MemoryResultVersion(value)
		return nil
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value < 0 {
		return fmt.Errorf("memory result version is invalid")
	}
	*v = MemoryResultVersion("legacy:" + strconv.FormatInt(value, 10))
	return nil
}

func (v MemoryResultVersion) MarshalJSON() ([]byte, error) {
	value := string(v)
	if strings.HasPrefix(value, "legacy:") {
		legacy, err := strconv.ParseInt(strings.TrimPrefix(value, "legacy:"), 10, 64)
		if err != nil || legacy < 0 {
			return nil, fmt.Errorf("memory result version is invalid")
		}
		return json.Marshal(legacy)
	}
	return json.Marshal(value)
}

func (v MemoryResultVersion) Legacy() (int64, bool) {
	value := string(v)
	if !strings.HasPrefix(value, "legacy:") {
		return 0, false
	}
	legacy, err := strconv.ParseInt(strings.TrimPrefix(value, "legacy:"), 10, 64)
	return legacy, err == nil && legacy >= 0
}

type MemoryExtractionSource struct {
	TaskID        string              `json:"taskId"`
	ResultVersion MemoryResultVersion `json:"resultVersion"`
}
type MemoryExtractionComparison struct {
	MemoryID      string `json:"memoryId"`
	MemoryVersion int    `json:"memoryVersion"`
}
type MemoryExtraction struct {
	Version           int                          `json:"version"`
	Tasks             []MemoryExtractionSource     `json:"tasks"`
	Comparisons       []MemoryExtractionComparison `json:"comparisons"`
	ComparisonOmitted int                          `json:"comparisonOmitted"`
}
type memoryExtractionItem struct {
	Source  agenttasks.MemorySource  `json:"source"`
	Outcome agenttasks.MemoryOutcome `json:"outcome"`
}
type memoryExtractionComparison struct {
	MemoryID      string `json:"memoryId"`
	MemoryVersion int    `json:"memoryVersion"`
	Content       string `json:"content"`
}
type memoryExtractionContext struct {
	Items             []memoryExtractionItem       `json:"items"`
	Comparisons       []memoryExtractionComparison `json:"comparisons"`
	ComparisonOmitted int                          `json:"comparisonOmitted"`
}
type memoryExtractionRelation struct {
	MemoryID string `json:"memoryId"`
	Kind     string `json:"kind"`
	Reason   string `json:"reason"`
}

func (s *Service) memoryTasks() *agenttasks.Service {
	return &agenttasks.Service{Management: s.Management, State: s.State}
}
func (s *Service) bindMemoryExtraction(ctx context.Context, actor application.Actor, book string, in MemoryExtractionInput) (*MemoryExtraction, error) {
	if len(in.TaskIDs) < 1 || len(in.TaskIDs) > 4 {
		return nil, fail(422, "INVALID_MEMORY_EVIDENCE")
	}
	binding := &MemoryExtraction{Version: 3, Tasks: []MemoryExtractionSource{}, Comparisons: []MemoryExtractionComparison{}}
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
		binding.Tasks = append(binding.Tasks, MemoryExtractionSource{id, MemoryResultVersion(result.Version)})
	}
	app, e := s.Management.Resolve(actor, book)
	if e != nil {
		return nil, e
	}
	views, e := (&procedural.Service{App: app, Tasks: s.memoryTasks(), ValidateExtraction: s.extractionValidator()}).List(ctx, actor)
	if e != nil {
		return nil, e
	}
	for _, view := range views {
		if view.Available && view.Status == "confirmed" {
			if len(binding.Comparisons) < 8 {
				binding.Comparisons = append(binding.Comparisons, MemoryExtractionComparison{view.ID, view.Version})
			} else {
				binding.ComparisonOmitted++
			}
		}
	}
	return binding, nil
}
func (s *Service) memoryExtractionContext(ctx context.Context, rec Record) (memoryExtractionContext, error) {
	out, e := s.memoryExtractionSources(ctx, rec)
	if e != nil {
		return out, e
	}
	binding := rec.MemoryExtraction
	if binding.Version >= 2 && len(binding.Comparisons) > 0 {
		actor := application.Actor{ID: rec.Owner, Role: "author"}
		app, e := s.Management.Resolve(actor, rec.Book)
		if e != nil {
			return out, e
		}
		views, e := (&procedural.Service{App: app, Tasks: s.memoryTasks(), ValidateExtraction: s.extractionValidator()}).List(ctx, actor)
		if e != nil {
			return out, e
		}
		current := map[string]procedural.View{}
		for _, view := range views {
			if view.Available && view.Status == "confirmed" {
				current[view.ID] = view
			}
		}
		for _, ref := range binding.Comparisons {
			view, ok := current[ref.MemoryID]
			if !ok || view.Version != ref.MemoryVersion || view.Content == "" {
				return out, fail(409, "MEMORY_SOURCE_CHANGED")
			}
			out.Comparisons = append(out.Comparisons, memoryExtractionComparison{ref.MemoryID, ref.MemoryVersion, view.Content})
		}
	}
	out.ComparisonOmitted = binding.ComparisonOmitted
	return out, nil
}
func (s *Service) memoryExtractionSources(ctx context.Context, rec Record) (memoryExtractionContext, error) {
	out := memoryExtractionContext{Items: []memoryExtractionItem{}, Comparisons: []memoryExtractionComparison{}}
	binding := rec.MemoryExtraction
	if binding == nil || binding.Version != 3 || len(binding.Tasks) < 1 || len(binding.Tasks) > 4 || len(binding.Comparisons) > 8 || binding.ComparisonOmitted < 0 || len(rec.Scopes) > 0 || rec.CancelPending || rec.ResumeBlocked {
		return out, fail(403, "MEMORY_EXTRACTION_UNAVAILABLE")
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	for _, ref := range binding.Tasks {
		if !agenttasks.ValidResultVersion(string(ref.ResultVersion)) {
			return out, fail(403, "MEMORY_EXTRACTION_UNAVAILABLE")
		}
		source, e := s.memoryTasks().MemorySource(ctx, actor, rec.Book, ref.TaskID)
		if e != nil {
			return out, e
		}
		outcome, e := s.memoryTasks().MemoryOutcome(ctx, actor, rec.Book, ref.TaskID)
		if e != nil {
			return out, e
		}
		if outcome.Version != string(ref.ResultVersion) {
			return out, fail(409, "MEMORY_SOURCE_CHANGED")
		}
		out.Items = append(out.Items, memoryExtractionItem{source, outcome})
	}
	return out, nil
}

func (s *Service) validateLegacyMemoryExtraction(ctx context.Context, rec Record) error {
	binding := rec.MemoryExtraction
	if binding == nil || (binding.Version != 1 && binding.Version != 2) || len(binding.Tasks) < 1 || len(binding.Tasks) > 4 || len(binding.Comparisons) > 8 || binding.ComparisonOmitted < 0 || len(rec.Scopes) > 0 || rec.CancelPending || rec.ResumeBlocked || (binding.Version == 1 && (len(binding.Comparisons) != 0 || binding.ComparisonOmitted != 0)) {
		return fail(403, "MEMORY_EXTRACTION_UNAVAILABLE")
	}
	actor := application.Actor{ID: rec.Owner, Role: "author"}
	seen := map[string]bool{}
	for _, ref := range binding.Tasks {
		legacy, ok := ref.ResultVersion.Legacy()
		if !ok || ref.TaskID == "" || seen[ref.TaskID] {
			return fail(403, "MEMORY_EXTRACTION_UNAVAILABLE")
		}
		seen[ref.TaskID] = true
		if _, err := s.memoryTasks().MemorySource(ctx, actor, rec.Book, ref.TaskID); err != nil {
			return err
		}
		outcome, err := s.memoryTasks().MemoryOutcome(ctx, actor, rec.Book, ref.TaskID)
		if err != nil {
			return err
		}
		if outcome.LegacyVersion != legacy {
			return fail(409, "MEMORY_SOURCE_CHANGED")
		}
	}
	return nil
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
			Content   string          `json:"content"`
			TaskIDs   []string        `json:"taskIds"`
			Relations json.RawMessage `json:"relations"`
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
		relations := []procedural.ExtractionRelation{}
		var outputRelations []memoryExtractionRelation
		if len(output.Relations) == 0 || json.Unmarshal(output.Relations, &outputRelations) != nil || outputRelations == nil {
			return fail(422, "INVALID_MEMORY_EXTRACTION")
		}
		comparisons := map[string]int{}
		for _, ref := range current.MemoryExtraction.Comparisons {
			comparisons[ref.MemoryID] = ref.MemoryVersion
		}
		seen := map[string]bool{}
		for _, relation := range outputRelations {
			version, ok := comparisons[relation.MemoryID]
			kind := relation.Kind
			reason := strings.TrimSpace(relation.Reason)
			if !ok || seen[relation.MemoryID] || !map[string]bool{"duplicate": true, "conflict": true, "refinement": true}[kind] || len(reason) == 0 || len(reason) > 1000 {
				return fail(422, "INVALID_MEMORY_EXTRACTION")
			}
			seen[relation.MemoryID] = true
			relations = append(relations, procedural.ExtractionRelation{MemoryID: relation.MemoryID, MemoryVersion: version, Kind: kind, Reason: reason})
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
		memories := procedural.Service{App: app, Tasks: s.memoryTasks(), ValidateExtraction: s.extractionValidator()}
		e = storage.Lock(r.Context(), s.path()+".lock", func() error {
			st, err := s.load()
			if err != nil {
				return err
			}
			fresh := st.Sessions[rec.ID]
			if fresh.Deleted || fresh.Nonce != current.Nonce || fresh.AuthorizationVersion != current.AuthorizationVersion || fresh.CancelPending || fresh.ResumeBlocked {
				return fail(403, "CAPABILITY_REVOKED")
			}
			result, e = memories.CreateExtracted(r.Context(), actor, "extract:"+view.Run.ID, procedural.Input{Content: output.Content, TaskIDs: output.TaskIDs}, procedural.Extraction{SessionID: rec.ID, RunID: view.Run.ID, Provider: current.Model.Provider, Model: current.Model.Model, PromptVersion: fmt.Sprintf("memory-extraction-v%d", current.MemoryExtraction.Version), AuthorizationVersion: current.AuthorizationVersion, Relations: relations})
			return e
		})
		return e
	})
	reply(w, result, e, 201)
}

func (s *Service) extractionValidator() func(context.Context, application.Actor, string, procedural.Extraction) error {
	if s.ExtractionValidator != nil {
		return s.ExtractionValidator
	}
	return s.ValidateMemoryExtraction
}

// ValidateMemoryExtraction keeps candidate confirmation and retrieval tied to the original grant.
func (s *Service) ValidateMemoryExtraction(ctx context.Context, actor application.Actor, book string, origin procedural.Extraction) error {
	rec, e := s.owned(actor, book, origin.SessionID)
	if e != nil {
		return e
	}
	binding := rec.MemoryExtraction
	if binding == nil || (binding.Version != 1 && binding.Version != 2 && binding.Version != 3) || rec.AuthorizationVersion != origin.AuthorizationVersion || origin.PromptVersion != fmt.Sprintf("memory-extraction-v%d", binding.Version) {
		return fail(403, "CAPABILITY_REVOKED")
	}
	allowed := map[string]int{}
	for _, ref := range binding.Comparisons {
		allowed[ref.MemoryID] = ref.MemoryVersion
	}
	seen := map[string]bool{}
	for _, relation := range origin.Relations {
		version, ok := allowed[relation.MemoryID]
		reason := strings.TrimSpace(relation.Reason)
		if !ok || seen[relation.MemoryID] || version != relation.MemoryVersion || !map[string]bool{"duplicate": true, "conflict": true, "refinement": true}[relation.Kind] || len(reason) == 0 || len(reason) > 1000 {
			return fail(403, "CAPABILITY_REVOKED")
		}
		seen[relation.MemoryID] = true
	}
	if binding.Version == 3 {
		_, e = s.memoryExtractionSources(ctx, rec)
	} else {
		e = s.validateLegacyMemoryExtraction(ctx, rec)
	}
	return e
}

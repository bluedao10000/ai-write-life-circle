package analysis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/evidence"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func (s *Service) reservePoints() int {
	return billing.PointsFor(s.contextLimit()+20000, s.outputLimit())
}

func (s *Service) Claim(ctx context.Context) (*ClaimedBatch, error) {
	var out *ClaimedBatch
	var meterOp string
	err := s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[st.Current]
		if job == nil || job.Status == "paused" || job.Status == "cancelled" || job.Status == "completed" || job.Status == "failed" {
			return false, nil
		}
		now := time.Now().UTC()
		changed := false
		for i := range job.Batches {
			batch := &job.Batches[i]
			if batch.Status != "running" || batch.Deadline == "" {
				continue
			}
			deadline, _ := time.Parse(time.RFC3339Nano, batch.Deadline)
			if now.Before(deadline) {
				continue
			}
			batch.Status = "pending"
			batch.FailureCode = "TASK_DEADLINE_EXPIRED"
			batch.Due = now.Format(time.RFC3339Nano)
			changed = true
		}
		var chosen *Batch
		for i := range job.Batches {
			batch := &job.Batches[i]
			if batch.Status != "pending" {
				continue
			}
			if batch.Due != "" {
				due, _ := time.Parse(time.RFC3339Nano, batch.Due)
				if now.Before(due) {
					continue
				}
			}
			if chosen == nil || (batch.Phase == "chapters" && chosen.Phase == "synthesis") {
				chosen = batch
			}
		}
		if chosen == nil {
			if changed {
				job.Progress = progressOf(job)
				job.UpdatedAt = compat.Now()
				return true, nil
			}
			return false, nil
		}
		op := fmt.Sprintf("analysis:%s:%s:%d", job.AnalysisID, chosen.BatchID, chosen.Attempts+1)
		if s.App.MeterReserve(ctx, op, "analysis", s.reservePoints()) != nil {
			return changed, nil
		}
		meterOp = op
		lease := ""
		epoch := uint64(0)
		deadline := ""
		guardErr := (executorpolicy.Controller{State: s.App.State}).Claim(ctx, "analysis", "pi", func(value uint64) (string, string, error) {
			lease = compat.UUID()
			epoch = value
			deadline = now.Add(s.timeout() + 15*time.Second).Format(time.RFC3339Nano)
			return lease, deadline, nil
		})
		if guardErr != nil {
			return changed, guardErr
		}
		chosen.Attempts++
		chosen.Status = "running"
		chosen.FailureCode = ""
		chosen.Due = ""
		chosen.Lease = lease
		chosen.Epoch = epoch
		chosen.Deadline = deadline
		chosen.MeterOp = op
		chosen.Reserved = s.reservePoints()
		chosen.BudgetDay = now.Format("2006-01-02")
		job.Status = "running"
		job.UpdatedAt = compat.Now()
		job.Progress = progressOf(job)
		if chosen.Phase == "synthesis" {
			job.SynthesisStatus = "running"
		}
		out = &ClaimedBatch{Job: *job, Batch: *chosen, Manifest: *st.Manifests[job.ManifestID], Reserved: chosen.Reserved, Day: chosen.BudgetDay}
		return true, nil
	})
	if err != nil {
		if meterOp != "" {
			s.App.MeterSettle(context.Background(), meterOp, 0)
		}
		return nil, err
	}
	return out, nil
}

func (s *Service) Prepare(ctx context.Context, claim *ClaimedBatch) (*PreparedBatch, error) {
	if claim == nil {
		return nil, application.Fail(422, "ANALYSIS_CLAIM_REQUIRED", "Analysis claim is required.")
	}
	if claim.Batch.Phase == "synthesis" {
		return s.prepareSynthesis(ctx, claim)
	}
	refs := map[string]ChapterRef{}
	for _, chapter := range claim.Manifest.Chapters {
		refs[chapter.ChapterID] = chapter
	}
	inputs := []ChapterInput{}
	total := 0
	for _, id := range claim.Batch.ChapterIDs {
		ref, ok := refs[id]
		if !ok {
			return nil, s.failBatch(ctx, claim, "ANALYSIS_MANIFEST_MISMATCH")
		}
		chapter, err := s.App.Source(id)
		if err != nil {
			return nil, s.failBatch(ctx, claim, "ANALYSIS_CHAPTER_MISSING")
		}
		head, err := s.App.Head(ctx, chapter)
		if err != nil {
			return nil, s.failBatch(ctx, claim, "ANALYSIS_REVISION_UNAVAILABLE")
		}
		if head.ID != ref.RevisionID || head.Hash != ref.ContentHash {
			_ = s.finishBatch(ctx, claim, "stale", "ANALYSIS_REVISION_CHANGED")
			return nil, application.Fail(409, "ANALYSIS_REVISION_CHANGED", "The chapter changed after the analysis manifest was frozen.")
		}
		total += len(head.Markdown)
		inputs = append(inputs, ChapterInput{
			ChapterID: id, RevisionID: head.ID, ContentHash: head.Hash,
			Title: chapter.Title, Volume: volumeTitle(chapter), Order: orderOf(chapter, 0),
			Markdown: head.Markdown,
		})
	}
	if total > s.contextLimit()-4096 {
		return nil, s.failBatch(ctx, claim, "ANALYSIS_CHAPTER_TOO_LARGE")
	}
	input, _ := json.Marshal(struct {
		AnalysisID string         `json:"analysisId"`
		BatchID    string         `json:"batchId"`
		Phase      string         `json:"phase"`
		Chapters   []ChapterInput `json:"chapters"`
	}{claim.Job.AnalysisID, claim.Batch.BatchID, "chapters", inputs})
	request := llm.Request{
		OutputLimit: s.outputLimit(),
		System:      chapterSystemPrompt,
		Input:       string(input),
		SchemaName:  "novel-analysis-candidates-v1",
		Schema:      chapterSchema(),
	}
	return &PreparedBatch{
		AnalysisID: claim.Job.AnalysisID, BatchID: claim.Batch.BatchID, Phase: "chapters",
		Chapters: inputs, Request: request, Reserved: claim.Reserved, Day: claim.Day,
		Lease: claim.Batch.Lease, Epoch: claim.Batch.Epoch, MeterOp: claim.Batch.MeterOp,
	}, nil
}

func (s *Service) prepareSynthesis(ctx context.Context, claim *ClaimedBatch) (*PreparedBatch, error) {
	st, err := s.load()
	if err != nil {
		return nil, err
	}
	findings := []map[string]any{}
	for _, finding := range st.Findings {
		if finding.AnalysisID != claim.Job.AnalysisID || finding.Status == "stale" || finding.Status == "rejected" {
			continue
		}
		evidenceRows := []map[string]any{}
		for _, item := range finding.Evidence {
			evidenceRows = append(evidenceRows, map[string]any{"chapterId": item.ChapterID, "quote": item.Quote})
		}
		findings = append(findings, map[string]any{
			"kind": finding.Kind, "title": finding.Title, "statement": finding.Statement,
			"confidence": finding.Confidence, "evidence": evidenceRows,
		})
	}
	if len(findings) == 0 {
		_ = s.finishBatch(ctx, claim, "failed", "ANALYSIS_NO_CANDIDATES")
		return nil, application.Fail(422, "ANALYSIS_NO_CANDIDATES", "No findings were produced for synthesis.")
	}
	sort.SliceStable(findings, func(i, j int) bool {
		return fmt.Sprint(findings[i]["title"]) < fmt.Sprint(findings[j]["title"])
	})
	if len(findings) > 200 {
		findings = findings[:200]
	}
	input, _ := json.Marshal(struct {
		AnalysisID string           `json:"analysisId"`
		BatchID    string           `json:"batchId"`
		Phase      string           `json:"phase"`
		Findings   []map[string]any `json:"findings"`
	}{claim.Job.AnalysisID, claim.Batch.BatchID, "synthesis", findings})
	if len(input) > s.contextLimit()-4096 {
		return nil, s.failBatch(ctx, claim, "ANALYSIS_SYNTHESIS_TOO_LARGE")
	}
	request := llm.Request{
		OutputLimit: s.outputLimit(),
		System:      synthesisSystemPrompt,
		Input:       string(input),
		SchemaName:  "novel-synthesis-candidates-v1",
		Schema:      synthesisSchema(),
	}
	return &PreparedBatch{
		AnalysisID: claim.Job.AnalysisID, BatchID: claim.Batch.BatchID, Phase: "synthesis",
		Request: request, Reserved: claim.Reserved, Day: claim.Day,
		Lease: claim.Batch.Lease, Epoch: claim.Batch.Epoch, MeterOp: claim.Batch.MeterOp,
	}, nil
}

func (s *Service) Complete(ctx context.Context, prepared *PreparedBatch, response llm.Response, sent bool, cause error) error {
	if prepared == nil {
		return application.Fail(422, "ANALYSIS_CLAIM_REQUIRED", "Analysis preparation is required.")
	}
	points := settlePoints(response, sent)
	if cause != nil {
		err := s.withLease(ctx, prepared, func() error {
			_, markErr := s.markBatch(ctx, &ClaimedBatch{
				Job:   Job{AnalysisID: prepared.AnalysisID},
				Batch: Batch{BatchID: prepared.BatchID, Lease: prepared.Lease, Epoch: prepared.Epoch, Phase: prepared.Phase},
			}, "failed", failureCode(cause))
			return markErr
		})
		s.App.MeterSettle(ctx, meterOp(prepared), points)
		return err
	}
	var parsed candidates
	if err := json.Unmarshal([]byte(response.Text), &parsed); err != nil {
		s.App.MeterSettle(ctx, meterOp(prepared), points)
		return s.withLease(ctx, prepared, func() error { return s.retryOrFail(ctx, prepared, "ANALYSIS_OUTPUT_INVALID") })
	}
	if len(parsed.Findings) > 80 || len(parsed.Entities) > 80 {
		s.App.MeterSettle(ctx, meterOp(prepared), points)
		return s.withLease(ctx, prepared, func() error { return s.retryOrFail(ctx, prepared, "ANALYSIS_OUTPUT_TOO_LARGE") })
	}
	if prepared.Phase == "synthesis" {
		err := s.withLease(ctx, prepared, func() error { return s.completeSynthesis(ctx, prepared, parsed) })
		s.App.MeterSettle(ctx, meterOp(prepared), points)
		return err
	}
	err := s.withLease(ctx, prepared, func() error { return s.completeChapters(ctx, prepared, parsed) })
	s.App.MeterSettle(ctx, meterOp(prepared), points)
	return err
}

func (s *Service) withLease(ctx context.Context, prepared *PreparedBatch, fn func() error) error {
	err := (executorpolicy.Controller{State: s.App.State}).Guard(ctx, "analysis", "pi", prepared.Epoch, prepared.Lease, true, fn)
	if errors.Is(err, executorpolicy.ErrFenced) {
		return application.Fail(409, "ANALYSIS_FENCED", "This analysis batch is no longer current.")
	}
	return err
}

func (s *Service) completeChapters(ctx context.Context, prepared *PreparedBatch, parsed candidates) error {
	byChapter := map[string]ChapterInput{}
	for _, chapter := range prepared.Chapters {
		byChapter[chapter.ChapterID] = chapter
	}
	now := compat.Now()
	return s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[prepared.AnalysisID]
		if job == nil {
			return false, application.Fail(404, "NOT_FOUND", "Analysis job not found.")
		}
		batch := findBatch(job, prepared.BatchID)
		if batch == nil || batch.Status != "running" || batch.Lease != prepared.Lease {
			return false, application.Fail(409, "ANALYSIS_FENCED", "This analysis batch is no longer current.")
		}
		entities := []Entity{}
		entityByName := map[string]string{}
		for _, candidate := range parsed.Entities {
			if !validEntityKind(candidate.Kind) || strings.TrimSpace(candidate.Name) == "" {
				continue
			}
			entity := s.findOrCreateEntity(st, candidate, now)
			entities = append(entities, entity)
			entityByName[normalizeName(entity.Name)] = entity.EntityID
			for _, alias := range entity.Aliases {
				entityByName[normalizeName(alias)] = entity.EntityID
			}
		}
		for _, candidate := range parsed.Findings {
			if !validFindingKind(candidate.Kind) || candidate.Confidence < 0 || candidate.Confidence > 1 || strings.TrimSpace(candidate.Title) == "" || strings.TrimSpace(candidate.Statement) == "" {
				continue
			}
			items := []Evidence{}
			for _, item := range candidate.Evidence {
				chapter, ok := byChapter[item.ChapterID]
				if !ok {
					continue
				}
				match := evidence.FindQuote(chapter.Markdown, item.Quote)
				if match.Status == "missing" {
					continue
				}
				items = append(items, Evidence{
					ChapterID: chapter.ChapterID, RevisionID: chapter.RevisionID, ContentHash: chapter.ContentHash,
					Quote: match.Quote, Start: match.StartUTF16, End: match.EndUTF16,
				})
			}
			if len(items) == 0 {
				continue
			}
			finding := Finding{
				FindingID: newID("find-"), AnalysisID: job.AnalysisID, BatchID: batch.BatchID,
				Kind: candidate.Kind, Title: truncate(candidate.Title, 200), Statement: truncate(candidate.Statement, 2000),
				AlternativeExplanation: truncate(candidate.AlternativeExplanation, 1000),
				Confidence:             candidate.Confidence, Status: "proposed", EntityIDs: []string{},
				Evidence: items, CreatedAt: now, UpdatedAt: now,
			}
			for _, name := range candidate.EntityNames {
				if id := entityByName[normalizeName(name)]; id != "" && !containsString(finding.EntityIDs, id) {
					finding.EntityIDs = append(finding.EntityIDs, id)
					if entity := st.Entities[id]; entity != nil {
						entity.Evidence = mergeEvidence(entity.Evidence, items)
					}
				}
			}
			st.Findings[finding.FindingID] = &finding
		}
		for _, entity := range entities {
			if st.Entities[entity.EntityID] == nil {
				copy := entity
				st.Entities[copy.EntityID] = &copy
			}
		}
		// Attribute conflicts are recorded after evidence is attached so the
		// conflict finding can point at both sides.
		for _, candidate := range parsed.Entities {
			if !validEntityKind(candidate.Kind) || strings.TrimSpace(candidate.Name) == "" {
				continue
			}
			id := entityByName[normalizeName(candidate.Name)]
			entity := st.Entities[id]
			if entity == nil {
				continue
			}
			s.applyAttributes(st, job.AnalysisID, entity, candidate.Attributes, now)
		}
		batch.Status = "completed"
		batch.FailureCode = ""
		batch.Deadline = ""
		batch.Lease = ""
		job.UpdatedAt = now
		job.Progress = progressOf(job)
		s.maybeQueueSynthesis(st, job)
		job.Status = deriveStatus(job)
		return true, nil
	})
}

func (s *Service) completeSynthesis(ctx context.Context, prepared *PreparedBatch, parsed candidates) error {
	now := compat.Now()
	return s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[prepared.AnalysisID]
		if job == nil {
			return false, application.Fail(404, "NOT_FOUND", "Analysis job not found.")
		}
		batch := findBatch(job, prepared.BatchID)
		if batch == nil || batch.Status != "running" || batch.Lease != prepared.Lease {
			return false, application.Fail(409, "ANALYSIS_FENCED", "This analysis batch is no longer current.")
		}
		for _, candidate := range parsed.Findings {
			if candidate.Kind != "conflict" && candidate.Kind != "continuity" {
				continue
			}
			items := s.synthesisEvidence(st, job.AnalysisID, candidate.Evidence)
			if len(items) == 0 {
				continue
			}
			finding := &Finding{
				FindingID: newID("find-"), AnalysisID: job.AnalysisID, BatchID: batch.BatchID,
				Kind: candidate.Kind, Title: truncate(candidate.Title, 200), Statement: truncate(candidate.Statement, 2000),
				Confidence: candidate.Confidence, Status: "proposed", EntityIDs: []string{},
				Evidence: items, CreatedAt: now, UpdatedAt: now,
			}
			st.Findings[finding.FindingID] = finding
		}
		batch.Status = "completed"
		batch.Lease = ""
		batch.Deadline = ""
		job.SynthesisStatus = "completed"
		job.UpdatedAt = now
		job.Progress = progressOf(job)
		job.Status = deriveStatus(job)
		return true, nil
	})
}

func (s *Service) synthesisEvidence(st *State, analysisID string, items []candidateEvidence) []Evidence {
	out := []Evidence{}
	for _, item := range items {
		for _, finding := range st.Findings {
			if finding.AnalysisID != analysisID {
				continue
			}
			for _, evidence := range finding.Evidence {
				if evidence.ChapterID == item.ChapterID && evidence.Quote == item.Quote {
					out = append(out, evidence)
					break
				}
			}
		}
	}
	return out
}

func (s *Service) maybeQueueSynthesis(st *State, job *Job) {
	if job.SynthesisStatus != "pending" {
		return
	}
	for _, batch := range job.Batches {
		if batch.Phase == "synthesis" {
			return
		}
		if batch.Status == "pending" || batch.Status == "running" {
			return
		}
	}
	completed := 0
	for _, batch := range job.Batches {
		if batch.Phase == "chapters" && batch.Status == "completed" {
			completed++
		}
	}
	if completed == 0 {
		job.SynthesisStatus = "failed"
		return
	}
	job.Batches = append(job.Batches, Batch{
		BatchID: newID("batch-"), Status: "pending", Phase: "synthesis",
	})
}

func (s *Service) findOrCreateEntity(st *State, candidate candidateEntity, now string) Entity {
	key := candidate.Kind + "\x00" + normalizeName(candidate.Name)
	for _, entity := range st.Entities {
		if entity.Kind+"\x00"+normalizeName(entity.Name) == key || containsNormalized(entity.Aliases, candidate.Name) {
			entity.Aliases = mergeStrings(entity.Aliases, candidate.Aliases)
			if entity.Description == "" {
				entity.Description = truncate(candidate.Description, 2000)
			}
			entity.UpdatedAt = now
			return *entity
		}
	}
	return Entity{
		EntityID: newID("went-"), BookID: s.App.Project, Kind: candidate.Kind,
		Name: truncate(candidate.Name, 120), Aliases: mergeStrings(nil, candidate.Aliases),
		Description: truncate(candidate.Description, 2000), Attributes: map[string]string{},
		State: "observed", Evidence: []Evidence{}, CreatedAt: now, UpdatedAt: now,
	}
}

func (s *Service) applyAttributes(st *State, analysisID string, entity *Entity, attributes map[string]string, now string) {
	if entity.Attributes == nil {
		entity.Attributes = map[string]string{}
	}
	for name, value := range attributes {
		if existing, ok := entity.Attributes[name]; ok && existing != value {
			s.recordConflict(st, analysisID, entity, name, existing, value, now)
			continue
		}
		entity.Attributes[name] = truncate(value, 500)
	}
	entity.UpdatedAt = now
}

func (s *Service) recordConflict(st *State, analysisID string, entity *Entity, attribute, first, second, now string) {
	statement := fmt.Sprintf("“%s”的%s存在不一致：%s / %s。", entity.Name, attribute, first, second)
	for _, finding := range st.Findings {
		if finding.AnalysisID == analysisID && finding.Kind == "conflict" && finding.Statement == statement {
			return
		}
	}
	finding := &Finding{
		FindingID: newID("find-"), AnalysisID: analysisID, BatchID: "",
		Kind: "conflict", Title: truncate("属性冲突："+entity.Name, 200), Statement: truncate(statement, 2000),
		Confidence: 1, Status: "proposed", EntityIDs: []string{entity.EntityID},
		Evidence: append([]Evidence{}, entity.Evidence...), CreatedAt: now, UpdatedAt: now,
	}
	if len(finding.Evidence) == 0 {
		return
	}
	st.Findings[finding.FindingID] = finding
	entity.State = "candidate"
}

func (s *Service) retryOrFail(ctx context.Context, prepared *PreparedBatch, code string) error {
	_, err := s.markBatch(ctx, &ClaimedBatch{
		Job:   Job{AnalysisID: prepared.AnalysisID},
		Batch: Batch{BatchID: prepared.BatchID, Lease: prepared.Lease, Epoch: prepared.Epoch, Phase: prepared.Phase},
	}, "retry", code)
	return err
}

func (s *Service) failBatch(ctx context.Context, claim *ClaimedBatch, code string) error {
	if err := s.finishBatch(ctx, claim, "failed", code); err != nil {
		return err
	}
	return application.Fail(422, code, "This analysis batch cannot run.")
}

// finishBatch ends the executor lease together with the batch, so a prepare
// failure cannot leave a live lease behind.
func (s *Service) finishBatch(ctx context.Context, claim *ClaimedBatch, outcome, code string) error {
	return s.withLease(ctx, &PreparedBatch{
		AnalysisID: claim.Job.AnalysisID, BatchID: claim.Batch.BatchID, Phase: claim.Batch.Phase,
		Lease: claim.Batch.Lease, Epoch: claim.Batch.Epoch,
	}, func() error {
		_, e := s.markBatch(ctx, claim, outcome, code)
		return e
	})
}

func (s *Service) markBatch(ctx context.Context, claim *ClaimedBatch, outcome, code string) (bool, error) {
	changed := false
	err := s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[claim.Job.AnalysisID]
		if job == nil {
			return false, nil
		}
		batch := findBatch(job, claim.Batch.BatchID)
		if batch == nil || batch.Status != "running" {
			return false, nil
		}
		if claim.Batch.Lease != "" && batch.Lease != claim.Batch.Lease {
			return false, application.Fail(409, "ANALYSIS_FENCED", "This analysis batch is no longer current.")
		}
		now := time.Now().UTC()
		switch outcome {
		case "stale":
			batch.Status = "stale"
		case "retry":
			if batch.Attempts < 3 {
				batch.Status = "pending"
				batch.Due = now.Add(time.Duration(1<<batch.Attempts) * time.Second).Format(time.RFC3339Nano)
			} else {
				batch.Status = "failed"
			}
		default:
			batch.Status = "failed"
		}
		batch.FailureCode = code
		batch.Lease = ""
		batch.Deadline = ""
		if batch.Phase == "synthesis" && batch.Status != "pending" {
			job.SynthesisStatus = "failed"
		}
		job.UpdatedAt = compat.Now()
		job.Progress = progressOf(job)
		s.maybeQueueSynthesis(st, job)
		job.Status = deriveStatus(job)
		changed = true
		return true, nil
	})
	return changed, err
}

func findBatch(job *Job, id string) *Batch {
	for i := range job.Batches {
		if job.Batches[i].BatchID == id {
			return &job.Batches[i]
		}
	}
	return nil
}

func meterOp(prepared *PreparedBatch) string {
	return prepared.MeterOp
}

func failureCode(err error) string {
	var appErr *application.Error
	if errors.As(err, &appErr) && appErr.Code != "" {
		return appErr.Code
	}
	var llmErr *llm.Error
	if errors.As(err, &llmErr) && llmErr.Code != "" {
		return llmErr.Code
	}
	return "ANALYSIS_FAILED"
}

func validFindingKind(kind string) bool {
	switch kind {
	case "character", "place", "event", "rule", "relationship", "thread", "timeline":
		return true
	}
	return false
}

func validEntityKind(kind string) bool {
	switch kind {
	case "character", "place", "faction", "item", "rule", "event", "thread":
		return true
	}
	return false
}

func volumeTitle(chapter application.Chapter) string {
	if chapter.VolumeTitle != nil {
		return *chapter.VolumeTitle
	}
	return ""
}

func normalizeName(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(name)), ""))
}

func containsNormalized(values []string, wanted string) bool {
	wanted = normalizeName(wanted)
	for _, value := range values {
		if normalizeName(value) == wanted {
			return true
		}
	}
	return false
}

func mergeStrings(existing, added []string) []string {
	out := append([]string{}, existing...)
	for _, value := range added {
		if value == "" || containsNormalized(out, value) {
			continue
		}
		out = append(out, truncate(value, 120))
	}
	return out
}

func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func mergeEvidence(existing, added []Evidence) []Evidence {
	out := append([]Evidence{}, existing...)
	for _, item := range added {
		found := false
		for _, current := range out {
			if current.ChapterID == item.ChapterID && current.RevisionID == item.RevisionID && current.Quote == item.Quote {
				found = true
				break
			}
		}
		if !found {
			out = append(out, item)
		}
	}
	return out
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

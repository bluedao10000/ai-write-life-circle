package analysis

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

type Service struct {
	App           *application.Service
	Config        llm.Config
	ExecutorOwner string
	QueueOnly     bool
}

func New(app *application.Service, config llm.Config) *Service {
	return &Service{App: app, Config: config}
}

func (s *Service) contextLimit() int {
	if s.Config.MaxContextBytes > 0 {
		return s.Config.MaxContextBytes
	}
	return 64 * 1024
}

func (s *Service) outputLimit() int {
	if s.Config.MaxOutputTokens > 0 {
		return min(s.Config.MaxOutputTokens, 16384)
	}
	return DefaultOutputSize
}

func (s *Service) Create(ctx context.Context, key string, chapterIDs []string) (View, error) {
	if s.App.Owner == "" {
		return View{}, application.Fail(403, "AUTHOR_DECISION_REQUIRED", "Only the owning author may start analysis.")
	}
	if !application.SafeKey(key) {
		return View{}, application.Fail(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required.")
	}
	if err := s.App.MeterAllow(ctx, "analysis"); err != nil {
		return View{}, err
	}
	projection, err := s.App.Projection()
	if err != nil {
		return View{}, err
	}
	all, err := application.Sources(projection)
	if err != nil {
		return View{}, err
	}
	wanted := map[string]bool{}
	for _, id := range chapterIDs {
		wanted[id] = true
	}
	if len(wanted) == 0 {
		for _, chapter := range all {
			wanted[chapter.ID] = true
		}
	}
	if len(wanted) == 0 {
		return View{}, application.Fail(422, "ANALYSIS_EMPTY", "This book has no chapters to analyze.")
	}
	if len(wanted) > MaxChapters {
		return View{}, application.Fail(422, "ANALYSIS_TOO_LARGE", "A single analysis is limited to 2000 chapters.")
	}
	refs := []ChapterRef{}
	seen := map[string]bool{}
	for _, chapter := range all {
		if !wanted[chapter.ID] || seen[chapter.ID] {
			continue
		}
		seen[chapter.ID] = true
		head, err := s.App.Head(ctx, chapter)
		if err != nil {
			return View{}, err
		}
		ref := ChapterRef{
			ChapterID:   chapter.ID,
			RevisionID:  head.ID,
			ContentHash: head.Hash,
			WordCount:   head.Words,
			VolumeID:    chapter.VolumeID,
			Order:       orderOf(chapter, len(refs)+1),
		}
		ref.Stamp, ref.Size, _ = s.draftStamp(chapter.ID)
		refs = append(refs, ref)
	}
	if len(refs) != len(wanted) {
		return View{}, application.Fail(404, "NOT_FOUND", "A requested chapter no longer exists.")
	}
	sort.SliceStable(refs, func(i, j int) bool {
		if refs[i].VolumeID != refs[j].VolumeID {
			return refs[i].VolumeID < refs[j].VolumeID
		}
		if refs[i].Order != refs[j].Order {
			return refs[i].Order < refs[j].Order
		}
		return refs[i].ChapterID < refs[j].ChapterID
	})
	// Batch by the exact frozen revision sizes after ordering.
	sizes := make([]int, len(refs))
	for i, ref := range refs {
		chapter, err := s.App.Source(ref.ChapterID)
		if err != nil {
			return View{}, err
		}
		head, err := s.App.Head(ctx, chapter)
		if err != nil {
			return View{}, err
		}
		sizes[i] = len(head.Markdown)
	}
	batches := buildBatches(refs, sizes, max(8192, s.contextLimit()-8192))
	fingerprint := manifestFingerprint(refs)
	now := compat.Now()
	var result View
	err = s.transaction(ctx, func(st *State) (bool, error) {
		if receipt, ok := st.Requests[key]; ok {
			if receipt.Fingerprint != fingerprint {
				return false, application.Fail(422, "VALIDATION_FAILED", "The Idempotency-Key was already used for a different analysis.")
			}
			if job := st.Jobs[receipt.AnalysisID]; job != nil {
				result = s.viewOf(st, job)
				return false, nil
			}
		}
		for _, job := range st.Jobs {
			if job.Fingerprint == fingerprint && (job.Status == "queued" || job.Status == "running" || job.Status == "paused") {
				st.Requests[key] = receipt{Fingerprint: fingerprint, AnalysisID: job.AnalysisID}
				result = s.viewOf(st, job)
				return true, nil
			}
		}
		// A revision change reruns only the batches that contain changed
		// chapters; unchanged findings and author decisions stay in place.
		if previous := s.previousJob(st, refs); previous != nil && s.refreshJob(st, previous, refs, now) {
			st.Requests[key] = receipt{Fingerprint: fingerprint, AnalysisID: previous.AnalysisID}
			result = s.viewOf(st, previous)
			return true, nil
		}
		id := newID("ana-")
		manifest := &Manifest{
			AnalysisID:      id,
			BookID:          s.App.Project,
			StrategyVersion: Strategy,
			CreatedAt:       now,
			Chapters:        refs,
			Batches:         batches,
		}
		job := &Job{
			AnalysisID:      id,
			BookID:          s.App.Project,
			OwnerID:         s.App.Owner,
			Status:          "queued",
			StrategyVersion: Strategy,
			CreatedAt:       now,
			UpdatedAt:       now,
			SynthesisStatus: "pending",
			ManifestID:      id,
			Fingerprint:     fingerprint,
		}
		for _, batch := range batches {
			job.Batches = append(job.Batches, Batch{
				BatchID: batch.BatchID, ChapterIDs: batch.ChapterIDs,
				Status: "pending", Phase: "chapters",
			})
		}
		job.Progress = progressOf(job)
		st.Jobs[id] = job
		st.Manifests[id] = manifest
		st.Requests[key] = receipt{Fingerprint: fingerprint, AnalysisID: id}
		st.Current = id
		result = s.viewOf(st, job)
		return true, nil
	})
	return result, err
}

func (s *Service) View(ctx context.Context) (View, error) {
	var result View
	err := s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[st.Current]
		if job == nil {
			result = View{Findings: []Finding{}, Entities: []Entity{}}
			return false, nil
		}
		changed := s.markStale(st, job)
		if changed {
			job.UpdatedAt = compat.Now()
			job.Progress = progressOf(job)
		}
		result = s.viewOf(st, job)
		return changed, nil
	})
	return result, err
}

// Counts reports job-level progress for the Worker heartbeat without mutating state.
type Counts struct {
	Pending   int
	Running   int
	Completed int
	Failed    int
	Cancelled int
}

func (s *Service) Counts(ctx context.Context) (Counts, error) {
	st, err := s.load()
	if err != nil {
		return Counts{}, err
	}
	var out Counts
	for _, job := range st.Jobs {
		switch job.Status {
		case "queued", "paused":
			out.Pending++
		case "running":
			out.Running++
		case "completed":
			out.Completed++
		case "failed":
			out.Failed++
		case "cancelled":
			out.Cancelled++
		}
	}
	return out, nil
}

func (s *Service) Pause(ctx context.Context) (View, error) {
	return s.setStatus(ctx, "paused")
}

func (s *Service) Resume(ctx context.Context) (View, error) {
	var result View
	err := s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[st.Current]
		if job == nil {
			return false, application.Fail(404, "NOT_FOUND", "No analysis job exists for this book.")
		}
		if job.Status != "paused" {
			return false, application.Fail(409, "ANALYSIS_NOT_PAUSED", "Only a paused analysis can resume.")
		}
		job.Status = "running"
		job.UpdatedAt = compat.Now()
		for i := range job.Batches {
			if job.Batches[i].Status == "failed" && job.Batches[i].FailureCode == "ANALYSIS_PAUSED" {
				job.Batches[i].Status = "pending"
				job.Batches[i].FailureCode = ""
			}
		}
		if job.SynthesisStatus == "failed" {
			job.SynthesisStatus = "pending"
		}
		job.Progress = progressOf(job)
		result = s.viewOf(st, job)
		return true, nil
	})
	return result, err
}

func (s *Service) Cancel(ctx context.Context) (View, error) {
	var result View
	err := s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[st.Current]
		if job == nil {
			return false, application.Fail(404, "NOT_FOUND", "No analysis job exists for this book.")
		}
		if job.Status == "completed" || job.Status == "cancelled" {
			return false, application.Fail(409, "ANALYSIS_TERMINAL", "This analysis has already finished.")
		}
		job.Status = "cancelled"
		job.UpdatedAt = compat.Now()
		for i := range job.Batches {
			if job.Batches[i].Status == "pending" || job.Batches[i].Status == "running" {
				job.Batches[i].Status = "failed"
				job.Batches[i].FailureCode = "ANALYSIS_CANCELLED"
			}
		}
		if job.SynthesisStatus == "pending" || job.SynthesisStatus == "running" {
			job.SynthesisStatus = "failed"
		}
		job.Progress = progressOf(job)
		result = s.viewOf(st, job)
		return true, nil
	})
	return result, err
}

func (s *Service) setStatus(ctx context.Context, status string) (View, error) {
	var result View
	err := s.transaction(ctx, func(st *State) (bool, error) {
		job := st.Jobs[st.Current]
		if job == nil {
			return false, application.Fail(404, "NOT_FOUND", "No analysis job exists for this book.")
		}
		if job.Status == "completed" || job.Status == "cancelled" {
			return false, application.Fail(409, "ANALYSIS_TERMINAL", "This analysis has already finished.")
		}
		job.Status = status
		job.UpdatedAt = compat.Now()
		if status == "paused" {
			for i := range job.Batches {
				if job.Batches[i].Status == "running" {
					job.Batches[i].Status = "failed"
					job.Batches[i].FailureCode = "ANALYSIS_PAUSED"
				}
			}
			if job.SynthesisStatus == "running" {
				job.SynthesisStatus = "failed"
			}
		}
		job.Progress = progressOf(job)
		result = s.viewOf(st, job)
		return true, nil
	})
	return result, err
}

func (s *Service) Decide(ctx context.Context, findingID, decision, note string) (View, error) {
	if decision != "confirm" && decision != "reject" {
		return View{}, application.Fail(422, "VALIDATION_FAILED", "Decision must be confirm or reject.")
	}
	var result View
	err := s.transaction(ctx, func(st *State) (bool, error) {
		finding := st.Findings[findingID]
		if finding == nil {
			return false, application.Fail(404, "NOT_FOUND", "Finding not found.")
		}
		job := st.Jobs[finding.AnalysisID]
		if job == nil {
			return false, application.Fail(404, "NOT_FOUND", "Analysis job not found.")
		}
		now := compat.Now()
		if decision == "confirm" {
			finding.Status = "author_confirmed"
			for _, id := range finding.EntityIDs {
				if entity := st.Entities[id]; entity != nil {
					entity.State = "author_confirmed"
					entity.UpdatedAt = now
				}
			}
		} else {
			finding.Status = "rejected"
			for _, id := range finding.EntityIDs {
				entity := st.Entities[id]
				if entity == nil {
					continue
				}
				otherConfirmed := false
				for _, other := range st.Findings {
					if other.FindingID == finding.FindingID || other.Status != "author_confirmed" {
						continue
					}
					for _, otherID := range other.EntityIDs {
						if otherID == id {
							otherConfirmed = true
						}
					}
				}
				if !otherConfirmed {
					entity.State = "rejected"
					entity.UpdatedAt = now
				}
			}
		}
		finding.AuthorNote = note
		finding.UpdatedAt = now
		job.UpdatedAt = now
		result = s.viewOf(st, job)
		return true, nil
	})
	return result, err
}

func (s *Service) viewOf(st *State, job *Job) View {
	manifest := st.Manifests[job.ManifestID]
	public := *job
	// Lease, meter and draft-stat fields are executor internals; the author view
	// exposes only job progress and frozen chapter identities.
	public.ManifestID, public.Fingerprint = "", ""
	public.Batches = make([]Batch, len(job.Batches))
	for i, batch := range job.Batches {
		batch.Lease, batch.Epoch, batch.MeterOp = "", 0, ""
		batch.Reserved, batch.BudgetDay, batch.Deadline, batch.Due = 0, "", "", ""
		public.Batches[i] = batch
	}
	if manifest != nil {
		copy := *manifest
		copy.Chapters = append([]ChapterRef{}, manifest.Chapters...)
		for i := range copy.Chapters {
			copy.Chapters[i].Stamp, copy.Chapters[i].Size = 0, 0
		}
		manifest = &copy
	}
	findings := []Finding{}
	for _, finding := range st.Findings {
		if finding.AnalysisID == job.AnalysisID {
			findings = append(findings, *finding)
		}
	}
	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].CreatedAt != findings[j].CreatedAt {
			return findings[i].CreatedAt < findings[j].CreatedAt
		}
		return findings[i].FindingID < findings[j].FindingID
	})
	entities := []Entity{}
	for _, entity := range st.Entities {
		entities = append(entities, *entity)
	}
	sort.SliceStable(entities, func(i, j int) bool {
		if entities[i].Kind != entities[j].Kind {
			return entities[i].Kind < entities[j].Kind
		}
		return entities[i].Name < entities[j].Name
	})
	return View{Job: &public, Manifest: manifest, Findings: findings, Entities: entities}
}

// previousJob finds the newest non-cancelled analysis that froze exactly the
// same chapter set, so a later revision can rerun just the affected batches.
func (s *Service) previousJob(st *State, refs []ChapterRef) *Job {
	var previous *Job
	for _, job := range st.Jobs {
		if job.Status == "cancelled" {
			continue
		}
		manifest := st.Manifests[job.ManifestID]
		if manifest == nil || len(manifest.Chapters) != len(refs) {
			continue
		}
		ids := map[string]bool{}
		for _, chapter := range manifest.Chapters {
			ids[chapter.ChapterID] = true
		}
		same := true
		for _, ref := range refs {
			if !ids[ref.ChapterID] {
				same = false
				break
			}
		}
		if same && (previous == nil || job.UpdatedAt > previous.UpdatedAt) {
			previous = job
		}
	}
	return previous
}

func (s *Service) refreshJob(st *State, job *Job, refs []ChapterRef, now string) bool {
	manifest := st.Manifests[job.ManifestID]
	if manifest == nil {
		return false
	}
	old := map[string]ChapterRef{}
	for _, ref := range manifest.Chapters {
		old[ref.ChapterID] = ref
	}
	changed := map[string]bool{}
	for _, ref := range refs {
		if previous, ok := old[ref.ChapterID]; !ok || previous.RevisionID != ref.RevisionID || previous.ContentHash != ref.ContentHash {
			changed[ref.ChapterID] = true
		}
	}
	if len(changed) == 0 {
		return false
	}
	manifest.Chapters = refs
	job.Fingerprint = manifestFingerprint(refs)
	job.UpdatedAt = now
	for _, finding := range st.Findings {
		if finding.AnalysisID != job.AnalysisID || finding.Status == "author_confirmed" || finding.Status == "rejected" {
			continue
		}
		if finding.Kind == "conflict" || finding.Kind == "continuity" {
			finding.Status = "stale"
			finding.UpdatedAt = now
			continue
		}
		for _, evidence := range finding.Evidence {
			if changed[evidence.ChapterID] {
				finding.Status = "stale"
				finding.UpdatedAt = now
				break
			}
		}
	}
	for _, entity := range st.Entities {
		if entity.State == "author_confirmed" || entity.State == "rejected" {
			continue
		}
		for _, evidence := range entity.Evidence {
			if changed[evidence.ChapterID] {
				entity.State = "superseded"
				entity.UpdatedAt = now
				break
			}
		}
	}
	batches := make([]Batch, 0, len(job.Batches))
	for _, batch := range job.Batches {
		if batch.Phase == "synthesis" {
			continue
		}
		for _, id := range batch.ChapterIDs {
			if changed[id] {
				batch.Status = "pending"
				batch.Attempts = 0
				batch.FailureCode = ""
				batch.Deadline = ""
				batch.Lease = ""
				batch.Due = ""
				break
			}
		}
		batches = append(batches, batch)
	}
	job.Batches = batches
	job.SynthesisStatus = "pending"
	job.Progress = progressOf(job)
	job.Status = deriveStatus(job)
	return true
}

func (s *Service) markStale(st *State, job *Job) bool {
	manifest := st.Manifests[job.ManifestID]
	if manifest == nil {
		return false
	}
	// Stat only chapters that can still change the outcome: unfinished batches
	// and chapters cited by findings/entities the author has not decided.
	watch := map[string]bool{}
	for _, batch := range job.Batches {
		if batch.Status == "completed" || batch.Status == "stale" {
			continue
		}
		for _, id := range batch.ChapterIDs {
			watch[id] = true
		}
	}
	for _, finding := range st.Findings {
		if finding.AnalysisID != job.AnalysisID || finding.Status == "author_confirmed" || finding.Status == "rejected" {
			continue
		}
		for _, evidence := range finding.Evidence {
			watch[evidence.ChapterID] = true
		}
	}
	for _, entity := range st.Entities {
		if entity.State == "author_confirmed" || entity.State == "rejected" {
			continue
		}
		for _, evidence := range entity.Evidence {
			watch[evidence.ChapterID] = true
		}
	}
	stale := map[string]bool{}
	for _, chapter := range manifest.Chapters {
		if chapter.Stamp == 0 || !watch[chapter.ChapterID] {
			continue
		}
		stamp, size, err := s.draftStamp(chapter.ChapterID)
		if err == nil && stamp == chapter.Stamp && size == chapter.Size {
			continue
		}
		stale[chapter.ChapterID] = true
	}
	if len(stale) == 0 {
		return false
	}
	changed := false
	for i := range job.Batches {
		if job.Batches[i].Status == "stale" || job.Batches[i].Status == "completed" {
			continue
		}
		for _, id := range job.Batches[i].ChapterIDs {
			if stale[id] {
				job.Batches[i].Status = "stale"
				changed = true
				break
			}
		}
	}
	for _, finding := range st.Findings {
		if finding.AnalysisID != job.AnalysisID || finding.Status == "author_confirmed" || finding.Status == "rejected" {
			continue
		}
		for _, evidence := range finding.Evidence {
			if stale[evidence.ChapterID] {
				finding.Status = "stale"
				changed = true
				break
			}
		}
	}
	for _, entity := range st.Entities {
		if entity.State == "author_confirmed" || entity.State == "rejected" {
			continue
		}
		for _, evidence := range entity.Evidence {
			if stale[evidence.ChapterID] {
				entity.State = "superseded"
				changed = true
				break
			}
		}
	}
	if changed {
		// Surviving completed batches still feed synthesis; if none survive the
		// synthesis step is recorded as failed rather than left running forever.
		s.maybeQueueSynthesis(st, job)
		job.Status = deriveStatus(job)
	}
	return changed
}

func (s *Service) draftStamp(chapterID string) (int64, int64, error) {
	path := filepath.Join(s.App.State, "chapter-drafts", compat.Key(s.App.Project), compat.Key(chapterID)+".json")
	info, err := os.Stat(path)
	if err != nil {
		return 0, 0, err
	}
	return info.ModTime().UnixNano(), info.Size(), nil
}

func orderOf(chapter application.Chapter, fallback int) int {
	if chapter.Order != nil {
		return int(*chapter.Order)
	}
	return fallback
}

func buildBatches(refs []ChapterRef, sizes []int, limit int) []ManifestBatch {
	batches := []ManifestBatch{}
	current := []string{}
	currentBytes := 0
	flush := func() {
		if len(current) == 0 {
			return
		}
		batches = append(batches, ManifestBatch{BatchID: newID("batch-"), ChapterIDs: current})
		current = []string{}
		currentBytes = 0
	}
	for i, ref := range refs {
		size := 0
		if i < len(sizes) {
			size = sizes[i]
		}
		if len(current) > 0 && (len(current) >= MaxBatchChapters || currentBytes+size > limit) {
			flush()
		}
		current = append(current, ref.ChapterID)
		currentBytes += size
	}
	flush()
	// A 5+1 split would leave a one-chapter tail; move one chapter so every
	// batch stays within the documented 2–5 range when bytes allow.
	if n := len(batches); n > 1 && len(batches[n-1].ChapterIDs) == 1 && len(batches[n-2].ChapterIDs) == MaxBatchChapters {
		moved := batches[n-2].ChapterIDs[len(batches[n-2].ChapterIDs)-1]
		batches[n-2].ChapterIDs = batches[n-2].ChapterIDs[:len(batches[n-2].ChapterIDs)-1]
		batches[n-1].ChapterIDs = append([]string{moved}, batches[n-1].ChapterIDs...)
	}
	return batches
}

// Batch IDs are random, so the idempotency fingerprint covers only the frozen
// chapter identities. Identical chapter sets reuse the active job.
func manifestFingerprint(refs []ChapterRef) string {
	raw, _ := json.Marshal(struct {
		Strategy string       `json:"strategy"`
		Chapters []ChapterRef `json:"chapters"`
	}{Strategy, refs})
	return compat.Hash(string(raw))
}

func progressOf(job *Job) Progress {
	p := Progress{Total: len(job.Batches)}
	for _, batch := range job.Batches {
		switch batch.Status {
		case "pending":
			p.Pending++
		case "running":
			p.Running++
		case "completed":
			p.Completed++
		case "failed":
			p.Failed++
		case "stale":
			p.Stale++
		}
	}
	return p
}

func deriveStatus(job *Job) string {
	if job.Status == "paused" || job.Status == "cancelled" {
		return job.Status
	}
	p := progressOf(job)
	if p.Pending > 0 || p.Running > 0 {
		if job.CreatedAt == job.UpdatedAt {
			return "queued"
		}
		return "running"
	}
	if job.SynthesisStatus == "pending" || job.SynthesisStatus == "running" {
		return "running"
	}
	if job.SynthesisStatus == "failed" || (p.Failed > 0 && p.Completed == 0) || (p.Stale > 0 && p.Completed == 0) {
		return "failed"
	}
	return "completed"
}

func (s *Service) timeout() time.Duration {
	if s.Config.Timeout > 0 {
		return s.Config.Timeout
	}
	return 180 * time.Second
}

// settlePoints: unsent calls are free, reported usage is charged, and a sent
// call without usage keeps its reservation.
func settlePoints(response llm.Response, sent bool) int {
	if !sent {
		return 0
	}
	if response.Usage == nil {
		return -1
	}
	return billingPoints(response.Usage.InputTokens, response.Usage.OutputTokens, response.Usage.CachedInputTokens)
}

func billingPoints(input, output, cached int) int {
	return billing.PointsFor(input, output, cached)
}

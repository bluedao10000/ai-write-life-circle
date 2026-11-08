// Package analysis owns whole-book analysis manifests, chapter batches and
// candidate findings. It never confirms canon; only the author does that.
package analysis

import "github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"

const (
	Strategy          = "novel-intelligence-v1"
	SchemaVersion     = 1
	MaxChapters       = 2000
	MaxBatchChapters  = 5
	MinBatchChapters  = 2
	DefaultOutputSize = 8192
)

type Evidence struct {
	ChapterID   string `json:"chapterId"`
	RevisionID  string `json:"revisionId"`
	ContentHash string `json:"contentHash"`
	Quote       string `json:"quote"`
	Start       int    `json:"startUTF16"`
	End         int    `json:"endUTF16"`
}

type ChapterRef struct {
	ChapterID   string `json:"chapterId"`
	RevisionID  string `json:"revisionId"`
	ContentHash string `json:"contentHash"`
	WordCount   int    `json:"wordCount"`
	VolumeID    string `json:"volumeId,omitempty"`
	Order       int    `json:"order"`
	// Stamp and Size detect a changed draft without parsing it on every view.
	Stamp int64 `json:"stamp,omitempty"`
	Size  int64 `json:"size,omitempty"`
}

type ManifestBatch struct {
	BatchID    string   `json:"batchId"`
	ChapterIDs []string `json:"chapterIds"`
}

type Manifest struct {
	AnalysisID      string          `json:"analysisId"`
	BookID          string          `json:"bookId"`
	StrategyVersion string          `json:"strategyVersion"`
	CreatedAt       string          `json:"createdAt"`
	Chapters        []ChapterRef    `json:"chapters"`
	Batches         []ManifestBatch `json:"batches"`
}

type Batch struct {
	BatchID     string   `json:"batchId"`
	ChapterIDs  []string `json:"chapterIds"`
	Status      string   `json:"status"`
	Phase       string   `json:"phase"`
	Attempts    int      `json:"attempts"`
	FailureCode string   `json:"failureCode,omitempty"`
	TaskID      string   `json:"taskId,omitempty"`
	Reserved    int      `json:"reservedTokens,omitempty"`
	BudgetDay   string   `json:"budgetDay,omitempty"`
	Deadline    string   `json:"deadlineAt,omitempty"`
	Due         string   `json:"nextAttemptAt,omitempty"`
	Lease       string   `json:"leaseToken,omitempty"`
	Epoch       uint64   `json:"executorEpoch,omitempty"`
	MeterOp     string   `json:"meterOp,omitempty"`
}

type Progress struct {
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Running   int `json:"running"`
	Completed int `json:"completed"`
	Failed    int `json:"failed"`
	Stale     int `json:"stale"`
}

type Job struct {
	AnalysisID      string   `json:"analysisId"`
	BookID          string   `json:"bookId"`
	OwnerID         string   `json:"ownerId"`
	Status          string   `json:"status"`
	StrategyVersion string   `json:"strategyVersion"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`
	Progress        Progress `json:"progress"`
	Batches         []Batch  `json:"batches"`
	SynthesisStatus string   `json:"synthesisStatus"`
	ManifestID      string   `json:"manifestId"`
	Fingerprint     string   `json:"fingerprint,omitempty"`
}

type Finding struct {
	FindingID              string     `json:"findingId"`
	AnalysisID             string     `json:"analysisId"`
	BatchID                string     `json:"batchId"`
	Kind                   string     `json:"kind"`
	Title                  string     `json:"title"`
	Statement              string     `json:"statement"`
	AlternativeExplanation string     `json:"alternativeExplanation,omitempty"`
	Confidence             float64    `json:"confidence"`
	Status                 string     `json:"status"`
	EntityIDs              []string   `json:"entityIds"`
	Evidence               []Evidence `json:"evidence"`
	CreatedAt              string     `json:"createdAt"`
	UpdatedAt              string     `json:"updatedAt"`
	AuthorNote             string     `json:"authorNote,omitempty"`
}

type Entity struct {
	EntityID       string            `json:"entityId"`
	BookID         string            `json:"bookId"`
	Kind           string            `json:"kind"`
	Name           string            `json:"name"`
	Aliases        []string          `json:"aliases"`
	Description    string            `json:"description"`
	Attributes     map[string]string `json:"attributes"`
	State          string            `json:"state"`
	FirstChapterID string            `json:"firstChapterId,omitempty"`
	LastChapterID  string            `json:"lastChapterId,omitempty"`
	Evidence       []Evidence        `json:"evidence"`
	CreatedAt      string            `json:"createdAt"`
	UpdatedAt      string            `json:"updatedAt"`
}

type receipt struct {
	Fingerprint string `json:"fingerprint"`
	AnalysisID  string `json:"analysisId"`
}

type State struct {
	SchemaVersion int                  `json:"schemaVersion"`
	BookID        string               `json:"bookId"`
	Version       int                  `json:"version"`
	Jobs          map[string]*Job      `json:"jobs"`
	Manifests     map[string]*Manifest `json:"manifests"`
	Findings      map[string]*Finding  `json:"findings"`
	Entities      map[string]*Entity   `json:"entities"`
	Requests      map[string]receipt   `json:"requests"`
	Current       string               `json:"currentAnalysisId,omitempty"`
}

type View struct {
	Job      *Job      `json:"job"`
	Manifest *Manifest `json:"manifest"`
	Findings []Finding `json:"findings"`
	Entities []Entity  `json:"entities"`
}

type ClaimedBatch struct {
	Job      Job
	Batch    Batch
	Manifest Manifest
	Reserved int
	Day      string
}

type ChapterInput struct {
	ChapterID   string `json:"chapterId"`
	RevisionID  string `json:"revisionId"`
	ContentHash string `json:"contentHash"`
	Title       string `json:"title"`
	Volume      string `json:"volume,omitempty"`
	Order       int    `json:"order"`
	Markdown    string `json:"markdown"`
}

type PreparedBatch struct {
	AnalysisID string         `json:"analysisId"`
	BatchID    string         `json:"batchId"`
	Phase      string         `json:"phase"`
	Chapters   []ChapterInput `json:"chapters"`
	Request    llm.Request    `json:"request"`
	Reserved   int            `json:"reservedTokens"`
	Day        string         `json:"budgetDay"`
	Lease      string         `json:"leaseToken"`
	Epoch      uint64         `json:"executorEpoch"`
	MeterOp    string         `json:"meterOp"`
}

type candidateEvidence struct {
	ChapterID string `json:"chapterId"`
	Quote     string `json:"quote"`
}

type candidateFinding struct {
	Kind                   string              `json:"kind"`
	Title                  string              `json:"title"`
	Statement              string              `json:"statement"`
	AlternativeExplanation string              `json:"alternativeExplanation,omitempty"`
	Confidence             float64             `json:"confidence"`
	EntityNames            []string            `json:"entityNames,omitempty"`
	Evidence               []candidateEvidence `json:"evidence"`
}

type candidateEntity struct {
	Kind        string            `json:"kind"`
	Name        string            `json:"name"`
	Aliases     []string          `json:"aliases,omitempty"`
	Description string            `json:"description,omitempty"`
	Attributes  map[string]string `json:"attributes,omitempty"`
}

type candidates struct {
	Findings []candidateFinding `json:"findings"`
	Entities []candidateEntity  `json:"entities"`
}

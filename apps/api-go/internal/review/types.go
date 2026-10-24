// Package review runs author-requested continuity checks against immutable evidence snapshots.
package review

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"io"
	"strings"
)

//go:embed candidate.schema.json
var candidateJSON []byte

func CandidateSchema() map[string]any {
	var v map[string]any
	_ = json.Unmarshal(candidateJSON, &v)
	return v
}

type Input struct {
	RevisionID  string   `json:"revisionId"`
	ContentHash string   `json:"contentHash"`
	ReviewTypes []string `json:"reviewTypes"`
}
type CreateInput struct {
	Input
	Consent struct {
		Confirmed bool   `json:"confirmed"`
		PlanHash  string `json:"planHash"`
	} `json:"consent"`
}
type Source struct {
	StructureHash string  `json:"structureHash,omitempty"`
	SourceID      string  `json:"sourceId"`
	Kind          string  `json:"kind"`
	ProjectID     string  `json:"projectId"`
	ChapterID     *string `json:"chapterId"`
	DocumentID    *string `json:"documentId"`
	RevisionID    *string `json:"revisionId"`
	Title         string  `json:"title"`
	Path          string  `json:"path"`
	ContentHash   string  `json:"contentHash"`
	SourceHash    string  `json:"sourceHash"`
	ExcerptHash   string  `json:"excerptHash"`
	Excerpt       string  `json:"excerpt"`
	StartUTF16    int     `json:"startUTF16"`
	EndUTF16      int     `json:"endUTF16"`
	Freshness     string  `json:"freshness"`
}
type Plan struct {
	ConfigFingerprint string `json:"configFingerprint,omitempty"`
	StrategyVersion   string `json:"strategyVersion"`
	Input
	ProjectID              string        `json:"projectId"`
	ChapterID              string        `json:"chapterId"`
	PlanHash               string        `json:"planHash"`
	Model                  llm.ModelInfo `json:"model"`
	Sources                []Source      `json:"sources"`
	ContextBytes           int           `json:"contextBytes"`
	BudgetBytes            int           `json:"budgetBytes"`
	ExcludedKnowledgeCount int           `json:"excludedKnowledgeCount"`
	SkippedSourceCount     int           `json:"skippedSourceCount"`
}
type Anchor struct {
	RevisionID     string `json:"revisionId"`
	ContentHash    string `json:"contentHash"`
	Quote          string `json:"quote"`
	OffsetEncoding string `json:"offsetEncoding"`
	Status         string `json:"status"`
	Start          *int   `json:"startUTF16"`
	End            *int   `json:"endUTF16"`
}
type Evidence struct {
	SourceID    string `json:"sourceId"`
	Quote       string `json:"quote"`
	Verified    bool   `json:"verified"`
	ContentHash string `json:"contentHash"`
	SourceHash  string `json:"sourceHash"`
	Start       *int   `json:"startUTF16"`
	End         *int   `json:"endUTF16"`
	Ambiguity   string `json:"ambiguity"`
}
type Feedback struct {
	FindingID string `json:"findingId"`
	Choice    string `json:"choice"`
	AuthorID  string `json:"authorId"`
	CreatedAt string `json:"createdAt"`
	Version   int64  `json:"version"`
}
type Finding struct {
	FindingID   string     `json:"findingId"`
	Type        string     `json:"type"`
	Title       string     `json:"title"`
	Inference   string     `json:"inference"`
	Question    string     `json:"question"`
	Alternative string     `json:"alternativeExplanation"`
	Evidence    []Evidence `json:"evidence"`
	Anchor      Anchor     `json:"anchor"`
	Feedback    *Feedback  `json:"feedback"`
}
type Run struct {
	CompletionReceipts map[string]string `json:"completionReceipts,omitempty"`
	ExecutorOwner      string            `json:"executorOwner,omitempty"`
	ExecutorEpoch      uint64            `json:"executorEpoch,omitempty"`
	Plan
	RunID            string     `json:"runId"`
	CreatedBy        string     `json:"createdBy"`
	Version          int64      `json:"version"`
	Status           string     `json:"status"`
	Lease            string     `json:"lease,omitempty"`
	Attempts         int        `json:"attempts,omitempty"`
	StartedAt        string     `json:"startedAt"`
	CompletedAt      *string    `json:"completedAt"`
	DeadlineAt       string     `json:"deadlineAt"`
	Findings         []Finding  `json:"findings"`
	RejectedCount    int        `json:"rejectedCount"`
	RejectionReasons []string   `json:"rejectionReasons"`
	FailureCode      *string    `json:"failureCode"`
	Stale            bool       `json:"stale"`
	StaleReasons     []string   `json:"staleReasons"`
	Usage            *llm.Usage `json:"usage"`
}

// PublicRun removes worker-only scheduling internals from the HTTP DTO.
func PublicRun(value Run) Run {
	value.CompletionReceipts = nil
	value.ExecutorOwner = ""
	value.ExecutorEpoch = 0
	value.Lease = ""
	value.Attempts = 0
	return value
}

func PublicRuns(values []Run) []Run {
	out := make([]Run, len(values))
	for i, value := range values {
		out[i] = PublicRun(value)
	}
	return out
}

type FeedbackInput struct {
	Choice      string `json:"choice"`
	BaseVersion int64  `json:"baseVersion"`
}
type candidateEvidence struct {
	SourceID string `json:"sourceId"`
	Quote    string `json:"quote"`
}
type candidate struct {
	Type        string              `json:"type"`
	Title       string              `json:"title"`
	Inference   string              `json:"inference"`
	Question    string              `json:"question"`
	Alternative string              `json:"alternativeExplanation"`
	Evidence    []candidateEvidence `json:"evidence"`
}
type candidateOutput struct {
	Findings []candidate `json:"findings"`
}

func failure(status int, code, detail string) error { return application.Fail(status, code, detail) }
func storageFailure() error {
	return failure(500, "REVIEW_STORAGE_FAILED", "The review state could not be safely read or saved. No author source was written.")
}
func author(a application.Actor) error {
	if a.Role != "author" || a.ID == "" {
		return failure(403, "AUTHOR_DECISION_REQUIRED", "Only the authenticated author can use review operations.")
	}
	return nil
}
func strict(data []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}
func DecodeInput(value any, dest any) error {
	b, e := json.Marshal(value)
	if e != nil || strict(b, dest) != nil {
		return failure(422, "VALIDATION_FAILED", "The review request does not match the contract.")
	}
	return nil
}
func validHash(value string) bool {
	if !strings.HasPrefix(value, "sha256:") || len(value) != 71 {
		return false
	}
	for _, c := range value[7:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func normalize(in Input) (Input, error) {
	if in.RevisionID == "" || len(in.RevisionID) > 200 || !validHash(in.ContentHash) || len(in.ReviewTypes) == 0 || len(in.ReviewTypes) > 2 {
		return in, failure(422, "VALIDATION_FAILED", "A saved revision, SHA-256 hash and review types are required.")
	}
	have := map[string]bool{}
	for _, k := range in.ReviewTypes {
		if k != "character_consistency" && k != "timeline_consistency" {
			return in, failure(422, "VALIDATION_FAILED", "Unsupported review type.")
		}
		have[k] = true
	}
	in.ReviewTypes = []string{}
	for _, k := range []string{"character_consistency", "timeline_consistency"} {
		if have[k] {
			in.ReviewTypes = append(in.ReviewTypes, k)
		}
	}
	return in, nil
}
func checkContext(ctx context.Context) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

// Package knowledge maintains private, evidence-backed AI observations, never author canon.
package knowledge

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

const Strategy = "knowledge-extraction-v1"
const MaxQueue = 256

type Source struct {
	BookID      string `json:"bookId"`
	ChapterID   string `json:"chapterId"`
	RevisionID  string `json:"revisionId"`
	ContentHash string `json:"contentHash"`
	Quote       string `json:"quote"`
	Start       int    `json:"startUTF16"`
	End         int    `json:"endUTF16"`
	Kind        string `json:"sourceKind"`
	Validity    string `json:"validity"`
	Retired     bool   `json:"retired,omitempty"`
}
type Entity struct {
	ID        string   `json:"entityId"`
	BookID    string   `json:"bookId"`
	Type      string   `json:"type"`
	Name      string   `json:"name"`
	Aliases   []string `json:"aliases"`
	Identity  string   `json:"identity"`
	Status    string   `json:"status"`
	CreatedAt string   `json:"createdAt"`
	UpdatedAt string   `json:"updatedAt"`
	Version   int      `json:"version"`
}
type Assertion struct {
	TargetName string   `json:"targetName,omitempty"` // Derived on reads, not a model-writable field.
	ID         string   `json:"assertionId"`
	EntityID   string   `json:"entityId"`
	Predicate  string   `json:"predicate"`
	Text       string   `json:"text"`
	TargetID   string   `json:"targetEntityId,omitempty"`
	Epistemic  string   `json:"epistemic"`
	Speaker    string   `json:"speaker,omitempty"`
	Time       string   `json:"time,omitempty"`
	Status     string   `json:"status"`
	Sources    []Source `json:"sources"`
}
type Job struct {
	AttemptReserve      int               `json:"attemptReserve,omitempty"`
	DebitedDay          string            `json:"debitedDay,omitempty"`
	CompletionReceipts  map[string]string `json:"completionReceipts,omitempty"`
	ExecutorOwner       string            `json:"executorOwner,omitempty"`
	ExecutorEpoch       uint64            `json:"executorEpoch,omitempty"`
	ID                  string            `json:"jobId"`
	ChapterID           string            `json:"chapterId"`
	RevisionID          string            `json:"revisionId"`
	Hash                string            `json:"contentHash"`
	Strategy            string            `json:"strategyVersion"`
	Model               llm.ModelInfo     `json:"model"`
	Status              string            `json:"status"`
	Attempts            int               `json:"attempts"`
	Due                 string            `json:"nextAttemptAt"`
	Deadline            string            `json:"deadlineAt,omitempty"`
	Lease               string            `json:"lease,omitempty"`
	Failure             string            `json:"failureCode,omitempty"`
	DiscardedAliases    int               `json:"discardedAliases,omitempty"`
	DiscardedAssertions int               `json:"discardedAssertions,omitempty"`
	DiscardedEntities   int               `json:"discardedEntities,omitempty"`
	ModelCalls          int               `json:"modelCalls,omitempty"`
	UsageIncomplete     bool              `json:"usageIncomplete,omitempty"`
	Usage               *llm.Usage        `json:"usage,omitempty"`
	ReservedTokens      int               `json:"reservedTokens"`
	DurationMS          int64             `json:"durationMs"`
	CreatedAt           string            `json:"createdAt"`
	CompletedAt         string            `json:"completedAt,omitempty"`
}
type Settings struct {
	ConfigFingerprint string        `json:"configFingerprint,omitempty"`
	Enabled           bool          `json:"enabled"`
	Paused            bool          `json:"paused"`
	ConsentAt         string        `json:"consentAt,omitempty"`
	Model             llm.ModelInfo `json:"model"`
	DailyTokenBudget  int           `json:"dailyTokenBudget"`
	DailyJobBudget    int           `json:"dailyJobBudget"`
}
type Correction struct {
	AnchorQuote string `json:"anchorQuote,omitempty"`
	ID          string `json:"correctionId"`
	EntityID    string `json:"entityId,omitempty"`
	AssertionID string `json:"assertionId,omitempty"`
	ChapterID   string `json:"chapterId,omitempty"`
	Action      string `json:"action"`
	Reason      string `json:"reason"`
	ActorID     string `json:"actorId"`
	Active      bool   `json:"active"`
	Version     int    `json:"version"`
	CreatedAt   string `json:"createdAt"`
}
type Change struct {
	ID         string `json:"changeId"`
	At         string `json:"at"`
	Kind       string `json:"kind"`
	ChapterID  string `json:"chapterId"`
	RevisionID string `json:"revisionId"`
	JobID      string `json:"jobId"`
}
type receipt struct {
	Fingerprint string `json:"fingerprint"`
	Version     int    `json:"version"`
}
type State struct {
	BookID        string   `json:"bookId"`
	MutationTimes []string `json:"mutationTimes,omitempty"`
	SchemaVersion int      `json:"schemaVersion"`
	Version       int      `json:"version"`
	// ScanStamp identifies the last successfully inspected saved revision set.
	// It is derived from atomic draft/catalog metadata, never manuscript text.
	ScanStamp string `json:"scanStamp,omitempty"`
	// ScanComplete is false when a queue cap or unreadable chapter means more
	// discovery work remains for the same ScanStamp.
	ScanComplete   bool                 `json:"scanComplete,omitempty"`
	ScanRetryAt    string               `json:"scanRetryAt,omitempty"`
	BudgetDay      string               `json:"budgetDay"`
	BudgetTokens   int                  `json:"budgetTokens"`
	BudgetAttempts int                  `json:"budgetAttempts"`
	Settings       Settings             `json:"settings"`
	Entities       map[string]Entity    `json:"entities"`
	Assertions     map[string]Assertion `json:"assertions"`
	Jobs           []Job                `json:"jobs"`
	Corrections    []Correction         `json:"corrections"`
	Changes        []Change             `json:"changes"`
	Requests       map[string]receipt   `json:"requests"`
	Index          map[string][]string  `json:"index"`
	// ChapterTotal counts chapters with text that backfill can analyse. sync()
	// owns it so progress stays correct beyond the MaxQueue batch size.
	ChapterTotal int `json:"chapterTotal,omitempty"`
}
type Mutation struct {
	BaseVersion      int            `json:"baseVersion"`
	Consent          bool           `json:"consent,omitempty"`
	Model            *llm.ModelInfo `json:"model,omitempty"`
	DailyTokenBudget int            `json:"dailyTokenBudget,omitempty"`
	DailyJobBudget   int            `json:"dailyJobBudget,omitempty"`
	ChapterID        string         `json:"chapterId,omitempty"`
	EntityID         string         `json:"entityId,omitempty"`
	AssertionID      string         `json:"assertionId,omitempty"`
	CorrectionID     string         `json:"correctionId,omitempty"`
	Reason           string         `json:"reason,omitempty"`
	Action           string         `json:"action,omitempty"`
}
type View struct {
	NeedsModelConsent bool          `json:"needsModelConsent"`
	WorkerStatus      string        `json:"workerStatus,omitempty"`
	BookID            string        `json:"bookId"`
	Version           int           `json:"version"`
	BudgetDay         string        `json:"budgetDay"`
	BudgetTokens      int           `json:"budgetTokens"`
	BudgetAttempts    int           `json:"budgetAttempts"`
	Settings          Settings      `json:"settings"`
	Available         bool          `json:"available"`
	Model             llm.ModelInfo `json:"model"`
	Disclosure        string        `json:"disclosure"`
	Pending           int           `json:"pending"`
	Running           int           `json:"running"`
	Failed            int           `json:"failed"`
	Completed         int           `json:"completed"`
	ChapterTotal      int           `json:"chapterTotal"`
	Stale             bool          `json:"stale"`
}
type Query struct {
	Type, Name, ChapterID, EntityID, Status string
	Offset, Limit, AssertionOffset          int
}
type Page struct {
	View
	Entities       []Entity    `json:"entities"`
	Assertions     []Assertion `json:"assertions"`
	Total          int         `json:"total"`
	Next           *int        `json:"nextCursor"`
	AssertionTotal int         `json:"assertionTotal"`
	NextAssertion  *int        `json:"nextAssertionCursor"`
}

// RecordPage is a history/jobs/corrections read. View remains optional for one
// deployment window so an older Web build can read the new API safely. New
// clients consume the lightweight /summary route instead.
type RecordPage struct {
	Items      []any `json:"items"`
	Total      int   `json:"total"`
	NextCursor *int  `json:"nextCursor"`
	View       *View `json:"view,omitempty"`
}

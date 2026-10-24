// Package creative owns author-intended story assets (characters, world rules,
// plans, foreshadowing, open questions) and the AI proposals derived from
// inspiration conversations. It is separate from knowledge, which only holds
// observations extracted from saved manuscript revisions.
//
// Authority rules enforced here:
//   - Only an author action creates or changes an asset version.
//   - Model output can only become a Proposal with status "proposed".
//   - Proposal status (review lifecycle) and stance/source (where content came
//     from) are modelled separately.
package creative

import "github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"

const (
	SchemaVersion = 1
	Strategy      = "creative-organize-v1"
	PlanStrategy  = "creative-plan-check-v1"

	MaxAssets        = 2000
	MaxProposals     = 5000
	MaxTurns         = 10000
	MaxJobs          = 10000
	MaxVersions      = 100
	MaxLinks         = 5000
	MaxDivergences   = 2000
	MaxFields        = 20
	MaxAliases       = 12
	MaxExcerptMsgs   = 6
	MaxExcerptBytes  = 24 * 1024
	MaxEvidenceQuote = 300
	ExcerptRetention = 200
)

// Asset kinds. open_question holds an author's undecided question.
var Kinds = map[string]string{
	"character":     "人物",
	"world_rule":    "世界规则",
	"place":         "地点",
	"organization":  "组织",
	"plot_line":     "剧情线",
	"event":         "事件计划",
	"foreshadowing": "伏笔计划",
	"character_arc": "人物轨迹",
	"open_question": "待决问题",
}

// PlanKinds may carry a chapter anchor and take part in plan/manuscript checks.
var PlanKinds = map[string]bool{"plot_line": true, "event": true, "foreshadowing": true, "character_arc": true}

var AssetStatuses = map[string]bool{"draft": true, "accepted": true, "superseded": true, "archived": true}

var Operations = map[string]bool{"CREATE": true, "UPDATE": true, "LINK": true, "SUPERSEDE": true}

var Stances = map[string]bool{
	"author_decision":   true,
	"author_hypothesis": true,
	"author_question":   true,
	"author_rejection":  true,
	"ai_suggestion":     true,
}

func Exploratory(stance string) bool {
	return stance == "author_hypothesis" || stance == "author_question" || stance == "ai_suggestion"
}

type Field struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type Plan struct {
	ChapterID       string `json:"chapterId,omitempty"`
	PayoffChapterID string `json:"payoffChapterId,omitempty"`
}

// Content is the author-visible body of an asset, shared by assets, versions and drafts.
type Content struct {
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`
	Summary string   `json:"summary"`
	Fields  []Field  `json:"fields"`
	Plan    *Plan    `json:"plan,omitempty"`
}

type Asset struct {
	ID     string `json:"assetId"`
	BookID string `json:"bookId"`
	Kind   string `json:"kind"`
	Content
	Status       string `json:"status"`
	SupersededBy string `json:"supersededBy,omitempty"`
	Origin       string `json:"origin"`
	Version      int    `json:"version"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

// ConversationSource is provenance for content that came from an inspiration
// conversation. It is never a manuscript source and never evidence of canon.
type ConversationSource struct {
	Type        string        `json:"type"` // always "conversation"
	SessionID   string        `json:"sessionId"`
	MessageID   string        `json:"messageId"`
	AnswerID    string        `json:"answerId"`
	BookID      string        `json:"bookId"`
	CapturedAt  string        `json:"capturedAt"`
	ExcerptHash string        `json:"excerptHash"`
	Model       llm.ModelInfo `json:"model"`
	Strategy    string        `json:"strategy"`
	Deleted     bool          `json:"sessionDeleted,omitempty"`
}

type Evidence struct {
	MessageID string `json:"messageId"`
	Role      string `json:"role"`
	Quote     string `json:"quote"`
}

type Version struct {
	Version    int                 `json:"version"`
	Kind       string              `json:"kind"`
	Content    Content             `json:"content"`
	Status     string              `json:"status"`
	ActorID    string              `json:"actorId"`
	At         string              `json:"at"`
	Origin     string              `json:"origin"` // author_create|author_edit|proposal_accept|proposal_edit_accept|status_change
	ProposalID string              `json:"proposalId,omitempty"`
	Source     *ConversationSource `json:"source,omitempty"`
	Evidence   []Evidence          `json:"evidence,omitempty"`
	Note       string              `json:"note,omitempty"`
}

type LinkTarget struct {
	Type string `json:"type"` // asset|knowledge_entity|chapter
	ID   string `json:"id"`
}

type Link struct {
	ID         string     `json:"linkId"`
	From       string     `json:"fromAssetId"`
	To         LinkTarget `json:"to"`
	Relation   string     `json:"relation"`
	Status     string     `json:"status"` // active|removed
	Origin     string     `json:"origin"`
	ProposalID string     `json:"proposalId,omitempty"`
	ActorID    string     `json:"actorId"`
	CreatedAt  string     `json:"createdAt"`
	RemovedAt  string     `json:"removedAt,omitempty"`
}

// Patch is a field-level change against an existing asset.
type Patch struct {
	Name         *string  `json:"name,omitempty"`
	Summary      *string  `json:"summary,omitempty"`
	AddAliases   []string `json:"addAliases,omitempty"`
	SetFields    []Field  `json:"setFields,omitempty"`
	RemoveFields []string `json:"removeFields,omitempty"`
	Plan         *Plan    `json:"plan,omitempty"`
}

type LinkDraft struct {
	ToAssetID    string `json:"toAssetId,omitempty"`
	ToProposalID string `json:"toProposalId,omitempty"`
	Relation     string `json:"relation"`
}

type Decision struct {
	Action  string `json:"action"` // accept|accept_edited|reject
	ActorID string `json:"actorId"`
	At      string `json:"at"`
	Note    string `json:"note,omitempty"`
	Edited  bool   `json:"edited,omitempty"`
}

type Proposal struct {
	ID               string             `json:"proposalId"`
	BookID           string             `json:"bookId"`
	ChangeSetID      string             `json:"changeSetId"`
	Operation        string             `json:"operation"`
	Kind             string             `json:"kind"`
	Stance           string             `json:"stance"`
	Exploratory      bool               `json:"exploratory"`
	AlternativeGroup string             `json:"alternativeGroup,omitempty"`
	Status           string             `json:"status"` // proposed|accepted|rejected|superseded|expired
	TargetAssetID    string             `json:"targetAssetId,omitempty"`
	BaseVersion      int                `json:"baseVersion,omitempty"`
	Draft            *Content           `json:"draft,omitempty"`
	Patch            *Patch             `json:"patch,omitempty"`
	Link             *LinkDraft         `json:"link,omitempty"`
	Reason           string             `json:"reason"`
	Evidence         []Evidence         `json:"evidence"`
	Source           ConversationSource `json:"source"`
	Replaces         string             `json:"replacesProposalId,omitempty"`
	ReplacedBy       string             `json:"replacedByProposalId,omitempty"`
	CreatedAt        string             `json:"createdAt"`
	Decision         *Decision          `json:"decision,omitempty"`
	ResultAssetID    string             `json:"resultAssetId,omitempty"`
	ResultVersion    int                `json:"resultVersion,omitempty"`
	StatusReason     string             `json:"statusReason,omitempty"`
}

type ChangeSet struct {
	ID             string   `json:"changeSetId"`
	TurnKey        string   `json:"turnKey"`
	JobID          string   `json:"jobId"`
	SessionID      string   `json:"sessionId"`
	MessageID      string   `json:"messageId"`
	Summary        string   `json:"summary"`
	NoChange       bool     `json:"noChange"`
	NoChangeReason string   `json:"noChangeReason,omitempty"`
	Proposals      []string `json:"proposalIds"`
	Discarded      int      `json:"discarded"`
	CreatedAt      string   `json:"createdAt"`
}

type TurnMessage struct {
	ID   string `json:"messageId"`
	Role string `json:"role"`
	Text string `json:"text"`
}

// Turn is the durable outbox entry linking a Thinking message to organizing work.
type Turn struct {
	Key         string        `json:"turnKey"`
	SessionID   string        `json:"sessionId"`
	MessageID   string        `json:"messageId"`
	AnswerID    string        `json:"answerId"`
	Status      string        `json:"status"` // awaiting|queued|organized|no_change|skipped|cancelled|failed|expired
	Reason      string        `json:"reason,omitempty"`
	Trigger     string        `json:"trigger"` // auto|manual
	Excerpt     []TurnMessage `json:"excerpt,omitempty"`
	ExcerptHash string        `json:"excerptHash,omitempty"`
	AcceptedAt  string        `json:"acceptedAt"`
	CapturedAt  string        `json:"capturedAt,omitempty"`
	JobID       string        `json:"jobId,omitempty"`
	ChangeSetID string        `json:"changeSetId,omitempty"`
	UpdatedAt   string        `json:"updatedAt"`
}

type Job struct {
	ID                 string            `json:"jobId"`
	Kind               string            `json:"kind"` // organize|plan_check
	TurnKey            string            `json:"turnKey,omitempty"`
	SessionID          string            `json:"sessionId,omitempty"`
	ChapterID          string            `json:"chapterId,omitempty"`
	RevisionID         string            `json:"revisionId,omitempty"`
	ContentHash        string            `json:"contentHash,omitempty"`
	Strategy           string            `json:"strategyVersion"`
	Model              llm.ModelInfo     `json:"model"`
	Status             string            `json:"status"` // pending|running|retry|completed|failed|cancelled
	Attempts           int               `json:"attempts"`
	Due                string            `json:"nextAttemptAt"`
	Deadline           string            `json:"deadlineAt,omitempty"`
	Lease              string            `json:"lease,omitempty"`
	AttemptReserve     int               `json:"attemptReserve,omitempty"`
	DebitedDay         string            `json:"debitedDay,omitempty"`
	ReservedTokens     int               `json:"reservedTokens"`
	Usage              *llm.Usage        `json:"usage,omitempty"`
	UsageIncomplete    bool              `json:"usageIncomplete,omitempty"`
	ModelCalls         int               `json:"modelCalls,omitempty"`
	Failure            string            `json:"failureCode,omitempty"`
	CompletionReceipts map[string]string `json:"completionReceipts,omitempty"`
	CreatedAt          string            `json:"createdAt"`
	CompletedAt        string            `json:"completedAt,omitempty"`
}

type ManuscriptEvidence struct {
	ChapterID   string `json:"chapterId"`
	RevisionID  string `json:"revisionId"`
	ContentHash string `json:"contentHash"`
	Quote       string `json:"quote"`
	Start       int    `json:"startUTF16"`
	End         int    `json:"endUTF16"`
}

// Divergence compares an accepted plan asset with a saved chapter revision.
// It is a prompt for an author decision, never an edit to either side.
type Divergence struct {
	ID           string              `json:"divergenceId"`
	JobID        string              `json:"jobId"`
	AssetID      string              `json:"assetId"`
	AssetVersion int                 `json:"assetVersion"`
	PlanText     string              `json:"planText"`
	ChapterID    string              `json:"chapterId"`
	RevisionID   string              `json:"revisionId"`
	ContentHash  string              `json:"contentHash"`
	Assessment   string              `json:"assessment"` // fulfilled|diverged|not_yet|unclear
	Explanation  string              `json:"explanation"`
	Question     string              `json:"question"`
	Evidence     *ManuscriptEvidence `json:"evidence,omitempty"`
	Status       string              `json:"status"` // open|decided|superseded
	Decision     *Decision           `json:"decision,omitempty"`
	Model        llm.ModelInfo       `json:"model"`
	CreatedAt    string              `json:"createdAt"`
}

type Settings struct {
	Enabled           bool          `json:"enabled"`
	Paused            bool          `json:"paused"`
	AutoOrganize      bool          `json:"autoOrganize"`
	ConsentAt         string        `json:"consentAt,omitempty"`
	Model             llm.ModelInfo `json:"model"`
	ConfigFingerprint string        `json:"configFingerprint,omitempty"`
	DailyTokenBudget  int           `json:"dailyTokenBudget"`
	DailyJobBudget    int           `json:"dailyJobBudget"`
}

type receipt struct {
	Fingerprint string `json:"fingerprint"`
	// Result is the JSON text of the original response, replayed on retry.
	Result string `json:"result,omitempty"`
}

type State struct {
	BookID         string                `json:"bookId"`
	SchemaVersion  int                   `json:"schemaVersion"`
	Version        int                   `json:"version"`
	Settings       Settings              `json:"settings"`
	Assets         map[string]Asset      `json:"assets"`
	Versions       map[string][]Version  `json:"versions"`
	Links          map[string]Link       `json:"links"`
	Proposals      map[string]Proposal   `json:"proposals"`
	ChangeSets     map[string]ChangeSet  `json:"changeSets"`
	Turns          map[string]Turn       `json:"turns"`
	Jobs           []Job                 `json:"jobs"`
	Divergences    map[string]Divergence `json:"divergences"`
	Requests       map[string]receipt    `json:"requests"`
	BudgetDay      string                `json:"budgetDay"`
	BudgetTokens   int                   `json:"budgetTokens"`
	BudgetAttempts int                   `json:"budgetAttempts"`
	MutationTimes  []string              `json:"mutationTimes,omitempty"`
}

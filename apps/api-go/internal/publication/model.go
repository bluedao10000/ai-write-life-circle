// Package publication owns immutable public snapshots, never public draft access.
package publication

import "github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"

type Book struct {
	App     *application.Service
	OwnerID string
}
type Cover struct {
	BG   string `json:"bg"`
	FG   string `json:"fg"`
	Mark string `json:"mark"`
}
type Metadata struct {
	Slug         string   `json:"slug"`
	Title        string   `json:"title"`
	PenName      string   `json:"penName"`
	AuthorBio    string   `json:"authorBio"`
	Tagline      string   `json:"tagline"`
	Description  string   `json:"description"`
	Category     string   `json:"category"`
	Categories   []string `json:"categories,omitempty"`
	SerialStatus string   `json:"serialStatus"`
	CoverURL     string   `json:"coverUrl"`
	Cover        *Cover   `json:"cover,omitempty"`
}
type Selection struct {
	ChapterID    string `json:"chapterId"`
	RevisionID   string `json:"revisionId"`
	ContentHash  string `json:"contentHash"`
	VolumeID     string `json:"volumeId"`
	ChapterOrder int64  `json:"chapterOrder"`
}
type PreviewInput struct {
	BaseVersionID *string     `json:"baseVersionId"`
	Metadata      Metadata    `json:"metadata"`
	Chapters      []Selection `json:"chapters"`
}
type CommitInput struct {
	Note          string  `json:"note,omitempty"`
	BaseVersionID *string `json:"baseVersionId"`
	PreviewID     string  `json:"previewId"`
}
type TransitionInput struct {
	BaseVersionID *string `json:"baseVersionId"`
}

// A nil volume title preserves legacy grouping; an explicit empty title means ungrouped.
type Snapshot struct {
	Selection
	Slug        string  `json:"slug"`
	Title       string  `json:"title"`
	VolumeTitle *string `json:"volumeTitle,omitempty"`
	VolumeOrder int     `json:"volumeOrder"`
	Markdown    string  `json:"markdown"`
}
type Version struct {
	Note           string     `json:"note,omitempty"`
	PublicURL      string     `json:"publicUrl"`
	ID             string     `json:"versionId"`
	PublicationID  string     `json:"publicationId"`
	Number         int        `json:"versionNumber"`
	State          string     `json:"state"`
	Metadata       Metadata   `json:"metadata"`
	Chapters       []Snapshot `json:"chapters"`
	CreatedAt      string     `json:"createdAt"`
	CreatedBy      string     `json:"createdBy"`
	AuditReference string     `json:"auditReference"`
}
type Preview struct {
	PreviousChapters []Snapshot `json:"previousChapters"`
	ID               string     `json:"previewId"`
	BookID           string     `json:"bookId"`
	BaseVersionID    *string    `json:"baseVersionId"`
	Metadata         Metadata   `json:"metadata"`
	Chapters         []Snapshot `json:"chapters"`
	ExpiresAt        string     `json:"expiresAt"`
	CreatedBy        string     `json:"createdBy"`
}
type Publication struct {
	ID           string            `json:"publicationId"`
	BookID       string            `json:"studioBookId"`
	OwnerID      string            `json:"ownerUserId"`
	AuthorSlug   string            `json:"authorSlug"`
	Current      string            `json:"currentVersionId"`
	Versions     []Version         `json:"versions"`
	ChapterSlugs map[string]string `json:"chapterSlugs"`
}

// Management summaries deliberately omit all draft and publication prose.
type SnapshotSummary struct {
	Selection
	Slug        string  `json:"slug"`
	Title       string  `json:"title"`
	VolumeTitle *string `json:"volumeTitle,omitempty"`
	VolumeOrder int     `json:"volumeOrder"`
}
type VersionSummary struct {
	Version
	Chapters []SnapshotSummary `json:"chapters"`
}
type PublicationSummary struct {
	Publication
	Versions []VersionSummary `json:"versions"`
}
type DraftSummary struct {
	Selection
	Title       string  `json:"title"`
	VolumeTitle *string `json:"volumeTitle,omitempty"`
	Words       int     `json:"words"`
	IsEmpty     bool    `json:"isEmpty"`
}
type Management struct {
	Publication       *PublicationSummary `json:"publication"`
	ChangedChapterIDs []string            `json:"changedChapterIds"`
	Drafts            []DraftSummary      `json:"drafts"`
}
type Audit struct {
	ID        string `json:"auditId"`
	BookID    string `json:"bookId"`
	VersionID string `json:"versionId"`
	ActorID   string `json:"actorId"`
	Action    string `json:"action"`
	At        string `json:"at"`
}
type requestRecord struct {
	Fingerprint string  `json:"fingerprint"`
	Version     Version `json:"version"`
}
type state struct {
	Schema       int                      `json:"schema"`
	Publications map[string]Publication   `json:"publications"`
	Previews     map[string]Preview       `json:"previews"`
	Requests     map[string]requestRecord `json:"requests"`
	AuthorSlugs  map[string]string        `json:"authorSlugs"`
	Audit        []Audit                  `json:"audit"`
}

// Explicit public DTOs deliberately cannot marshal source IDs, revisions,
// hashes, ownership, previews, audit, or author account details.
type PublicChapterRef struct {
	PublishedAt  string  `json:"publishedAt"`
	UpdatedAt    string  `json:"updatedAt"`
	Slug         string  `json:"slug"`
	Title        string  `json:"title"`
	VolumeTitle  *string `json:"volumeTitle,omitempty"`
	VolumeOrder  int     `json:"volumeOrder"`
	ChapterOrder int64   `json:"chapterOrder"`
}
type PublicBook struct {
	ContentUpdatedAt     string             `json:"contentUpdatedAt"`
	PublicationUpdatedAt string             `json:"publicationUpdatedAt"`
	FirstPublishedAt     string             `json:"firstPublishedAt"`
	Slug                 string             `json:"slug"`
	Title                string             `json:"title"`
	PenName              string             `json:"penName"`
	AuthorSlug           string             `json:"authorSlug"`
	Tagline              string             `json:"tagline"`
	Description          string             `json:"description"`
	Category             string             `json:"category"`
	Categories           []string           `json:"categories,omitempty"`
	SerialStatus         string             `json:"serialStatus"`
	CoverURL             string             `json:"coverUrl"`
	Cover                *Cover             `json:"cover,omitempty"`
	UpdatedAt            string             `json:"updatedAt"`
	ChapterCount         int                `json:"chapterCount"`
	Chapters             []PublicChapterRef `json:"chapters"`
}
type PublicChapter struct {
	PublicChapterRef
	BookSlug string  `json:"bookSlug"`
	Markdown string  `json:"markdown"`
	Previous *string `json:"previous"`
	Next     *string `json:"next"`
}
type PublicAuthor struct {
	Slug    string       `json:"slug"`
	PenName string       `json:"penName"`
	Bio     string       `json:"bio"`
	Books   []PublicBook `json:"books"`
}
type Catalog struct {
	Items      []PublicBook `json:"items"`
	Total      int          `json:"total"`
	NextCursor *string      `json:"nextCursor"`
}
type Home struct {
	Items      []PublicBook `json:"items"`
	Total      int          `json:"total"`
	Featured   *PublicBook  `json:"featured"`
	Opening    *string      `json:"opening"`
	Categories []string     `json:"categories"`
}
type Query struct {
	Search, Category, Status, Sort string
	Offset, Limit                  int
}

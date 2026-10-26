package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/epub"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

var importIDRE = regexp.MustCompile(`^imp-[0-9a-f]{24}$`)

type ImportVolume struct {
	VolumeID string `json:"volumeId"`
	Title    string `json:"title"`
}

type ImportChapter struct {
	ChapterID   string `json:"chapterId"`
	Title       string `json:"title"`
	VolumeID    string `json:"volumeId,omitempty"`
	WordCount   int    `json:"wordCount"`
	SourcePart  string `json:"sourcePart"`
	Excerpt     string `json:"excerpt"`
	ContentHash string `json:"-"`
}

type ImportKnowledge struct {
	Status string `json:"status"`
}

type ImportPreview struct {
	ImportID    string          `json:"importId"`
	Status      string          `json:"status"`
	Title       string          `json:"title"`
	Author      string          `json:"author,omitempty"`
	Language    string          `json:"language,omitempty"`
	Volumes     []ImportVolume  `json:"volumes"`
	Chapters    []ImportChapter `json:"chapters"`
	Warnings    []epub.Warning  `json:"warnings"`
	Fingerprint string          `json:"fingerprint"`
	BookID      string          `json:"bookId,omitempty"`
	Knowledge   ImportKnowledge `json:"knowledge"`
	CreatedAt   string          `json:"createdAt"`
	CommittedAt string          `json:"committedAt,omitempty"`
}

type ImportReference struct {
	ChapterID   string `json:"chapterId"`
	Title       string `json:"title"`
	VolumeID    string `json:"volumeId,omitempty"`
	SourcePart  string `json:"sourcePart"`
	WordCount   int    `json:"wordCount"`
	ContentHash string `json:"contentHash"`
}

type importManifest struct {
	Schema      int               `json:"schema"`
	ImportID    string            `json:"importId"`
	OwnerID     string            `json:"ownerId"`
	BookID      string            `json:"bookId"`
	Status      string            `json:"status"`
	Filename    string            `json:"filename"`
	FileHash    string            `json:"fileHash"`
	Fingerprint string            `json:"fingerprint"`
	Title       string            `json:"title"`
	Author      string            `json:"author,omitempty"`
	Language    string            `json:"language,omitempty"`
	Volumes     []ImportVolume    `json:"volumes"`
	Chapters    []ImportReference `json:"chapters"`
	Warnings    []epub.Warning    `json:"warnings"`
	CreatedAt   string            `json:"createdAt"`
	CommittedAt string            `json:"committedAt,omitempty"`
	CommitKey   string            `json:"commitKey,omitempty"`
	CommitHash  string            `json:"commitHash,omitempty"`
}

type ImportCommitInput struct {
	Fingerprint string             `json:"fingerprint"`
	Title       string             `json:"title"`
	Volumes     []ImportVolume     `json:"volumes"`
	Chapters    []ImportChapterRef `json:"chapters"`
}

type ImportChapterRef struct {
	ChapterID string `json:"chapterId"`
	Title     string `json:"title"`
	VolumeID  string `json:"volumeId,omitempty"`
}

type ImportStageResult struct {
	Preview ImportPreview
	Created bool
}

type ImportCommitResult struct {
	Book    ManagedBook
	Created bool
}

// ImportService owns EPUB staging and the one atomic visibility change that
// adds a complete imported book to the managed catalog. Parsed prose stays in
// a private staging directory until every initial revision has been persisted.
// It never invokes a model.
type ImportService struct {
	Management *Management
}

func NewImportService(management *Management) *ImportService {
	return &ImportService{Management: management}
}

func importError(err error) error {
	var e *epub.Error
	if errors.As(err, &e) {
		return Fail(e.Status, e.Code, e.Detail)
	}
	return Fail(422, "EPUB_INVALID", "EPUB 无法安全导入。")
}

func importKey(owner, key string) string {
	sum := sha256.Sum256([]byte(owner + "\x00" + key))
	return "imp-" + hex.EncodeToString(sum[:])[:24]
}

func commitRequestKey(owner, key string) string {
	return "import:" + compat.Key(owner) + ":" + key
}

func (s *ImportService) paths(a Actor, id string) (owner, dir, manifest string, err error) {
	if s == nil || s.Management == nil || s.Management.Legacy == nil || s.Management.Legacy.State == "" {
		return "", "", "", Fail(503, "IMPORT_UNAVAILABLE", "EPUB import storage is unavailable.")
	}
	if a.ID == "" || !importIDRE.MatchString(id) {
		return "", "", "", Fail(404, "NOT_FOUND", "Import not found.")
	}
	owner = compat.Key(a.ID)
	dir = filepath.Join(s.Management.Legacy.State, "works", "imports", owner, id)
	manifest = filepath.Join(dir, "manifest.json")
	return owner, dir, manifest, nil
}

func (s *ImportService) ensureOwnerDir(owner string) (string, error) {
	base := filepath.Join(s.Management.Legacy.State, "works", "imports")
	dir := filepath.Join(base, owner)
	for _, p := range []string{filepath.Join(s.Management.Legacy.State, "works"), base, dir} {
		if info, err := os.Lstat(p); err == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return "", Fail(500, "WORKSPACE_STORAGE_FAILED", "Import state cannot contain symbolic links.")
			}
		} else if !os.IsNotExist(err) {
			return "", err
		}
		if err := os.MkdirAll(p, 0700); err != nil {
			return "", err
		}
	}
	return dir, nil
}

func (s *ImportService) load(a Actor, id string) (importManifest, string, error) {
	_, dir, manifestPath, err := s.paths(a, id)
	if err != nil {
		return importManifest{}, "", err
	}
	if err := safeImportTree(dir); err != nil {
		if os.IsNotExist(err) {
			return importManifest{}, "", Fail(404, "NOT_FOUND", "Import not found.")
		}
		return importManifest{}, "", err
	}
	if _, err := os.Lstat(dir); os.IsNotExist(err) {
		return importManifest{}, "", Fail(404, "NOT_FOUND", "Import not found.")
	}
	var state importManifest
	found, err := storage.Read(manifestPath, &state)
	if err != nil || !found {
		if err != nil {
			return state, "", err
		}
		return state, "", Fail(404, "NOT_FOUND", "Import not found.")
	}
	if state.Schema != 1 || state.ImportID != id || state.OwnerID != a.ID || state.BookID == "" ||
		(state.Status != "previewed" && state.Status != "committed") ||
		state.FileHash == "" || state.Fingerprint == "" || len(state.Chapters) == 0 {
		return state, "", Fail(500, "WORKSPACE_STORAGE_FAILED", "Invalid import state.")
	}
	return state, dir, nil
}

func importChapterPath(dir, chapterID string) (string, error) {
	if !chapterRE.MatchString(chapterID) {
		return "", ErrInvalidImportState
	}
	return filepath.Join(dir, "chapters", chapterID+".md"), nil
}

var ErrInvalidImportState = errors.New("invalid EPUB import state")

// Reading a staging preview must fail closed if any path below the import is a
// link. The staging tree is application-owned; valid imports contain only
// regular files and directories.
func safeImportTree(root string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || !(entry.IsDir() || entry.Type().IsRegular()) {
			return Fail(500, "WORKSPACE_STORAGE_FAILED", "Import state contains an unsafe entry.")
		}
		return nil
	})
}

func excerpt(markdown string) string {
	text := strings.Join(strings.Fields(markdown), " ")
	runes := []rune(text)
	if len(runes) > 180 {
		return string(runes[:180]) + "…"
	}
	return string(runes)
}

func publicImport(state importManifest, dir string) (ImportPreview, error) {
	chapters := make([]ImportChapter, 0, len(state.Chapters))
	for _, ref := range state.Chapters {
		path, err := importChapterPath(dir, ref.ChapterID)
		if err != nil {
			return ImportPreview{}, err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return ImportPreview{}, err
		}
		if compat.HashBytes(b) != ref.ContentHash || !utf8.Valid(b) {
			return ImportPreview{}, ErrInvalidImportState
		}
		chapters = append(chapters, ImportChapter{
			ChapterID:   ref.ChapterID,
			Title:       ref.Title,
			VolumeID:    ref.VolumeID,
			WordCount:   ref.WordCount,
			SourcePart:  ref.SourcePart,
			Excerpt:     excerpt(string(b)),
			ContentHash: ref.ContentHash,
		})
	}
	return ImportPreview{
		ImportID: state.ImportID, Status: state.Status, Title: state.Title,
		Author: state.Author, Language: state.Language, Volumes: state.Volumes,
		Chapters: chapters, Warnings: state.Warnings, Fingerprint: state.Fingerprint,
		BookID: state.BookID, Knowledge: ImportKnowledge{Status: "awaiting_author_consent"},
		CreatedAt: state.CreatedAt, CommittedAt: state.CommittedAt,
	}, nil
}

// stageCacheLoad returns a complete staged import only when the idempotency
// key maps to the same owner and file. A missing directory is a cache miss;
// partial or tampered state fails closed.
func (s *ImportService) stageCacheLoad(a Actor, id string, fileHash string) (*ImportStageResult, error) {
	state, dir, err := s.load(a, id)
	if err != nil {
		if AsError(err).Status == 404 {
			return nil, nil
		}
		return nil, err
	}
	if state.FileHash != fileHash {
		return nil, Fail(422, "IDEMPOTENCY_KEY_REUSED", "The upload key was already used for a different EPUB.")
	}
	preview, err := publicImport(state, dir)
	if err != nil {
		return nil, err
	}
	return &ImportStageResult{Preview: preview}, nil
}

func (s *ImportService) Stage(ctx context.Context, a Actor, key, filename string, data []byte) (ImportStageResult, error) {
	if err := author(a); err != nil {
		return ImportStageResult{}, err
	}
	if !SafeKey(key) {
		return ImportStageResult{}, Fail(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required.")
	}
	if len(filename) > 255 || !utf8.ValidString(filename) || strings.ContainsAny(filename, "\r\n\x00/\\") {
		return ImportStageResult{}, Fail(422, "VALIDATION_FAILED", "Invalid EPUB filename.")
	}
	// Early plan check so an author over a limit is told before uploading
	// work is parsed; Commit enforces the same limits authoritatively.
	if err := s.planLimits(ctx, a); err != nil {
		return ImportStageResult{}, err
	}
	id := importKey(a.ID, key)
	owner, dir, _, err := s.paths(a, id)
	if err != nil {
		return ImportStageResult{}, err
	}
	ownerDir, err := s.ensureOwnerDir(owner)
	if err != nil {
		return ImportStageResult{}, err
	}
	lock := filepath.Join(ownerDir, id+".lock")
	var result ImportStageResult
	err = storage.Lock(ctx, lock, func() error {
		if cached, readErr := s.stageCacheLoad(a, id, compat.HashBytes(data)); readErr != nil {
			return readErr
		} else if cached != nil {
			result = *cached
			return nil
		}
		// Parsing is deliberately after the idempotency lookup: retries do not
		// repeat ZIP/XML work, and a completed import can be previewed across
		// process restarts without re-uploading or re-parsing the archive.
		parsed, parseErr := epub.Parse(bytes.NewReader(data), int64(len(data)))
		if parseErr != nil {
			return importError(parseErr)
		}

		now := compat.Now()
		bookID := "book-" + compat.UUID()
		volumeIDs := make([]string, len(parsed.Volumes))
		volumes := make([]ImportVolume, len(parsed.Volumes))
		for i, volume := range parsed.Volumes {
			volumeIDs[i] = "VOL-" + compat.UUID()
			volumes[i] = ImportVolume{VolumeID: volumeIDs[i], Title: volume.Title}
		}
		refs := make([]ImportReference, 0, len(parsed.Chapters))
		for i, chapter := range parsed.Chapters {
			chapterID := fmt.Sprintf("CH-%06d", i+1)
			volumeID := ""
			if chapter.Volume >= 0 && chapter.Volume < len(volumeIDs) {
				volumeID = volumeIDs[chapter.Volume]
			}
			contentHash := compat.Hash(chapter.Markdown)
			refs = append(refs, ImportReference{
				ChapterID: chapterID, Title: chapter.Title, VolumeID: volumeID,
				SourcePart: chapter.SourcePart, WordCount: chapter.WordCount,
				ContentHash: contentHash,
			})
		}
		state := importManifest{
			Schema: 1, ImportID: id, OwnerID: a.ID, BookID: bookID, Status: "previewed",
			Filename: filename, FileHash: compat.HashBytes(data), Fingerprint: parsed.Fingerprint,
			Title: parsed.Title, Author: parsed.Author, Language: parsed.Language,
			Volumes: volumes, Chapters: refs, Warnings: parsed.Warnings, CreatedAt: now,
		}
		temp := filepath.Join(ownerDir, "."+id+"."+compat.UUID()+".tmp")
		if err := os.Mkdir(temp, 0700); err != nil {
			return err
		}
		defer os.RemoveAll(temp)
		if err := writeImportJSON(temp, "manifest.json", state); err != nil {
			return err
		}
		chapterDir := filepath.Join(temp, "chapters")
		if err := os.Mkdir(chapterDir, 0700); err != nil {
			return err
		}
		for i, chapter := range parsed.Chapters {
			if err := writeImportFile(filepath.Join(chapterDir, refs[i].ChapterID+".md"), []byte(chapter.Markdown)); err != nil {
				return err
			}
		}
		if err := syncDir(chapterDir); err != nil {
			return err
		}
		if err := syncDir(temp); err != nil {
			return err
		}
		if err := os.Rename(temp, dir); err != nil {
			return err
		}
		_ = syncDir(ownerDir)
		result.Preview, err = publicImport(state, dir)
		result.Created = true
		return err
	})
	return result, err
}

func writeImportJSON(dir, name string, value any) error {
	b, err := compat.Marshal(value, true)
	if err != nil {
		return err
	}
	return writeImportFile(filepath.Join(dir, name), append(b, '\n'))
}

func writeImportFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *ImportService) Get(a Actor, id string) (ImportPreview, error) {
	if err := author(a); err != nil {
		return ImportPreview{}, err
	}
	_, dir, _, err := s.paths(a, id)
	if err != nil {
		return ImportPreview{}, err
	}
	var result ImportPreview
	err = storage.Lock(context.Background(), dir+".lock", func() error {
		var err error
		result, err = s.getLocked(a, id)
		return err
	})
	return result, err
}
func (s *ImportService) getLocked(a Actor, id string) (ImportPreview, error) {
	if err := author(a); err != nil {
		return ImportPreview{}, err
	}
	state, dir, err := s.load(a, id)
	if err != nil {
		return ImportPreview{}, err
	}
	if state.Status == "previewed" {
		// The catalog is the commit point. Reconcile a crash that happened after
		// that atomic write but before the staging status was updated.
		book, getErr := s.Management.Get(a, state.BookID)
		if getErr == nil && book.ID == state.BookID {
			state.Status = "committed"
			state.CommittedAt = compat.Now()
			_ = storage.Write(context.Background(), filepath.Join(dir, "manifest.json"), state)
		}
	}
	return publicImport(state, dir)
}

func (s *ImportService) Delete(ctx context.Context, a Actor, id string) error {
	if err := author(a); err != nil {
		return err
	}
	_, dir, _, err := s.paths(a, id)
	if err != nil {
		return err
	}
	return storage.Lock(ctx, dir+".lock", func() error { return s.deleteLocked(ctx, a, id) })
}
func (s *ImportService) deleteLocked(ctx context.Context, a Actor, id string) error {
	if err := author(a); err != nil {
		return err
	}
	state, dir, err := s.load(a, id)
	if err != nil {
		return err
	}
	if state.Status == "committed" {
		return Fail(409, "IMPORT_ALREADY_COMMITTED", "A committed import cannot be removed.")
	}
	if _, getErr := s.Management.Get(a, state.BookID); getErr == nil {
		return Fail(409, "IMPORT_ALREADY_COMMITTED", "A committed import cannot be removed.")
	}
	if err := safeImportTree(dir); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return Fail(404, "NOT_FOUND", "Import not found.")
	}
	return os.RemoveAll(dir)
}

func validImportStructure(input ImportCommitInput, state importManifest) error {
	if input.Fingerprint != state.Fingerprint {
		return Fail(409, "IMPORT_STATE_CHANGED", "The EPUB preview changed. Upload it again before committing.")
	}
	if !validTitle(input.Title) {
		return Fail(422, "VALIDATION_FAILED", "The imported book title is invalid.")
	}
	if len(input.Volumes) != len(state.Volumes) || len(input.Chapters) != len(state.Chapters) {
		return Fail(422, "VALIDATION_FAILED", "An import must retain every parsed volume and chapter.")
	}
	expectedVolumes := map[string]bool{}
	for _, volume := range state.Volumes {
		expectedVolumes[volume.VolumeID] = true
	}
	seenVolumes := map[string]bool{}
	for _, volume := range input.Volumes {
		if !expectedVolumes[volume.VolumeID] || seenVolumes[volume.VolumeID] || !validTitle(volume.Title) {
			return Fail(422, "VALIDATION_FAILED", "The imported volume structure is invalid.")
		}
		seenVolumes[volume.VolumeID] = true
	}
	expectedChapters := map[string]bool{}
	for _, chapter := range state.Chapters {
		expectedChapters[chapter.ChapterID] = true
	}
	seenChapters := map[string]bool{}
	for _, chapter := range input.Chapters {
		if !expectedChapters[chapter.ChapterID] || seenChapters[chapter.ChapterID] || !validTitle(chapter.Title) ||
			(chapter.VolumeID != "" && !expectedVolumes[chapter.VolumeID]) {
			return Fail(422, "VALIDATION_FAILED", "The imported chapter structure is invalid.")
		}
		seenChapters[chapter.ChapterID] = true
	}
	return nil
}

func importBook(state importManifest, input ImportCommitInput) ManagedBook {
	volumes := make([]ManagedVolume, 0, len(input.Volumes))
	for _, volume := range input.Volumes {
		volumes = append(volumes, ManagedVolume{ID: volume.VolumeID, Title: volume.Title})
	}
	chapters := make([]ManagedChapter, 0, len(input.Chapters))
	for _, chapter := range input.Chapters {
		chapters = append(chapters, ManagedChapter{ID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	return ManagedBook{ID: state.BookID, Title: input.Title, Version: 1, ReadOnly: false, Volumes: volumes, Chapters: chapters}
}

func (s *ImportService) writeInitialRevision(ctx context.Context, bookID string, chapter ManagedChapter, content, createdAt string) error {
	// Managed chapter envelopes intentionally keep a stable generic title in
	// the source body; display titles are mutable projection metadata. This
	// must match Management.projection byte-for-byte so SourceHash remains
	// stable when the author renames a chapter.
	envelope := "# 第一章\n\nID: " + chapter.ID + "\n\n"
	doc := harness.Parse("manuscript/"+chapter.ID+".md", envelope, map[string]string{})
	sourceID := "source:" + doc.Blob
	draft := &DraftState{
		SourceHash: doc.SHA256,
		Source: &StoredRevision{
			Revision: Revision{
				ID: sourceID, Hash: compat.Hash(""), Words: 0,
				CreatedBy: RevisionActor{Type: "system", ID: pointer("harness-reader"), Label: pointer("Harness 源文件")},
			},
			Markdown: "",
		},
		Revisions: []StoredRevision{},
	}
	hash := compat.Hash(content)
	revision := StoredRevision{
		Revision: Revision{
			ID:     "import:" + strings.TrimPrefix(hash, "sha256:"),
			Parent: pointer(sourceID), Hash: hash, Words: compat.Words(content),
			CreatedAt: createdAt,
			CreatedBy: RevisionActor{Type: "system", ID: pointer("epub-import"), Label: pointer("EPUB 导入")},
		},
		Markdown: content, RequestHash: hash,
	}
	draft.Revisions = append(draft.Revisions, revision)
	draft.KnowledgeIntent = &revision.Revision
	service := &Service{State: s.Management.Legacy.State, Project: bookID}
	path := service.draftPath(Chapter{ID: chapter.ID})
	return storage.Lock(ctx, path+".lock", func() error {
		// A previous attempt can have written one or more complete drafts before
		// the catalog commit failed. Treat those as prepared facts only if every
		// byte relevant to this import still matches; otherwise stop rather than
		// overwrite unexpected author data.
		var existing *DraftState
		found, err := storage.Read(path, &existing)
		if err != nil {
			return err
		}
		if found {
			if existing == nil || existing.SourceHash != doc.SHA256 || existing.Source == nil ||
				existing.Source.ID != sourceID || existing.Source.Hash != compat.Hash("") ||
				len(existing.Revisions) != 1 || existing.Revisions[0].ID != revision.ID ||
				existing.Revisions[0].Hash != hash || existing.Revisions[0].Parent == nil ||
				*existing.Revisions[0].Parent != sourceID {
				return Fail(409, "IMPORT_STATE_CHANGED", "The import revision state changed. Upload it again.")
			}
			if existing.KnowledgeIntent == nil {
				existing.KnowledgeIntent = &existing.Revisions[0].Revision
				return storage.Write(ctx, path, existing)
			}
			if existing.KnowledgeIntent.ID != revision.ID {
				return Fail(409, "IMPORT_STATE_CHANGED", "The import revision state changed. Upload it again.")
			}
			return nil
		}
		return storage.Write(ctx, path, draft)
	})
}

func (s *ImportService) planLimits(ctx context.Context, a Actor) error {
	plan, err := s.Management.entitlements(ctx, a)
	if err != nil || (plan.Books == 0 && plan.ImportsPerMonth == 0) {
		return err
	}
	st, err := s.Management.load()
	if err != nil {
		return err
	}
	if err := bookLimit(plan, st, a.ID); err != nil {
		return err
	}
	return importLimit(plan, st, a.ID)
}

func (s *ImportService) Commit(ctx context.Context, a Actor, id, key string, input ImportCommitInput) (ImportCommitResult, error) {
	if err := author(a); err != nil {
		return ImportCommitResult{}, err
	}
	_, dir, _, err := s.paths(a, id)
	if err != nil {
		return ImportCommitResult{}, err
	}
	var result ImportCommitResult
	err = storage.Lock(ctx, dir+".lock", func() error {
		var err error
		result, err = s.commitLocked(ctx, a, id, key, input)
		return err
	})
	return result, err
}
func (s *ImportService) commitLocked(ctx context.Context, a Actor, id, key string, input ImportCommitInput) (ImportCommitResult, error) {
	if err := author(a); err != nil {
		return ImportCommitResult{}, err
	}
	if !SafeKey(key) {
		return ImportCommitResult{}, Fail(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required.")
	}
	state, dir, err := s.load(a, id)
	if err != nil {
		return ImportCommitResult{}, err
	}
	if err := validImportStructure(input, state); err != nil {
		return ImportCommitResult{}, err
	}
	candidate := importBook(state, input)
	raw, _ := compat.Marshal(struct {
		Import string
		Input  ImportCommitInput
	}{id, input}, false)
	requestHash := compat.Hash(string(raw))
	requestKey := commitRequestKey(a.ID, key)
	var result ImportCommitResult
	if err := s.Management.safe(); err != nil {
		return result, err
	}
	plan, err := s.Management.entitlements(ctx, a)
	if err != nil {
		return result, err
	}
	lookup := func(st managedState) (bool, error) {
		if _, deleted := st.Requests["delete:tombstone:"+compat.Key(state.BookID)]; deleted {
			return true, bookMissing()
		}
		if prior, ok := st.Requests[requestKey]; ok {
			if prior.Hash != requestHash {
				return true, Fail(422, "VALIDATION_FAILED", "The Idempotency-Key was already used for a different import.")
			}
			result.Book = prior.Result
			return true, nil
		}
		for _, existing := range st.Books {
			if existing.ID == state.BookID {
				if existing.Owner != a.ID {
					return true, Fail(409, "IMPORT_STATE_CHANGED", "The imported book ID is no longer available.")
				}
				// The catalog write is the commit point. This branch recovers after
				// a crash between catalog commit and staging-status update.
				result.Book = existing.ManagedBook
				return true, nil
			}
		}
		return false, nil
	}
	done := false
	err = storage.Lock(ctx, s.Management.path()+".lock", func() error {
		st, err := s.Management.load()
		if err != nil {
			return err
		}
		if done, err = lookup(st); done || err != nil {
			return err
		}
		// Checked again at the commit point below; refusing here avoids
		// writing drafts for a book that cannot be committed.
		if err := bookLimit(plan, st, a.ID); err != nil {
			return err
		}
		return importLimit(plan, st, a.ID)
	})
	if err != nil || done {
		return result, err
	}
	// Prepare every immutable draft before taking the shared catalog lock. A
	// large first import must not block unrelated chapters while it fsyncs
	// hundreds of files. Rechecking the catalog after preparation resolves
	// concurrent idempotent retries without exposing a half-imported book.
	if err := s.Management.safeDrafts(state.BookID); err != nil {
		return result, err
	}
	if err := safeImportTree(dir); err != nil {
		return result, err
	}
	for i, chapter := range candidate.Chapters {
		ref := state.Chapters[i]
		if ref.ChapterID != chapter.ID {
			return result, Fail(409, "IMPORT_STATE_CHANGED", "The import chapter order changed.")
		}
		path, err := importChapterPath(dir, ref.ChapterID)
		if err != nil {
			return result, Fail(409, "IMPORT_STATE_CHANGED", "The import chapter data is invalid.")
		}
		content, err := os.ReadFile(path)
		if err != nil || compat.HashBytes(content) != ref.ContentHash {
			return result, Fail(409, "IMPORT_STATE_CHANGED", "The staged EPUB content changed. Upload it again.")
		}
		if err := s.writeInitialRevision(ctx, candidate.ID, chapter, string(content), state.CreatedAt); err != nil {
			return result, err
		}
	}

	err = storage.Lock(ctx, s.Management.path()+".lock", func() error {
		st, err := s.Management.load()
		if err != nil {
			return err
		}
		if done, err := lookup(st); done || err != nil {
			return err
		}
		if err := bookLimit(plan, st, a.ID); err != nil {
			return err
		}
		if err := importLimit(plan, st, a.ID); err != nil {
			return err
		}

		books := append(append([]storedBook{}, st.Books...), storedBook{ManagedBook: candidate, Owner: a.ID})
		requests := make(map[string]managedRequest, len(st.Requests)+1)
		for k, v := range st.Requests {
			requests[k] = v
		}
		requests[requestKey] = managedRequest{Hash: requestHash, Result: candidate}
		audit := append(append([]any{}, st.Audit...), map[string]any{
			"actor": a, "bookId": candidate.ID, "operation": "epub_import",
			"version": candidate.Version, "at": compat.Now(), "requestId": key, "importId": id,
		})
		if s.Management.commitCatalog != nil {
			err = s.Management.commitCatalog(ctx, books, requests, audit)
		} else {
			st.Books = books
			st.Requests = requests
			st.Audit = audit
			err = s.Management.write(ctx, s.Management.path(), st)
		}
		if err != nil {
			return err
		}
		result.Book = candidate
		result.Created = true
		return nil
	})
	if err != nil {
		return result, err
	}
	// Best effort: catalog state is authoritative if this status update fails.
	state.Status = "committed"
	state.CommittedAt = compat.Now()
	state.CommitKey = key
	state.CommitHash = requestHash
	_ = storage.Write(ctx, filepath.Join(dir, "manifest.json"), state)
	return result, nil
}

func (s *ImportService) Status(a Actor, id string) (ImportPreview, error) {
	return s.Get(a, id)
}

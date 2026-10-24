package application

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type ManagedVolume struct {
	ID       string `json:"volumeId"`
	Title    string `json:"title"`
	Archived bool   `json:"archived,omitempty"`
}
type ManagedChapter struct {
	ID       string `json:"chapterId"`
	Title    string `json:"title"`
	VolumeID string `json:"volumeId,omitempty"`
	Archived bool   `json:"archived"`
}
type ManagedBook struct {
	ID       string           `json:"bookId"`
	Title    string           `json:"title"`
	Version  int              `json:"version"`
	Volumes  []ManagedVolume  `json:"volumes"`
	Chapters []ManagedChapter `json:"chapters"`
	ReadOnly bool             `json:"readOnly"`
}
type deletionReceipt struct {
	BookID  string `json:"bookId"`
	OwnerID string `json:"ownerId"`
}
type storedBook struct {
	ManagedBook
	Owner string `json:"ownerId"`
}
type managedRequest struct {
	Deleted         bool             `json:"deleted,omitempty"`
	Hash            string           `json:"hash"`
	Result          ManagedBook      `json:"result"`
	DeletionReceipt *deletionReceipt `json:"deletionReceipt,omitempty"`
}
type managedState struct {
	Schema   int                       `json:"schema"`
	Books    []storedBook              `json:"books"`
	Requests map[string]managedRequest `json:"requests"`
	Audit    []any                     `json:"audit"`
}

type Management struct {
	Legacy        *Service
	OwnerID       string
	write         func(context.Context, string, any) error
	commitCatalog func(context.Context, []storedBook, map[string]managedRequest, []any) error
	// These hooks keep publication ownership in the publication package while
	// preserving one server-side deletion workflow. They are trusted wiring,
	// never values supplied by an HTTP caller.
	GuardDelete     func(context.Context, Actor, string) error
	CleanupExternal func(context.Context, Actor, string) error
}
type StructureInput struct {
	BaseVersion int              `json:"baseVersion"`
	Operation   string           `json:"operation"`
	Title       string           `json:"title,omitempty"`
	VolumeID    string           `json:"volumeId,omitempty"`
	Volumes     []ManagedVolume  `json:"volumes,omitempty"`
	Chapters    []ManagedChapter `json:"chapters,omitempty"`
}
type DeleteBookInput struct {
	BaseVersion int `json:"baseVersion"`
}

func NewManagement(legacy *Service, owner string) *Management {
	return &Management{Legacy: legacy, OwnerID: owner, write: storage.Write}
}
func (m *Management) path() string { return filepath.Join(m.Legacy.State, "works", "catalog-v1.json") }

// Reject symlinks in every existing state ancestor. No client value becomes a path.
func (m *Management) safe() error {
	p, e := filepath.Abs(m.path())
	if e != nil {
		return e
	}
	stop, e := filepath.Abs(filepath.Dir(m.Legacy.State))
	if e != nil {
		return e
	}
	for p != stop && p != "/" && p != "." {
		info, e := os.Lstat(p)
		if e != nil && !os.IsNotExist(e) {
			return e
		}
		if e == nil && info.Mode()&os.ModeSymlink != 0 {
			return Fail(500, "WORKSPACE_STORAGE_FAILED", "Managed state cannot contain symbolic links.")
		}
		p = filepath.Dir(p)
	}
	return nil
}
func (m *Management) load() (managedState, error) {
	st := managedState{1, []storedBook{}, map[string]managedRequest{}, []any{}}
	if e := m.safe(); e != nil {
		return st, e
	}
	found, e := storage.Read(m.path(), &st)
	if e != nil {
		return st, e
	}
	if found && (st.Schema != 1 || st.Requests == nil || st.Books == nil || st.Audit == nil) {
		return st, Fail(500, "WORKSPACE_STORAGE_FAILED", "Invalid workspace registry.")
	}
	seen := map[string]bool{}
	for _, b := range st.Books {
		if b.ID == "" || seen[b.ID] || b.Owner == "" || b.Version < 1 || validStructure(b.ManagedBook) != nil {
			return st, Fail(500, "WORKSPACE_STORAGE_FAILED", "Invalid workspace registry.")
		}
		seen[b.ID] = true
	}
	return st, nil
}
func author(a Actor) error {
	if a.Role != "author" {
		return Fail(403, "AGENT_WRITE_FORBIDDEN", "Only an authenticated author can manage works.")
	}
	return nil
}
func bookMissing() error { return Fail(404, "NOT_FOUND", "Book not found.") }
func validTitle(s string) bool {
	return compat.Trim(s) != "" && utf8.ValidString(s) && compat.UTF16Len(s) <= 200 && !strings.ContainsAny(s, "\r\n\x00")
}
func validStructure(b ManagedBook) error {
	if b.Volumes == nil || b.Chapters == nil || !validTitle(b.Title) || len(b.Chapters) > 999999 || len(b.Volumes) > 10000 {
		return Fail(422, "VALIDATION_FAILED", "Invalid book structure.")
	}
	volumes := map[string]bool{"": true}
	for _, v := range b.Volumes {
		_, exists := volumes[v.ID]
		if !strings.HasPrefix(v.ID, "VOL-") || len(v.ID) > 80 || strings.ContainsAny(v.ID, "/\\.%") || exists || !validTitle(v.Title) {
			return Fail(422, "VALIDATION_FAILED", "Invalid or repeated volume.")
		}
		volumes[v.ID] = !v.Archived
	}
	chapters := map[string]bool{}
	for _, c := range b.Chapters {
		if !chapterRE.MatchString(c.ID) || chapters[c.ID] || !volumes[c.VolumeID] || !validTitle(c.Title) {
			return Fail(422, "VALIDATION_FAILED", "Invalid or repeated chapter.")
		}
		chapters[c.ID] = true
	}
	return nil
}
func (m *Management) List(a Actor) ([]ManagedBook, error) {
	if e := author(a); e != nil {
		return nil, e
	}
	st, e := m.load()
	if e != nil {
		return nil, e
	}
	out := []ManagedBook{}
	// External compatibility data is optional; its read failure cannot hide managed works.
	if a.ID == m.OwnerID {
		if legacy, err := m.legacyBook(); err == nil {
			out = append(out, legacy)
		}
	}
	for _, b := range st.Books {
		if b.Owner == a.ID {
			out = append(out, b.ManagedBook)
		}
	}
	return out, nil
}
func (m *Management) legacyBook() (ManagedBook, error) {
	p, e := m.Legacy.Projection()
	if e != nil {
		return ManagedBook{}, e
	}
	all, e := Sources(p)
	if e != nil {
		return ManagedBook{}, e
	}
	if len(all) == 0 {
		return ManagedBook{}, bookMissing()
	}
	for _, c := range p.Collisions {
		if chapterRE.MatchString(c.ID) {
			return ManagedBook{}, duplicateChapter(c.ID, c.Paths)
		}
	}
	b := ManagedBook{ID: m.Legacy.Project, Title: "本地作品", ReadOnly: true, Version: 1, Volumes: []ManagedVolume{}, Chapters: []ManagedChapter{}}
	for _, c := range OrderedChapters(all) {
		b.Chapters = append(b.Chapters, ManagedChapter{ID: c.ID, Title: c.Title, VolumeID: c.VolumeID})
	}
	return b, nil
}
func (m *Management) Get(a Actor, id string) (ManagedBook, error) {
	if e := author(a); e != nil {
		return ManagedBook{}, e
	}
	if id == m.Legacy.Project {
		if a.ID != m.OwnerID {
			return ManagedBook{}, bookMissing()
		}
		return m.legacyBook()
	}
	// Resolve managed IDs directly against the ownership registry, never via List.
	st, e := m.load()
	if e != nil {
		return ManagedBook{}, e
	}
	for _, b := range st.Books {
		if b.ID == id && b.Owner == a.ID {
			return b.ManagedBook, nil
		}
	}
	return ManagedBook{}, bookMissing()
}
func (m *Management) Resolve(a Actor, id string) (*Service, error) {
	if id == m.Legacy.Project && (a.ID == m.OwnerID && a.Role == "author" || a.Role == "agent") {
		return m.Legacy, nil
	}
	if _, e := m.Get(a, id); e != nil {
		return nil, e
	}
	s := &Service{State: m.Legacy.State, Project: id, ReviewsEnabled: m.Legacy.ReviewsEnabled}
	s.managedExists = func() error { _, err := m.Get(a, id); return err }
	s.ProjectTitle = func() (string, error) { b, e := m.Get(a, id); return b.Title, e }
	s.DirectoryProvider = func() (any, error) {
		b, e := m.Get(a, id)
		if e != nil {
			return nil, e
		}
		volumes := []any{}
		for _, v := range append([]ManagedVolume{{ID: "", Title: "未分卷"}}, b.Volumes...) {
			if v.Archived {
				continue
			}
			items := []any{}
			order := 0
			for _, c := range b.Chapters {
				if c.Archived || c.VolumeID != v.ID {
					continue
				}
				order++
				items = append(items, map[string]any{"chapterId": c.ID, "title": c.Title, "order": order})
			}
			group := map[string]any{"title": v.Title, "chapters": items}
			if v.ID != "" {
				group["volumeId"] = v.ID
			}
			volumes = append(volumes, group)
		}
		return map[string]any{"volumes": volumes}, nil
	}
	s.ProjectionProvider = func() (harness.Projection, error) { return m.projection(id) }
	return s, nil
}
func (m *Management) projection(id string) (harness.Projection, error) {
	st, e := m.load()
	if e != nil {
		return harness.Projection{}, e
	}
	if e := m.safeDrafts(id); e != nil {
		return harness.Projection{}, e
	}
	var b *storedBook
	for i := range st.Books {
		if st.Books[i].ID == id {
			b = &st.Books[i]
			break
		}
	}
	if b == nil {
		return harness.Projection{}, bookMissing()
	}
	p := harness.Projection{ProjectID: id, Knowledge: []harness.Document{}, Proposals: []harness.Document{}, Chapters: []harness.Document{}, Unmapped: []string{}, Other: []harness.Document{}, Collisions: []harness.Collision{}}
	fingerprint, _ := compat.Marshal(b.ManagedBook, false)
	structureHash := compat.Hash(string(fingerprint))
	for _, v := range append([]ManagedVolume{{ID: ""}}, b.Volumes...) {
		if v.Archived {
			continue
		}
		order := 0
		for _, c := range b.Chapters {
			if c.Archived || c.VolumeID != v.ID {
				continue
			}
			order++
			// Immutable envelope: mutable display names/order never alter source lineage.
			d := harness.Parse("manuscript/"+c.ID+".md", "# 第一章\n\nID: "+c.ID+"\n\n", map[string]string{})
			d.Title = pointer(c.Title)
			d.Metadata["volumeId"] = c.VolumeID
			d.Metadata["volumeTitle"] = v.Title
			d.Metadata["order"] = fmt.Sprint(order)
			d.Metadata["structureHash"] = structureHash
			p.Chapters = append(p.Chapters, d)
		}
	}
	return p, nil
}
func (m *Management) Mutate(ctx context.Context, a Actor, id, key string, in StructureInput) (ManagedBook, error) {
	var result ManagedBook
	if e := author(a); e != nil {
		return result, e
	}
	if !SafeKey(key) {
		return result, Fail(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required.")
	}
	if id == m.Legacy.Project {
		return result, Fail(403, "READ_ONLY_HARNESS", "External Harness structure is read-only.")
	}
	data, _ := json.Marshal(struct {
		ID    string
		Input StructureInput
	}{id, in})
	hash := compat.Hash(string(data))
	legacyRequestKey := compat.Key(a.ID) + ":" + key
	requestKey := "structure:" + legacyRequestKey
	if e := m.safe(); e != nil {
		return result, e
	}
	e := storage.Lock(ctx, m.path()+".lock", func() error {
		st, e := m.load()
		if e != nil {
			return e
		}
		if prior, ok := st.Requests[requestKey]; ok {
			if prior.Hash != hash {
				return Fail(422, "VALIDATION_FAILED", "The Idempotency-Key was already used for a different workspace operation.")
			}
			if prior.Deleted {
				return bookMissing()
			}
			result = prior.Result
			return nil
		}
		// Catalogs written before import receipts were namespaced still use the
		// unprefixed form. Preserve cross-deployment replay safety by accepting
		// that receipt and migrating it in the same catalog write as the replay.
		legacy, hasLegacy := st.Requests[legacyRequestKey]
		if hasLegacy {
			if legacy.Hash != hash {
				return Fail(422, "VALIDATION_FAILED", "The Idempotency-Key was already used for a different workspace operation.")
			}
			if legacy.Deleted {
				return bookMissing()
			}
			st.Requests[requestKey] = legacy
			delete(st.Requests, legacyRequestKey)
			var writeErr error
			if m.commitCatalog != nil {
				writeErr = m.commitCatalog(ctx, st.Books, st.Requests, st.Audit)
			} else {
				writeErr = m.write(ctx, m.path(), st)
			}
			if writeErr != nil {
				return writeErr
			}
			result = legacy.Result
			return nil
		}
		index := -1
		for i, b := range st.Books {
			if b.ID == id && b.Owner == a.ID {
				index = i
				break
			}
		}
		var b ManagedBook
		if id == "" {
			if in.Operation != "create" || in.BaseVersion != 0 {
				return Fail(422, "VALIDATION_FAILED", "Use create to start a work.")
			}
			b = ManagedBook{ID: "book-" + compat.UUID(), Title: "未命名作品", Version: 1, Volumes: []ManagedVolume{}, Chapters: []ManagedChapter{{ID: "CH-000001", Title: "第一章"}}}
			if in.Title != "" {
				b.Title = in.Title
			}
		} else {
			if index < 0 {
				return bookMissing()
			}
			b = st.Books[index].ManagedBook
			if b.Version != in.BaseVersion {
				return &Error{Status: 409, Code: "STRUCTURE_CONFLICT", Detail: "作品目录已在另一处更新，请刷新目录后重试。", Current: b}
			}
			switch in.Operation {
			case "rename":
				b.Title = strings.TrimSpace(in.Title)
			case "chapter":
				maxID := 0
				for _, c := range b.Chapters {
					var n int
					fmt.Sscanf(c.ID, "CH-%d", &n)
					if n > maxID {
						maxID = n
					}
				}
				if maxID >= 999999 {
					return Fail(422, "VALIDATION_FAILED", "Chapter limit reached.")
				}
				title := in.Title
				if title == "" {
					title = fmt.Sprintf("第%d章", maxID+1)
				}
				b.Chapters = append(b.Chapters, ManagedChapter{ID: fmt.Sprintf("CH-%06d", maxID+1), Title: title, VolumeID: in.VolumeID})
			case "volume":
				title := in.Title
				if title == "" {
					title = "未命名卷"
				}
				b.Volumes = append(b.Volumes, ManagedVolume{ID: "VOL-" + compat.UUID(), Title: title})
			case "structure":
				old := map[string]bool{}
				for _, c := range b.Chapters {
					old[c.ID] = true
				}
				if len(in.Chapters) != len(b.Chapters) {
					return Fail(422, "VALIDATION_FAILED", "Structure must retain every chapter.")
				}
				for _, c := range in.Chapters {
					if !old[c.ID] {
						return Fail(422, "VALIDATION_FAILED", "Unknown chapter.")
					}
				}
				if len(in.Volumes) != len(b.Volumes) {
					return Fail(422, "VALIDATION_FAILED", "Structure must retain every volume, including archived volumes.")
				}
				for _, v := range b.Volumes {
					found := false
					for _, next := range in.Volumes {
						if next.ID == v.ID && !next.Archived {
							found = true
						}
					}
					if !found {
						for _, c := range b.Chapters {
							if c.VolumeID == v.ID {
								return Fail(422, "VALIDATION_FAILED", "Only empty volumes can be archived.")
							}
						}
					}
				}
				for _, v := range in.Volumes {
					found := false
					for _, prior := range b.Volumes {
						if prior.ID == v.ID {
							found = true
						}
					}
					if !found {
						return Fail(422, "VALIDATION_FAILED", "Create a volume before ordering it.")
					}
				}
				b.Volumes = in.Volumes
				b.Chapters = in.Chapters
			default:
				return Fail(422, "VALIDATION_FAILED", "Unknown structure operation.")
			}
			b.Version++
		}
		if e := validStructure(b); e != nil {
			return e
		}
		if e := m.safeDrafts(b.ID); e != nil {
			return e
		}
		// Draft locks block concurrent publication commit. Readers of the catalog use
		// atomic snapshots without its lock, so publication's inverse read cannot cycle.
		ids := []string{}
		if index >= 0 {
			for _, c := range st.Books[index].Chapters {
				ids = append(ids, c.ID)
			}
		}
		sort.Strings(ids)
		var guard func(int) error
		guard = func(i int) error {
			if i < len(ids) {
				s := &Service{State: m.Legacy.State, Project: b.ID, managedExists: func() error { return nil }}
				return s.StateLock(ctx, s.draftPath(Chapter{ID: ids[i]})+".lock", func() error { return guard(i + 1) })
			}
			if index < 0 {
				st.Books = append(st.Books, storedBook{b, a.ID})
			} else {
				st.Books[index] = storedBook{b, a.ID}
			}
			st.Requests[requestKey] = managedRequest{Hash: hash, Result: b}
			st.Audit = append(st.Audit, map[string]any{"actor": a, "bookId": b.ID, "operation": in.Operation, "version": b.Version, "at": compat.Now(), "requestId": key})
			var e error
			if m.commitCatalog != nil {
				e = m.commitCatalog(ctx, st.Books, st.Requests, st.Audit)
			} else {
				e = m.write(ctx, m.path(), st)
			}
			if e != nil {
				return e
			}
			result = b
			return nil
		}
		return guard(0)
	})
	return result, e
}

// Delete removes an author-owned managed book from the catalog. The catalog
// replacement is the visibility commit; only after that point are book-scoped
// files and publication state purged. A replay with the same key repairs any
// cleanup that failed after the catalog commit.
func (m *Management) Delete(ctx context.Context, a Actor, id, key string, in DeleteBookInput) (ManagedBook, error) {
	var deleted ManagedBook
	if e := author(a); e != nil {
		return deleted, e
	}
	if !SafeKey(key) {
		return deleted, Fail(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required.")
	}
	if in.BaseVersion < 1 {
		return deleted, Fail(422, "VALIDATION_FAILED", "A valid baseVersion is required.")
	}
	if id == m.Legacy.Project {
		return deleted, Fail(403, "READ_ONLY_HARNESS", "External Harness books cannot be deleted.")
	}
	if m.GuardDelete != nil {
		if e := m.GuardDelete(ctx, a, id); e != nil {
			return deleted, e
		}
	}
	payload, _ := json.Marshal(struct {
		ID    string
		Input DeleteBookInput
	}{id, in})
	hash := compat.Hash(string(payload))
	requestKey := "delete:" + compat.Key(a.ID) + ":" + key
	if e := m.safe(); e != nil {
		return deleted, e
	}
	// The tombstone key is deterministic per book. Keeping exactly one deletion
	// receipt per book both supports retries after a recreate and bounds catalog
	// growth; purge progress is tracked separately from deleted data.
	tombstoneKey := "delete:tombstone:" + compat.Key(id)
	purgeKey := "delete:purge:" + compat.Key(id)
	e := storage.Lock(ctx, m.path()+".lock", func() error {
		st, e := m.load()
		if e != nil {
			return e
		}
		tombstone, alreadyDeleted := st.Requests[tombstoneKey]
		if alreadyDeleted {
			deleted = tombstone.Result
			if tombstone.DeletionReceipt == nil || tombstone.DeletionReceipt.OwnerID != a.ID {
				return bookMissing()
			}
		}
		if prior, ok := st.Requests[requestKey]; ok {
			if prior.Hash != hash {
				return Fail(422, "VALIDATION_FAILED", "The Idempotency-Key was already used for a different workspace operation.")
			}
			deleted = prior.Result
			return nil
		} else if alreadyDeleted {
			// The browser may legitimately mint a fresh key after losing the
			// first response. The per-book tombstone keeps the immutable receipt
			// needed to finish a cleanup without restoring catalog visibility.
			st.Requests[requestKey] = managedRequest{Hash: hash, Result: deleted}
			st.Requests[purgeKey] = managedRequest{Hash: hash, Result: deleted}
			if m.commitCatalog != nil {
				return m.commitCatalog(ctx, st.Books, st.Requests, st.Audit)
			}
			return m.write(ctx, m.path(), st)
		}
		index := -1
		for i, b := range st.Books {
			if b.ID == id && b.Owner == a.ID {
				index = i
				break
			}
		}
		if index < 0 {
			return bookMissing()
		}
		b := st.Books[index]
		if b.Version != in.BaseVersion {
			return &Error{Status: 409, Code: "STRUCTURE_CONFLICT", Detail: "作品目录已在另一处更新，请刷新目录后重试。", Current: b.ManagedBook}
		}
		deleted = b.ManagedBook
		st.Books = append(append([]storedBook{}, st.Books[:index]...), st.Books[index+1:]...)
		for requestID, receipt := range st.Requests {
			// A stale browser intent must not recover deleted work.
			if receipt.Result.ID == id {
				receipt.Result = ManagedBook{ID: id}
				receipt.Deleted = true
				st.Requests[requestID] = receipt
			}
		}
		st.Requests[tombstoneKey] = managedRequest{Hash: hash, Result: deleted, DeletionReceipt: &deletionReceipt{BookID: deleted.ID, OwnerID: a.ID}}
		st.Audit = append(st.Audit, map[string]any{
			"actor": a, "bookId": id, "operation": "delete",
			"version": b.Version, "at": compat.Now(), "requestId": key,
		})
		st.Requests[requestKey] = managedRequest{Hash: hash, Result: deleted}
		st.Requests[purgeKey] = managedRequest{Hash: hash, Result: deleted}
		if m.commitCatalog != nil {
			return m.commitCatalog(ctx, st.Books, st.Requests, st.Audit)
		}
		return m.write(ctx, m.path(), st)
	})
	if e != nil {
		return ManagedBook{}, e
	}
	// The book is no longer resolvable even if a best-effort purge is interrupted.
	// The durable purge marker lets the same key, any later delete key for the
	// same book, or a server restart finish the job without restoring visibility.
	if e := m.cleanupDeletedBook(ctx, a, deleted); e != nil {
		return deleted, e
	}
	e = storage.Lock(ctx, m.path()+".lock", func() error {
		st, err := m.load()
		if err != nil {
			return err
		}
		delete(st.Requests, purgeKey)
		if m.commitCatalog != nil {
			return m.commitCatalog(ctx, st.Books, st.Requests, st.Audit)
		}
		return m.write(ctx, m.path(), st)
	})
	if e != nil {
		return deleted, e
	}
	return deleted, nil
}

func (m *Management) cleanupDeletedBook(ctx context.Context, a Actor, b ManagedBook) error {
	bookKey := compat.Key(b.ID)
	service := &Service{State: m.Legacy.State, Project: b.ID}
	if err := storage.Lock(ctx, service.bookCommitPath(), func() error {
		for _, path := range []string{
			filepath.Join(m.Legacy.State, "chapter-drafts", bookKey),
			filepath.Join(m.Legacy.State, "notes", bookKey+".json"),
			filepath.Join(m.Legacy.State, "review-runs", bookKey+".json"),
			filepath.Join(m.Legacy.State, "workspace", bookKey),
			filepath.Join(m.Legacy.State, "knowledge", bookKey),
		} {
			if e := m.removeBookPath(path); e != nil {
				return e
			}
		}
		return nil
	}); err != nil {
		return err
	}
	if e := m.removeCommittedImports(ctx, a, b.ID); e != nil {
		return e
	}
	if m.CleanupExternal != nil {
		return m.CleanupExternal(ctx, a, b.ID)
	}
	return nil
}

// ResumeDeletionCleanup finishes durable deletions whose catalog visibility
// commit succeeded before the process stopped. The tombstone records the
// owner needed to scope import and publication cleanup; it never restores a
// book and returns the number of purges completed.
func (m *Management) ResumeDeletionCleanup(ctx context.Context) (int, error) {
	if e := m.safe(); e != nil {
		return 0, e
	}
	st, e := m.load()
	if e != nil {
		return 0, e
	}
	type pendingDelete struct {
		owner Actor
		book  ManagedBook
	}
	pending := []pendingDelete{}
	for key, receipt := range st.Requests {
		if !strings.HasPrefix(key, "delete:purge:") || receipt.Result.ID == "" {
			continue
		}
		tombstone, ok := st.Requests["delete:tombstone:"+compat.Key(receipt.Result.ID)]
		if !ok || tombstone.DeletionReceipt == nil || tombstone.DeletionReceipt.OwnerID == "" || tombstone.DeletionReceipt.BookID != receipt.Result.ID {
			return 0, Fail(500, "WORKSPACE_STORAGE_FAILED", "Managed deletion receipt is incomplete.")
		}
		pending = append(pending, pendingDelete{owner: Actor{ID: tombstone.DeletionReceipt.OwnerID, Role: "author"}, book: receipt.Result})
	}
	completed := 0
	for _, p := range pending {
		if e := m.cleanupDeletedBook(ctx, p.owner, p.book); e != nil {
			return completed, e
		}
		if e := storage.Lock(ctx, m.path()+".lock", func() error {
			current, err := m.load()
			if err != nil {
				return err
			}
			key := "delete:purge:" + compat.Key(p.book.ID)
			if _, ok := current.Requests[key]; !ok {
				return nil
			}
			delete(current.Requests, key)
			if m.commitCatalog != nil {
				return m.commitCatalog(ctx, current.Books, current.Requests, current.Audit)
			}
			return m.write(ctx, m.path(), current)
		}); e != nil {
			return completed, e
		}
		completed++
	}
	return completed, nil
}

func (m *Management) removeCommittedImports(ctx context.Context, a Actor, bookID string) error {
	root := filepath.Join(m.Legacy.State, "works", "imports", compat.Key(a.ID))
	if e := m.safeStateDir(root); e != nil {
		return e
	}
	entries, e := os.ReadDir(root)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if !entry.IsDir() || !importIDRE.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(root, entry.Name())
		var manifest importManifest
		found, e := storage.Read(filepath.Join(dir, "manifest.json"), &manifest)
		if e != nil {
			return e
		}
		if !found || manifest.OwnerID != a.ID || manifest.BookID != bookID {
			continue
		}
		if e := storage.Lock(ctx, dir+".lock", func() error { return m.removeBookPath(dir) }); e != nil {
			return e
		}
	}
	return nil
}

func (m *Management) safeStateDir(path string) error {
	base, e := filepath.Abs(m.Legacy.State)
	if e != nil {
		return e
	}
	target, e := filepath.Abs(path)
	if e != nil {
		return e
	}
	rel, e := filepath.Rel(base, target)
	if e != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return Fail(500, "WORKSPACE_STORAGE_FAILED", "Managed deletion path escaped state.")
	}
	for current := target; ; current = filepath.Dir(current) {
		if info, err := os.Lstat(current); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return Fail(500, "WORKSPACE_STORAGE_FAILED", "Managed state cannot contain symbolic links.")
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
		if current == base {
			break
		}
	}
	return nil
}

func (m *Management) removeBookPath(path string) error {
	if e := m.safeStateDir(path); e != nil {
		return e
	}
	info, e := os.Lstat(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return Fail(500, "WORKSPACE_STORAGE_FAILED", "Managed state cannot contain symbolic links.")
	}
	return os.RemoveAll(path)
}

// State is service-owned; reject pre-existing links in the existing Revision
// namespace as well as the catalog. No path supplied by an HTTP caller is used.
func (m *Management) safeDrafts(id string) error {
	root := filepath.Join(m.Legacy.State, "chapter-drafts")
	if info, e := os.Lstat(root); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return Fail(500, "WORKSPACE_STORAGE_FAILED", "Revision state cannot contain symbolic links.")
	} else if e != nil && !os.IsNotExist(e) {
		return e
	}
	return filepath.WalkDir(filepath.Join(root, compat.Key(id)), func(path string, d os.DirEntry, e error) error {
		if os.IsNotExist(e) {
			return nil
		}
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return Fail(500, "WORKSPACE_STORAGE_FAILED", "Revision state cannot contain symbolic links.")
		}
		return nil
	})
}

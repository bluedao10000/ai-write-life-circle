// Package harness reads the existing Markdown conventions without modifying author files.
package harness

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"golang.org/x/text/collate"
	textunicode "golang.org/x/text/encoding/unicode"
	"golang.org/x/text/language"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type Section struct {
	Heading  *string `json:"heading"`
	Markdown string  `json:"markdown"`
}
type SourceReference struct {
	Raw          string  `json:"raw"`
	Path         *string `json:"path"`
	Locator      *string `json:"locator"`
	Availability string  `json:"availability"`
	GitBlobHash  *string `json:"gitBlobHash"`
}
type Document struct {
	Path               string            `json:"path"`
	Title              *string           `json:"title"`
	Metadata           map[string]string `json:"metadata"`
	StableID           *string           `json:"stableId"`
	IDSource           *string           `json:"idSource"`
	RawStatus          *string           `json:"rawStatus"`
	RawSource          *string           `json:"rawSource"`
	SourceReferences   []SourceReference `json:"sourceReferences"`
	DeclaredRelatedIDs []string          `json:"declaredRelatedIds"`
	ReferencedIDs      []string          `json:"referencedIds"`
	Sections           []Section         `json:"sections"`
	Markdown           string            `json:"markdown"`
	Body               string            `json:"bodyMarkdown"`
	SHA256             string            `json:"sha256"`
	Blob               string            `json:"gitBlobHash"`
}
type Collision struct {
	ID    string   `json:"id"`
	Paths []string `json:"paths"`
}
type Projection struct {
	ProjectID      string      `json:"projectId"`
	SourceRevision *string     `json:"sourceRevision"`
	Knowledge      []Document  `json:"knowledgeDocuments"`
	Proposals      []Document  `json:"proposalDocuments"`
	Chapters       []Document  `json:"chapterDocuments"`
	Unmapped       []string    `json:"unmappedChapterPaths"`
	Other          []Document  `json:"otherDocuments"`
	Collisions     []Collision `json:"idCollisions"`
}

var stable = regexp.MustCompile(`^[A-Z][A-Z0-9]*-\d{1,6}$`)
var refs = regexp.MustCompile(`\b(?:INTENT|WORLD|CHAR|THREAD|EVENT|CH|P|REF|NOTE|U|C|A|R)-\d{1,6}\b`)
var filenameID = regexp.MustCompile(`^([A-Z][A-Z0-9]*-\d{1,6})(?:[-_.]|$)`)

const ws = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var titleRE = regexp.MustCompile(`^#` + ws + `+([^\r\n\x{2028}\x{2029}]+?)` + ws + `*#*$`)
var headingRE = regexp.MustCompile(`^#{1,6}` + ws + `+([^\r\n\x{2028}\x{2029}]+?)` + ws + `*#*$`)
var fieldRE = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9_-]*):` + ws + `*([^\r\n\x{2028}\x{2029}]*)(?:[\r\x{2028}\x{2029}])?$`)
var sourceRE = regexp.MustCompile(`(?:^|` + ws + `|\()((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.md)(#[^` + ws[1:len(ws)-1] + `;；]*)?`)

func ptr(s string) *string          { return &s }
func LocaleCompare(a, b string) int { return collate.New(language.English).CompareString(a, b) }
func unique(s string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, id := range refs.FindAllString(s, -1) {
		if !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	return out
}
func Parse(path, markdown string, known map[string]string) Document {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	cursor := 0
	for cursor < len(lines) && compat.Trim(lines[cursor]) == "" {
		cursor++
	}
	d := Document{Path: path, Metadata: map[string]string{}, SourceReferences: []SourceReference{}, DeclaredRelatedIDs: []string{}, ReferencedIDs: []string{}, Sections: []Section{}, Markdown: markdown, SHA256: compat.Hash(markdown), Blob: compat.Blob(markdown)}
	if cursor < len(lines) {
		if m := titleRE.FindStringSubmatch(lines[cursor]); m != nil {
			d.Title = ptr(compat.Trim(m[1]))
			cursor++
		}
	}
	for cursor < len(lines) {
		line := lines[cursor]
		if compat.Trim(line) == "" {
			cursor++
			if len(d.Metadata) > 0 {
				break
			}
			continue
		}
		m := fieldRE.FindStringSubmatch(line)
		if m == nil {
			break
		}
		d.Metadata[m[1]] = compat.Trim(m[2])
		cursor++
	}
	offset := 0
	for i := 0; i < cursor; i++ {
		n := strings.IndexByte(markdown[offset:], '\n')
		if n < 0 {
			offset = len(markdown)
			break
		}
		offset += n + 1
	}
	d.Body = markdown[offset:]
	declared, exists := d.Metadata["ID"]
	if !exists {
		declared = d.Metadata["id"]
	}
	declared = compat.Trim(declared)
	if stable.MatchString(declared) {
		d.StableID = ptr(declared)
		d.IDSource = ptr("metadata")
	} else if m := filenameID.FindStringSubmatch(filepath.Base(path)); m != nil {
		d.StableID = ptr(m[1])
		d.IDSource = ptr("filename")
	}
	if s, ok := d.Metadata["status"]; ok {
		d.RawStatus = ptr(s)
	}
	if s, ok := d.Metadata["source"]; ok {
		d.RawSource = ptr(s)
	}
	d.DeclaredRelatedIDs = unique(d.Metadata["related"])
	d.ReferencedIDs = unique(d.Body)
	if d.RawSource != nil && compat.Trim(*d.RawSource) != "" {
		for _, part := range strings.Split(strings.ReplaceAll(*d.RawSource, "；", ";"), ";") {
			raw := compat.Trim(part)
			ref := SourceReference{Raw: raw, Availability: "not-a-file-reference"}
			if m := sourceRE.FindStringSubmatch(raw); m != nil {
				ref.Path = ptr(m[1])
				if m[2] != "" {
					ref.Locator = ptr(m[2][1:])
				}
				ref.Availability = "unresolved"
				if hash, ok := known[m[1]]; ok {
					ref.Availability = "available"
					ref.GitBlobHash = ptr(hash)
				}
			}
			d.SourceReferences = append(d.SourceReferences, ref)
		}
	}
	var heading *string
	body := []string{}
	flush := func() {
		content := compat.Trim(strings.Join(body, "\n"))
		if content != "" || heading != nil {
			d.Sections = append(d.Sections, Section{heading, content})
		}
		body = []string{}
	}
	for _, line := range strings.Split(strings.ReplaceAll(d.Body, "\r\n", "\n"), "\n") {
		if m := headingRE.FindStringSubmatch(line); m != nil {
			flush()
			heading = ptr(compat.Trim(m[1]))
		} else {
			body = append(body, line)
		}
	}
	flush()
	return d
}

var directories = []string{"book", "decisions", "harness", "inbox", "manuscript", "notes", "proposals", "references", "reviews", "state", "templates"}

func Load(root, project string) (Projection, error) {
	p := Projection{ProjectID: project, Knowledge: []Document{}, Proposals: []Document{}, Chapters: []Document{}, Unmapped: []string{}, Other: []Document{}, Collisions: []Collision{}}
	type file struct{ path, body, sha, blob string }
	files := []file{}
	known := map[string]string{}
	var walk func(string) error
	walk = func(rel string) error {
		dir := filepath.Join(root, rel)
		st, e := os.Lstat(dir)
		if os.IsNotExist(e) {
			return nil
		}
		if e != nil {
			return e
		}
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		entries, e := os.ReadDir(dir)
		if e != nil {
			return e
		}
		c := collate.New(language.English)
		sort.SliceStable(entries, func(i, j int) bool { return c.CompareString(entries[i].Name(), entries[j].Name()) < 0 })
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") || entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			child := filepath.ToSlash(filepath.Join(rel, entry.Name()))
			if entry.IsDir() {
				if e = walk(child); e != nil {
					return e
				}
				continue
			}
			if !strings.HasSuffix(strings.ToLower(entry.Name()), ".md") {
				continue
			}
			st, e := entry.Info()
			if e != nil {
				return e
			}
			if !st.Mode().IsRegular() || st.Size() > 2*1024*1024 {
				continue
			}
			b, e := os.ReadFile(filepath.Join(root, child))
			if e != nil {
				return e
			}
			decoded, _ := textunicode.UTF8.NewDecoder().Bytes(b)
			s := string(decoded)
			known[child] = compat.BlobBytes(b)
			files = append(files, file{child, s, compat.HashBytes(b), compat.BlobBytes(b)})
		}
		return nil
	}
	for _, dir := range directories {
		if e := walk(dir); e != nil {
			return p, e
		}
	}
	ids := map[string][]string{}
	for _, f := range files {
		d := Parse(f.path, f.body, known)
		d.SHA256 = f.sha
		d.Blob = f.blob
		if d.StableID != nil {
			ids[*d.StableID] = append(ids[*d.StableID], d.Path)
		}
		switch {
		case d.StableID != nil && strings.HasPrefix(d.Path, "book/") && !strings.HasSuffix(d.Path, "/index.md"):
			p.Knowledge = append(p.Knowledge, d)
		case d.StableID != nil && strings.HasPrefix(d.Path, "proposals/"):
			p.Proposals = append(p.Proposals, d)
		case d.StableID != nil && strings.HasPrefix(d.Path, "manuscript/"):
			p.Chapters = append(p.Chapters, d)
		default:
			p.Other = append(p.Other, d)
		}
		if d.StableID == nil && strings.HasPrefix(d.Path, "manuscript/") {
			p.Unmapped = append(p.Unmapped, d.Path)
		}
	}
	for id, paths := range ids {
		if len(paths) > 1 {
			sort.Strings(paths)
			p.Collisions = append(p.Collisions, Collision{id, paths})
		}
	}
	sort.Slice(p.Collisions, func(i, j int) bool { return LocaleCompare(p.Collisions[i].ID, p.Collisions[j].ID) < 0 })
	sort.Strings(p.Unmapped)
	return p, nil
}

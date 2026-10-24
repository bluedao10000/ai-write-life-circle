package application

import (
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type Chapter struct {
	ID, Title, Markdown, SourceHash, SourceRevisionID string
	Path                                              string
	VolumeTitle                                       *string
	StructureHash                                     string
	VolumeID, Meta                                    string
	Order                                             *int64
}

var chapterRE = regexp.MustCompile(`^CH-\d{1,6}$`)
var digits = regexp.MustCompile(`^\d+$`)

func invalidChapter(id, reason string) *Error {
	return &Error{Status: 422, Code: "VALIDATION_FAILED", Detail: fmt.Sprintf("Chapter source %s is invalid: %s.", id, reason), Kind: "validation", Current: map[string]any{"chapterId": id}}
}
func duplicateChapter(id string, paths []string) *Error {
	return &Error{Status: 409, Code: "VALIDATION_FAILED", Detail: fmt.Sprintf("Chapter ID %s is declared by more than one Harness file.", id), Kind: "validation", Current: map[string]any{"chapterId": id, "paths": paths}}
}
func Sources(p harness.Projection) ([]Chapter, error) {
	out := []Chapter{}
	for _, d := range p.Chapters {
		if d.IDSource == nil || *d.IDSource != "metadata" || d.StableID == nil || !chapterRE.MatchString(*d.StableID) {
			continue
		}
		id := *d.StableID
		name := filepath.Base(d.Path)
		if !strings.HasPrefix(name, id+".") && !strings.HasPrefix(name, id+"-") {
			return nil, invalidChapter(id, "filename must begin with the stable chapter ID")
		}
		title := d.Metadata["title"]
		if d.Title != nil {
			title = *d.Title
		}
		if compat.Trim(title) == "" {
			return nil, invalidChapter(id, "a level-one Markdown title is required")
		}
		c := Chapter{StructureHash: d.Metadata["structureHash"], Path: d.Path, ID: id, Title: compat.Trim(title), VolumeID: d.Metadata["volumeId"], Meta: d.Metadata["meta"], Markdown: d.Body, SourceHash: d.SHA256, SourceRevisionID: "source:" + d.Blob}
		if title, ok := d.Metadata["volumeTitle"]; ok {
			c.VolumeTitle = pointer(title)
		} else if c.VolumeID == "" {
			c.VolumeTitle = pointer("")
		}
		if raw, ok := d.Metadata["order"]; ok {
			n, e := strconv.ParseFloat(raw, 64)
			if !digits.MatchString(raw) || e != nil || n < 1 || n > 9007199254740991 || math.Trunc(n) != n {
				return nil, invalidChapter(id, "order must be a positive integer")
			}
			order := int64(n)
			c.Order = &order
		}
		out = append(out, c)
	}
	return out, nil
}
func Unique(p harness.Projection, id string) (Chapter, error) {
	for _, c := range p.Collisions {
		if c.ID == id {
			return Chapter{}, duplicateChapter(id, c.Paths)
		}
	}
	all, e := Sources(p)
	if e != nil {
		return Chapter{}, e
	}
	for _, c := range all {
		if c.ID == id {
			return c, nil
		}
	}
	return Chapter{}, &Error{Status: 404, Code: "NOT_FOUND", Detail: fmt.Sprintf("Chapter %s was not found in the Harness.", id), Kind: "not_found"}
}
func (s *Service) Source(id string) (Chapter, error) {
	p, e := s.Projection()
	if e != nil {
		return Chapter{}, e
	}
	return Unique(p, id)
}

// chapterGroups is the directory's canonical volume and within-volume order.
// Volume order follows first appearance in the deterministic Harness projection.
func chapterGroups(all []Chapter) [][]Chapter {
	groups := [][]Chapter{}
	indices := map[string]int{}
	for _, c := range all {
		key := c.VolumeID
		if key == "" {
			key = "__no_volume_id__"
		}
		i, ok := indices[key]
		if !ok {
			i = len(groups)
			indices[key] = i
			groups = append(groups, []Chapter{})
		}
		groups[i] = append(groups[i], c)
	}
	for _, g := range groups {
		sort.SliceStable(g, func(i, j int) bool {
			a, b := int64(9007199254740991), int64(9007199254740991)
			if g[i].Order != nil {
				a = *g[i].Order
			}
			if g[j].Order != nil {
				b = *g[j].Order
			}
			if a != b {
				return a < b
			}
			an, _ := strconv.Atoi(g[i].ID[3:])
			bn, _ := strconv.Atoi(g[j].ID[3:])
			if an != bn {
				return an < bn
			}
			return harness.LocaleCompare(g[i].ID, g[j].ID) < 0
		})
	}
	return groups
}

// OrderedChapters flattens the exact chapter directory order for historical review.
func OrderedChapters(all []Chapter) []Chapter {
	ordered := []Chapter{}
	for _, group := range chapterGroups(all) {
		ordered = append(ordered, group...)
	}
	return ordered
}

func (s *Service) Chapters() (any, error) {
	if s.DirectoryProvider != nil {
		return s.DirectoryProvider()
	}
	p, e := s.Projection()
	if e != nil {
		return nil, e
	}
	for _, c := range p.Collisions {
		if chapterRE.MatchString(c.ID) {
			return nil, duplicateChapter(c.ID, c.Paths)
		}
	}
	all, e := Sources(p)
	if e != nil {
		return nil, e
	}
	volumes := []any{}
	for _, g := range chapterGroups(all) {
		items := []any{}
		for _, c := range g {
			m := map[string]any{"chapterId": c.ID, "title": c.Title, "wordCount": compat.Words(c.Markdown)}
			if c.Meta != "" {
				m["meta"] = c.Meta
			}
			if c.Order != nil {
				m["order"] = *c.Order
			}
			items = append(items, m)
		}
		v := map[string]any{"chapters": items}
		if g[0].VolumeID != "" {
			v["volumeId"] = g[0].VolumeID
		}
		volumes = append(volumes, v)
	}
	return map[string]any{"volumes": volumes}, nil
}

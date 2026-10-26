package application

import (
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"regexp"
	"strconv"
	"time"
)

func member(v any, values ...string) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	for _, x := range values {
		if s == x {
			return true
		}
	}
	return false
}
func workspaceInput(input any) (map[string]any, bool) {
	m, ok := input.(map[string]any)
	if !ok || m == nil {
		return nil, false
	}
	out := map[string]any{}
	for k, v := range m {
		switch k {
		case "resume":
			r, ok := v.(map[string]any)
			if !ok || len(r) < 8 || len(r) > 9 || !compat.Integer(r["schema"], 1, 1) || !member(r["view"], "inspire", "read", "book") {
				return nil, false
			}
			for name, value := range r {
				switch name {
				case "schema", "view":
				case "chapterId":
					text, ok := value.(string)
					if !ok || len(text) == 0 || len(text) > 128 {
						return nil, false
					}
				case "compose":
					if _, ok := value.(bool); !ok {
						return nil, false
					}
				case "scroll":
					if !compat.Integer(value, 0, 10000000) {
						return nil, false
					}
				case "from", "to":
					if !compat.Integer(value, 0, 5000000) {
						return nil, false
					}
				case "revisionId":
					text, ok := value.(string)
					if !ok || len(text) > 512 {
						return nil, false
					}
				case "updatedAt":
					text, ok := value.(string)
					if !ok {
						return nil, false
					}
					if _, err := time.Parse(time.RFC3339Nano, text); err != nil {
						return nil, false
					}
				default:
					return nil, false
				}
			}
			for _, name := range []string{"chapterId", "compose", "scroll", "from", "to", "updatedAt"} {
				if _, ok := r[name]; !ok {
					return nil, false
				}
			}
		case "lastView":
			if !member(v, "write", "kb", "reasoning") {
				return nil, false
			}
		case "theme":
			if !member(v, "light", "dark") {
				return nil, false
			}
		case "lastChapterId", "activeSessionId":
			if _, ok := v.(string); !ok {
				return nil, false
			}
		case "kbRecent":
			a, ok := v.([]any)
			if !ok || len(a) > 6 {
				return nil, false
			}
			for _, x := range a {
				if _, ok := x.(string); !ok {
					return nil, false
				}
			}
		case "currentBranchBySession":
			obj, ok := v.(map[string]any)
			if !ok || obj == nil {
				return nil, false
			}
			for _, x := range obj {
				if _, ok := x.(string); !ok {
					return nil, false
				}
			}
		case "layout":
			layout, ok := v.(map[string]any)
			if !ok || layout == nil {
				return nil, false
			}
			clean := map[string]any{}
			for field, val := range layout {
				switch field {
				case "leftOpen", "rightOpen", "focus":
					if _, ok := val.(bool); !ok {
						return nil, false
					}
				case "leftW":
					if !compat.Integer(val, 200, 360) {
						return nil, false
					}
				case "rightW":
					if !compat.Integer(val, 320, 560) {
						return nil, false
					}
				default:
					continue
				}
				clean[field] = val
			}
			v = clean
		default:
			continue
		}
		out[k] = v
	}
	return out, true
}

type RevisionInput struct {
	Base     *string
	Markdown string
}

func revisionInput(input any) (RevisionInput, bool) {
	m, ok := input.(map[string]any)
	if !ok {
		return RevisionInput{}, false
	}
	base, exists := m["baseRevisionId"]
	if !exists {
		return RevisionInput{}, false
	}
	var parent *string
	if base != nil {
		x, ok := base.(string)
		if !ok {
			return RevisionInput{}, false
		}
		parent = &x
	}
	markdown, ok := m["markdown"].(string)
	if !ok || compat.Length(markdown) > 2*1024*1024 {
		return RevisionInput{}, false
	}
	if v, ok := m["clientSavedAt"]; ok {
		d, ok := v.(string)
		if !ok || !compat.Date(d) {
			return RevisionInput{}, false
		}
	}
	if v, ok := m["trigger"]; ok && !member(v, "autosave", "manual", "chapter_switch", "pre_review") {
		return RevisionInput{}, false
	}
	return RevisionInput{parent, markdown}, true
}

type NoteInput struct {
	Content     string
	ChapterID   *string
	Purpose     string
	BaseVersion int64
	Status      string
	Update      bool
}

func noteInput(input any, update bool) (NoteInput, bool) {
	n := NoteInput{Purpose: "note", Status: "active", Update: update}
	m, ok := input.(map[string]any)
	if !ok {
		return n, false
	}
	for k := range m {
		if k != "content" && k != "chapterId" && k != "purpose" && (!update || (k != "baseVersion" && k != "status")) {
			return n, false
		}
	}
	content, ok := m["content"].(string)
	if !ok || compat.Length(content) < 1 || compat.Length(content) > 20000 || compat.Trim(content) == "" {
		return n, false
	}
	n.Content = content
	if v, exists := m["chapterId"]; exists && v != nil {
		str, ok := v.(string)
		if !ok || compat.Length(str) < 1 || compat.Length(str) > 200 {
			return n, false
		}
		n.ChapterID = &str
	}
	if v, exists := m["purpose"]; exists {
		if !member(v, "note", "next_writing") {
			return n, false
		}
		n.Purpose = v.(string)
	}
	if update {
		if !compat.Integer(m["baseVersion"], 1, 9007199254740991) || !member(m["status"], "active", "archived") {
			return n, false
		}
		f, _ := compat.Number(m["baseVersion"])
		n.BaseVersion = int64(f)
		n.Status = m["status"].(string)
	}
	return n, true
}
func (n NoteInput) Fingerprint(id *string) string {
	s := "[" + compat.NullableQuote(id) + `,{"content":` + compat.Quote(n.Content) + `,"chapterId":` + compat.NullableQuote(n.ChapterID) + `,"purpose":` + compat.Quote(n.Purpose)
	if n.Update {
		s += `,"baseVersion":` + strconv.FormatInt(n.BaseVersion, 10) + `,"status":` + compat.Quote(n.Status)
	}
	return s + "}]"
}

var safeKeyRE = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func SafeKey(key string) bool { return safeKeyRE.MatchString(key) }

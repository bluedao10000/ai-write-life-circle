package publication

import (
	"bytes"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"io"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"
)

var slugRE = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validSlug(s string) bool { return len(s) > 0 && len(s) <= 80 && slugRE.MatchString(s) }
func bounded(s string, max int, required bool) bool {
	n := compat.UTF16Len(s)
	return utf8.ValidString(s) && n <= max && (!required || strings.TrimSpace(s) != "")
}
func validateMetadata(m Metadata) error {
	if !validSlug(m.Slug) || !bounded(m.Title, 160, true) || !bounded(m.PenName, 100, true) || !bounded(m.AuthorBio, 2000, false) || !bounded(m.Tagline, 250, true) || !bounded(m.Description, 10000, true) || !bounded(m.Category, 80, true) || (m.SerialStatus != "ongoing" && m.SerialStatus != "completed" && m.SerialStatus != "paused") {
		return fail(422, "VALIDATION_FAILED", "Invalid public book metadata.")
	}
	if len(m.Categories) > 10 {
		return fail(422, "VALIDATION_FAILED", "Too many categories.")
	}
	seen := map[string]bool{}
	for _, c := range m.Categories {
		if !bounded(c, 80, true) || seen[c] {
			return fail(422, "VALIDATION_FAILED", "Invalid categories.")
		}
		seen[c] = true
	}
	if len(m.Categories) > 0 && !seen[m.Category] {
		return fail(422, "VALIDATION_FAILED", "Primary category must be selected.")
	}
	if m.Cover != nil {
		if !regexp.MustCompile(`^#[a-fA-F0-9]{6}$`).MatchString(m.Cover.BG) || !regexp.MustCompile(`^#[a-fA-F0-9]{6}$`).MatchString(m.Cover.FG) || !regexp.MustCompile(`^(rule|circle|wave|grid|none)$`).MatchString(m.Cover.Mark) {
			return fail(422, "VALIDATION_FAILED", "Invalid cover palette.")
		}
	}
	if m.CoverURL != "" {
		u, e := url.Parse(m.CoverURL)
		if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || len(m.CoverURL) > 2048 {
			return fail(422, "VALIDATION_FAILED", "Cover must be a public HTTPS URL.")
		}
	}
	return nil
}

// DecodeInput rejects unknown fields, null, trailing JSON and type mismatches.
func DecodeInput(data []byte, dst any) error {
	if strings.TrimSpace(string(data)) == "null" {
		return fail(422, "VALIDATION_FAILED", "A JSON object is required.")
	}
	if !utf8.Valid(data) || !requiredFields(data, reflect.TypeOf(dst).Elem()) {
		return fail(422, "VALIDATION_FAILED", "All contract fields are required with their declared types.")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fail(422, "VALIDATION_FAILED", "Request does not match the publication contract.")
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return fail(422, "VALIDATION_FAILED", "Exactly one JSON object is required.")
	}
	return nil
}

// encoding/json otherwise accepts null for strings/structs and omitted required
// fields. Enforce the same required/non-null shape as strict Zod/OpenAPI.
func requiredFields(data json.RawMessage, t reflect.Type) bool {
	if t.Kind() == reflect.Pointer {
		if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			return true
		}
		return requiredFields(data, t.Elem())
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return false
	}
	switch t.Kind() {
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil || fields == nil {
			return false
		}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name := strings.Split(f.Tag.Get("json"), ",")[0]
			v, ok := fields[name]
			if strings.Contains(f.Tag.Get("json"), ",omitempty") {
				if !ok {
					continue
				}
				if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
					return false
				}
			}
			if !ok || !requiredFields(v, f.Type) {
				return false
			}
		}
	case reflect.Slice:
		var items []json.RawMessage
		if json.Unmarshal(data, &items) != nil {
			return false
		}
		for _, v := range items {
			if !requiredFields(v, t.Elem()) {
				return false
			}
		}
	}
	return true
}

func validSelection(v Selection) bool {
	return regexp.MustCompile(`^CH-\d{1,6}$`).MatchString(v.ChapterID) && len(v.RevisionID) > 0 && len(v.RevisionID) <= 256 && regexp.MustCompile(`^sha256:[a-f0-9]{64}$`).MatchString(v.ContentHash) && compat.UTF16Len(v.VolumeID) <= 256 && v.ChapterOrder >= 0 && v.ChapterOrder <= 9007199254740991
}

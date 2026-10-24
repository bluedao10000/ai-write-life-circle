// Package compat makes JavaScript's string, hash and persistence conventions explicit.
package compat

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

func UUID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func Now() string               { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func Key(s string) string       { return base64.RawURLEncoding.EncodeToString(utf8Bytes(s)) }
func HashBytes(b []byte) string { h := sha256.Sum256(b); return "sha256:" + hex.EncodeToString(h[:]) }
func BlobBytes(b []byte) string {
	header := []byte(fmt.Sprintf("blob %d\x00", len(b)))
	h := sha1.New()
	h.Write(header)
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}
func Hash(s string) string {
	h := sha256.Sum256(utf8Bytes(s))
	return "sha256:" + hex.EncodeToString(h[:])
}
func Blob(s string) string {
	h := sha1.Sum([]byte(fmt.Sprintf("blob %d\x00%s", len(s), s)))
	return hex.EncodeToString(h[:])
}

// ES white space deliberately excludes U+0085 (which unicode.IsSpace includes).
func Space(r rune) bool {
	return r == '\t' || r == '\n' || r == '\v' || r == '\f' || r == '\r' || r == ' ' || r == 0xa0 || r == 0x1680 || (r >= 0x2000 && r <= 0x200a) || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func Trim(s string) string { return strings.TrimFunc(s, Space) }
func Words(s string) int {
	n := 0
	for _, r := range Runes(s) {
		if !Space(r) {
			n++
		}
	}
	return n
}
func UTF16Len(s string) int {
	n := 0
	for _, r := range Runes(s) {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

// Quote matches JSON.stringify for valid Unicode, including literal <>& and U+2028/2029.
func Quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range Runes(s) {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 32 || (r >= 0xd800 && r <= 0xdfff) {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
func NullableQuote(s *string) string {
	if s == nil {
		return "null"
	}
	return Quote(*s)
}
func Number(v any) (float64, bool) {
	var f float64
	switch n := v.(type) {
	case json.Number:
		parsed, e := strconv.ParseFloat(string(n), 64)
		if e != nil {
			return 0, false
		}
		f = parsed
	case float64:
		f = n
	case float32:
		f = float64(n)
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	case int32:
		f = float64(n)
	default:
		return 0, false
	}
	return f, !math.IsInf(f, 0) && !math.IsNaN(f)
}
func Integer(v any, low, high float64) bool {
	f, ok := Number(v)
	return ok && math.Trunc(f) == f && f >= low && f <= high
}
func String(v any) (string, bool) { s, ok := v.(string); return s, ok }

var dateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$`)

func Date(s string) bool {
	if !dateRE.MatchString(s) {
		return false
	}
	if !strings.HasSuffix(s, "Z") {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, s)
	return err == nil
}

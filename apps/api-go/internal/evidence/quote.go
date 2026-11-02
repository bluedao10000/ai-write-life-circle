// Package evidence locates model quotes in their original source text.
package evidence

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

type Match struct {
	Quote      string
	StartUTF16 int
	EndUTF16   int
	Status     string // unique, ambiguous, missing
}

// FindQuote prefers literal matches, then normalizes whitespace and punctuation.
// Repeated quotes retain the first location. Quote always contains the actual
// source slice, so its UTF-16 bounds can be used directly by the editor.
func FindQuote(text, quote string) Match {
	if strings.TrimSpace(quote) == "" {
		return Match{Status: "missing"}
	}
	at := strings.Index(text, quote)
	if at >= 0 {
		return located(text, at, at+len(quote), strings.Contains(text[at+1:], quote))
	}
	normal, spans := normalize(text)
	wanted, _ := normalize(strings.TrimSpace(quote))
	at = strings.Index(normal, wanted)
	if at < 0 {
		return Match{Status: "missing"}
	}
	return located(text, spans[at].start, spans[at+len(wanted)-1].end, strings.Contains(normal[at+1:], wanted))
}

func located(text string, start, end int, repeated bool) Match {
	status := "unique"
	if repeated {
		status = "ambiguous"
	}
	return Match{Quote: text[start:end], StartUTF16: compat.UTF16Len(text[:start]), EndUTF16: compat.UTF16Len(text[:end]), Status: status}
}

type span struct{ start, end int }

func normalize(text string) (string, []span) {
	var out strings.Builder
	spans := []span{}
	for i := 0; i < len(text); {
		start := i
		r, size := utf8.DecodeRuneInString(text[i:])
		i += size
		switch {
		case unicode.IsSpace(r):
			r = ' '
			for i < len(text) {
				next, n := utf8.DecodeRuneInString(text[i:])
				if !unicode.IsSpace(next) {
					break
				}
				i += n
			}
		case r == '…' || r == '⋯' || (r == '.' && strings.HasPrefix(text[start:], "...")):
			r = '…'
			for i < len(text) {
				next, n := utf8.DecodeRuneInString(text[i:])
				if next != '…' && next != '⋯' && next != '.' {
					break
				}
				i += n
			}
		default:
			switch r {
			case '“', '”', '「', '」', '『', '』', '＂':
				r = '"'
			case '‘', '’', '＇':
				r = '\''
			case '，':
				r = ','
			case '。':
				r = '.'
			case '！':
				r = '!'
			case '？':
				r = '?'
			case '：':
				r = ':'
			case '；':
				r = ';'
			case '（':
				r = '('
			case '）':
				r = ')'
			}
		}
		out.WriteRune(r)
		for range utf8.RuneLen(r) {
			spans = append(spans, span{start, i})
		}
	}
	return out.String(), spans
}

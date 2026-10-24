package compat

// encoding/json replaces lone UTF-16 surrogates with U+FFFD. JavaScript preserves
// them in JSON and only replaces them when encoding UTF-8 for hashing. Keep their
// WTF-8 representation internally and escape them again at the JSON boundary.
// A per-call private marker is removed before any data reaches disk or the wire.
import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

func runeAt(s string) (rune, int) {
	if len(s) >= 3 && s[0] == 0xed && s[1] >= 0xa0 && s[1] <= 0xbf && s[2] >= 0x80 && s[2] <= 0xbf {
		return rune(s[0]&15)<<12 | rune(s[1]&63)<<6 | rune(s[2]&63), 3
	}
	return utf8.DecodeRuneInString(s)
}
func Runes(s string) []rune {
	out := []rune{}
	for len(s) > 0 {
		r, n := runeAt(s)
		out = append(out, r)
		s = s[n:]
	}
	return out
}
func Length(s string) int { return len(Runes(s)) }
func utf8Bytes(s string) []byte {
	var b strings.Builder
	for _, r := range Runes(s) {
		if r >= 0xd800 && r <= 0xdfff {
			r = utf8.RuneError
		}
		b.WriteRune(r)
	}
	return []byte(b.String())
}
func surrogateBytes(r uint64) string {
	return string([]byte{0xe0 | byte(r>>12), 0x80 | byte((r>>6)&63), 0x80 | byte(r&63)})
}
func markedString(s, marker string) string {
	var b strings.Builder
	for len(s) > 0 {
		r, n := runeAt(s)
		if r >= 0xd800 && r <= 0xdfff {
			fmt.Fprintf(&b, "%s%04xEND", marker, r)
		} else {
			b.WriteString(s[:n])
		}
		s = s[n:]
	}
	return b.String()
}
func unmarkString(s, marker string) string {
	for {
		start := strings.Index(s, marker)
		if start < 0 {
			return s
		}
		end := start + len(marker) + 7
		if end > len(s) || s[end-3:end] != "END" {
			return s
		}
		r, e := strconv.ParseUint(s[start+len(marker):end-3], 16, 16)
		if e != nil {
			return s
		}
		s = s[:start] + surrogateBytes(r) + s[end:]
	}
}
func restore(v reflect.Value, marker string) {
	if !v.IsValid() {
		return
	}
	switch v.Kind() {
	case reflect.Pointer:
		if !v.IsNil() {
			restore(v.Elem(), marker)
		}
	case reflect.Interface:
		if !v.IsNil() {
			copy := reflect.New(v.Elem().Type()).Elem()
			copy.Set(v.Elem())
			restore(copy, marker)
			if v.CanSet() {
				v.Set(copy)
			}
		}
	case reflect.String:
		if v.CanSet() {
			v.SetString(unmarkString(v.String(), marker))
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Field(i).CanSet() {
				restore(v.Field(i), marker)
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < v.Len(); i++ {
			restore(v.Index(i), marker)
		}
	case reflect.Map:
		for _, key := range v.MapKeys() {
			value := reflect.New(v.Type().Elem()).Elem()
			value.Set(v.MapIndex(key))
			restore(value, marker)
			newKey := reflect.New(key.Type()).Elem()
			newKey.Set(key)
			restore(newKey, marker)
			v.SetMapIndex(key, reflect.Value{})
			v.SetMapIndex(newKey, value)
		}
	}
}
func Decode(data []byte, v any) error {
	if !json.Valid(data) {
		return errors.New("invalid JSON document")
	}
	marker := "__writer_surrogate_" + UUID() + "_"
	var b bytes.Buffer
	inString := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		if c == '"' {
			inString = !inString
		}
		if inString && c == '\\' && i+1 < len(data) {
			if data[i+1] == 'u' && i+5 < len(data) {
				r, e := strconv.ParseUint(string(data[i+2:i+6]), 16, 16)
				if e == nil && r >= 0xd800 && r <= 0xdfff {
					paired := false
					if r <= 0xdbff && i+11 < len(data) && string(data[i+6:i+8]) == `\u` {
						low, e := strconv.ParseUint(string(data[i+8:i+12]), 16, 16)
						paired = e == nil && low >= 0xdc00 && low <= 0xdfff
					}
					if paired {
						b.Write(data[i : i+12])
						i += 11
						continue
					}
					fmt.Fprintf(&b, "%s%04xEND", marker, r)
					i += 5
					continue
				}
			}
			b.WriteByte(c)
			i++
			b.WriteByte(data[i])
			continue
		}
		b.WriteByte(c)
	}
	d := json.NewDecoder(&b)
	d.UseNumber()
	if e := d.Decode(v); e != nil {
		return e
	}
	restore(reflect.ValueOf(v), marker)
	return nil
}
func prepare(v reflect.Value, marker string) any {
	if !v.IsValid() {
		return nil
	}
	if v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil
		}
		return prepare(v.Elem(), marker)
	}
	if v.Type() == reflect.TypeFor[json.Number]() {
		return v.Interface()
	}
	switch v.Kind() {
	case reflect.String:
		return markedString(v.String(), marker)
	case reflect.Struct:
		out := map[string]any{}
		for i := 0; i < v.NumField(); i++ {
			field := v.Type().Field(i)
			if field.PkgPath != "" {
				continue
			}
			tag := field.Tag.Get("json")
			if tag == "-" {
				continue
			}
			parts := strings.Split(tag, ",")
			if len(parts) > 1 && parts[1] == "omitempty" && empty(v.Field(i)) {
				continue
			}
			name := parts[0]
			if name == "" && field.Anonymous {
				if embedded, ok := prepare(v.Field(i), marker).(map[string]any); ok {
					for k, x := range embedded {
						out[k] = x
					}
				}
				continue
			}
			if name == "" {
				name = field.Name
			}
			out[name] = prepare(v.Field(i), marker)
		}
		return out
	case reflect.Map:
		if v.IsNil() {
			return nil
		}
		out := map[string]any{}
		for _, key := range v.MapKeys() {
			out[markedString(key.String(), marker)] = prepare(v.MapIndex(key), marker)
		}
		return out
	case reflect.Slice:
		if v.IsNil() {
			return nil
		}
		fallthrough
	case reflect.Array:
		out := make([]any, v.Len())
		for i := range out {
			out[i] = prepare(v.Index(i), marker)
		}
		return out
	default:
		return v.Interface()
	}
}
func empty(v reflect.Value) bool {
	switch v.Kind() {
	case reflect.Array, reflect.Map, reflect.Slice, reflect.String:
		return v.Len() == 0
	default:
		return v.IsZero()
	}
}
func Marshal(v any, indent bool) ([]byte, error) {
	marker := "__writer_surrogate_" + UUID() + "_"
	value := prepare(reflect.ValueOf(v), marker)
	var b []byte
	var e error
	if indent {
		b, e = json.MarshalIndent(value, "", "  ")
	} else {
		b, e = json.Marshal(value)
	}
	if e != nil {
		return nil, e
	}
	s := string(b)
	for {
		start := strings.Index(s, marker)
		if start < 0 {
			break
		}
		end := start + len(marker) + 7
		if end > len(s) || s[end-3:end] != "END" {
			return nil, fmt.Errorf("invalid surrogate marker")
		}
		s = s[:start] + `\u` + s[start+len(marker):end-3] + s[end:]
	}
	return []byte(s), nil
}

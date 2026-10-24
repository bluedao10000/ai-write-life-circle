package compat

import (
	"os"
	"reflect"
	"testing"
)

func TestNodeStringGolden(t *testing.T) {
	b, e := os.ReadFile("../testdata/node-golden.json")
	if e != nil {
		t.Fatal(e)
	}
	var data struct {
		Cases []struct {
			Input  string `json:"input"`
			Key    string `json:"key"`
			Length int    `json:"utf16Length"`
			Words  int    `json:"words"`
			Hash   string `json:"hash"`
			Quote  string `json:"quote"`
		} `json:"cases"`
	}
	if e = Decode(b, &data); e != nil {
		t.Fatal(e)
	}
	for i, c := range data.Cases {
		t.Run(string(rune('A'+i)), func(t *testing.T) {
			if Key(c.Input) != c.Key || UTF16Len(c.Input) != c.Length || Words(c.Input) != c.Words || Hash(c.Input) != c.Hash || Quote(c.Input) != c.Quote {
				t.Fatalf("Node string mismatch: length %d/%d words %d/%d hash %s/%s quote %q/%q", UTF16Len(c.Input), c.Length, Words(c.Input), c.Words, Hash(c.Input), c.Hash, Quote(c.Input), c.Quote)
			}
		})
	}
}

func TestJSONSurrogatesAndMissingNullRoundTrip(t *testing.T) {
	data := []byte(`{"content":"\ud800x\udc00","literal":"\\ud800","nil":null,"empty":[],"map":{"\ud800":"😀"}}`)
	var value map[string]any
	if e := Decode(data, &value); e != nil {
		t.Fatal(e)
	}
	encoded, e := Marshal(value, false)
	if e != nil {
		t.Fatal(e)
	}
	var restored map[string]any
	if e = Decode(encoded, &restored); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(value, restored) {
		t.Fatalf("JSON changed: %s", encoded)
	}
	if _, ok := restored["missing"]; ok {
		t.Fatal("invented a missing field")
	}
	if restored["nil"] != nil {
		t.Fatal("null was dropped")
	}
	if e = Decode([]byte(`{} garbage`), &value); e == nil {
		t.Fatal("trailing bytes accepted")
	}
}

package harness

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestNodeHarnessGolden(t *testing.T) {
	b, e := os.ReadFile("../testdata/node-golden.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixture struct {
		Files       map[string]string `json:"files"`
		BinaryFiles map[string]string `json:"binaryFiles"`
		Projection  any               `json:"projection"`
	}
	if e = json.Unmarshal(b, &fixture); e != nil {
		t.Fatal(e)
	}
	root := t.TempDir()
	for name, content := range fixture.Files {
		path := filepath.Join(root, name)
		if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(path, []byte(content), 0600); e != nil {
			t.Fatal(e)
		}
	}
	for name, data := range fixture.BinaryFiles {
		b, e := base64.StdEncoding.DecodeString(data)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(root, name), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	outside := t.TempDir()
	if e = os.WriteFile(filepath.Join(outside, "CH-009.md"), []byte("# Outside\nID: CH-009\n\nDo not read."), 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(outside, filepath.Join(root, "manuscript", "linked")); e != nil {
		t.Fatal(e)
	}
	p, e := Load(root, "golden")
	if e != nil {
		t.Fatal(e)
	}
	actualBytes, _ := json.Marshal(p)
	var actual any
	_ = json.Unmarshal(actualBytes, &actual)
	if !reflect.DeepEqual(actual, fixture.Projection) {
		t.Fatalf("Node parser mismatch\nactual: %s\nexpected: %+v", actualBytes, fixture.Projection)
	}
}

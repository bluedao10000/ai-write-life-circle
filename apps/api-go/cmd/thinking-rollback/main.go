package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/thinking"
)

// thinking-rollback prepares a new registry; it never overwrites author state.
// The operator must stop both services and install verified outputs explicitly.
func main() {
	if len(os.Args) != 4 {
		fatal("usage: thinking-rollback <source-registry> <output-registry> --compatible-go|--legacy-go")
	}
	source, output, mode := os.Args[1], os.Args[2], os.Args[3]
	if source == output {
		fatal("source and output must be different")
	}
	if mode != "--compatible-go" && mode != "--legacy-go" {
		fatal("mode must be --compatible-go or --legacy-go")
	}
	info, e := os.Lstat(source)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		fatal("source registry must be a private regular file")
	}
	if _, e = os.Lstat(output); !os.IsNotExist(e) {
		fatal("output registry must not exist")
	}
	data, e := os.ReadFile(source)
	if e != nil {
		fatal(e.Error())
	}
	converted, e := thinking.RollbackRegistry(data, mode == "--compatible-go")
	if e != nil {
		fatal(e.Error())
	}
	parent := filepath.Dir(output)
	if e = os.MkdirAll(parent, 0700); e != nil {
		fatal(e.Error())
	}
	file, e := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		fatal(e.Error())
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(output)
		}
	}()
	if _, e = file.Write(append(converted, '\n')); e != nil {
		fatal(e.Error())
	}
	if e = file.Sync(); e != nil {
		fatal(e.Error())
	}
	if e = file.Close(); e != nil {
		fatal(e.Error())
	}
	ok = true
	fmt.Printf("prepared %s with %s; source was not modified\n", output, mode)
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}

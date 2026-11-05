package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
)

func TestMemoryRollbackValidationLeavesBothRegistriesUntouched(t *testing.T) {
	for _, invalid := range []string{"tasks", "sessions"} {
		t.Run(invalid, func(t *testing.T) {
			dir := t.TempDir()
			controller := executorpolicy.Controller{State: dir}
			if err := controller.Drain(context.Background(), "memory"); err != nil {
				t.Fatal(err)
			}
			if err := controller.Switch(context.Background(), "memory", "disabled"); err != nil {
				t.Fatal(err)
			}
			tasks := `{"schema":1,"tasks":{"memory":{"task":{"kind":"memory.consolidate"},"finished":true}}}`
			sessions := `{"schema":1,"sessions":{"current":{"memoryExtraction":{"version":3}}},"requests":{}}`
			if invalid == "tasks" {
				tasks = `{"schema":1,"tasks":{"memory":{"task":{"kind":"memory.consolidate"},"finished":false}}}`
			} else {
				sessions = `{"schema":1,"sessions":{"current":{"memoryExtraction":{"version":3},"billOp":"open"}},"requests":{}}`
			}
			paths := map[string]string{filepath.Join(dir, "agent-runtime", "tasks-v1.json"): tasks, filepath.Join(dir, "thinking", "sessions-v1.json"): sessions}
			for path, value := range paths {
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(value), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := rollbackMemoryState(dir); err == nil {
				t.Fatal("unsafe rollback accepted")
			}
			for path, value := range paths {
				got, err := os.ReadFile(path)
				if err != nil || string(got) != value {
					t.Fatal("rollback changed state after validation failure", path, err)
				}
			}
		})
	}
}

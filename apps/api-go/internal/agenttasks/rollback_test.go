package agenttasks

import (
	"bytes"
	"strings"
	"testing"
)

func TestRollbackMemoryTasksRemovesOnlyTerminalConsolidation(t *testing.T) {
	input := []byte(`{"schema":1,"cursor":2,"tasks":{"memory":{"task":{"taskId":"memory","kind":"memory.consolidate"},"finished":true,"memory":{}},"review":{"task":{"taskId":"review","kind":"review.execute"},"finished":true,"review":{}}}}`)
	output, err := RollbackMemoryTasks(input)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(output, []byte(`"memory.consolidate"`)) || !bytes.Contains(output, []byte(`"review.execute"`)) {
		t.Fatal(string(output))
	}
	open := []byte(`{"schema":1,"tasks":{"memory":{"task":{"taskId":"memory","kind":"memory.consolidate"},"finished":false,"memory":{}}}}`)
	if _, err = RollbackMemoryTasks(open); err == nil || !strings.Contains(err.Error(), "still open") {
		t.Fatal("open consolidation was removed", err)
	}
}

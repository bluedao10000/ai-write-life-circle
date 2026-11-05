package agenttasks

import (
	"encoding/json"
	"fmt"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

// RollbackMemoryTasks prepares an offline task registry for a build that does
// not understand memory.consolidate. The executor must already be disabled and
// drained; only terminal task records are removed.
func RollbackMemoryTasks(data []byte) ([]byte, error) {
	var root map[string]any
	if err := compat.Decode(data, &root); err != nil {
		return nil, fmt.Errorf("task registry is not valid JSON: %w", err)
	}
	if number(root["schema"]) != 1 {
		return nil, fmt.Errorf("task registry requires schema=1")
	}
	rawTasks, ok := root["tasks"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("task registry requires tasks")
	}
	for id, raw := range rawTasks {
		record, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("task %s is invalid", id)
		}
		task, ok := record["task"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("task %s identity is invalid", id)
		}
		if stringValue(task["kind"]) != "memory.consolidate" {
			continue
		}
		if record["finished"] != true {
			return nil, fmt.Errorf("memory task %s is still open; disable and drain before rollback", id)
		}
		delete(rawTasks, id)
	}
	out, err := compat.Marshal(root, true)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func number(value any) int {
	switch value := value.(type) {
	case float64:
		return int(value)
	case json.Number:
		n, _ := value.Int64()
		return int(n)
	case int:
		return value
	default:
		return 0
	}
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

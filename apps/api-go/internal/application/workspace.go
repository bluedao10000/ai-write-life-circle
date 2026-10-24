package application

import (
	"context"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"path/filepath"
)

func (s *Service) workspacePath(actor string) string {
	return filepath.Join(s.State, "workspace", compat.Key(s.Project), compat.Key(actor)+".json")
}
func (s *Service) loadWorkspace(actor string) (map[string]any, error) {
	var value any
	found, e := storage.Read(s.workspacePath(actor), &value)
	if e != nil {
		return nil, e
	}
	if !found {
		return map[string]any{"lastView": "write", "theme": "light", "kbRecent": []any{}}, nil
	}
	out, ok := workspaceInput(value)
	if !ok {
		return nil, Fail(500, "HARNESS_WRITE_FAILED", "The request could not be completed. No Harness file was written.")
	}
	return out, nil
}
func (s *Service) Workspace(actor string) (any, error) {
	if _, e := s.Projection(); e != nil {
		return nil, e
	}
	state, e := s.loadWorkspace(actor)
	if e != nil {
		return nil, e
	}
	capabilities := map[string]bool{"notes": true, "agentRuntime": true, "knowledge": false, "annotations": false, "canonChanges": false}
	if s.ReviewsEnabled {
		capabilities["evidenceReview"] = true
		capabilities["annotations"] = true
	}
	project := map[string]any{"projectId": s.Project}
	if s.ProjectTitle != nil {
		title, e := s.ProjectTitle()
		if e != nil {
			return nil, e
		}
		project["title"] = title
	}
	return map[string]any{"project": project, "userState": state, "counts": map[string]any{}, "runningTasks": []any{}, "capabilities": capabilities}, nil
}
func (s *Service) PatchWorkspace(ctx context.Context, actor Actor, input any) (any, error) {
	if actor.Role != "author" {
		code := "AUTHOR_DECISION_REQUIRED"
		if actor.Role == "agent" {
			code = "AGENT_WRITE_FORBIDDEN"
		}
		return nil, Fail(403, code, "The authenticated actor is not allowed to perform this operation.")
	}
	patch, ok := workspaceInput(input)
	if !ok {
		return nil, Fail(422, "VALIDATION_FAILED", "The workspace state does not match the V0.4 contract.")
	}
	path := s.workspacePath(actor.ID)
	var saved any
	e := s.StateLock(ctx, path+".lock", func() error {
		current, e := s.loadWorkspace(actor.ID)
		if e != nil {
			return e
		}
		layout := map[string]any{"leftOpen": false, "rightOpen": false, "leftW": 280, "rightW": 400, "focus": false}
		if next, ok := patch["layout"].(map[string]any); ok {
			if prior, ok := current["layout"].(map[string]any); ok {
				for k, v := range prior {
					layout[k] = v
				}
			}
			for k, v := range next {
				layout[k] = v
			}
			patch["layout"] = layout
		}
		for k, v := range patch {
			current[k] = v
		}
		if e = s.writeState(ctx, path, current); e != nil {
			return e
		}
		saved = current
		return nil
	})
	return saved, e
}

package main

import (
	"encoding/json"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/harness"
	"os"
)

func main() {
	project := os.Getenv("WRITER_AGENT_PROJECT_ID")
	if project == "" {
		project = "local"
	}
	p, e := harness.Load(config.Root(), project)
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
	e = json.NewEncoder(os.Stdout).Encode(map[string]any{"projectId": p.ProjectID, "markdownDocuments": len(p.Knowledge) + len(p.Proposals) + len(p.Chapters) + len(p.Other), "knowledgeDocuments": len(p.Knowledge), "proposalDocuments": len(p.Proposals), "chapterDocuments": len(p.Chapters), "unmappedChapterPaths": p.Unmapped, "idCollisions": p.Collisions})
	if e != nil {
		os.Exit(1)
	}
}

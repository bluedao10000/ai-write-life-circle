// Package main runs the independent Agent Worker. It owns the only process
// credential and executes durable review and knowledge jobs.
package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
)

func run() error {
	check := flag.Bool("check-config", false, "validate configuration without starting tasks")
	version := flag.Bool("version", false, "print compatible runtime protocol")
	health := flag.Bool("healthcheck", false, "check local worker heartbeat")
	taskProtocol := flag.Bool("task-protocol", false, "print fenced external-task protocol")
	flag.Parse()
	if *taskProtocol {
		fmt.Println(executorpolicy.Protocol)
		return nil
	}
	if *version {
		fmt.Println(agentruntime.Protocol)
		return nil
	}
	c, e := config.LoadWorker()
	if e != nil {
		return e
	}
	modelConfig, e := llm.Load()
	if e != nil {
		return e
	}
	client, e := llm.New(modelConfig)
	if e != nil {
		return e
	}
	if *health {
		status := agentruntime.ReadStatus(c.State, modelConfig)
		if !status.Online || !status.Compatible {
			return fmt.Errorf("worker offline or incompatible")
		}
		return nil
	}
	if e = os.MkdirAll(c.State, 0700); e != nil {
		return e
	}
	if info, err := os.Stat(c.State); err != nil || !info.IsDir() {
		return fmt.Errorf("invalid worker state directory")
	}
	probe, err := os.CreateTemp(c.State, ".worker-check-")
	if err != nil {
		return fmt.Errorf("worker state is not writable")
	}
	probe.Close()
	os.Remove(probe.Name())
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	s := &application.Service{Root: c.Root, State: c.State, Project: c.Project}
	ownerID := c.AuthorID
	if ownerID == "" && c.AuthMode == "local" && c.Environment != "production" {
		ownerID = "local-author"
	}
	// ownerID only owns the read-only Harness book and pre-identity data; every
	// managed book carries its own owner, and jobs run as that owner.
	management := application.NewManagement(s, ownerID)
	if _, e = management.OwnedBooks(); e != nil {
		return fmt.Errorf("invalid work registry")
	}
	if *check {
		fmt.Println("worker configuration valid")
		return nil
	}
	discover := review.BookDiscoverer{Management: management}
	resolve := func(bookID string) (*application.Service, error) {
		app, _, e := management.ResolveOwned(bookID)
		if e != nil {
			return nil, e
		}
		app.ReviewsEnabled = true
		return app, nil
	}
	memoryFor := func(app *application.Service) func(context.Context, string) ([]string, error) {
		return knowledge.New(app, modelConfig, nil).RelatedChapters
	}
	runtime := agentruntime.New("writer-agent-worker/"+agentruntime.Revision(), discover, []agentruntime.Executor{
		&review.Executor{Config: modelConfig, Client: client, Resolve: resolve, Memory: memoryFor},
		&knowledge.Executor{Config: modelConfig, Client: client, Resolve: resolve},
		&creative.Executor{Config: modelConfig, Client: client, Resolve: resolve},
	}, 2, slog.Default())
	runtime.Model = modelConfig
	runtime.Instance = compat.UUID()
	runtime.Report = func(status agentruntime.Status) error {
		return agentruntime.WriteStatus(context.Background(), c.State, status)
	}
	if e = runtime.Run(ctx); e != nil {
		return e
	}
	fmt.Println("writer agent worker exited")
	return nil
}

func main() {
	if e := run(); e != nil {
		slog.Error("agent worker stopped", "error", e)
		os.Exit(1)
	}
}

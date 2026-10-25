package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agentruntime"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/agenttasks"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/identity"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/thinking"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func run() error {
	version := flag.Bool("version", false, "print compatible runtime protocol")
	health := flag.Bool("healthcheck", false, "probe the loopback health endpoint and exit")
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
	if *health {
		port := os.Getenv("WRITER_AGENT_API_PORT")
		if port == "" {
			port = "8787"
		}
		client := http.Client{Timeout: 3 * time.Second}
		host := os.Getenv("WRITER_AGENT_API_HOST")
		if host == "" {
			host = "127.0.0.1"
		}
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return fmt.Errorf("health probe requires loopback")
		}
		res, e := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
		if e != nil {
			return e
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return fmt.Errorf("health probe returned %d", res.StatusCode)
		}
		return nil
	}
	c, e := config.Load()
	if e != nil {
		return e
	}
	s := &application.Service{Root: c.Root, State: c.State, Project: c.Project}
	resolver, e := identity.New(c)
	if e != nil {
		return e
	}
	// The business API holds model capability metadata, but never the provider
	// credential. Execution belongs to the independent Agent Worker process.
	modelConfig, modelErr := llm.LoadPublic()
	s.ReviewsEnabled = modelErr == nil
	startup, cancelStartup := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelStartup()
	reviews := review.New(s, modelConfig, nil)
	reviews.DisableLocalExecution = true
	defer reviews.Close()
	ownerID := c.AuthorID
	if ownerID == "" && c.AuthMode == "local" && c.Environment != "production" {
		ownerID = "local-author"
	}
	publications := publication.New(c.State, map[string]publication.Book{c.Project: {App: s, OwnerID: ownerID}})
	management := application.NewManagement(s, ownerID)
	imports := application.NewImportService(management)
	knowledgeFor := func(app *application.Service) *knowledge.Service {
		k := knowledge.New(app, modelConfig, nil)
		k.QueueOnly = true
		return k
	}
	memory := knowledgeFor(s)
	reviews.MemoryChapters = memory.RelatedChapters
	publications.ResolveBook = func(actor application.Actor, id string) (publication.Book, error) {
		app, e := management.Resolve(actor, id)
		return publication.Book{App: app, OwnerID: actor.ID}, e
	}
	management.GuardDelete = publications.CheckDelete
	tasks := &agenttasks.Service{Management: management, State: c.State, Config: modelConfig}
	thought := &thinking.Service{Management: management, State: c.State, ResolveActor: resolver}
	privateAddress, piErr := thought.Configure()
	if piErr != nil {
		slog.Warn("Thinking disabled: invalid private configuration")
		thought.Origin = ""
		privateAddress = ""
	}
	creativeFor := func(app *application.Service) *creative.Service { return creative.New(app, modelConfig, nil) }
	// Organizing is an outbox written after Pi durably accepted the message; a
	// failure here never fails the conversation.
	// Returning an error keeps the message in the session's durable intake
	// outbox for RetryIntake; permanent rejections are logged and dropped.
	thought.OnMessageAccepted = func(ctx context.Context, rec thinking.Record, messageID string) error {
		app, e := management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
		if e == nil {
			_, e = creativeFor(app).AcceptTurn(ctx, rec.ID, messageID, "auto")
		}
		if e == nil {
			return nil
		}
		p := application.AsError(e)
		if ctx.Err() == nil && p.Status >= 400 && p.Status < 500 && p.Status != 408 && p.Status != 409 && p.Status != 423 {
			slog.Warn("creative turn rejected", "code", p.Code)
			return nil
		}
		slog.Warn("creative turn deferred", "code", p.Code)
		return e
	}
	thought.OnSessionDeleted = func(ctx context.Context, rec thinking.Record) {
		if app, e := management.Resolve(application.Actor{ID: rec.Owner, Role: "author"}, rec.Book); e == nil {
			if e = creativeFor(app).CancelSession(ctx, rec.ID); e != nil {
				slog.Warn("creative session cleanup deferred")
			}
		}
	}
	reconciler := &creative.Reconciler{Management: management, For: creativeFor, Fetch: func(ctx context.Context, id string) (*creative.Snapshot, bool, error) {
		raw, found, e := thought.Snapshot(ctx, id)
		if e != nil || !found {
			return nil, found, e
		}
		var snap creative.Snapshot
		if e = json.Unmarshal(raw, &snap); e != nil {
			return nil, true, e
		}
		return &snap, true, nil
	}}
	management.CleanupExternal = func(ctx context.Context, a application.Actor, book string) error {
		return cleanupOwnedBook(ctx, a, book, publications, thought, tasks)
	}
	if _, e := management.ResumeDeletionCleanup(startup); e != nil {
		slog.Warn("deferred book deletion cleanup did not finish", "error", e)
	}
	var reviewMu sync.Mutex
	var reviewsClosed bool
	reviewServices := map[string]*review.Service{c.Project: reviews}
	defer func() {
		reviewMu.Lock()
		reviewsClosed = true
		closing := make([]*review.Service, 0, len(reviewServices))
		for id, r := range reviewServices {
			if id != c.Project {
				closing = append(closing, r)
			}
		}
		reviewMu.Unlock()
		for _, r := range closing {
			r.Close()
		}
	}()
	reviewFor := func(app *application.Service) *review.Service {
		reviewMu.Lock()
		defer reviewMu.Unlock()
		if reviewsClosed {
			return nil
		}
		if r := reviewServices[app.Project]; r != nil {
			return r
		}
		r := review.New(app, modelConfig, nil)
		r.DisableLocalExecution = true
		r.MemoryChapters = knowledge.New(app, modelConfig, nil).RelatedChapters
		reviewServices[app.Project] = r
		return r
	}
	h := transport.Handler(transport.Options{CreativeFor: creativeFor, SessionOwned: thought.Owned, WorkerStatus: func() any { return agentruntime.ReadUnifiedStatus(c.State, modelConfig) }, KnowledgeFor: func(app *application.Service) *knowledge.Service { return knowledgeFor(app) }, Imports: imports, Management: management, ReviewFor: reviewFor, Service: s, Environment: c.Environment, ResolveActor: resolver, Reviews: reviews, Publications: publications})
	baseHandler := h
	thinkingHandler := thought.PublicHandler()
	perUser := c.IdentityPublicKey != ""
	h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if perUser {
			// The login Worker refuses any API that does not separate users.
			w.Header().Set(identity.ModeHeader, identity.Mode)
		}
		if thinking.IsPublicPath(r.URL.Path) {
			thinkingHandler.ServeHTTP(w, r)
		} else {
			baseHandler.ServeHTTP(w, r)
		}
	})
	taskServer, taskErr := tasks.Listen()
	if taskErr != nil {
		slog.Warn("Task listener disabled: invalid private configuration")
	}
	if taskServer != nil {
		defer taskServer.Close()
	}
	var private *http.Server
	if privateAddress != "" {
		l, err := net.Listen("tcp", privateAddress)
		if err != nil {
			slog.Warn("Thinking private listener unavailable")
			thought.Origin = ""
		} else {
			private = &http.Server{Handler: thought.PrivateHandler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
			go func() {
				if err := private.Serve(l); err != nil && err != http.ErrServerClosed {
					slog.Warn("Thinking private listener stopped")
				}
			}()
			defer private.Close()
		}
	}
	// Request-level deadlines in transport keep normal APIs at 30 seconds and
	// give multipart EPUB import its bounded 120-second window. Server-level
	// safety limits remain wider because ReadTimeout starts before body reads.
	server := &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 130 * time.Second, WriteTimeout: 130 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	listener, e := net.Listen("tcp", net.JoinHostPort(c.Host, c.Port))
	if e != nil {
		return e
	}
	fmt.Printf("Writer Agent API listening on http://%s\nHarness root: %s\n", listener.Addr().String(), c.Root)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				clean, cancel := context.WithTimeout(ctx, 4*time.Second)
				thought.Cleanup(clean)
				cancel()
				if taskServer != nil {
					clean, stop := context.WithTimeout(ctx, 4*time.Second)
					_ = tasks.Sweep(clean)
					stop()
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sweep, cancel := context.WithTimeout(ctx, 10*time.Second)
				thought.RetryIntake(sweep, 20)
				_ = reconciler.Sweep(sweep)
				cancel()
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case e = <-done:
		if e == http.ErrServerClosed {
			return nil
		}
		return e
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e = server.Shutdown(shutdown); e != nil {
			_ = server.Close()
			return e
		}
		e = <-done
		if e == http.ErrServerClosed {
			return nil
		}
		return e
	}
}
func main() {
	if e := run(); e != nil {
		slog.Error("API stopped", "error", e)
		os.Exit(1)
	}
}

// Publication removal must not depend on the availability of private agent state.
// Attempt both idempotent cleanups; managed deletion retains its durable retry
// marker until both finish, while the deleted book is already unresolvable.
func cleanupOwnedBook(ctx context.Context, a application.Actor, book string, p *publication.Service, t *thinking.Service, taskServices ...*agenttasks.Service) error {
	publicationErr := p.DeleteOwned(ctx, a, book)
	thinkingErr := t.CleanupBook(ctx, a, book)
	errs := []error{publicationErr, thinkingErr}
	for _, service := range taskServices {
		errs = append(errs, service.CleanupBook(ctx, book))
	}
	return errors.Join(errs...)
}

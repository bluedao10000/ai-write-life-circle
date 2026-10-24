package agenttasks

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/knowledge"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/review"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func reply(w http.ResponseWriter, v any, e error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if e != nil {
		status, code := 500, "TASK_STORAGE_FAILED"
		var a *application.Error
		if errors.As(e, &a) {
			status, code = a.Status, a.Code
		}
		if errors.Is(e, executorpolicy.ErrFenced) {
			status, code = 409, "EXECUTOR_FENCED"
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "status": status})
		return
	}
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil || d.Decode(new(any)) != io.EOF {
		return application.Fail(422, "VALIDATION_FAILED", "Invalid task protocol payload.")
	}
	return nil
}
func (s *Service) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(s.Token) < 32 || subtle.ConstantTimeCompare([]byte(supplied), []byte(s.Token)) != 1 {
			reply(w, nil, application.Fail(401, "UNAUTHORIZED", "Worker service credential required."))
			return
		}
		if r.Method == "GET" && r.URL.Path == "/internal/v1/agent/tasks/capabilities" {
			reply(w, map[string]any{"protocol": Protocol, "configFingerprint": s.Config.Fingerprint(), "model": s.Config.Info(), "contracts": executionContracts()}, nil)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/internal/v1/agent/tasks/status" {
			reply(w, s.WorkerStatus(), nil)
			return
		}
		if r.Method != "POST" {
			reply(w, nil, application.Fail(404, "NOT_FOUND", "Unknown task route."))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if r.URL.Path == "/internal/v1/agent/tasks/worker-heartbeat" {
			var in WorkerHeartbeat
			if e := decode(w, r, &in); e != nil {
				reply(w, nil, e)
				return
			}
			e := s.ReportWorker(ctx, in)
			reply(w, map[string]any{"acknowledged": e == nil}, e)
			return
		}
		if r.URL.Path == "/internal/v1/agent/tasks/claim" {
			var in struct {
				Instance  string            `json:"instance"`
				Config    string            `json:"configFingerprint"`
				Kinds     []string          `json:"kinds,omitempty"`
				Contracts map[string]string `json:"contracts"`
			}
			if e := decode(w, r, &in); e != nil {
				reply(w, nil, e)
				return
			}
			kinds := in.Kinds
			if len(kinds) == 0 {
				kinds = []string{"review", "knowledge"}
			}
			for _, kind := range kinds {
				if expected, ok := executionContracts()[kind]; !ok || in.Contracts[kind] != expected {
					reply(w, nil, application.Fail(409, "AGENT_CONFIG_CHANGED", "Executor strategy/schema mismatch before claim."))
					return
				}
			}
			t, e := s.Claim(ctx, in.Instance, in.Config, in.Kinds...)
			reply(w, map[string]any{"task": t}, e)
			return
		}
		path := strings.Split(strings.TrimPrefix(r.URL.Path, "/internal/v1/agent/tasks/"), "/")
		if !strings.HasPrefix(r.URL.Path, "/internal/v1/agent/tasks/") || len(path) != 2 || len(path[0]) != 36 {
			reply(w, nil, application.Fail(404, "NOT_FOUND", "Unknown task route."))
			return
		}
		var in Envelope
		if e := decode(w, r, &in); e != nil {
			reply(w, nil, e)
			return
		}
		e := s.Action(ctx, path[0], path[1], in)
		reply(w, map[string]any{"acknowledged": e == nil}, e)
	})
}

// Listen is explicitly opt-in and separate from Thinking capabilities and the public API.
func (s *Service) Listen() (*http.Server, error) {
	path := os.Getenv("WRITER_AGENT_TASK_SERVICE_TOKEN_FILE")
	if path == "" {
		return nil, nil
	}
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0137 != 0 || info.Size() > 256 {
		return nil, errors.New("protected task service credential required")
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	s.Token = strings.TrimSpace(string(raw))
	if len(s.Token) < 32 {
		return nil, errors.New("invalid task service credential")
	}
	for _, other := range []string{"WRITER_AGENT_AUTH_TOKEN_FILE", "WRITER_AGENT_PI_SERVICE_TOKEN_FILE", "WRITER_AGENT_PI_CAPABILITY_KEY_FILE"} {
		if path := os.Getenv(other); path != "" {
			raw, e := os.ReadFile(path)
			if e != nil {
				return nil, e
			}
			if strings.TrimSpace(string(raw)) == s.Token {
				return nil, errors.New("background Worker credential must differ from public and Thinking credentials")
			}
		}
	}
	host := os.Getenv("WRITER_AGENT_TASK_INTERNAL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("task listener must be loopback")
	}
	port := os.Getenv("WRITER_AGENT_TASK_INTERNAL_PORT")
	if port == "" {
		port = "8792"
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1 || n > 65535 {
		return nil, errors.New("invalid task listener port")
	}
	listener, e := net.Listen("tcp", net.JoinHostPort(host, port))
	if e != nil {
		return nil, e
	}
	server := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16384}
	go func() { _ = server.Serve(listener) }()
	return server, nil
}

func executionContracts() map[string]string {
	return map[string]string{"review": review.ExecutionContract(), "knowledge": knowledge.ExecutionContract()}
}

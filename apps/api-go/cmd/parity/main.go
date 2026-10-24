//go:build parity

// This test-only executable is never included in the server binary or Docker image.
package main

import (
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
	"net"
	"net/http"
)

func main() {
	c, e := config.Load()
	if e != nil {
		panic(e)
	}
	s := &application.Service{Root: c.Root, State: c.State, Project: c.Project}
	h := transport.Handler(transport.Options{Service: s, Environment: c.Environment, ResolveActor: func(r *http.Request) *application.Actor {
		role := r.Header.Get("x-parity-role")
		if role == "none" {
			return nil
		}
		if role == "" {
			role = "author"
		}
		return &application.Actor{ID: "local-author", Role: role}
	}})
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		panic(e)
	}
	fmt.Printf("PARITY_PORT=%d\n", listener.Addr().(*net.TCPAddr).Port)
	if e = http.Serve(listener, h); e != nil {
		panic(e)
	}
}

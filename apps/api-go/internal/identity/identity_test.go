package identity

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
)

func production(t *testing.T) config.Config {
	t.Helper()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte(strings.Repeat("a1", 32)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return config.Config{Environment: "production", AuthMode: "bearer", AuthTokenFile: token, AuthorID: "bruce"}
}

func TestProductionAuthenticationAndActorIsolation(t *testing.T) {
	c := production(t)
	resolver, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	service := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "local"}
	handler := transport.Handler(transport.Options{Service: service, Environment: "production", ResolveActor: resolver})
	for _, tc := range []struct {
		name    string
		headers []string
		status  int
	}{
		{"anonymous", nil, 401}, {"wrong", []string{"Bearer " + strings.Repeat("b2", 32)}, 401},
		{"basic", []string{"Basic " + strings.Repeat("a1", 32)}, 401},
		{"duplicate", []string{"Bearer " + strings.Repeat("a1", 32), "Bearer " + strings.Repeat("a1", 32)}, 401},
		{"comma joined", []string{"Bearer " + strings.Repeat("a1", 32) + ",Bearer " + strings.Repeat("a1", 32)}, 401},
		{"valid", []string{"bEaReR " + strings.Repeat("a1", 32)}, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/v1/projects/local/workspace?token="+strings.Repeat("a1", 32), nil)
			for _, h := range tc.headers {
				r.Header.Add("Authorization", h)
			}
			r.Header.Set("X-Actor-ID", "attacker")
			r.Header.Set("X-Actor-Role", "author")
			r.Header.Set("Cookie", "token="+strings.Repeat("a1", 32))
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if tc.status == 401 && w.Header().Get("WWW-Authenticate") == "" {
				t.Fatal("missing challenge")
			}
			if actor := resolver(r); actor != nil && (actor.ID != "bruce" || actor.Role != "author") {
				t.Fatal("request changed actor")
			}
		})
	}
	for _, path := range []string{"/internal/projects/local/harness-projection", "/v1/projects/other/workspace"} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("a1", 32))
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatalf("exposed %s", path)
		}
	}
}

func TestInvalidCredentialsFailBeforeStartup(t *testing.T) {
	for _, name := range []string{"missing", "weak", "public file", "group writable", "symlink", "directory", "invalid author", "local production", "unknown mode"} {
		t.Run(name, func(t *testing.T) {
			c := production(t)
			switch name {
			case "missing":
				c.AuthTokenFile += ".missing"
			case "weak":
				os.WriteFile(c.AuthTokenFile, []byte("short"), 0600)
			case "public file":
				os.Chmod(c.AuthTokenFile, 0644)
			case "group writable":
				os.Chmod(c.AuthTokenFile, 0660)
			case "directory":
				c.AuthTokenFile = filepath.Dir(c.AuthTokenFile)
			case "symlink":
				link := c.AuthTokenFile + ".link"
				if err := os.Symlink(c.AuthTokenFile, link); err != nil {
					t.Fatal(err)
				}
				c.AuthTokenFile = link
			case "invalid author":
				c.AuthorID = "../../root"
			case "local production":
				c.AuthMode = "local"
			case "unknown mode":
				c.AuthMode = "unknown"
			}
			if _, err := New(c); err == nil {
				t.Fatal("unsafe identity accepted")
			}
		})
	}
}

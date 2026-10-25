package config

import (
	"testing"
)

func TestLocalIdentityConfigurationFailsClosed(t *testing.T) {
	for _, c := range []struct {
		name, env, node, host, port string
		ok                          bool
	}{{"default", "development", "", "127.0.0.1", "0", true}, {"test", "test", "", "::1", "8787", true}, {"production", "production", "", "127.0.0.1", "8787", false}, {"node production", "development", "production", "127.0.0.1", "8787", false}, {"public bind", "development", "", "0.0.0.0", "8787", false}, {"public v6", "development", "", "::", "8787", false}, {"invalid port", "development", "", "127.0.0.1", "NaN", false}, {"unknown env", "staging", "", "127.0.0.1", "8787", false}} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("WRITER_AGENT_ENV", c.env)
			t.Setenv("NODE_ENV", c.node)
			t.Setenv("WRITER_AGENT_API_HOST", c.host)
			t.Setenv("WRITER_AGENT_API_PORT", c.port)
			t.Setenv("WRITER_AGENT_STATE_DIR", t.TempDir())
			_, e := Load()
			if (e == nil) != c.ok {
				t.Fatal(e)
			}
		})
	}
}

func TestProductionRequiresExplicitBearerIdentity(t *testing.T) {
	for _, tc := range []struct {
		name, mode, file, author string
		ok                       bool
	}{
		{"valid", "bearer", "/etc/writer-agent/auth-token", "bruce", true},
		{"local", "local", "/etc/writer-agent/auth-token", "bruce", false},
		{"missing file", "bearer", "", "bruce", false},
		{"missing author", "bearer", "/etc/writer-agent/auth-token", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("WRITER_AGENT_ENV", "production")
			t.Setenv("NODE_ENV", "production")
			t.Setenv("WRITER_AGENT_AUTH_MODE", tc.mode)
			t.Setenv("WRITER_AGENT_AUTH_TOKEN_FILE", tc.file)
			t.Setenv("WRITER_AGENT_AUTHOR_ID", tc.author)
			t.Setenv("WRITER_AGENT_IDENTITY_PUBLIC_KEY", "fixture-public-key")
			t.Setenv("WRITER_AGENT_STATE_DIR", t.TempDir())
			t.Setenv("WRITER_AGENT_API_HOST", "127.0.0.1")
			t.Setenv("WRITER_AGENT_API_PORT", "8787")
			_, err := Load()
			if (err == nil) != tc.ok {
				t.Fatal(err)
			}
		})
	}
}

func TestProductionWorkerDoesNotRequireHTTPBearerToken(t *testing.T) {
	t.Setenv("WRITER_AGENT_ENV", "production")
	t.Setenv("WRITER_AGENT_AUTHOR_ID", "author")
	t.Setenv("WRITER_AGENT_AUTH_TOKEN_FILE", "")
	t.Setenv("WRITER_AGENT_STATE_DIR", t.TempDir())
	if _, err := LoadWorker(); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil {
		t.Fatal("HTTP service bypassed bearer requirement")
	}
}

func TestProductionAPIRequiresPerUserIdentityKey(t *testing.T) {
	t.Setenv("WRITER_AGENT_ENV", "production")
	t.Setenv("NODE_ENV", "production")
	t.Setenv("WRITER_AGENT_AUTH_MODE", "bearer")
	t.Setenv("WRITER_AGENT_AUTH_TOKEN_FILE", "/etc/writer-agent/auth-token")
	t.Setenv("WRITER_AGENT_AUTHOR_ID", "bruce")
	t.Setenv("WRITER_AGENT_IDENTITY_PUBLIC_KEY", "")
	t.Setenv("WRITER_AGENT_STATE_DIR", t.TempDir())
	t.Setenv("WRITER_AGENT_API_HOST", "127.0.0.1")
	t.Setenv("WRITER_AGENT_API_PORT", "8787")
	if _, err := Load(); err == nil {
		t.Fatal("production API must not start with one shared author identity")
	}
	// The Worker process never authenticates browser callers.
	if _, err := LoadWorker(); err != nil {
		t.Fatal(err)
	}
}

package config

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Root, State, Project, Host, Port, Environment string
	AuthMode, AuthTokenFile, AuthorID             string
	// IdentityPublicKey verifies the per-request Ed25519 user assertion signed
	// by the login Worker (base64 of the raw 32-byte key). Required for the
	// production API: without it every bearer caller would share AuthorID.
	IdentityPublicKey string
	// LegacyOwnerEmail is the verified Google address that inherits AuthorID
	// (all data created before per-user identity). The first verified sign-in
	// with this address binds its immutable user ID; the address is not
	// consulted again afterwards.
	LegacyOwnerEmail string
}

func value(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
func Root() string {
	if root := os.Getenv("WRITER_AGENT_HARNESS_ROOT"); root != "" {
		r, _ := filepath.Abs(root)
		return r
	}
	cwd, _ := os.Getwd()
	for dir := cwd; ; dir = filepath.Dir(dir) {
		if _, e := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); e == nil {
			return dir
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	return cwd
}
func Load() (Config, error)       { return load(false) }
func LoadWorker() (Config, error) { return load(true) }
func load(worker bool) (Config, error) {
	home, e := os.UserHomeDir()
	if e != nil {
		return Config{}, e
	}
	c := Config{Root: Root(), State: value("WRITER_AGENT_STATE_DIR", filepath.Join(home, ".local/share/ai-write-life-circle")), Project: value("WRITER_AGENT_PROJECT_ID", "local"), Host: value("WRITER_AGENT_API_HOST", "127.0.0.1"), Port: value("WRITER_AGENT_API_PORT", "8787"), Environment: value("WRITER_AGENT_ENV", value("NODE_ENV", "development"))}
	c.AuthMode = value("WRITER_AGENT_AUTH_MODE", "local")
	c.AuthTokenFile = value("WRITER_AGENT_AUTH_TOKEN_FILE", "")
	c.AuthorID = value("WRITER_AGENT_AUTHOR_ID", "")
	c.IdentityPublicKey = strings.TrimSpace(value("WRITER_AGENT_IDENTITY_PUBLIC_KEY", ""))
	c.LegacyOwnerEmail = strings.ToLower(strings.TrimSpace(value("WRITER_AGENT_LEGACY_OWNER_EMAIL", "")))
	if os.Getenv("NODE_ENV") == "production" && c.Environment != "production" {
		return c, errors.New("NODE_ENV=production requires WRITER_AGENT_ENV=production and production identity")
	}
	switch c.Environment {
	case "production":
		if c.AuthorID == "" || (!worker && (c.AuthMode != "bearer" || c.AuthTokenFile == "")) {
			return c, errors.New("production requires bearer identity, a token file and an explicit author ID; local identity is development-only")
		}
		if !worker && c.IdentityPublicKey == "" {
			return c, errors.New("production requires WRITER_AGENT_IDENTITY_PUBLIC_KEY so each signed-in user is a separate author")
		}
	case "development", "test":
		if c.AuthMode != "local" && c.AuthMode != "bearer" {
			return c, errors.New("unsupported authentication mode")
		}
	default:
		return c, errors.New("WRITER_AGENT_ENV must be development, test or production")
	}
	ip := net.ParseIP(c.Host)
	if ip == nil || !ip.IsLoopback() {
		return c, errors.New("API requires a loopback bind address behind a trusted TLS proxy")
	}
	port, e := strconv.Atoi(c.Port)
	if e != nil || port < 0 || port > 65535 {
		return c, errors.New("invalid API port")
	}
	if c.Project == "" {
		return c, errors.New("project ID must not be empty")
	}
	c.State, e = filepath.Abs(c.State)
	if e != nil {
		return c, e
	}
	if rel, e := filepath.Rel(c.Root, c.State); e == nil {
		first := strings.Split(filepath.ToSlash(rel), "/")[0]
		for _, forbidden := range []string{"manuscript", "book", "proposals", "decisions"} {
			if first == forbidden {
				return c, errors.New("application state must stay outside author source directories")
			}
		}
	}
	return c, nil
}

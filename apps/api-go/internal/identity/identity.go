// Package identity authenticates the caller of the business API. It never
// trusts request actor headers on their own.
//
// Production uses two factors on every request:
//   - the service Bearer token proves the request came through the login Worker;
//   - an Ed25519-signed, short-lived user assertion from that Worker names the
//     signed-in user (Better Auth's immutable user ID) and binds the method and
//     path. Each user becomes a separate author Actor.
//
// The configured AuthorID keeps owning everything created before per-user
// identity. It is inherited by exactly one verified Google account, bound on
// first sign-in by LegacyOwnerEmail and by immutable user ID afterwards.
package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
)

const (
	// Header carries the Worker-signed user assertion.
	Header = "X-Writer-Agent-Identity"
	// ModeHeader/Mode are advertised on every response so the Worker can refuse
	// to talk to an API that would still map all users onto one author.
	ModeHeader = "X-Writer-Agent-Identity-Mode"
	Mode       = "per-user-v1"
	issuer     = "story2u-worker"
	audience   = "writer-agent-api"
	// Assertions are minted per request; a short window bounds replay and skew.
	maxLifetime = 120 * time.Second
	clockSkew   = 30 * time.Second
	maxBytes    = 2048
)

var subjectRE = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Claims is the Worker's signed statement about the signed-in user.
type Claims struct {
	Issuer        string `json:"iss"`
	Audience      string `json:"aud"`
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	IssuedAt      int64  `json:"iat"`
	ExpiresAt     int64  `json:"exp"`
	Method        string `json:"mth"`
	Path          string `json:"pth"`
}

// UserActorID derives the stable author ID for a Better Auth user ID. The
// prefix keeps it disjoint from configured IDs and the hash keeps provider
// identifiers out of storage paths and audit records.
func UserActorID(subject string) string {
	sum := sha256.Sum256([]byte("writer-agent-user-v1:" + subject))
	return "u-" + hex.EncodeToString(sum[:16])
}

// ParsePublicKey accepts the raw 32-byte Ed25519 key in standard or URL-safe
// base64, with or without padding.
func ParsePublicKey(value string) (ed25519.PublicKey, error) {
	value = strings.TrimSpace(value)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if raw, err := enc.DecodeString(value); err == nil && len(raw) == ed25519.PublicKeySize {
			return ed25519.PublicKey(raw), nil
		}
	}
	return nil, errors.New("identity public key must be base64 of a raw 32-byte Ed25519 key")
}

func New(c config.Config) (transport.Resolver, error) {
	if c.AuthMode == "local" && (c.Environment == "development" || c.Environment == "test") {
		return func(*http.Request) *application.Actor { return &application.Actor{ID: "local-author", Role: "author"} }, nil
	}
	if c.AuthMode != "bearer" || !application.SafeKey(c.AuthorID) {
		return nil, errors.New("bearer identity requires a stable valid author ID")
	}
	expected, err := readToken(c.AuthTokenFile)
	if err != nil {
		return nil, err
	}
	bearer := func(r *http.Request) bool {
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			return false
		}
		fields := strings.Fields(values[0])
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return false
		}
		actual := sha256.Sum256([]byte(fields[1]))
		return subtle.ConstantTimeCompare(actual[:], expected[:]) == 1
	}
	if c.IdentityPublicKey == "" {
		if c.Environment == "production" {
			return nil, errors.New("production requires a per-user identity public key")
		}
		// Development/test fixtures without a login Worker: one configured author.
		return func(r *http.Request) *application.Actor {
			if !bearer(r) {
				return nil
			}
			return &application.Actor{ID: c.AuthorID, Role: "author"}
		}, nil
	}
	key, err := ParsePublicKey(c.IdentityPublicKey)
	if err != nil {
		return nil, err
	}
	if c.State == "" {
		return nil, errors.New("per-user identity requires a state directory for the legacy owner binding")
	}
	legacy := &legacyOwner{path: filepath.Join(c.State, "identity", "legacy-owner-v1.json"), email: c.LegacyOwnerEmail, actor: c.AuthorID}
	return func(r *http.Request) *application.Actor {
		if !bearer(r) {
			return nil
		}
		claims, reason := verify(key, r, time.Now())
		if reason != "" {
			// Reason codes only; the assertion itself is never logged.
			slog.Info("identity assertion rejected", "reason", reason, "path", r.URL.EscapedPath())
			return nil
		}
		id, err := legacy.actorFor(r.Context(), claims)
		if err != nil {
			// Fail closed: never fall back to a fresh identity for the legacy owner.
			slog.Warn("legacy owner binding unavailable", "error", err)
			return nil
		}
		actor := &application.Actor{ID: id, Role: "author"}
		if claims.EmailVerified {
			actor.Email = strings.ToLower(strings.TrimSpace(claims.Email))
		}
		return actor
	}, nil
}

func readToken(path string) ([32]byte, error) {
	var none [32]byte
	// Reject symlinks, devices and files readable by other users or writable by the group.
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0137 != 0 || info.Size() > 128 {
		return none, errors.New("bearer token must be a regular protected file (0600 or 0640), at most 128 bytes")
	}
	file, err := os.Open(path)
	if err != nil {
		return none, errors.New("cannot open bearer token file")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 129))
	if err != nil {
		return none, errors.New("cannot read bearer token file")
	}
	token := strings.TrimSpace(string(data))
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 || len(token) != 64 {
		return none, errors.New("bearer token must contain 64 hexadecimal characters generated from 32 random bytes")
	}
	return sha256.Sum256([]byte(token)), nil
}

// Verify checks a compact EdDSA JWS from the identity header against the
// request it accompanies. Any deviation fails closed.
func Verify(key ed25519.PublicKey, r *http.Request, now time.Time) (Claims, bool) {
	c, reason := verify(key, r, now)
	return c, reason == ""
}

func verify(key ed25519.PublicKey, r *http.Request, now time.Time) (Claims, string) {
	var c Claims
	values := r.Header.Values(Header)
	if len(values) == 0 {
		return c, "missing"
	}
	if len(values) != 1 || len(values[0]) > maxBytes {
		return c, "malformed"
	}
	parts := strings.Split(values[0], ".")
	if len(parts) != 3 {
		return c, "malformed"
	}
	head, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return c, "malformed"
	}
	var h map[string]any
	if json.Unmarshal(head, &h) != nil || len(h) != 2 || h["alg"] != "EdDSA" || h["typ"] != "JWT" {
		return c, "header"
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), sig) {
		return c, "signature"
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return c, "malformed"
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if dec.Decode(&c) != nil || dec.More() {
		return Claims{}, "claims"
	}
	issued, expires := time.Unix(c.IssuedAt, 0), time.Unix(c.ExpiresAt, 0)
	switch {
	case c.Issuer != issuer || c.Audience != audience || !subjectRE.MatchString(c.Subject) || len(c.Email) > 320:
		return Claims{}, "claims"
	case !expires.After(issued) || expires.Sub(issued) > maxLifetime:
		return Claims{}, "lifetime"
	case now.Before(issued.Add(-clockSkew)) || !now.Before(expires):
		return Claims{}, "expired"
	case c.Method != r.Method || c.Path != r.URL.EscapedPath():
		return Claims{}, "binding"
	}
	return c, ""
}

type legacyBinding struct {
	Schema  int    `json:"schema"`
	Subject string `json:"subject"`
	Email   string `json:"email"`
	BoundAt string `json:"boundAt"`
}

// legacyOwner maps exactly one verified user onto the pre-existing author ID.
type legacyOwner struct {
	path, email, actor string
	mu                 sync.Mutex
	bound              *legacyBinding
}

func (l *legacyOwner) read() (*legacyBinding, error) {
	var b legacyBinding
	found, err := storage.Read(l.path, &b)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	if b.Schema != 1 || !subjectRE.MatchString(b.Subject) {
		return nil, errors.New("invalid legacy owner binding")
	}
	return &b, nil
}

func (l *legacyOwner) actorFor(ctx context.Context, c Claims) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.bound == nil {
		b, err := l.read()
		if err != nil {
			return "", err
		}
		l.bound = b
	}
	if l.bound != nil {
		if l.bound.Subject == c.Subject {
			return l.actor, nil
		}
		return UserActorID(c.Subject), nil
	}
	if l.email == "" || !c.EmailVerified || !strings.EqualFold(strings.TrimSpace(c.Email), l.email) {
		return UserActorID(c.Subject), nil
	}
	// First verified sign-in by the legacy owner: bind the immutable user ID.
	var bound *legacyBinding
	err := storage.Lock(ctx, l.path+".lock", func() error {
		current, err := l.read()
		if err != nil {
			return err
		}
		if current != nil {
			bound = current
			return nil
		}
		next := legacyBinding{Schema: 1, Subject: c.Subject, Email: strings.ToLower(c.Email), BoundAt: time.Now().UTC().Format(time.RFC3339)}
		if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
			return err
		}
		if err := storage.Write(ctx, l.path, next); err != nil {
			return err
		}
		bound = &next
		return nil
	})
	if err != nil {
		return "", err
	}
	l.bound = bound
	if bound.Subject == c.Subject {
		return l.actor, nil
	}
	return UserActorID(c.Subject), nil
}

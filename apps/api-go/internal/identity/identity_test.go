package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
)

var bearer = "Bearer " + strings.Repeat("a1", 32)

type signer struct{ key ed25519.PrivateKey }

func newSigner(t *testing.T) (signer, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{private}, base64.StdEncoding.EncodeToString(public)
}

func (s signer) token(t *testing.T, claims map[string]any) string {
	t.Helper()
	head := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	body := base64.RawURLEncoding.EncodeToString(raw)
	return head + "." + body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(s.key, []byte(head+"."+body)))
}

func claimsFor(sub, email, method, path string) map[string]any {
	now := time.Now().Unix()
	return map[string]any{"iss": "story2u-worker", "aud": "writer-agent-api", "sub": sub, "email": email, "email_verified": true, "iat": now, "exp": now + 60, "mth": method, "pth": path}
}

func production(t *testing.T) config.Config {
	t.Helper()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte(strings.Repeat("a1", 32)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return config.Config{Environment: "production", AuthMode: "bearer", AuthTokenFile: token, AuthorID: "bruce", State: t.TempDir(), LegacyOwnerEmail: "owner@example.com"}
}

func request(method, path, auth, assertion string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	if auth != "" {
		r.Header.Set("Authorization", auth)
	}
	if assertion != "" {
		r.Header.Set(Header, assertion)
	}
	return r
}

func TestProductionRequiresBearerAndSignedUser(t *testing.T) {
	s, public := newSigner(t)
	c := production(t)
	c.IdentityPublicKey = public
	resolver, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	service := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "local"}
	handler := transport.Handler(transport.Options{Service: service, Environment: "production", ResolveActor: resolver})
	path := "/v1/projects/local/workspace"
	valid := s.token(t, claimsFor("userA", "a@example.com", "GET", path))
	for _, tc := range []struct {
		name      string
		auth      []string
		assertion string
		status    int
	}{
		{"anonymous", nil, "", 401},
		{"bearer only", []string{bearer}, "", 401},
		{"assertion only", nil, valid, 401},
		{"wrong bearer", []string{"Bearer " + strings.Repeat("b2", 32)}, valid, 401},
		{"duplicate bearer", []string{bearer, bearer}, valid, 401},
		{"comma joined", []string{bearer + "," + bearer}, valid, 401},
		{"valid", []string{"bEaReR " + strings.Repeat("a1", 32)}, valid, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := request("GET", path+"?token=x", "", tc.assertion)
			for _, h := range tc.auth {
				r.Header.Add("Authorization", h)
			}
			// Browser-style actor hints are never trusted.
			r.Header.Set("X-Actor-ID", "attacker")
			r.Header.Set("X-Actor-Role", "author")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			if actor := resolver(r); actor != nil && (actor.ID != UserActorID("userA") || actor.Role != "author") {
				t.Fatal("request changed actor", actor)
			}
		})
	}
}

func TestAssertionIsBoundToRequestAndKey(t *testing.T) {
	s, public := newSigner(t)
	other, _ := newSigner(t)
	c := production(t)
	c.IdentityPublicKey = public
	resolver, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	path := "/v1/studio/books"
	mutate := func(f func(map[string]any)) string {
		claims := claimsFor("userA", "a@example.com", "GET", path)
		f(claims)
		return s.token(t, claims)
	}
	now := time.Now().Unix()
	cases := map[string]string{
		"other key":      other.token(t, claimsFor("userA", "a@example.com", "GET", path)),
		"other path":     s.token(t, claimsFor("userA", "a@example.com", "GET", "/v1/studio/books/book-x")),
		"other method":   s.token(t, claimsFor("userA", "a@example.com", "POST", path)),
		"expired":        mutate(func(m map[string]any) { m["iat"], m["exp"] = now-120, now-1 }),
		"too long":       mutate(func(m map[string]any) { m["exp"] = now + 3600 }),
		"future":         mutate(func(m map[string]any) { m["iat"], m["exp"] = now+300, now+360 }),
		"wrong audience": mutate(func(m map[string]any) { m["aud"] = "other" }),
		"wrong issuer":   mutate(func(m map[string]any) { m["iss"] = "browser" }),
		"bad subject":    mutate(func(m map[string]any) { m["sub"] = "../x" }),
		"unknown claim":  mutate(func(m map[string]any) { m["role"] = "admin" }),
		"tampered":       strings.Replace(s.token(t, claimsFor("userA", "a@example.com", "GET", path)), ".", ".e", 1),
		"none alg":       base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`)) + "." + base64.RawURLEncoding.EncodeToString([]byte(`{}`)) + ".",
	}
	for name, token := range cases {
		t.Run(name, func(t *testing.T) {
			if actor := resolver(request("GET", path, bearer, token)); actor != nil {
				t.Fatalf("accepted %s as %v", name, actor)
			}
		})
	}
	r := request("GET", path, bearer, s.token(t, claimsFor("userA", "a@example.com", "GET", path)))
	r.Header.Add(Header, s.token(t, claimsFor("userB", "b@example.com", "GET", path)))
	if resolver(r) != nil {
		t.Fatal("two identity headers accepted")
	}
}

func TestEachUserIsSeparateAndLegacyOwnerBindsOnce(t *testing.T) {
	s, public := newSigner(t)
	c := production(t)
	c.IdentityPublicKey = public
	resolver, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	path := "/v1/studio/books"
	as := func(sub, email string, verified bool) *application.Actor {
		claims := claimsFor(sub, email, "GET", path)
		claims["email_verified"] = verified
		return resolver(request("GET", path, bearer, s.token(t, claims)))
	}
	a, b := as("userA", "a@example.com", true), as("userB", "b@example.com", true)
	if a == nil || b == nil || a.ID == b.ID || a.ID == "bruce" || b.ID == "bruce" {
		t.Fatalf("users not isolated: %v %v", a, b)
	}
	if again := as("userA", "renamed@example.com", true); again == nil || again.ID != a.ID {
		t.Fatal("actor must follow the immutable user ID, not the email")
	}
	// An unverified address never inherits the legacy author.
	if v := as("userC", "owner@example.com", false); v == nil || v.ID == "bruce" {
		t.Fatal("unverified legacy email claimed legacy data")
	}
	if owner := as("ownerID", "Owner@Example.com", true); owner == nil || owner.ID != "bruce" {
		t.Fatalf("legacy owner not bound: %v", owner)
	}
	// After binding, the email is irrelevant: another account with the same
	// address cannot take over, and the owner keeps the data after renaming.
	if impostor := as("ownerID2", "owner@example.com", true); impostor == nil || impostor.ID == "bruce" {
		t.Fatal("legacy data re-bound to a second account")
	}
	if owner := as("ownerID", "new@example.com", true); owner == nil || owner.ID != "bruce" {
		t.Fatal("legacy owner lost access after an email change")
	}
	// The binding survives restarts.
	restarted, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	claims := claimsFor("ownerID", "x@example.com", "GET", path)
	if owner := restarted(request("GET", path, bearer, s.token(t, claims))); owner == nil || owner.ID != "bruce" {
		t.Fatal("binding not persisted")
	}
}

func TestConcurrentLegacyClaimsBindOneAccount(t *testing.T) {
	s, public := newSigner(t)
	c := production(t)
	c.IdentityPublicKey = public
	path := "/v1/studio/books"
	var wg sync.WaitGroup
	results := make([]string, 8)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Separate resolvers model separate processes sharing the state dir.
			resolver, err := New(c)
			if err != nil {
				t.Error(err)
				return
			}
			sub := "candidate" + string(rune('A'+i))
			if actor := resolver(request("GET", path, bearer, s.token(t, claimsFor(sub, "owner@example.com", "GET", path)))); actor != nil {
				results[i] = actor.ID
			}
		}(i)
	}
	wg.Wait()
	owners := 0
	for _, id := range results {
		if id == "bruce" {
			owners++
		}
	}
	if owners != 1 {
		t.Fatalf("legacy author bound to %d accounts: %v", owners, results)
	}
}

func TestInvalidCredentialsFailBeforeStartup(t *testing.T) {
	_, public := newSigner(t)
	for _, name := range []string{"missing", "weak", "public file", "group writable", "symlink", "directory", "invalid author", "local production", "unknown mode", "no identity key", "bad identity key", "no state"} {
		t.Run(name, func(t *testing.T) {
			c := production(t)
			c.IdentityPublicKey = public
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
			case "no identity key":
				c.IdentityPublicKey = ""
			case "bad identity key":
				c.IdentityPublicKey = "c2hvcnQ="
			case "no state":
				c.State = ""
			}
			if _, err := New(c); err == nil {
				t.Fatal("unsafe identity accepted")
			}
		})
	}
}

func TestDevelopmentBearerWithoutKeyKeepsSingleAuthor(t *testing.T) {
	c := production(t)
	c.Environment = "test"
	resolver, err := New(c)
	if err != nil {
		t.Fatal(err)
	}
	if actor := resolver(request("GET", "/v1/studio/books", bearer, "")); actor == nil || actor.ID != "bruce" {
		t.Fatal("fixture bearer identity changed")
	}
}

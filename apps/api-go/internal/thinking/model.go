// Package thinking owns author/session grants and a private read-only Story Tool boundary.
package thinking

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

const Protocol = "thinking-v1"

type Limits struct {
	Turns       int `json:"maxTurnsPerRequest"`
	Tools       int `json:"maxToolCalls"`
	Input       int `json:"maxInputTokens"`
	Output      int `json:"maxOutputTokens"`
	Session     int `json:"maxSessionTokens"`
	Concurrent  int `json:"maxConcurrentSessions"`
	Duration    int `json:"maxDurationMs"`
	ResultBytes int `json:"maxToolResultBytes"`
}
type Model struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Endpoint string `json:"endpoint"`
	Protocol string `json:"protocol"`
	Limits   Limits `json:"limits"`
}
type Record struct {
	ID      string   `json:"sessionId"`
	Book    string   `json:"bookId"`
	Owner   string   `json:"ownerId"`
	Title   string   `json:"title"`
	Created string   `json:"createdAt"`
	Model   Model    `json:"model"`
	Scopes  []string `json:"scopes"`
	Deleted bool     `json:"deleted"`
	Pending bool     `json:"cleanupPending"`
	Nonce   string   `json:"nonce"`
	Calls   int      `json:"toolCalls"`
}
type receipt struct {
	Hash string `json:"hash"`
	ID   string `json:"id"`
}
type registry struct {
	Schema   int                `json:"schema"`
	Sessions map[string]Record  `json:"sessions"`
	Requests map[string]receipt `json:"requests"`
}
type Service struct {
	Management                  *application.Management
	State, Origin, ServiceToken string
	Secret                      []byte
	Client                      *http.Client
	ResolveActor                func(*http.Request) *application.Actor
}
type Create struct {
	Consent bool     `json:"consent"`
	Model   Model    `json:"model"`
	Scopes  []string `json:"scopes"`
}
type Selection struct {
	Chapter  string `json:"chapterId"`
	Revision string `json:"revisionId"`
	Hash     string `json:"contentHash"`
	Quote    string `json:"quote"`
}
type Message struct {
	Text      string     `json:"text"`
	Selection *Selection `json:"selection,omitempty"`
	Compact   bool       `json:"compact,omitempty"`
}
type Source struct {
	ID        string `json:"sourceId"`
	Chapter   string `json:"chapterId"`
	Title     string `json:"title"`
	Revision  string `json:"revisionId"`
	Hash      string `json:"contentHash"`
	Quote     string `json:"quote"`
	Start     int    `json:"startUTF16"`
	End       int    `json:"endUTF16"`
	Validity  string `json:"validity"`
	Epistemic string `json:"epistemic,omitempty"`
}

func fail(status int, code string) error {
	detail := "思考服务请求未完成，请保留输入后重试。"
	if status == 503 {
		detail = "思考服务暂不可用。写作和保存仍可正常使用，请保留输入后重试。"
	}
	if code == "MODEL_REAUTHORIZATION_REQUIRED" {
		detail = "模型或执行限制已变化，请新建思考会话重新确认。"
	}
	if code == "INVALID_SELECTION" {
		detail = "选中原文无法定位到已保存版本，请重新选取。"
	}
	return application.Fail(status, code, detail)
}
func (s *Service) path() string { return filepath.Join(s.State, "thinking", "sessions-v1.json") }
func (s *Service) load() (registry, error) {
	st := registry{1, map[string]Record{}, map[string]receipt{}}
	found, e := storage.Read(s.path(), &st)
	if e != nil {
		return st, e
	}
	if found && (st.Schema != 1 || st.Sessions == nil || st.Requests == nil) {
		return st, fail(500, "THINKING_STORAGE_INVALID")
	}
	return st, nil
}
func (s *Service) tx(ctx context.Context, fn func(*registry) error) error {
	return storage.Lock(ctx, s.path()+".lock", func() error {
		st, e := s.load()
		if e != nil {
			return e
		}
		if e = fn(&st); e != nil {
			return e
		}
		return storage.Write(ctx, s.path(), st)
	})
}
func (s *Service) owned(a application.Actor, book, id string) (Record, error) {
	if _, e := s.Management.Resolve(a, book); e != nil {
		return Record{}, e
	}
	st, e := s.load()
	if e != nil {
		return Record{}, e
	}
	r, ok := st.Sessions[id]
	if !ok || r.Owner != a.ID || r.Book != book || r.Deleted {
		return r, fail(404, "NOT_FOUND")
	}
	return r, nil
}

type claim struct {
	ID    string `json:"sessionId"`
	Nonce string `json:"nonce"`
	Exp   int64  `json:"exp"`
}

func (s *Service) capability(r Record) string {
	b, _ := json.Marshal(claim{r.ID, r.Nonce, time.Now().Add(10 * time.Minute).Unix()})
	payload := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, s.Secret)
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
func (s *Service) authorize(token string) (Record, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return Record{}, fail(401, "CAPABILITY_INVALID")
	}
	mac := hmac.New(sha256.New, s.Secret)
	mac.Write([]byte(parts[0]))
	sig, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return Record{}, fail(401, "CAPABILITY_INVALID")
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[0])
	var c claim
	if e != nil || json.Unmarshal(raw, &c) != nil || time.Now().Unix() >= c.Exp {
		return Record{}, fail(401, "CAPABILITY_EXPIRED")
	}
	st, e := s.load()
	if e != nil {
		return Record{}, e
	}
	r, ok := st.Sessions[c.ID]
	if !ok || r.Deleted || r.Nonce != c.Nonce {
		return r, fail(403, "CAPABILITY_REVOKED")
	}
	_, e = s.Management.Resolve(application.Actor{ID: r.Owner, Role: "author"}, r.Book)
	return r, e
}
func contains(items []string, item string) bool {
	for _, v := range items {
		if v == item {
			return true
		}
	}
	return false
}
func hash(v any) string { b, _ := json.Marshal(v); return compat.Hash(string(b)) }
func (s *Service) CleanupBook(ctx context.Context, a application.Actor, book string) error {
	return s.tx(ctx, func(st *registry) error {
		for id, r := range st.Sessions {
			if r.Book == book && r.Owner == a.ID {
				r.Deleted = true
				r.Pending = true
				r.Nonce = compat.UUID()
				st.Sessions[id] = r
			}
		}
		return nil
	})
}

// Cleanup is durable and independent of manuscript deletion. Offline Pi cannot
// restore access; pending records are retried on startup and every five seconds.
func (s *Service) Cleanup(ctx context.Context) {
	st, e := s.load()
	if e != nil {
		return
	}
	for id, r := range st.Sessions {
		if !r.Deleted {
			if _, e = s.Management.Resolve(application.Actor{ID: r.Owner, Role: "author"}, r.Book); e != nil {
				var p *application.Error
				if errors.As(e, &p) && p.Status == 404 {
					_ = s.CleanupBook(ctx, application.Actor{ID: r.Owner, Role: "author"}, r.Book)
				}
			}
			continue
		}
		if !r.Pending {
			continue
		}
		_, e = s.agent(ctx, "DELETE", "/internal/v1/sessions/"+id, nil)
		if e == nil {
			_ = s.tx(ctx, func(current *registry) error {
				v := current.Sessions[id]
				v.Pending = false
				current.Sessions[id] = v
				return nil
			})
		}
	}
}

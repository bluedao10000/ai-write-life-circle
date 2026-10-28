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
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
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
	ContextWindow   int    `json:"contextWindow,omitempty"`
	BillingPolicy   string `json:"billingPolicy,omitempty"`
	ID              string `json:"modelId,omitempty"`
	DisplayName     string `json:"displayName,omitempty"`
	HostedBy        string `json:"hostedBy,omitempty"`
	ToolCalling     *bool  `json:"toolCalling,omitempty"`
	TokenParameter  string `json:"tokenParameter,omitempty"`
	ProviderOptions string `json:"providerOptions,omitempty"`
	Provider        string `json:"provider"`
	Model           string `json:"model"`
	Endpoint        string `json:"endpoint"`
	Protocol        string `json:"protocol"`
	Limits          Limits `json:"limits"`
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
	// LastMessage is the most recently accepted user message, used only to
	// scope the controlled request_turn_organize tool to the current turn.
	LastMessage string `json:"lastMessageId,omitempty"`
	// Intake is the durable creative-organizing outbox: accepted messages whose
	// OnMessageAccepted hook has not succeeded yet. It is written in the same
	// registry commit as LastMessage and drained by RetryIntake.
	Intake []string `json:"pendingIntake,omitempty"`
	// BillOp is the open AI-point reservation of the last accepted message;
	// Billed is the session's cumulative points already charged.
	BillOp string `json:"billOp,omitempty"`
	Billed int    `json:"billedPoints,omitempty"`
}
type receipt struct {
	Hash string `json:"hash"`
	ID   string `json:"id"`
}
type registry struct {
	Schema      int                 `json:"schema"`
	Sessions    map[string]Record   `json:"sessions"`
	Requests    map[string]receipt  `json:"requests"`
	Preferences map[string][]string `json:"preferences,omitempty"`
}
type Service struct {
	Management                  *application.Management
	State, Origin, ServiceToken string
	Secret                      []byte
	Client                      *http.Client
	ResolveActor                func(*http.Request) *application.Actor
	// OnMessageAccepted runs after Pi durably accepted a message (202). It
	// records the creative-organizing turn; failures never fail chat. A
	// non-nil error means "retry later": the message stays in Record.Intake.
	OnMessageAccepted func(ctx context.Context, rec Record, messageID string) error
	// OnSessionDeleted invalidates derived creative work for a deleted session.
	OnSessionDeleted func(ctx context.Context, rec Record)
	// Meter charges each message's model usage to the session owner.
	Meter application.Meter
}
type Create struct {
	ID      string   `json:"modelId,omitempty"`
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
	ModelID   string     `json:"modelId,omitempty"`
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
	st := registry{Schema: 1, Sessions: map[string]Record{}, Requests: map[string]receipt{}}
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

// Owned verifies that a live session belongs to the author and book.
func (s *Service) Owned(a application.Actor, book, id string) error {
	_, e := s.owned(a, book, id)
	return e
}

// Snapshot reads the Pi session view with the service token. found=false means
// Pi or Go no longer has the session (deleted or unknown).
func (s *Service) Snapshot(ctx context.Context, id string) (raw json.RawMessage, found bool, err error) {
	st, e := s.load()
	if e != nil {
		return nil, true, e
	}
	if r, ok := st.Sessions[id]; !ok || r.Deleted {
		return nil, false, nil
	}
	raw, e = s.agent(ctx, "GET", "/internal/v1/sessions/"+id, nil)
	if e != nil {
		var p *application.Error
		if errors.As(e, &p) && (p.Status == 404 || p.Status == 410) {
			return nil, false, nil
		}
		return nil, true, e
	}
	return raw, true, nil
}

// SessionBook reports the book and owner of a session for background reconciliation.
func (s *Service) SessionBook(id string) (Record, bool) {
	st, e := s.load()
	if e != nil {
		return Record{}, false
	}
	r, ok := st.Sessions[id]
	return r, ok && !r.Deleted
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

// maxIntake bounds the per-session outbox; a session only ever has one
// message in flight, so this is only reached after a long outage.
const maxIntake = 32

func addIntake(items []string, id string) []string {
	for _, v := range items {
		if v == id {
			return items
		}
	}
	items = append(items, id)
	if len(items) > maxIntake {
		items = items[len(items)-maxIntake:]
	}
	return items
}

func (s *Service) dropIntake(ctx context.Context, session, message string) error {
	return s.tx(ctx, func(st *registry) error {
		r, ok := st.Sessions[session]
		if !ok {
			return nil
		}
		next := r.Intake[:0:0]
		for _, v := range r.Intake {
			if v != message {
				next = append(next, v)
			}
		}
		r.Intake = next
		st.Sessions[session] = r
		return nil
	})
}

// RetryIntake re-runs OnMessageAccepted for accepted messages whose intake
// did not commit (REL-001). Deleted sessions drop their outbox. At most limit
// hook calls are made per sweep.
func (s *Service) RetryIntake(ctx context.Context, limit int) {
	if s.OnMessageAccepted == nil {
		return
	}
	st, e := s.load()
	if e != nil {
		return
	}
	for id, r := range st.Sessions {
		if len(r.Intake) == 0 {
			continue
		}
		if r.Deleted {
			_ = s.tx(ctx, func(current *registry) error {
				v := current.Sessions[id]
				v.Intake = nil
				current.Sessions[id] = v
				return nil
			})
			continue
		}
		for _, message := range r.Intake {
			if limit <= 0 || ctx.Err() != nil {
				return
			}
			limit--
			if s.OnMessageAccepted(ctx, r, message) == nil {
				_ = s.dropIntake(ctx, id, message)
			}
		}
	}
}

// sessionUsage is the cumulative usage Pi reports in a session view.
type sessionUsage struct {
	Status string `json:"status"`
	Usage  struct {
		Input       int  `json:"input"`
		CachedInput int  `json:"cachedInput"`
		Output      int  `json:"output"`
		Charged     int  `json:"charged"`
		Incomplete  bool `json:"incomplete"`
	} `json:"usage"`
}

// points converts Pi's cumulative usage; incomplete usage falls back to Pi's
// conservative reservation ceiling.
func (u sessionUsage) points() int {
	p := billing.PointsFor(u.Usage.Input, u.Usage.Output, u.Usage.CachedInput)
	if u.Usage.Incomplete {
		p = max(p, (u.Usage.Charged+999)/1000)
	}
	return p
}

func (u sessionUsage) running() bool { return u.Status == "running" || u.Status == "accepted" }

// messagePoints bounds one message: every allowed turn at full input/output.
func messagePoints(l Limits) int {
	return max(1, l.Turns) * max(1, billing.PointsFor(l.Input, l.Output))
}

func (s *Service) settle(ctx context.Context, r Record, u *sessionUsage) Record {
	if s.Meter == nil || r.BillOp == "" {
		return r
	}
	charge := -1
	if u != nil {
		total := u.points()
		charge = max(0, total-r.Billed)
		r.Billed = max(r.Billed, total)
	}
	if s.Meter.Settle(ctx, r.Owner, r.BillOp, charge) == nil {
		r.BillOp = ""
	}
	return r
}

// SettleUsage charges finished messages from Pi's reported usage. Deleted or
// unknown sessions are charged their reservation. At most limit sessions are
// read per sweep.
func (s *Service) SettleUsage(ctx context.Context, limit int) {
	if s.Meter == nil {
		return
	}
	st, e := s.load()
	if e != nil {
		return
	}
	for id, r := range st.Sessions {
		if r.BillOp == "" {
			continue
		}
		if limit <= 0 || ctx.Err() != nil {
			return
		}
		limit--
		_ = storage.Lock(ctx, s.path()+"."+compat.Key(id)+".lock", func() error {
			latest, err := s.load()
			if err != nil {
				return err
			}
			if latest.Sessions[id].BillOp != r.BillOp {
				return nil
			}
			var usage *sessionUsage
			if !r.Deleted {
				raw, found, err := s.Snapshot(ctx, id)
				if err != nil {
					return nil // Pi offline: the ledger lease charges the reservation if this persists.
				}
				if found {
					var u sessionUsage
					if json.Unmarshal(raw, &u) != nil {
						return nil
					}
					if u.running() {
						return nil
					}
					usage = &u
				}
			}
			next := s.settle(ctx, r, usage)
			_ = s.tx(ctx, func(current *registry) error {
				v, ok := current.Sessions[id]
				if !ok || v.BillOp != r.BillOp {
					return nil
				}
				v.BillOp, v.Billed = next.BillOp, next.Billed
				current.Sessions[id] = v
				return nil
			})
			return nil
		})
	}
}

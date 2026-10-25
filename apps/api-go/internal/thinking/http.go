package thinking

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var route = regexp.MustCompile(`^/v1/studio/books/([A-Za-z0-9_-]+)/thinking/(capabilities|sessions)(?:/(th-[a-f0-9-]{36}))?(?:/(messages|events|cancel))?$`)

func IsPublicPath(path string) bool { return strings.Contains(path, "/thinking/") }
func reply(w http.ResponseWriter, v any, e error, status int) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	if e != nil {
		p := application.AsError(e)
		w.WriteHeader(p.Status)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": p.Code, "detail": p.Detail, "status": p.Status, "type": "about:blank", "title": p.Code})
		return
	}
	w.WriteHeader(status)
	if status != 204 {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return fail(422, "VALIDATION_FAILED")
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return fail(422, "VALIDATION_FAILED")
	}
	return nil
}
func (s *Service) agent(ctx context.Context, method, path string, v any) (json.RawMessage, error) {
	if s.Origin == "" || s.ServiceToken == "" {
		return nil, fail(503, "THINKING_UNAVAILABLE")
	}
	var body io.Reader
	if v != nil {
		b, _ := json.Marshal(v)
		body = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, s.Origin+path, body)
	if e != nil {
		return nil, fail(503, "THINKING_UNAVAILABLE")
	}
	req.Header.Set("Authorization", "Bearer "+s.ServiceToken)
	req.Header.Set("Content-Type", "application/json")
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	res, e := client.Do(req)
	if e != nil {
		return nil, fail(503, "THINKING_UNAVAILABLE")
	}
	defer res.Body.Close()
	data, e := io.ReadAll(io.LimitReader(res.Body, 4*1024*1024+1))
	if e != nil || len(data) > 4*1024*1024 || !json.Valid(data) {
		return nil, fail(502, "AGENT_INVALID_RESPONSE")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		code := "AGENT_REQUEST_FAILED"
		var p struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(data, &p) == nil && regexp.MustCompile(`^[A-Z_]{1,80}$`).MatchString(p.Code) {
			code = p.Code
		}
		return nil, fail(res.StatusCode, code)
	}
	return data, nil
}
func (s *Service) model(ctx context.Context) (Model, error) {
	var out struct {
		Protocol string `json:"protocol"`
		Model    Model  `json:"model"`
	}
	raw, e := s.agent(ctx, "GET", "/internal/v1/health", nil)
	if e != nil {
		return out.Model, e
	}
	if json.Unmarshal(raw, &out) != nil || out.Protocol != Protocol || out.Model.Protocol != Protocol || out.Model.Provider == "" || out.Model.Model == "" || out.Model.Limits.Tools < 1 || out.Model.Limits.Duration > 300000 {
		return out.Model, fail(503, "AGENT_PROTOCOL_MISMATCH")
	}
	return out.Model, nil
}
func summary(r Record) map[string]any {
	return map[string]any{"sessionId": r.ID, "bookId": r.Book, "title": r.Title, "createdAt": r.Created, "model": r.Model, "scopes": r.Scopes, "status": "idle"}
}
func (s *Service) PublicHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		m := route.FindStringSubmatch(r.URL.EscapedPath())
		if m == nil {
			reply(w, nil, fail(404, "NOT_FOUND"), 0)
			return
		}
		var a *application.Actor
		if s.ResolveActor != nil {
			a = s.ResolveActor(r)
		}
		if a == nil || a.Role != "author" {
			reply(w, nil, fail(401, "AUTHOR_DECISION_REQUIRED"), 0)
			return
		}
		book, op, id, action := m[1], m[2], m[3], m[4]
		if _, e := s.Management.Resolve(*a, book); e != nil {
			reply(w, nil, e, 0)
			return
		}
		if op == "capabilities" {
			if r.Method != "GET" || id != "" {
				reply(w, nil, fail(405, "METHOD_NOT_ALLOWED"), 0)
				return
			}
			v, e := s.model(r.Context())
			reply(w, v, e, 200)
			return
		}
		if id == "" {
			if r.Method == "GET" {
				st, e := s.load()
				items := []map[string]any{}
				if e == nil {
					for _, v := range st.Sessions {
						if v.Owner == a.ID && v.Book == book && !v.Deleted {
							items = append(items, summary(v))
						}
					}
				}
				sort.Slice(items, func(i, j int) bool { return items[i]["createdAt"].(string) > items[j]["createdAt"].(string) })
				reply(w, map[string]any{"items": items}, e, 200)
				return
			}
			if r.Method != "POST" {
				reply(w, nil, fail(405, "METHOD_NOT_ALLOWED"), 0)
				return
			}
			var in Create
			if e := decode(w, r, &in); e != nil {
				reply(w, nil, e, 0)
				return
			}
			model, e := s.model(r.Context())
			if e != nil {
				reply(w, nil, e, 0)
				return
			}
			if !in.Consent || hash(model) != hash(in.Model) || len(in.Scopes) == 0 || len(in.Scopes) > 4 {
				reply(w, nil, fail(422, "THINKING_CONSENT_REQUIRED"), 0)
				return
			}
			for _, scope := range in.Scopes {
				if !contains([]string{"chapters", "knowledge", "notes", "creative"}, scope) {
					reply(w, nil, fail(422, "INVALID_SCOPE"), 0)
					return
				}
			}
			key := r.Header.Get("Idempotency-Key")
			if !application.SafeKey(key) {
				reply(w, nil, fail(422, "IDEMPOTENCY_KEY_REQUIRED"), 0)
				return
			}
			var record Record
			e = s.tx(r.Context(), func(st *registry) error {
				rk := hash([]string{a.ID, book, "create", key})
				fp := hash(in)
				if old, ok := st.Requests[rk]; ok {
					if old.Hash != fp {
						return fail(422, "IDEMPOTENCY_KEY_REUSED")
					}
					record = st.Sessions[old.ID]
					if record.Deleted {
						return fail(404, "NOT_FOUND")
					}
					return nil
				}
				if _, e := s.Management.Resolve(*a, book); e != nil {
					return e
				}
				active := 0
				for _, candidate := range st.Sessions {
					if !candidate.Deleted {
						active++
					}
				}
				if active >= 10000 {
					return fail(429, "SESSION_LIMIT")
				}
				record = Record{ID: "th-" + compat.UUID(), Book: book, Owner: a.ID, Title: "新的思考", Created: compat.Now(), Model: model, Scopes: in.Scopes, Nonce: compat.UUID()}
				st.Sessions[record.ID] = record
				st.Requests[rk] = receipt{fp, record.ID}
				return nil
			})
			if e != nil {
				reply(w, nil, e, 0)
				return
			}
			v, e := s.agent(r.Context(), "POST", "/internal/v1/sessions", map[string]any{"sessionId": record.ID, "authorId": record.Owner, "bookId": book, "model": model, "scopes": record.Scopes, "createdAt": record.Created, "capability": s.capability(record)})
			if e == nil {
				_, e = s.owned(*a, book, record.ID)
			}
			reply(w, v, e, 201)
			return
		}
		record, e := s.owned(*a, book, id)
		if e != nil {
			reply(w, nil, e, 0)
			return
		}
		target := "/internal/v1/sessions/" + id
		if action == "" && r.Method == "DELETE" {
			e = s.tx(r.Context(), func(st *registry) error {
				v := st.Sessions[id]
				v.Deleted = true
				v.Pending = true
				v.Nonce = compat.UUID()
				st.Sessions[id] = v
				return nil
			})
			if e == nil {
				if s.OnSessionDeleted != nil {
					s.OnSessionDeleted(r.Context(), record)
				}
				s.Cleanup(r.Context())
			}
			reply(w, nil, e, 204)
			return
		}
		if r.Method == "GET" && (action == "" || action == "events") {
			if action == "events" {
				cursor, e := strconv.Atoi(r.URL.Query().Get("after"))
				if r.URL.Query().Get("after") == "" {
					cursor = 0
					e = nil
				}
				if e != nil || cursor < 0 {
					reply(w, nil, fail(422, "INVALID_CURSOR"), 0)
					return
				}
				target += "/events?after=" + strconv.Itoa(cursor)
			}
			v, e := s.agent(r.Context(), "GET", target, nil)
			if e == nil {
				v, e = s.validateResponseSources(r.Context(), record, v)
			}
			if e == nil {
				_, e = s.owned(*a, book, id)
			}
			reply(w, v, e, 200)
			return
		}
		if r.Method == "POST" && action == "cancel" {
			e = s.tx(r.Context(), func(st *registry) error {
				v := st.Sessions[id]
				v.Nonce = compat.UUID()
				st.Sessions[id] = v
				return nil
			})
			if e != nil {
				reply(w, nil, e, 0)
				return
			}
			v, e := s.agent(r.Context(), "POST", target+"/cancel", map[string]any{})
			reply(w, v, e, 200)
			return
		}
		if r.Method == "POST" && action == "messages" {
			var in Message
			if e := decode(w, r, &in); e != nil {
				reply(w, nil, e, 0)
				return
			}
			if strings.TrimSpace(in.Text) == "" || compat.UTF16Len(in.Text) > 12000 {
				reply(w, nil, fail(422, "VALIDATION_FAILED"), 0)
				return
			}
			key := r.Header.Get("Idempotency-Key")
			if !application.SafeKey(key) {
				reply(w, nil, fail(422, "IDEMPOTENCY_KEY_REQUIRED"), 0)
				return
			}
			e = storage.Lock(r.Context(), s.path()+"."+compat.Key(id)+".lock", func() error {
				model, e := s.model(r.Context())
				if e != nil {
					return e
				}
				if hash(model) != hash(record.Model) {
					return fail(409, "MODEL_REAUTHORIZATION_REQUIRED")
				}
				// Only explicit saved-version selections enter model context.
				if in.Selection != nil {
					if !contains(record.Scopes, "chapters") {
						return fail(403, "SCOPE_FORBIDDEN")
					}
					if e := s.validateSelection(r.Context(), record, *in.Selection); e != nil {
						return e
					}
				}
				rk := hash([]string{id, "message", key})
				fp := hash(in)
				st, e := s.load()
				if e != nil {
					return e
				}
				old, exists := st.Requests[rk]
				if exists && old.Hash != fp {
					return fail(422, "IDEMPOTENCY_KEY_REUSED")
				}
				if !exists {
					raw, e := s.agent(r.Context(), "GET", target, nil)
					if e != nil {
						return e
					}
					var state sessionUsage
					if json.Unmarshal(raw, &state) != nil {
						return fail(502, "AGENT_INVALID_RESPONSE")
					}
					if state.Status == "running" {
						return fail(409, "SESSION_BUSY")
					}
					// AI points: settle the previous message from Pi's usage, then
					// hold this message's ceiling before Pi may call the model.
					current := s.settle(r.Context(), st.Sessions[id], &state)
					if current.BillOp != "" {
						return fail(503, "BILLING_UNAVAILABLE")
					}
					op := ""
					if s.Meter != nil {
						op = "think:" + id + ":" + rk
						if e := s.Meter.Reserve(r.Context(), current.Owner, op, "thinking", messagePoints(current.Model.Limits)); e != nil {
							_ = s.tx(r.Context(), func(st *registry) error {
								v := st.Sessions[id]
								v.BillOp, v.Billed = current.BillOp, current.Billed
								st.Sessions[id] = v
								return nil
							})
							return e
						}
					}
					e = s.tx(r.Context(), func(st *registry) error {
						v := st.Sessions[id]
						if v.Deleted {
							return fail(404, "NOT_FOUND")
						}
						v.Billed = current.Billed
						v.BillOp = op
						v.Nonce = compat.UUID()
						v.Calls = 0
						if v.Title == "新的思考" {
							v.Title = string([]rune(in.Text)[:min(40, len([]rune(in.Text)))])
						}
						record = v
						st.Sessions[id] = v
						st.Requests[rk] = receipt{fp, id}
						return nil
					})
					if e != nil {
						if op != "" {
							_ = s.Meter.Settle(r.Context(), current.Owner, op, 0)
						}
						return e
					}
				} else {
					record = st.Sessions[id]
				}
				v, e := s.agent(r.Context(), "POST", target+"/messages", map[string]any{"input": in, "key": key, "capability": s.capability(record)})
				// A failed hand-off keeps its reservation: Pi may still have accepted
				// the message, and SettleUsage charges only what Pi reports.
				if e == nil {
					_, e = s.owned(*a, book, id)
				}
				if e == nil {
					var accepted struct {
						MessageID string `json:"messageId"`
					}
					if json.Unmarshal(v, &accepted) == nil && accepted.MessageID != "" && len(accepted.MessageID) <= 128 {
						// LastMessage and the intake outbox commit together, so a failed
						// hook below is retried by RetryIntake instead of being lost.
						queued := s.tx(r.Context(), func(st *registry) error {
							current := st.Sessions[id]
							if current.Deleted {
								return nil
							}
							current.LastMessage = accepted.MessageID
							if s.OnMessageAccepted != nil {
								current.Intake = addIntake(current.Intake, accepted.MessageID)
							}
							st.Sessions[id] = current
							record = current
							return nil
						}) == nil
						if s.OnMessageAccepted != nil && !record.Deleted {
							if s.OnMessageAccepted(r.Context(), record, accepted.MessageID) == nil && queued {
								_ = s.dropIntake(r.Context(), id, accepted.MessageID)
							}
						}
					}
				}
				reply(w, v, e, 202)
				return nil
			})
			if e != nil {
				reply(w, nil, e, 0)
			}
			return
		}
		reply(w, nil, fail(405, "METHOD_NOT_ALLOWED"), 0)
	})
}
func Bearer(r *http.Request) string {
	v := strings.Fields(r.Header.Get("Authorization"))
	if len(v) == 2 && v[0] == "Bearer" {
		return v[1]
	}
	return ""
}
func ValidServiceToken(expected, provided string) bool {
	return len(expected) >= 32 && subtle.ConstantTimeCompare([]byte(expected), []byte(provided)) == 1
}

// ValidateOrigin requires explicit private loopback endpoints; cross-machine support
// must add authenticated TLS configuration rather than accepting arbitrary URLs.
func ValidateOrigin(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "http" || (u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") || u.Port() == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return fail(500, "INVALID_AGENT_ORIGIN")
	}
	return nil
}

package transport

import (
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
)

var creativeIDRE = regexp.MustCompile(`^(ca|cl|cd)-[a-f0-9-]{36}$`)
var sessionIDRE = regexp.MustCompile(`^th-[a-f0-9-]{36}$`)

// handleCreative serves /v1/studio/books/:book/creative/... for the owning author.
func handleCreative(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	parts := strings.Split(path, "/")
	if len(parts) < 6 || parts[1] != "v1" || parts[2] != "studio" || parts[3] != "books" || parts[5] != "creative" {
		return false
	}
	var actor *application.Actor
	if o.ResolveActor != nil {
		actor = o.ResolveActor(r)
	}
	if actor == nil {
		problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "Authentication required."), "")
		return true
	}
	if !role(w, actor, "author") {
		return true
	}
	book := parts[4]
	if strings.ContainsAny(book, "%.\\") || book == "" {
		problem(w, application.Fail(404, "NOT_FOUND", "Unknown book."), "")
		return true
	}
	var app *application.Service
	var e error
	if o.Management != nil {
		app, e = o.Management.Resolve(*actor, book)
	} else if o.Service != nil && o.Service.Project == book {
		app = o.Service
	} else {
		e = application.Fail(404, "NOT_FOUND", "Unknown book.")
	}
	if e != nil {
		problem(w, application.AsError(e), "")
		return true
	}
	if o.CreativeFor == nil {
		problem(w, application.Fail(503, "CREATIVE_UNAVAILABLE", "Creative assets unavailable."), "")
		return true
	}
	s := o.CreativeFor(app)
	respond := func(v any, e error, status int) {
		if e != nil {
			problem(w, application.AsError(e), "")
		} else {
			write(w, status, v, "")
		}
	}
	rest := parts[6:]
	suffix := strings.Join(rest, "/")
	q := r.URL.Query()
	offset, limit, ok := pagination(q.Get("cursor"), q.Get("limit"))
	if r.Method == "GET" {
		if !ok {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "Invalid pagination."), "")
			return true
		}
		switch {
		case suffix == "":
			v, e := s.Overview(r.Context())
			respond(v, e, 200)
		case suffix == "assets":
			v, e := s.Assets(r.Context(), creative.AssetQuery{Kind: q.Get("kind"), Status: q.Get("status"), Q: q.Get("q"), Offset: offset, Limit: limit})
			respond(v, e, 200)
		case len(rest) == 2 && rest[0] == "assets" && creativeIDRE.MatchString(rest[1]):
			v, e := s.Asset(r.Context(), rest[1])
			respond(v, e, 200)
		case suffix == "proposals":
			v, e := s.Proposals(r.Context(), creative.ProposalQuery{Status: q.Get("status"), SessionID: q.Get("sessionId"), AssetID: q.Get("assetId"), ChangeSetID: q.Get("changeSetId"), Offset: offset, Limit: limit})
			respond(v, e, 200)
		case suffix == "turns":
			session := q.Get("sessionId")
			if !sessionIDRE.MatchString(session) {
				problem(w, application.Fail(422, "VALIDATION_FAILED", "sessionId required."), "")
				return true
			}
			if e := ownedSession(o, *actor, book, session); e != nil {
				problem(w, application.AsError(e), "")
				return true
			}
			v, e := s.Turns(r.Context(), session)
			respond(map[string]any{"items": v}, e, 200)
		case suffix == "turns/excerpt":
			session, message := q.Get("sessionId"), q.Get("messageId")
			if !sessionIDRE.MatchString(session) || message == "" || len(message) > 128 {
				problem(w, application.Fail(422, "VALIDATION_FAILED", "sessionId and messageId required."), "")
				return true
			}
			if e := ownedSession(o, *actor, book, session); e != nil {
				problem(w, application.AsError(e), "")
				return true
			}
			v, e := s.Excerpt(r.Context(), creative.TurnKey(session, message))
			respond(v, e, 200)
		case suffix == "context":
			v, e := s.WritingContext(r.Context(), q.Get("chapterId"))
			respond(v, e, 200)
		case suffix == "divergences":
			v, e := s.Divergences(r.Context(), q.Get("chapterId"))
			respond(map[string]any{"items": v}, e, 200)
		default:
			problem(w, application.Fail(404, "NOT_FOUND", "Unknown creative route."), "")
		}
		return true
	}
	if r.Method != "POST" && r.Method != "PATCH" {
		problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported creative method."), "")
		return true
	}
	data, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
	if e != nil {
		problem(w, application.Fail(413, "VALIDATION_FAILED", "Creative request too large."), "")
		return true
	}
	key := r.Header.Get("Idempotency-Key")
	decode := func(v any) bool {
		if e := creative.Decode(data, v); e != nil {
			problem(w, application.AsError(e), "")
			return false
		}
		return true
	}
	ctx := r.Context()
	switch {
	case r.Method == "POST" && suffix == "assets":
		var in creative.AssetInput
		if decode(&in) {
			v, e := s.CreateAsset(ctx, *actor, key, in)
			respond(v, e, 201)
		}
	case r.Method == "PATCH" && len(rest) == 2 && rest[0] == "assets" && creativeIDRE.MatchString(rest[1]):
		var in creative.AssetUpdate
		if decode(&in) {
			v, e := s.UpdateAsset(ctx, *actor, key, rest[1], in)
			respond(v, e, 200)
		}
	case r.Method == "POST" && suffix == "links":
		var in creative.LinkInput
		if decode(&in) {
			v, e := s.CreateLink(ctx, *actor, key, in)
			respond(v, e, 201)
		}
	case r.Method == "POST" && len(rest) == 3 && rest[0] == "links" && creativeIDRE.MatchString(rest[1]) && rest[2] == "remove":
		v, e := s.RemoveLink(ctx, *actor, key, rest[1])
		respond(v, e, 200)
	case r.Method == "POST" && suffix == "proposals/decide":
		var in creative.DecideInput
		if decode(&in) {
			v, e := s.Decide(ctx, *actor, key, in)
			respond(v, e, 200)
		}
	case r.Method == "POST" && suffix == "organize":
		var in struct {
			SessionID string `json:"sessionId"`
			MessageID string `json:"messageId"`
		}
		if !decode(&in) {
			return true
		}
		if !sessionIDRE.MatchString(in.SessionID) || in.MessageID == "" || len(in.MessageID) > 128 {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "sessionId and messageId required."), "")
			return true
		}
		if e := ownedSession(o, *actor, book, in.SessionID); e != nil {
			problem(w, application.AsError(e), "")
			return true
		}
		if !application.SafeKey(key) {
			problem(w, application.Fail(422, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key required."), "")
			return true
		}
		v, e := s.AcceptTurn(ctx, in.SessionID, in.MessageID, "manual")
		respond(v, e, 202)
	case r.Method == "POST" && suffix == "plan-checks":
		var in struct {
			ChapterID string `json:"chapterId"`
		}
		if decode(&in) {
			v, e := s.RequestPlanCheck(ctx, *actor, key, in.ChapterID)
			respond(v, e, 202)
		}
	case r.Method == "POST" && len(rest) == 3 && rest[0] == "divergences" && creativeIDRE.MatchString(rest[1]) && rest[2] == "decide":
		var in creative.DivergenceDecision
		if decode(&in) {
			v, e := s.DecideDivergence(ctx, *actor, key, rest[1], in)
			respond(v, e, 200)
		}
	case r.Method == "POST" && len(rest) == 2 && rest[0] == "settings":
		var in creative.SettingsInput
		if decode(&in) {
			v, e := s.Configure(ctx, *actor, rest[1], key, in)
			respond(v, e, 200)
		}
	default:
		problem(w, application.Fail(404, "NOT_FOUND", "Unknown creative action."), "")
	}
	return true
}

func pagination(cursor, size string) (int, int, bool) {
	offset, limit := 0, 50
	if cursor != "" {
		n, e := strconv.Atoi(cursor)
		if e != nil || n < 0 {
			return 0, 0, false
		}
		offset = n
	}
	if size != "" {
		n, e := strconv.Atoi(size)
		if e != nil || n < 1 || n > 100 {
			return 0, 0, false
		}
		limit = n
	}
	return offset, limit, true
}

func ownedSession(o Options, a application.Actor, book, session string) error {
	if o.SessionOwned == nil {
		return application.Fail(503, "THINKING_UNAVAILABLE", "Thinking sessions unavailable.")
	}
	return o.SessionOwned(a, book, session)
}

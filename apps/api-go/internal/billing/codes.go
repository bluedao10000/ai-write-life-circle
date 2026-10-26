package billing

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

// Redeem codes let an operator hand out plans and top-ups before payments
// exist. A code is 16 Crockford base32 characters (80 random bits) shown as
// WA-XXXX-XXXX-XXXX-XXXX. Only its SHA-256 digest is stored, so the state
// directory never contains a redeemable code.

const (
	codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	codeLength   = 16
	// maxRedeemFails bounds wrong guesses per account per UTC day.
	maxRedeemFails = 10
	maxCodeBatch   = 1000
)

// CodeSpec is what a code grants: a plan (Plan, Interval, Periods) or a
// top-up (Points).
type CodeSpec struct {
	Kind     string `json:"kind"`
	Plan     Plan   `json:"plan,omitempty"`
	Interval string `json:"interval,omitempty"`
	Periods  int    `json:"periods,omitempty"`
	Points   int    `json:"points,omitempty"`
}

func (s CodeSpec) validate() error {
	switch s.Kind {
	case "plan":
		if s.Plan == Free || s.Points != 0 {
			return fmt.Errorf("a plan code needs --plan plus or pro and no --points")
		}
		return Grant{Plan: s.Plan, Interval: s.Interval, Periods: s.Periods, Source: "code"}.validate()
	case "topup":
		if s.Plan != "" || s.Interval != "" || s.Periods != 0 || s.Points < 1 || s.Points > MaxTopupPoints {
			return fmt.Errorf("a top-up code needs only --points 1..%d", MaxTopupPoints)
		}
		return nil
	}
	return fmt.Errorf("code kind must be plan or topup")
}

type codeRecord struct {
	Schema int `json:"schema"`
	CodeSpec
	Batch      string `json:"batch,omitempty"`
	Created    string `json:"createdAt"`
	Expires    string `json:"expiresAt,omitempty"`
	RedeemedBy string `json:"redeemedBy,omitempty"`
	RedeemedAt string `json:"redeemedAt,omitempty"`
}

// CodeInfo is the operator listing of a code; it never includes the code.
type CodeInfo struct {
	Digest string `json:"digest"`
	CodeSpec
	Batch      string `json:"batch,omitempty"`
	Created    string `json:"createdAt"`
	Expires    string `json:"expiresAt,omitempty"`
	RedeemedBy string `json:"redeemedBy,omitempty"`
	RedeemedAt string `json:"redeemedAt,omitempty"`
}

func codesDir(state string) string { return filepath.Join(state, "billing", "codes") }

// normalizeCode accepts what an author may type: any case, spaces, dashes,
// the WA- prefix, and O/I/L for 0/1/1.
func normalizeCode(raw string) (string, bool) {
	s := strings.ToUpper(strings.TrimSpace(raw))
	s = strings.NewReplacer("-", "", " ", "", "O", "0", "I", "1", "L", "1").Replace(s)
	if len(s) == codeLength+2 && strings.HasPrefix(s, "WA") {
		s = s[2:]
	}
	if len(s) != codeLength {
		return "", false
	}
	for _, r := range s {
		if !strings.ContainsRune(codeAlphabet, r) {
			return "", false
		}
	}
	return s, true
}

func codeDigest(normalized string) string {
	sum := sha256.Sum256([]byte("writer-agent-code-v1:" + normalized))
	return hex.EncodeToString(sum[:])
}

func format(normalized string) string {
	return "WA-" + normalized[0:4] + "-" + normalized[4:8] + "-" + normalized[8:12] + "-" + normalized[12:16]
}

func newCode() (string, error) {
	// 32 symbols divide 256, so masking a random byte is unbiased.
	raw := make([]byte, codeLength)
	if _, e := rand.Read(raw); e != nil {
		return "", e
	}
	out := make([]byte, codeLength)
	for i, b := range raw {
		out[i] = codeAlphabet[b&31]
	}
	return string(out), nil
}

// CreateCodes stores n new codes and returns them for one-time display.
// A zero expires means the code does not expire.
func CreateCodes(ctx context.Context, state string, spec CodeSpec, n int, expires time.Time, batch string) ([]string, error) {
	if e := spec.validate(); e != nil {
		return nil, e
	}
	if n < 1 || n > maxCodeBatch {
		return nil, fmt.Errorf("count must be 1..%d", maxCodeBatch)
	}
	if len(batch) > 64 {
		return nil, fmt.Errorf("batch label too long")
	}
	now := time.Now().UTC()
	rec := codeRecord{Schema: 1, CodeSpec: spec, Batch: batch, Created: now.Format(time.RFC3339)}
	if !expires.IsZero() {
		if !expires.After(now) {
			return nil, fmt.Errorf("expiry must be in the future")
		}
		rec.Expires = expires.UTC().Format(time.RFC3339)
	}
	out := make([]string, 0, n)
	for len(out) < n {
		code, e := newCode()
		if e != nil {
			return nil, e
		}
		path := filepath.Join(codesDir(state), codeDigest(code)+".json")
		created := false
		if e := storage.LockShort(ctx, staleLock, path+".lock", func() error {
			var existing codeRecord
			found, e := storage.Read(path, &existing)
			if e != nil || found {
				return e // a collision is skipped and a new code drawn
			}
			created = true
			return storage.Write(ctx, path, rec)
		}); e != nil {
			return nil, e
		}
		if created {
			out = append(out, format(code))
		}
	}
	return out, nil
}

// ListCodes returns every stored code, newest first.
func ListCodes(state string) ([]CodeInfo, error) {
	entries, e := os.ReadDir(codesDir(state))
	if os.IsNotExist(e) {
		return []CodeInfo{}, nil
	}
	if e != nil {
		return nil, e
	}
	out := []CodeInfo{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(codesDir(state), name))
		if e != nil {
			return nil, e
		}
		var r codeRecord
		if json.Unmarshal(raw, &r) != nil || r.Schema != 1 {
			continue
		}
		out = append(out, CodeInfo{Digest: strings.TrimSuffix(name, ".json")[:12], CodeSpec: r.CodeSpec, Batch: r.Batch, Created: r.Created, Expires: r.Expires, RedeemedBy: r.RedeemedBy, RedeemedAt: r.RedeemedAt})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out, nil
}

func codeInvalid() error {
	return application.Fail(404, "CODE_INVALID", "兑换码无效，请检查后重试。")
}

// failedRedeem counts a wrong guess against the account's daily allowance.
func (l *Ledger) failedRedeem(ctx context.Context, owner string) error {
	return l.withAccount(ctx, owner, func(a *account, _ time.Time) error {
		if a.RedeemDay != a.Day {
			a.RedeemDay, a.RedeemFails = a.Day, 0
		}
		a.RedeemFails++
		return nil
	})
}

// Redeem applies a code to the owner's account. Redeeming the same code
// again by the same owner is a no-op; another owner gets CODE_USED.
func (l *Ledger) Redeem(ctx context.Context, owner, raw string) (Usage, error) {
	if owner == "" {
		return Usage{}, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "Authentication required.")
	}
	if a, e := l.load(owner); e != nil {
		return Usage{}, e
	} else if a.RedeemDay == l.now().Format("2006-01-02") && a.RedeemFails >= maxRedeemFails {
		return Usage{}, application.Fail(429, "REDEEM_RATE_LIMITED", "今天输错兑换码的次数过多，请明天（UTC）再试。")
	}
	code, ok := normalizeCode(raw)
	if !ok {
		if e := l.failedRedeem(ctx, owner); e != nil {
			return Usage{}, e
		}
		return Usage{}, codeInvalid()
	}
	digest := codeDigest(code)
	path := filepath.Join(codesDir(l.State), digest+".json")
	c, e := ReadControl(l.State)
	if e != nil {
		return Usage{}, e
	}
	var out Usage
	missing := false
	e = storage.LockShort(ctx, staleLock, path+".lock", func() error {
		var r codeRecord
		found, e := storage.Read(path, &r)
		if e != nil {
			return e
		}
		if !found || r.Schema != 1 || r.validate() != nil {
			missing = true
			return nil
		}
		if r.RedeemedBy != "" && r.RedeemedBy != owner {
			return application.Fail(409, "CODE_USED", "这个兑换码已被使用。")
		}
		now := l.now()
		if r.RedeemedBy == "" && r.Expires != "" && !before(now, r.Expires) {
			return application.Fail(410, "CODE_EXPIRED", "这个兑换码已过期。")
		}
		// The account records the digest first, so a crash before the code is
		// marked lets the same owner finish the redemption without a double grant.
		e = l.withAccount(ctx, owner, func(a *account, now time.Time) error {
			if _, done := a.Redeemed[digest]; !done {
				plan := l.planOf(*a, now)
				switch r.Kind {
				case "plan":
					if current, active := explicit(*a, now); active && current != Free && (current != r.Plan || a.PlanUntil == "") {
						return application.Fail(409, "PLAN_CONFLICT", "当前已有其他有效方案，暂时不能兑换这个方案码。如需更换，请联系我们。")
					}
					applyGrant(a, Grant{Plan: r.Plan, Interval: r.Interval, Periods: r.Periods, Source: "code"}, now)
				case "topup":
					if !Plans[plan].Topups {
						return application.Fail(402, "PLAN_FEATURE_REQUIRED", "加油包需要 Plus 或 Pro 方案。")
					}
					if e := addTopup(a, "code:"+digest[:24], r.Points, "code", now); e != nil {
						return e
					}
				}
				if a.Redeemed == nil {
					a.Redeemed = map[string]string{}
				}
				a.Redeemed[digest] = now.Format(time.RFC3339)
			}
			out = l.view(*a, now, c)
			return nil
		})
		if e != nil || r.RedeemedBy == owner {
			return e
		}
		r.RedeemedBy, r.RedeemedAt = owner, now.Format(time.RFC3339)
		return storage.Write(ctx, path, r)
	})
	if e != nil {
		return Usage{}, e
	}
	if missing {
		if e := l.failedRedeem(ctx, owner); e != nil {
			return Usage{}, e
		}
		return Usage{}, codeInvalid()
	}
	return out, nil
}

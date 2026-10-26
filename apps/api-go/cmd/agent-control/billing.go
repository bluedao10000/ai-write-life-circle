package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

const billingUsage = `billing commands (run as the service user, e.g. sudo -u writer-agent):
  billing usage  --email E | --actor ID
  billing grant  --email E | --actor ID --plan plus|pro|free [--interval month|year] [--periods N]
  billing topup  --email E | --actor ID --points N [--id KEY]
  billing codes create --kind plan --plan plus|pro --interval month|year [--periods N] --count N [--expires YYYY-MM-DD] [--batch LABEL]
  billing codes create --kind topup --points N --count N [--expires YYYY-MM-DD] [--batch LABEL]
  billing codes list

An account is found by the email it last signed in with; the author must
have opened the app once. --plan free revokes a granted plan.`

func billingCommand(state string, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%s", billingUsage)
	}
	ctx := context.Background()
	ledger := &billing.Ledger{State: state, LegacyOwner: os.Getenv("WRITER_AGENT_AUTHOR_ID")}
	out := json.NewEncoder(os.Stdout)
	out.SetIndent("", "  ")
	cmd, rest := args[0], args[1:]
	if cmd == "codes" {
		return codesCommand(ctx, state, rest, out)
	}
	fs := flag.NewFlagSet("billing "+cmd, flag.ContinueOnError)
	email := fs.String("email", "", "account email (last verified sign-in)")
	actor := fs.String("actor", "", "account actor ID (u-…)")
	plan := fs.String("plan", "", "plus, pro, or free to revoke")
	interval := fs.String("interval", "month", "month or year")
	periods := fs.Int("periods", 1, "number of months or years")
	points := fs.Int("points", 0, "top-up points")
	id := fs.String("id", "", "top-up idempotency key (default: random)")
	if e := fs.Parse(rest); e != nil {
		return e
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	owner, e := findAccount(state, *email, *actor)
	if e != nil {
		return e
	}
	switch cmd {
	case "usage":
		u, e := ledger.View(ctx, owner)
		if e != nil {
			return e
		}
		return out.Encode(map[string]any{"actorId": owner, "account": u})
	case "grant":
		u, e := ledger.Grant(ctx, owner, billing.Grant{Plan: billing.Plan(*plan), Interval: *interval, Periods: *periods, Source: "manual"})
		if e != nil {
			return e
		}
		return out.Encode(map[string]any{"actorId": owner, "plan": u.Plan, "interval": u.Interval, "expiresAt": u.ExpiresAt})
	case "topup":
		key := *id
		if key == "" {
			key = "manual:" + compat.UUID()
		}
		u, e := ledger.AddTopup(ctx, owner, key, *points, "manual")
		if e != nil {
			return e
		}
		if u.Topups.Frozen {
			fmt.Fprintln(os.Stderr, "note: the account is on Free, so this top-up stays frozen until a paid plan is granted")
		}
		return out.Encode(map[string]any{"actorId": owner, "id": key, "topups": u.Topups})
	}
	return fmt.Errorf("unknown billing command %q\n%s", cmd, billingUsage)
}

func findAccount(state, email, actor string) (string, error) {
	if (email == "") == (actor == "") {
		return "", fmt.Errorf("give exactly one of --email or --actor")
	}
	if actor != "" {
		if !billing.AccountExists(state, actor) {
			return "", fmt.Errorf("no billing account for %s; check the ID or ask the author to open the app once", actor)
		}
		return actor, nil
	}
	found, e := billing.FindByEmail(state, email)
	if e != nil {
		return "", e
	}
	switch len(found) {
	case 0:
		return "", fmt.Errorf("no account has signed in with %s; ask the author to open the app once", email)
	case 1:
		return found[0], nil
	}
	return "", fmt.Errorf("several accounts used %s (%s); pass --actor", email, strings.Join(found, ", "))
}

func codesCommand(ctx context.Context, state string, args []string, out *json.Encoder) error {
	if len(args) == 0 {
		return fmt.Errorf("%s", billingUsage)
	}
	switch args[0] {
	case "list":
		codes, e := billing.ListCodes(state)
		if e != nil {
			return e
		}
		return out.Encode(codes)
	case "create":
	default:
		return fmt.Errorf("unknown codes command %q", args[0])
	}
	fs := flag.NewFlagSet("billing codes create", flag.ContinueOnError)
	kind := fs.String("kind", "", "plan or topup")
	plan := fs.String("plan", "", "plus or pro (plan codes)")
	interval := fs.String("interval", "", "month or year (plan codes)")
	periods := fs.Int("periods", 0, "months or years (plan codes, default 1)")
	points := fs.Int("points", 0, "points (top-up codes)")
	count := fs.Int("count", 1, "number of codes")
	expires := fs.String("expires", "", "last UTC day a code can be redeemed (YYYY-MM-DD)")
	batch := fs.String("batch", "", "label for this batch")
	if e := fs.Parse(args[1:]); e != nil {
		return e
	}
	spec := billing.CodeSpec{Kind: *kind, Plan: billing.Plan(*plan), Interval: *interval, Periods: *periods, Points: *points}
	if spec.Kind == "plan" && spec.Periods == 0 {
		spec.Periods = 1
	}
	var until time.Time
	if *expires != "" {
		day, e := time.Parse("2006-01-02", *expires)
		if e != nil {
			return fmt.Errorf("--expires must be YYYY-MM-DD")
		}
		until = day.AddDate(0, 0, 1)
	}
	codes, e := billing.CreateCodes(ctx, state, spec, *count, until, *batch)
	if e != nil {
		return e
	}
	fmt.Fprintln(os.Stderr, "Codes are shown once and only their digests are stored. Share them over a private channel.")
	return out.Encode(map[string]any{"spec": spec, "expiresAt": *expires, "codes": codes})
}

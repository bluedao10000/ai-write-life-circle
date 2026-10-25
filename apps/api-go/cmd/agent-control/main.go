// agent-control is an offline/operator CLI, never an author or Worker HTTP privilege.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/executorpolicy"
	"os"
	"time"
)

func run() error {
	state := flag.String("state", "", "existing Go StateDirectory")
	kind := flag.String("kind", "", "review or knowledge")
	owner := flag.String("owner", "", "target go, pi, or disabled; empty means status")
	wait := flag.Duration("wait", 200*time.Second, "bounded drain timeout")
	billingStatus := flag.Bool("billing", false, "print the AI-point switch (pause, Free daily pool)")
	pause := flag.String("ai-pause", "", "pause AI features: none, free or all (writing is never paused)")
	freeDaily := flag.Int("free-daily-points", 0, "site-wide Free AI points per UTC day (0 keeps the current value)")
	flag.Parse()
	if *state == "" {
		return fmt.Errorf("--state is required")
	}
	if st, e := os.Stat(*state); e != nil || !st.IsDir() {
		return fmt.Errorf("existing state directory required")
	}
	if *billingStatus || *pause != "" || *freeDaily != 0 {
		c, e := billing.ReadControl(*state)
		if e != nil {
			return e
		}
		if *pause != "" || *freeDaily != 0 {
			switch *pause {
			case "":
			case "none":
				c.Paused = ""
			case "free", "all":
				c.Paused = *pause
			default:
				return fmt.Errorf("--ai-pause must be none, free or all")
			}
			if *freeDaily < 0 || *freeDaily > 100000000 {
				return fmt.Errorf("invalid --free-daily-points")
			}
			if *freeDaily > 0 {
				c.FreeDailyPoints = *freeDaily
			}
			if e := billing.WriteControl(context.Background(), *state, c); e != nil {
				return e
			}
		}
		c.Schema = 1
		if c.FreeDailyPoints == 0 {
			c.FreeDailyPoints = billing.DefaultFreeDailyPoints
		}
		return json.NewEncoder(os.Stdout).Encode(c)
	}
	c := executorpolicy.Controller{State: *state}
	if *owner == "" {
		s, e := c.Read()
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(s)
	}
	if *wait < time.Second || *wait > 10*time.Minute {
		return fmt.Errorf("invalid drain timeout")
	}
	ctx, cancel := context.WithTimeout(context.Background(), *wait)
	defer cancel()
	if (*kind != "review" && *kind != "knowledge") || (*owner != "go" && *owner != "pi" && *owner != "disabled") {
		return fmt.Errorf("invalid kind or owner")
	}
	if e := c.Drain(ctx, *kind); e != nil {
		return e
	}
	for {
		if e := c.Switch(ctx, *kind, *owner); e == nil {
			fmt.Println("Executor switch committed; previous generation fenced")
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("drain timeout; ownership unchanged, claims remain disabled; inspect active leases before retrying")
		case <-time.After(200 * time.Millisecond):
		}
	}
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}

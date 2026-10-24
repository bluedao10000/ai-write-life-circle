// Command creative-eval measures conversation → proposal behaviour on synthetic
// cases. Default mode replays fixture outputs (no network). Live mode calls the
// configured model and requires --live --confirm-fixtures plus a model key.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/creative"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/llm"
)

func main() {
	path := flag.String("cases", "../../harness/evals/creative/cases.json", "synthetic case file")
	live := flag.Bool("live", false, "call the configured model")
	confirm := flag.Bool("confirm-fixtures", false, "confirm only synthetic fixtures are sent")
	maxCalls := flag.Int("max-calls", 40, "hard cap on live model calls")
	flag.Parse()
	raw, e := os.ReadFile(*path)
	if e != nil {
		fail(e)
	}
	var cases []creative.EvalCase
	if e = json.Unmarshal(raw, &cases); e != nil {
		fail(e)
	}
	turns := 0
	for _, c := range cases {
		turns += len(c.Turns)
	}
	cfg := llm.Config{Provider: "openai-compatible", BaseURL: "http://127.0.0.1:9", Model: "fixture", ResponseFormat: "json_object", TokenParameter: "max_tokens", Timeout: 30e9, MaxContextBytes: 64 * 1024, MaxOutputTokens: 4096, MaxResponseBytes: 1 << 20}
	var client llm.Client
	if *live {
		if !*confirm {
			fail(fmt.Errorf("live eval requires --confirm-fixtures"))
		}
		if turns > *maxCalls {
			fail(fmt.Errorf("cases need %d calls, above --max-calls %d", turns, *maxCalls))
		}
		cfg, e = llm.Load()
		if e != nil {
			fail(e)
		}
		cfg.MaxOutputTokens = min(cfg.MaxOutputTokens, 8192)
		if client, e = llm.New(cfg); e != nil {
			fail(e)
		}
	}
	rep, e := creative.RunEval(context.Background(), cases, cfg, client)
	if e != nil {
		fail(e)
	}
	out, _ := json.MarshalIndent(rep, "", "  ")
	fmt.Println(string(out))
}

func fail(e error) {
	fmt.Fprintln(os.Stderr, e)
	os.Exit(1)
}

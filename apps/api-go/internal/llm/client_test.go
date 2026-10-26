package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testConfig(url string) Config {
	return Config{Provider: "openai-compatible", BaseURL: url, Model: "fixture-model", ResponseFormat: "none", TokenParameter: "max_completion_tokens", Timeout: time.Second, MaxContextBytes: 12000, MaxOutputTokens: 1024, MaxResponseBytes: 256 * 1024}
}
func errorCode(e error) string {
	var problem *Error
	if errors.As(e, &problem) {
		return problem.Code
	}
	return ""
}
func clearModelEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{"PROVIDER", "BASE_URL", "API_KEY", "MODEL", "RESPONSE_FORMAT", "TOKEN_PARAMETER", "TIMEOUT_SECONDS", "MAX_OUTPUT_TOKENS"} {
		t.Setenv("WRITER_AGENT_LLM_"+key, "")
	}
	t.Setenv("WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS", "")
	t.Setenv("WRITER_AGENT_LLM_MAX_CONTEXT_BYTES", "")
}
func TestDeepSeekEnvironmentDefaults(t *testing.T) {
	for _, endpoint := range []string{"", "https://api.deepseek.com", "https://api.deepseek.com/v1/"} {
		t.Run(endpoint, func(t *testing.T) {
			clearModelEnvironment(t)
			t.Setenv("WRITER_AGENT_LLM_API_KEY", "test-only-key")
			t.Setenv("WRITER_AGENT_LLM_BASE_URL", endpoint)
			c, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			if c.Provider != "openai-compatible" || c.Model != "deepseek-flash" || c.ResponseFormat != "json_object" || c.TokenParameter != "max_tokens" || c.Timeout != 180*time.Second || c.MaxOutputTokens != 131072 || c.MaxContextBytes != 65536 {
				t.Fatal("incorrect DeepSeek defaults")
			}
			if endpoint == "" && c.BaseURL != "https://api.deepseek.com" {
				t.Fatal("incorrect default endpoint")
			}
		})
	}
}
func TestEnvironmentOverridesAndOtherProviders(t *testing.T) {
	clearModelEnvironment(t)
	t.Setenv("WRITER_AGENT_LLM_API_KEY", "test-only-key")
	for name, value := range map[string]string{"MODEL": "explicit-model", "RESPONSE_FORMAT": "none", "TOKEN_PARAMETER": "max_completion_tokens", "TIMEOUT_SECONDS": "42", "MAX_OUTPUT_TOKENS": "512"} {
		t.Setenv("WRITER_AGENT_LLM_"+name, value)
	}
	t.Setenv("WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS", "4096")
	c, err := Load()
	if err != nil || c.Model != "explicit-model" || c.ResponseFormat != "none" || c.TokenParameter != "max_completion_tokens" || c.Timeout != 42*time.Second || c.MaxOutputTokens != 512 || c.MaxContextBytes != 4096 {
		t.Fatal("explicit configuration was not preserved", err)
	}
	for _, endpoint := range []string{"http://127.0.0.1:11434/v1", "https://other.example/v1", "https://api.deepseek.com.attacker.test"} {
		clearModelEnvironment(t)
		t.Setenv("WRITER_AGENT_LLM_BASE_URL", endpoint)
		t.Setenv("WRITER_AGENT_LLM_API_KEY", "test-only-key")
		if _, err := Load(); errorCode(err) != "LLM_INVALID_CONFIG" {
			t.Fatal("third-party endpoint must require its own model")
		}
		t.Setenv("WRITER_AGENT_LLM_MODEL", "other-model")
		c, err := Load()
		if err != nil || c.ResponseFormat != "none" || c.TokenParameter != "max_completion_tokens" || c.Timeout != 60*time.Second || c.MaxOutputTokens != 2048 {
			t.Fatal("changed third-party provider defaults", err)
		}
	}
	clearModelEnvironment(t)
	t.Setenv("WRITER_AGENT_LLM_MODEL", "deepseek-flash")
	if _, err := Load(); errorCode(err) != "LLM_INVALID_CONFIG" {
		t.Fatal("remote endpoint must still require a key")
	}
	t.Setenv("WRITER_AGENT_LLM_API_KEY", "test-only-key")
	t.Setenv("WRITER_AGENT_LLM_TOKEN_PARAMETER", "invalid")
	if _, err := Load(); errorCode(err) != "LLM_INVALID_CONFIG" {
		t.Fatal("invalid explicit value silently fell back")
	}
}
func TestConfigurationAndPrivacy(t *testing.T) {
	clearModelEnvironment(t)
	if _, e := Load(); errorCode(e) != "LLM_NOT_CONFIGURED" {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		name, url, key, format, param string
		ok                            bool
	}{
		{"local", "http://127.0.0.1:11434/v1", "", "none", "max_tokens", true},
		{"local v6", "http://[::1]:11434/v1", "", "json_object", "max_tokens", true},
		{"https", "https://model.example.test/v1", "server-secret", "json_schema", "max_completion_tokens", true},
		{"remote http", "http://model.example.test/v1", "server-secret", "none", "max_tokens", false},
		{"credentials in URL", "https://key:secret@model.example.test/v1", "server-secret", "none", "max_tokens", false},
		{"query secret", "https://model.example.test/v1?key=secret", "server-secret", "none", "max_tokens", false},
		{"no remote key", "https://model.example.test/v1", "", "none", "max_tokens", false},
		{"unknown format", "https://model.example.test/v1", "server-secret", "guess", "max_tokens", false},
		{"unknown token parameter", "https://model.example.test/v1", "server-secret", "none", "unbounded", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testConfig(tc.url)
			c.APIKey = tc.key
			c.ResponseFormat = tc.format
			c.TokenParameter = tc.param
			if (c.Validate() == nil) != tc.ok {
				t.Fatal("wrong validity")
			}
			info, _ := json.Marshal(c.Info())
			if strings.Contains(string(info), "server-secret") {
				t.Fatal("public model leaked key")
			}
		})
	}
	t.Setenv("WRITER_AGENT_LLM_BASE_URL", "http://localhost:11434/v1")
	t.Setenv("WRITER_AGENT_LLM_MODEL", "fixture")
	t.Setenv("WRITER_AGENT_LLM_TIMEOUT_SECONDS", "999")
	if _, e := Load(); errorCode(e) != "LLM_INVALID_CONFIG" {
		t.Fatal(e)
	}
}
func TestCompatibleRequestModes(t *testing.T) {
	for _, mode := range []string{"none", "json_object", "json_schema"} {
		t.Run(mode, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer server-secret" {
					t.Error("wrong authenticated endpoint")
				}
				var body map[string]any
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					t.Error("invalid request")
				}
				if body["model"] != "fixture-model" || body["max_completion_tokens"] != float64(1024) || body["stream"] != false {
					t.Error("missing bounded request")
				}
				if mode == "none" {
					if _, ok := body["response_format"]; ok {
						t.Error("guessed unsupported output capability")
					}
				} else if body["response_format"].(map[string]any)["type"] != mode {
					t.Error("wrong configured mode")
				}
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"findings\":[]}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5}}`))
			}))
			defer server.Close()
			c := testConfig(server.URL + "/v1")
			c.APIKey = "server-secret"
			c.ResponseFormat = mode
			client, e := New(c)
			if e != nil {
				t.Fatal(e)
			}
			result, e := client.Generate(context.Background(), Request{System: "JSON only", Input: "fixture", Schema: map[string]any{"type": "object"}})
			if e != nil || result.Text != `{"findings":[]}` || result.Usage == nil || result.Usage.InputTokens != 20 || calls.Load() != 1 {
				t.Fatal(result, e)
			}
		})
	}
}
func TestProviderFailuresBoundedAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		name, body, code string
		status           int
	}{
		{"http failure", "secret manuscript provider error", "LLM_HTTP_ERROR", 503},
		{"invalid JSON", "<html>secret</html>", "LLM_INVALID_RESPONSE", 200},
		{"empty choices", `{"choices":[]}`, "LLM_INVALID_RESPONSE", 200},
		{"truncated", `{"choices":[{"message":{"content":"{}"},"finish_reason":"length"}]}`, "LLM_INCOMPLETE_OUTPUT", 200},
		{"refusal", `{"choices":[{"message":{"refusal":"no","content":null},"finish_reason":"stop"}]}`, "LLM_REFUSED", 200},
		{"tool calls", `{"choices":[{"message":{"content":"{}","tool_calls":[{"function":{"name":"write_manuscript"}}]},"finish_reason":"stop"}]}`, "LLM_TOOL_OUTPUT_FORBIDDEN", 200},
		{"large", strings.Repeat("x", 2000), "LLM_RESPONSE_TOO_LARGE", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			c := testConfig(server.URL)
			c.MaxResponseBytes = 1024
			client, _ := New(c)
			_, e := client.Generate(context.Background(), Request{})
			if errorCode(e) != tc.code || calls.Load() != 1 || strings.Contains(e.Error(), "secret") {
				t.Fatal(e, calls.Load())
			}
		})
	}
}
func TestTimeoutCancellationAndNoRedirect(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer redirect.Close()
	client, _ := New(testConfig(redirect.URL))
	if _, e := client.Generate(context.Background(), Request{}); errorCode(e) != "LLM_HTTP_ERROR" || redirected.Load() != 0 {
		t.Fatal(e, "redirect followed")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
	}))
	defer server.Close()
	client, _ = New(testConfig(server.URL))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, e := client.Generate(ctx, Request{}); errorCode(e) != "LLM_TIMEOUT" {
		t.Fatal(e)
	}
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	if _, e := client.Generate(ctx2, Request{}); !errors.Is(e, context.Canceled) {
		t.Fatal(e)
	}
}

func TestByteCapacitySettingPrecedenceAndOutputLimit(t *testing.T) {
	clearModelEnvironment(t)
	t.Setenv("WRITER_AGENT_LLM_API_KEY", "test-only-key")
	t.Setenv("WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS", "4096")
	t.Setenv("WRITER_AGENT_LLM_MAX_CONTEXT_BYTES", "65536")
	t.Setenv("WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS", "131072")
	c, err := Load()
	if err != nil || c.MaxContextBytes != 65536 || c.MaxOutputTokens != 131072 {
		t.Fatal("byte setting precedence or extended output failed", err)
	}
	t.Setenv("WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS", "131073")
	if _, err = Load(); err == nil {
		t.Fatal("unbounded output accepted")
	}
}

func TestProviderCacheUsageIsValidated(t *testing.T) {
	for _, tc := range []struct {
		details string
		want    int
	}{
		{`"prompt_cache_hit_tokens":9000`, 9000},
		{`"prompt_tokens_details":{"cached_tokens":8000}`, 8000},
		{`"prompt_cache_hit_tokens":9000,"prompt_tokens_details":{"cached_tokens":9000}`, 9000},
		{`"prompt_cache_hit_tokens":10001`, 0},
		{`"prompt_cache_hit_tokens":-1`, 0},
		{`"prompt_cache_hit_tokens":9000,"prompt_tokens_details":{"cached_tokens":8000}`, 0},
	} {
		t.Run(tc.details, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10000,"completion_tokens":100,` + tc.details + `}}`))
			}))
			defer server.Close()
			client, e := New(testConfig(server.URL))
			if e != nil {
				t.Fatal(e)
			}
			response, e := client.Generate(context.Background(), Request{System: "fixture", Input: "fixture"})
			if e != nil {
				t.Fatal(e)
			}
			if response.Usage == nil || response.Usage.InputTokens != 10000 || response.Usage.CachedInputTokens != tc.want {
				t.Fatal(response.Usage)
			}
		})
	}
}

func TestConsentedOutputLimitBoundsActualProviderRequest(t *testing.T) {
	var output int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		output = int(body["max_completion_tokens"].(float64))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":8}}`))
	}))
	defer server.Close()
	c, e := New(testConfig(server.URL))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = c.Generate(context.Background(), Request{System: "fixture", Input: "synthetic", OutputLimit: 512}); e != nil || output != 512 {
		t.Fatal(output, e)
	}
	if _, e = c.Generate(context.Background(), Request{OutputLimit: 2048}); errorCode(e) != "LLM_INVALID_REQUEST" {
		t.Fatal("request may not raise configured ceiling", e)
	}
}

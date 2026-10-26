package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

type OpenAICompatible struct {
	Config Config
	HTTP   *http.Client
}

func New(c Config) (*OpenAICompatible, error) {
	if e := c.Validate(); e != nil {
		return nil, e
	}
	return &OpenAICompatible{Config: c, HTTP: &http.Client{Timeout: c.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *OpenAICompatible) Generate(ctx context.Context, r Request) (Response, error) {
	timeout, cancel := context.WithTimeout(ctx, c.Config.Timeout)
	defer cancel()
	payload := map[string]any{"model": c.Config.Model, "messages": []map[string]string{{"role": "system", "content": r.System}, {"role": "user", "content": r.Input}}, c.Config.TokenParameter: c.Config.MaxOutputTokens, "stream": false}
	if c.Config.ResponseFormat == "json_object" {
		payload["response_format"] = map[string]any{"type": "json_object"}
	}
	if c.Config.ResponseFormat == "json_schema" {
		payload["response_format"] = map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": schemaName(r), "strict": true, "schema": r.Schema}}
	}
	data, e := json.Marshal(payload)
	if e != nil {
		return Response{}, Fail("LLM_INVALID_REQUEST")
	}
	req, e := http.NewRequestWithContext(timeout, "POST", strings.TrimRight(c.Config.BaseURL, "/")+"/chat/completions", bytes.NewReader(data))
	if e != nil {
		return Response{}, Fail("LLM_INVALID_CONFIG")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.Config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.Config.APIKey)
	}
	res, e := c.HTTP.Do(req)
	if e != nil {
		if errors.Is(timeout.Err(), context.DeadlineExceeded) {
			return Response{}, Fail("LLM_TIMEOUT")
		}
		if ctx.Err() != nil {
			return Response{}, ctx.Err()
		}
		return Response{}, Fail("LLM_NETWORK_ERROR")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return Response{}, Fail("LLM_HTTP_ERROR")
	}
	body, e := io.ReadAll(io.LimitReader(res.Body, int64(c.Config.MaxResponseBytes)+1))
	if e != nil {
		return Response{}, Fail("LLM_RESPONSE_ERROR")
	}
	if len(body) > c.Config.MaxResponseBytes {
		return Response{}, Fail("LLM_RESPONSE_TOO_LARGE")
	}
	var decoded struct {
		Choices []struct {
			Message struct {
				Content   *string           `json:"content"`
				Refusal   *string           `json:"refusal"`
				ToolCalls []json.RawMessage `json:"tool_calls"`
			} `json:"message"`
			Finish string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			Prompt        *int `json:"prompt_tokens"`
			CacheHit      *int `json:"prompt_cache_hit_tokens"`
			PromptDetails *struct {
				Cached *int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
			Completion *int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(body, &decoded) != nil || len(decoded.Choices) != 1 {
		return Response{}, Fail("LLM_INVALID_RESPONSE")
	}
	choice := decoded.Choices[0]
	if choice.Message.Refusal != nil && *choice.Message.Refusal != "" {
		return Response{}, Fail("LLM_REFUSED")
	}
	if len(choice.Message.ToolCalls) > 0 {
		return Response{}, Fail("LLM_TOOL_OUTPUT_FORBIDDEN")
	}
	// The HTTP body is capped by MaxResponseBytes. Do not reject an otherwise
	// complete structured response at the older 64 KiB content ceiling.
	if choice.Finish != "stop" || choice.Message.Content == nil {
		return Response{}, Fail("LLM_INCOMPLETE_OUTPUT")
	}
	var usage *Usage
	if decoded.Usage != nil && decoded.Usage.Prompt != nil && decoded.Usage.Completion != nil && *decoded.Usage.Prompt >= 0 && *decoded.Usage.Prompt <= 1000000 && *decoded.Usage.Completion >= 0 && *decoded.Usage.Completion <= c.Config.MaxOutputTokens {
		var details *int
		if decoded.Usage.PromptDetails != nil {
			details = decoded.Usage.PromptDetails.Cached
		}
		usage = &Usage{InputTokens: *decoded.Usage.Prompt, OutputTokens: *decoded.Usage.Completion, CachedInputTokens: CachedInput(*decoded.Usage.Prompt, decoded.Usage.CacheHit, details)}
	}
	return Response{*choice.Message.Content, usage}, nil
}

func schemaName(r Request) string {
	if r.SchemaName == "knowledge_extraction" {
		return r.SchemaName
	}
	return "writing_review"
}

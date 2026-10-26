// Package llm provides bounded, non-streaming model calls. It owns no manuscript tools.
package llm

import "context"

type Usage struct {
	CachedInputTokens int `json:"cachedInputTokens,omitempty"`
	InputTokens       int `json:"inputTokens"`
	OutputTokens      int `json:"outputTokens"`
}
type Request struct {
	OutputLimit int            `json:"outputLimit,omitempty"`
	System      string         `json:"system"`
	Input       string         `json:"input"`
	SchemaName  string         `json:"schemaName"`
	Schema      map[string]any `json:"schema"`
}
type Response struct {
	Text  string `json:"text"`
	Usage *Usage `json:"usage"`
}
type Client interface {
	Generate(context.Context, Request) (Response, error)
}
type Error struct{ Code string }

func (e *Error) Error() string { return e.Code }
func Fail(code string) error   { return &Error{Code: code} }

// CachedInput accepts either DeepSeek or OpenAI cache reporting. Invalid or
// inconsistent optional details receive no discount; total input stays intact.
func CachedInput(total int, hit, details *int) int {
	if hit != nil && details != nil && *hit != *details {
		return 0
	}
	if hit == nil {
		hit = details
	}
	if hit == nil || *hit < 0 || *hit > total {
		return 0
	}
	return *hit
}

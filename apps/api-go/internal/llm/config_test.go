package llm

import (
	"testing"
	"time"
)

func TestFingerprintTracksModelIdentity(t *testing.T) {
	c := testConfig("https://model.example/v1")
	want := c.Fingerprint()
	c.APIKey = "new-key"
	c.MaxOutputTokens *= 2
	c.MaxContextBytes *= 2
	c.MaxResponseBytes *= 2
	c.Timeout += time.Second
	c.TokenParameter = "max_tokens"
	c.ResponseFormat = "json_object"
	if c.Fingerprint() != want {
		t.Fatal("runtime settings changed the model identity")
	}
	for _, change := range []func(*Config){
		func(c *Config) { c.Provider = "another-provider" },
		func(c *Config) { c.Model = "another-model" },
		func(c *Config) { c.BaseURL = "https://another.example/v1" },
	} {
		next := c
		change(&next)
		if next.Fingerprint() == want {
			t.Fatal("model identity change was ignored")
		}
	}
}

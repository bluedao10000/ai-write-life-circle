package agenttasks

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListenerRejectsSharedCredentials(t *testing.T) {
	for _, name := range []string{"WRITER_AGENT_AUTH_TOKEN_FILE", "WRITER_AGENT_PI_SERVICE_TOKEN_FILE", "WRITER_AGENT_PI_CAPABILITY_KEY_FILE"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "token")
			if e := os.WriteFile(path, []byte("0123456789012345678901234567890123456789"), 0600); e != nil {
				t.Fatal(e)
			}
			t.Setenv("WRITER_AGENT_TASK_SERVICE_TOKEN_FILE", path)
			t.Setenv(name, path)
			s := &Service{}
			server, e := s.Listen()
			if server != nil {
				server.Close()
			}
			if e == nil {
				t.Fatal("shared credential accepted")
			}
		})
	}
}

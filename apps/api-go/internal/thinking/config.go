package thinking

import (
	"errors"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func readSecret(path string) (string, error) {
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0137 != 0 || info.Size() > 256 {
		return "", errors.New("Pi credential requires a protected regular file (0600 or 0640)")
	}
	raw, e := os.ReadFile(path)
	v := strings.TrimSpace(string(raw))
	if e != nil || len(v) < 32 {
		return "", errors.New("invalid Pi credential")
	}
	return v, nil
}

// Configure is opt-in. Misconfiguration disables Thinking, never manuscript APIs.
func (s *Service) Configure() (string, error) {
	s.Origin = os.Getenv("WRITER_AGENT_PI_ORIGIN")
	if s.Origin == "" {
		return "", nil
	}
	if e := ValidateOrigin(s.Origin); e != nil {
		return "", e
	}
	token, e := readSecret(os.Getenv("WRITER_AGENT_PI_SERVICE_TOKEN_FILE"))
	if e != nil {
		return "", e
	}
	secret, e := readSecret(os.Getenv("WRITER_AGENT_PI_CAPABILITY_KEY_FILE"))
	if e != nil {
		return "", e
	}
	if token == secret {
		return "", errors.New("Pi capability key must differ from service token")
	}
	s.ServiceToken = token
	s.Secret = []byte(secret)
	s.Client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	host := os.Getenv("WRITER_AGENT_PI_INTERNAL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", errors.New("Pi tools require loopback listener")
	}
	port := os.Getenv("WRITER_AGENT_PI_INTERNAL_PORT")
	if port == "" {
		port = "8791"
	}
	n, e := strconv.Atoi(port)
	if e != nil || n < 1 || n > 65535 {
		return "", errors.New("invalid Pi internal port")
	}
	return net.JoinHostPort(host, port), nil
}

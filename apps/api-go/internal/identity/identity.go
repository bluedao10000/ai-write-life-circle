// Package identity authenticates one configured author. It never trusts request actor headers.
package identity

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/config"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/transport"
)

func New(c config.Config) (transport.Resolver, error) {
	if c.AuthMode == "local" && (c.Environment == "development" || c.Environment == "test") {
		return func(*http.Request) *application.Actor { return &application.Actor{ID: "local-author", Role: "author"} }, nil
	}
	if c.AuthMode != "bearer" || !application.SafeKey(c.AuthorID) {
		return nil, errors.New("bearer identity requires a stable valid author ID")
	}
	// Reject symlinks, devices and files readable by other users or writable by the group.
	info, err := os.Lstat(c.AuthTokenFile)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0137 != 0 || info.Size() > 128 {
		return nil, errors.New("bearer token must be a regular protected file (0600 or 0640), at most 128 bytes")
	}
	file, err := os.Open(c.AuthTokenFile)
	if err != nil {
		return nil, errors.New("cannot open bearer token file")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 129))
	if err != nil {
		return nil, errors.New("cannot read bearer token file")
	}
	token := strings.TrimSpace(string(data))
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 || len(token) != 64 {
		return nil, errors.New("bearer token must contain 64 hexadecimal characters generated from 32 random bytes")
	}
	expected := sha256.Sum256([]byte(token))
	return func(r *http.Request) *application.Actor {
		values := r.Header.Values("Authorization")
		if len(values) != 1 {
			return nil
		}
		fields := strings.Fields(values[0])
		if len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			return nil
		}
		actual := sha256.Sum256([]byte(fields[1]))
		if subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			return nil
		}
		return &application.Actor{ID: c.AuthorID, Role: "author"}
	}, nil
}

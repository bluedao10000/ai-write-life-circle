package transport

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/epub"
)

// Run with CADDY_BIN pointing to the same Caddy version as production. CI
// installs that version and runs this test explicitly; ordinary unit runs skip it.
func TestEPUBCaddyUploadBoundary(t *testing.T) {
	binary := os.Getenv("CADDY_BIN")
	if binary == "" {
		t.Skip("set CADDY_BIN to run the real proxy boundary test")
	}
	handler, _ := importHandler(t)
	backend := httptest.NewServer(handler)
	defer backend.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	config, err := os.ReadFile("../../../../scripts/deploy/Caddyfile.api")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(config), "{$WRITER_AGENT_API_DOMAIN}", "http://"+address)
	text = strings.ReplaceAll(text, "127.0.0.1:8787", strings.TrimPrefix(backend.URL, "http://"))
	configPath := filepath.Join(t.TempDir(), "Caddyfile")
	if err := os.WriteFile(configPath, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary, "run", "--config", configPath, "--adapter", "caddyfile")
	logFile, err := os.CreateTemp(t.TempDir(), "caddy-log")
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	ready := false
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		conn, err := net.DialTimeout("tcp", address, 100*time.Millisecond)
		if err == nil {
			conn.Close()
			ready = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		data, _ := os.ReadFile(logFile.Name())
		t.Fatalf("Caddy did not start: %s", data)
	}
	fixture := transportEPUB(t)
	// Store inert assets without compression, keeping every ZIP entry below its
	// individual limit. This produces a valid EPUB exactly at the archive limit.
	padded := func(padding int) []byte {
		var buffer bytes.Buffer
		writer := zip.NewWriter(&buffer)
		reader, err := zip.NewReader(bytes.NewReader(fixture), int64(len(fixture)))
		if err != nil {
			t.Fatal(err)
		}
		for _, file := range reader.File {
			if err := writer.Copy(file); err != nil {
				t.Fatal(err)
			}
		}
		for i := 0; i < 3; i++ {
			part, err := writer.CreateHeader(&zip.FileHeader{Name: fmt.Sprintf("asset-%d.dat", i), Method: zip.Store})
			if err != nil {
				t.Fatal(err)
			}
			size := padding / 3
			if i == 2 {
				size += padding % 3
			}
			if _, err := io.CopyN(part, zeroReader{}, int64(size)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		return buffer.Bytes()
	}
	overhead := len(padded(0))
	data := padded(epub.MaxArchiveBytes - overhead)
	if len(data) != epub.MaxArchiveBytes {
		t.Fatal("fixture size", len(data))
	}
	client := &http.Client{Timeout: 30 * time.Second}
	for _, extra := range []int{0, 1} {
		t.Run(fmt.Sprintf("64MiB-plus-%d", extra), func(t *testing.T) {
			archive := data
			if extra > 0 {
				archive = append(archive[:len(archive):len(archive)], 'x')
			}
			request := uploadRequest(t, archive, fmt.Sprintf("boundary-%d", extra))
			request.URL.Scheme, request.URL.Host = "http", address
			request.RequestURI = ""
			request.Host = address
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if extra == 0 {
				var preview application.ImportPreview
				if response.StatusCode != 201 || json.Unmarshal(body, &preview) != nil || len(preview.Chapters) != 1 {
					t.Fatalf("boundary upload: %d %s", response.StatusCode, body)
				}
			} else if response.StatusCode != 413 || !bytes.Contains(body, []byte("EPUB_SIZE_INVALID")) {
				t.Fatalf("Go must reject oversized EPUB after proxy accepts multipart: %d %s", response.StatusCode, body)
			}
		})
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }

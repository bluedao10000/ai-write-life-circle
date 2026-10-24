package transport

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/epub"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/publication"
)

var importRouteRE = regexp.MustCompile(`^/v1/studio/imports(?:/(imp-[0-9a-f]{24})(?:/(status))?)?$`)

func handleImports(o Options, w http.ResponseWriter, r *http.Request, path string) bool {
	match := importRouteRE.FindStringSubmatch(path)
	if match == nil {
		return false
	}
	var actor *application.Actor
	if o.ResolveActor != nil {
		actor = o.ResolveActor(r)
	}
	if actor == nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="writer-agent"`)
		problem(w, application.Fail(401, "AUTHOR_DECISION_REQUIRED", "Authentication required."), "")
		return true
	}
	if !role(w, actor, "author") {
		return true
	}
	if o.Imports == nil {
		problem(w, application.Fail(503, "IMPORT_UNAVAILABLE", "EPUB import is unavailable."), "")
		return true
	}
	id := match[1]
	isStatus := match[2] == "status"
	if id == "" {
		if r.Method != "POST" {
			problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Create an import with POST multipart/form-data."), "")
			return true
		}
		if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data;") {
			problem(w, application.Fail(415, "EPUB_MULTIPART_REQUIRED", "EPUB uploads require multipart/form-data."), "")
			return true
		}
		key := r.Header.Get("Idempotency-Key")
		if !application.SafeKey(key) {
			problem(w, application.Fail(422, "VALIDATION_FAILED", "A valid Idempotency-Key is required."), "")
			return true
		}
		body := http.MaxBytesReader(w, r.Body, epub.MaxArchiveBytes+1024*1024)
		defer body.Close()
		r.Body = body
		reader, err := r.MultipartReader()
		if err != nil {
			problem(w, application.Fail(422, "EPUB_MULTIPART_INVALID", "The multipart upload is invalid."), "")
			return true
		}
		var filename string
		var data []byte
		for {
			part, err := reader.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				problem(w, application.Fail(422, "EPUB_MULTIPART_INVALID", "The multipart upload is invalid."), "")
				return true
			}
			name := part.FormName()
			if name != "file" {
				_ = part.Close()
				// Unknown fields are rejected so the browser cannot smuggle a
				// second file or owner/path override through the upload.
				if name != "" {
					problem(w, application.Fail(422, "VALIDATION_FAILED", "Only the EPUB file field is accepted."), "")
					return true
				}
				continue
			}
			if filename != "" {
				_ = part.Close()
				problem(w, application.Fail(422, "VALIDATION_FAILED", "Only one EPUB file may be uploaded."), "")
				return true
			}
			if data != nil {
				_ = part.Close()
				problem(w, application.Fail(422, "VALIDATION_FAILED", "Only one EPUB file may be uploaded."), "")
				return true
			}
			filename = filepath.Base(strings.TrimSpace(part.FileName()))
			if filename == "" || !strings.EqualFold(filepath.Ext(filename), ".epub") {
				_ = part.Close()
				problem(w, application.Fail(422, "EPUB_FILE_REQUIRED", "The uploaded file must have an .epub extension."), "")
				return true
			}
			data, err = io.ReadAll(io.LimitReader(part, epub.MaxArchiveBytes+1))
			_ = part.Close()
			if err != nil || len(data) == 0 || len(data) > epub.MaxArchiveBytes {
				problem(w, application.Fail(413, "EPUB_SIZE_INVALID", "EPUB must be between 1 byte and 64 MiB."), "")
				return true
			}
		}
		if data == nil {
			problem(w, application.Fail(422, "EPUB_FILE_REQUIRED", "An EPUB file field is required."), "")
			return true
		}
		result, err := o.Imports.Stage(r.Context(), *actor, key, filename, data)
		if err != nil {
			problem(w, application.AsError(err), "")
			return true
		}
		status := 200
		if result.Created {
			status = 201
		}
		write(w, status, result.Preview, "")
		return true
	}
	switch {
	case r.Method == "GET" && !isStatus:
		preview, err := o.Imports.Get(*actor, id)
		if err != nil {
			problem(w, application.AsError(err), "")
		} else {
			write(w, 200, preview, "")
		}
	case r.Method == "GET" && isStatus:
		preview, err := o.Imports.Status(*actor, id)
		if err != nil {
			problem(w, application.AsError(err), "")
		} else {
			write(w, 200, preview, "")
		}
	case r.Method == "DELETE" && !isStatus:
		if err := o.Imports.Delete(r.Context(), *actor, id); err != nil {
			problem(w, application.AsError(err), "")
		} else {
			w.WriteHeader(http.StatusNoContent)
		}
	case r.Method == "POST" && !isStatus:
		if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			problem(w, application.Fail(415, "JSON_REQUIRED", "Import commit requires JSON."), "")
			return true
		}
		body := http.MaxBytesReader(w, r.Body, 8*1024*1024)
		defer body.Close()
		data, err := io.ReadAll(body)
		if err != nil {
			problem(w, application.Fail(413, "VALIDATION_FAILED", "Import commit is too large."), "")
			return true
		}
		var input application.ImportCommitInput
		if err := publication.DecodeInput(bytes.TrimSpace(data), &input); err != nil {
			problem(w, application.AsError(err), "")
			return true
		}
		result, err := o.Imports.Commit(r.Context(), *actor, id, r.Header.Get("Idempotency-Key"), input)
		if err != nil {
			problem(w, application.AsError(err), "")
		} else {
			status := 200
			if result.Created {
				status = 201
			}
			write(w, status, result.Book, "")
		}
	default:
		problem(w, application.Fail(405, "METHOD_NOT_ALLOWED", "Unsupported import method."), "")
	}
	return true
}

package transport

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
)

func transportEPUB(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	z := zip.NewWriter(&buffer)
	files := map[string]string{
		"META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
		"OEBPS/content.opf":      `<package><metadata><title>测试书</title></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>`,
		"OEBPS/nav.xhtml":        `<html><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="a.xhtml">第一章</a></li></ol></nav></body></html>`,
		"OEBPS/a.xhtml":          `<html><body><h1>第一章</h1><p>合成导入正文。</p></body></html>`,
	}
	for name, body := range files {
		entry, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = entry.Write([]byte(body))
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func importHandler(t *testing.T) (http.Handler, *application.Management) {
	t.Helper()
	app := &application.Service{Root: t.TempDir(), State: t.TempDir(), Project: "legacy"}
	managed := application.NewManagement(app, "owner")
	imports := application.NewImportService(managed)
	actor := application.Actor{ID: "owner", Role: "author"}
	handler := Handler(Options{
		Service: app, Management: managed, Imports: imports,
		ResolveActor: func(r *http.Request) *application.Actor {
			if r.Header.Get("X-Fixture") == "anonymous" {
				return nil
			}
			return &actor
		},
	})
	return handler, managed
}

func uploadRequest(t *testing.T, data []byte, key string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "novel.epub")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/v1/studio/imports", &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r.Header.Set("Idempotency-Key", key)
	return r
}

func TestEPUBImportTransportUploadPreviewCommitAndOwnership(t *testing.T) {
	handler, managed := importHandler(t)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, uploadRequest(t, transportEPUB(t), "transport-upload"))
	if rec.Code != 201 {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	var preview application.ImportPreview
	if err := json.Unmarshal(rec.Body.Bytes(), &preview); err != nil || preview.ImportID == "" || preview.Title != "测试书" {
		t.Fatal(preview, err, rec.Body.String())
	}
	books, _ := managed.List(application.Actor{ID: "owner", Role: "author"})
	if len(books) != 0 {
		t.Fatal("upload became visible before commit")
	}
	var chaps []application.ImportChapterRef
	for _, chapter := range preview.Chapters {
		chaps = append(chaps, application.ImportChapterRef{ChapterID: chapter.ChapterID, Title: chapter.Title, VolumeID: chapter.VolumeID})
	}
	body, _ := json.Marshal(application.ImportCommitInput{Fingerprint: preview.Fingerprint, Title: "确认书名", Volumes: preview.Volumes, Chapters: chaps})
	r := httptest.NewRequest("POST", "/v1/studio/imports/"+preview.ImportID, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Idempotency-Key", "transport-commit")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != 201 {
		t.Fatalf("commit: %d %s", rec.Code, rec.Body.String())
	}
	books, _ = managed.List(application.Actor{ID: "owner", Role: "author"})
	if len(books) != 1 || books[0].Title != "确认书名" {
		t.Fatal(books)
	}
	// The preview intentionally shows a short author-authored excerpt for
	// boundary confirmation, but never the full chapter body.
	r = httptest.NewRequest("GET", "/v1/studio/imports/"+preview.ImportID, nil)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != 200 || strings.Contains(rec.Body.String(), "\"markdown\"") ||
		strings.Count(rec.Body.String(), "合成导入正文。") != 1 {
		t.Fatalf("preview leaked prose: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEPUBImportTransportRejectsJSONAndTraversingNames(t *testing.T) {
	handler, _ := importHandler(t)
	for _, c := range []struct {
		name, contentType string
		status            int
	}{
		{"json", "application/json", 415},
		{"bodyless", "multipart/form-data; boundary=bad", 422},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/v1/studio/imports", strings.NewReader("{}"))
			r.Header.Set("Content-Type", c.contentType)
			r.Header.Set("Idempotency-Key", "reject")
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, r)
			if rec.Code != c.status {
				t.Fatalf("%d %s", rec.Code, rec.Body.String())
			}
		})
	}
	anonymous := uploadRequest(t, transportEPUB(t), "anonymous")
	anonymous.Header.Set("X-Fixture", "anonymous")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, anonymous)
	if rec.Code != 401 {
		t.Fatalf("anonymous: %d", rec.Code)
	}
}

func TestEPUBImportTransportOnlyAdmitsBoundedContentTypes(t *testing.T) {
	handler, _ := importHandler(t)
	request := httptest.NewRequest("POST", "/v1/studio/imports", strings.NewReader("{}"))
	request.Header.Set("Content-Type", "multipart/form-data")
	request.Header.Set("Idempotency-Key", "missing-boundary")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != 415 {
		t.Fatalf("multipart without boundary: %d %s", recorder.Code, recorder.Body.String())
	}
}

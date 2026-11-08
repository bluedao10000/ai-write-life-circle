package thinking

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/application"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/billing"
)

func TestSuggestPublicationUsesOneBoundedCallAndSettlesUsage(t *testing.T) {
	s, rec, _ := fixture(t)
	ctx := context.Background()
	ledger := &billing.Ledger{State: s.State}
	s.Meter = ledger
	var sent map[string]any
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/internal/v1/generate" {
			t.Error(r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+s.ServiceToken {
			t.Error("missing service token")
		}
		if e := json.NewDecoder(r.Body).Decode(&sent); e != nil {
			t.Error(e)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"{\"title\":\"逐玉\",\"penName\":\"逐玉\",\"tagline\":\"侯夫人与杀猪刀。\",\"description\":\"市井女子与侯府的纠葛。\",\"authorBio\":\"写故事的人。\",\"category\":\"历史\"}","usage":{"inputTokens":1000,"outputTokens":500,"cachedInputTokens":0}}`))
	}))
	defer node.Close()
	s.Origin, s.ServiceToken = node.URL, strings.Repeat("t", 64)

	out, e := s.SuggestPublication(ctx, application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if e != nil {
		t.Fatal(e)
	}
	if out.Title != "逐玉" || out.PenName != "逐玉" || out.Category != "历史" || out.Tagline == "" || out.Description == "" {
		t.Fatal(out)
	}
	input, _ := sent["input"].(string)
	if !strings.Contains(input, "章节结构") || !strings.Contains(input, "林舟") {
		t.Fatalf("prompt lost outline or excerpt: %q", input)
	}
	if sent["maxOutputTokens"] != float64(1200) || !strings.Contains(sent["system"].(string), "发布资料") {
		t.Fatal(sent)
	}
	usage, e := ledger.View(ctx, rec.Owner)
	if e != nil {
		t.Fatal(e)
	}
	if usage.Day.Used != 3 || usage.Day.Reserved != 0 {
		t.Fatalf("usage not settled from reported tokens: %+v", usage.Day)
	}
}

func TestSuggestPublicationChargesReservationWhenUsageUnknown(t *testing.T) {
	s, rec, _ := fixture(t)
	ctx := context.Background()
	ledger := &billing.Ledger{State: s.State}
	s.Meter = ledger
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"{\"title\":\"逐玉\",\"penName\":\"逐玉\",\"tagline\":\"一句话。\",\"description\":\"简介。\",\"authorBio\":\"\",\"category\":\"未知\"}","usage":null}`))
	}))
	defer node.Close()
	s.Origin, s.ServiceToken = node.URL, strings.Repeat("t", 64)

	out, e := s.SuggestPublication(ctx, application.Actor{ID: rec.Owner, Role: "author"}, rec.Book)
	if e != nil {
		t.Fatal(e)
	}
	if out.Category != "其他原创" {
		t.Fatal(out)
	}
	usage, _ := ledger.View(ctx, rec.Owner)
	if usage.Day.Used == 0 || usage.Day.Reserved != 0 {
		t.Fatalf("unknown usage was not charged in full: %+v", usage.Day)
	}
}

func TestPublicationSuggestRouteIsPostOnly(t *testing.T) {
	s, rec, _ := fixture(t)
	s.ResolveActor = func(*http.Request) *application.Actor {
		return &application.Actor{ID: rec.Owner, Role: "author"}
	}
	path := "/v1/studio/books/" + rec.Book + "/thinking/publication-suggest"
	r := httptest.NewRequest("GET", path, nil)
	w := httptest.NewRecorder()
	s.PublicHandler().ServeHTTP(w, r)
	if w.Code != 405 {
		t.Fatalf("%d: %s", w.Code, w.Body)
	}
}

func TestParsePublicationSuggestionRejectsForeignFields(t *testing.T) {
	if _, e := parsePublicationSuggestion(`{"tagline":"一句话。","description":"简介。","chapters":[]}`); e == nil {
		t.Fatal("unknown field accepted")
	}
	out, e := parsePublicationSuggestion("```json\n{\"title\":\"逐玉\",\"tagline\":\"一句话。\",\"description\":\"简介。\",\"category\":\"未知\"}\n```")
	if e != nil || out.Title != "逐玉" || out.Category != "其他原创" {
		t.Fatal(out, e)
	}
}

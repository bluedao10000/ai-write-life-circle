package thinking

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

func rollbackFixture(t *testing.T, blocked bool) []byte {
	t.Helper()
	s, rec, _ := fixture(t)
	rec.ResumeBlocked = blocked
	rec.CancelPending = blocked
	rec.AuthorizationVersion = 2
	rec.BillOp = "think:reservation"
	rec.Billed = 27
	rec.Intake = []string{"accepted-user"}
	if e := s.tx(t.Context(), func(st *registry) error {
		st.Sessions[rec.ID] = rec
		st.Requests["receipt"] = receipt{Hash: "fingerprint", ID: rec.ID}
		st.Cancelled = map[string]bool{"receipt": blocked}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	data, e := compat.Marshal(mustLoadRegistry(t, s), false)
	if e != nil {
		t.Fatal(e)
	}
	return data
}

func mustLoadRegistry(t *testing.T, s *Service) registry {
	t.Helper()
	st, e := s.load()
	if e != nil {
		t.Fatal(e)
	}
	return st
}

func TestRollbackRegistryPreservesCompatibleCancellationAndAccounting(t *testing.T) {
	data := rollbackFixture(t, true)
	converted, e := RollbackRegistry(data, true)
	if e != nil {
		t.Fatal(e)
	}
	var current registry
	if e = json.Unmarshal(converted, &current); e != nil {
		t.Fatal(e)
	}
	if len(current.Sessions) != 1 || !current.Sessions[recID(current)].ResumeBlocked || !current.Sessions[recID(current)].CancelPending || current.Sessions[recID(current)].BillOp != "think:reservation" || current.Sessions[recID(current)].Billed != 27 {
		t.Fatalf("rollback lost durable state: %+v", current.Sessions)
	}
	if !current.Cancelled["receipt"] || current.Requests["receipt"].Hash != "fingerprint" {
		t.Fatal("rollback lost cancellation or request receipt")
	}
	// Repeatability matters when an operator resumes an interrupted maintenance run.
	again, e := RollbackRegistry(converted, true)
	if e != nil || string(again) != string(converted) {
		t.Fatalf("rollback is not idempotent: %v", e)
	}
}

func recID(st registry) string {
	for id := range st.Sessions {
		return id
	}
	return ""
}

func TestRollbackRegistryRejectsUnsafeLegacyProjection(t *testing.T) {
	data := rollbackFixture(t, true)
	if _, e := RollbackRegistry(data, false); e == nil || !strings.Contains(e.Error(), "durable cancellation fence") {
		t.Fatalf("unsafe legacy projection accepted: %v", e)
	}
	data = rollbackFixture(t, false)
	converted, e := RollbackRegistry(data, false)
	if e != nil {
		t.Fatal(e)
	}
	var strict map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(converted)))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&strict); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(converted), "cancelledReceipts") || strings.Contains(string(converted), "authorizationVersion") {
		t.Fatal("legacy projection retained unknown fields")
	}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &raw)
	var sessions map[string]json.RawMessage
	_ = json.Unmarshal(raw["sessions"], &sessions)
	for id, value := range sessions {
		var record map[string]any
		_ = json.Unmarshal(value, &record)
		record["futureField"] = true
		encoded, _ := json.Marshal(record)
		sessions[id] = encoded
	}
	raw["sessions"], _ = json.Marshal(sessions)
	data, _ = json.Marshal(raw)
	if _, e = RollbackRegistry(data, true); e == nil {
		t.Fatal("unknown state was silently discarded")
	}
}

func TestRollbackRejectsOpenBillingReservation(t *testing.T) {
	data := rollbackFixture(t, false)
	if e := AssertRegistryRollbackSafe(data); e == nil {
		t.Fatal("open billing reservation accepted for rollback")
	}
	var st map[string]any
	_ = json.Unmarshal(data, &st)
	st["sessions"] = map[string]any{}
	data, _ = json.Marshal(st)
	if e := AssertRegistryRollbackSafe(data); e != nil {
		t.Fatal(e)
	}
}

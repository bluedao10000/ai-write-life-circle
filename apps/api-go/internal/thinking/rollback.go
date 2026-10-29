package thinking

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
)

// LegacyRegistry is the complete persisted contract understood before durable
// Thinking Runs. Keep every old field: dropping a receipt or billing operation
// can repeat paid work when a service is rolled back.
type LegacyRegistry struct {
	Schema      int                     `json:"schema"`
	Sessions    map[string]LegacyRecord `json:"sessions"`
	Requests    map[string]receipt      `json:"requests"`
	Preferences map[string][]string     `json:"preferences,omitempty"`
}

type rollbackLockRegistry struct {
	Sessions map[string]struct {
		BillOp string `json:"billOp"`
	} `json:"sessions"`
}

// AssertRegistryRollbackSafe is called by the offline installer immediately
// before replacing a registry. Open paid reservations must be settled or
// explicitly accounted for before the old billing authority can resume.
func AssertRegistryRollbackSafe(data []byte) error {
	var st rollbackLockRegistry
	if e := json.Unmarshal(data, &st); e != nil {
		return e
	}
	for id, record := range st.Sessions {
		if record.BillOp != "" {
			return fmt.Errorf("session %s has an open billing reservation; settle it before rollback", id)
		}
	}
	return nil
}

type LegacyRecord struct {
	ID          string   `json:"sessionId"`
	Book        string   `json:"bookId"`
	Owner       string   `json:"ownerId"`
	Title       string   `json:"title"`
	Created     string   `json:"createdAt"`
	Model       Model    `json:"model"`
	Scopes      []string `json:"scopes"`
	Deleted     bool     `json:"deleted"`
	Pending     bool     `json:"cleanupPending"`
	Nonce       string   `json:"nonce"`
	Calls       int      `json:"toolCalls"`
	LastMessage string   `json:"lastMessageId,omitempty"`
	Intake      []string `json:"pendingIntake,omitempty"`
	BillOp      string   `json:"billOp,omitempty"`
	Billed      int      `json:"billedPoints,omitempty"`
}

type rollbackRegistry struct {
	Schema      int                       `json:"schema"`
	Cancelled   map[string]bool           `json:"cancelledReceipts,omitempty"`
	Sessions    map[string]rollbackRecord `json:"sessions"`
	Requests    map[string]receipt        `json:"requests"`
	Preferences map[string][]string       `json:"preferences,omitempty"`
}

type rollbackRecord struct {
	LegacyRecord
	AuthorizationVersion int  `json:"authorizationVersion,omitempty"`
	CancelPending        bool `json:"cancelPending,omitempty"`
	ResumeBlocked        bool `json:"resumeBlocked,omitempty"`
}

var rollbackSessionID = regexp.MustCompile(`^th-[a-f0-9-]{36}$`)

// RollbackRegistry converts the offline Thinking registry to the old contract.
// A compatible Go service may keep the new durable cancellation fields. Direct
// rollback to an old Go service rejects them rather than silently losing a stop.
func RollbackRegistry(data []byte, preserveCancelFence bool) ([]byte, error) {
	// Preserve valid lone UTF-16 surrogates in discussion text just as the
	// running service does. No author content is logged by this conversion.
	var normalized any
	if e := compat.Decode(data, &normalized); e != nil {
		return nil, fmt.Errorf("rollback registry is not valid JSON: %w", e)
	}
	canonical, e := compat.Marshal(normalized, false)
	if e != nil {
		return nil, e
	}
	var source rollbackRegistry
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&source); e != nil {
		return nil, fmt.Errorf("rollback registry has an unsupported schema: %w", e)
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("rollback registry contains trailing JSON")
	}
	if source.Schema != 1 || source.Sessions == nil || source.Requests == nil {
		return nil, fmt.Errorf("rollback registry requires schema=1, sessions and requests")
	}
	out := LegacyRegistry{Schema: 1, Sessions: map[string]LegacyRecord{}, Requests: source.Requests, Preferences: source.Preferences}
	for id, record := range source.Sessions {
		if !rollbackSessionID.MatchString(id) || record.ID != id || record.Book == "" || record.Owner == "" || record.Nonce == "" {
			return nil, fmt.Errorf("rollback registry contains an invalid session")
		}
		if !preserveCancelFence && (record.CancelPending || record.ResumeBlocked) {
			return nil, fmt.Errorf("session %s has a durable cancellation fence; retain the compatible Go service instead of rolling back its state authority", id)
		}
		out.Sessions[id] = record.LegacyRecord
	}
	if !preserveCancelFence {
		return compat.Marshal(out, true)
	}
	var raw struct {
		Schema      int                       `json:"schema"`
		Sessions    map[string]map[string]any `json:"sessions"`
		Requests    map[string]receipt        `json:"requests"`
		Preferences map[string][]string       `json:"preferences,omitempty"`
	}
	encoded, _ := compat.Marshal(out, false)
	_ = compat.Decode(encoded, &raw)
	for id, record := range source.Sessions {
		if record.AuthorizationVersion != 0 {
			raw.Sessions[id]["authorizationVersion"] = record.AuthorizationVersion
		}
		if record.CancelPending {
			raw.Sessions[id]["cancelPending"] = true
		}
		if record.ResumeBlocked {
			raw.Sessions[id]["resumeBlocked"] = true
		}
	}
	if len(source.Cancelled) > 0 {
		var final map[string]any
		encoded, _ = compat.Marshal(raw, false)
		_ = compat.Decode(encoded, &final)
		final["cancelledReceipts"] = source.Cancelled
		return compat.Marshal(final, true)
	}
	return compat.Marshal(raw, true)
}

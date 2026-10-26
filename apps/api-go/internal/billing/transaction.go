package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/compat"
	"github.com/story2u/ai-write-life-circle/apps/api-go/internal/storage"
)

// All billing readers/writers recover the committed redo intent while holding
// one process lock. No external calls run here. After intent persistence, writes
// are roll-forward only; each image is safe to replay after an ambiguous I/O error.
type transaction struct {
	Schema int                        `json:"schema"`
	Files  map[string]json.RawMessage `json:"files"`
	root   string
}

func poolOp(actor, op string) string { return compat.Key(actor) + ":" + op }

func (tx *transaction) relative(path string) (string, error) {
	rel, err := filepath.Rel(tx.root, path)
	if err != nil || filepath.IsAbs(rel) || strings.HasPrefix(rel, "..") || !strings.HasSuffix(rel, ".json") || rel == "pending-v1.json" {
		return "", fmt.Errorf("invalid billing transaction path")
	}
	return rel, nil
}

func (tx *transaction) put(path string, value any) error {
	rel, err := tx.relative(path)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tx.Files[rel] = raw
	return nil
}

func (tx *transaction) read(path string, value any) (bool, error) {
	rel, err := tx.relative(path)
	if err != nil {
		return false, err
	}
	if raw, ok := tx.Files[rel]; ok {
		return true, json.Unmarshal(raw, value)
	}
	return storage.Read(path, value)
}

func (l *Ledger) writeState(ctx context.Context, path string, value any) error {
	if l.write != nil {
		return l.write(ctx, path, value)
	}
	// storage.Write's legacy encoder treats []byte (including RawMessage) as
	// arrays. Normalize the journal and its images to ordinary JSON values.
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		return err
	}
	if err := storage.Write(ctx, path, document); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (l *Ledger) apply(tx *transaction) error {
	keys := make([]string, 0, len(tx.Files))
	for rel, raw := range tx.Files {
		if clean, err := tx.relative(filepath.Join(tx.root, rel)); err != nil || clean != rel || !json.Valid(raw) {
			return fmt.Errorf("invalid billing redo journal")
		}
		keys = append(keys, rel)
	}
	sort.Strings(keys)
	for _, rel := range keys {
		if err := l.writeState(context.Background(), filepath.Join(tx.root, rel), tx.Files[rel]); err != nil {
			return err
		}
	}
	if err := os.Remove(filepath.Join(tx.root, "pending-v1.json")); err != nil {
		return err
	}
	d, err := os.Open(tx.root)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (l *Ledger) transaction(ctx context.Context, fn func(*transaction) error) error {
	return storage.ProcessLock(ctx, filepath.Join(l.dir(), "ledger-v2.mutex"), func() error {
		journal := filepath.Join(l.dir(), "pending-v1.json")
		previous := transaction{root: l.dir()}
		found, err := storage.Read(journal, &previous)
		if err != nil {
			return err
		}
		if found {
			if previous.Schema != 1 || len(previous.Files) == 0 {
				return fmt.Errorf("invalid billing redo journal")
			}
			if err := l.apply(&previous); err != nil {
				return err
			}
		}
		tx := transaction{Schema: 1, Files: map[string]json.RawMessage{}, root: l.dir()}
		if err := fn(&tx); err != nil {
			return err
		}
		if len(tx.Files) == 0 {
			return nil
		}
		if err := l.writeState(ctx, journal, tx); err != nil {
			return err
		}
		return l.apply(&tx)
	})
}

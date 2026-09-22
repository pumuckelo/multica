package agent

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestInteractiveCancelPausedExecution(t *testing.T) {
	for _, provider := range []string{"pi", "codex"} {
		t.Run(provider, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			deadline, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			cfg := Config{ExecutablePath: os.Args[0], CLIVersion: "0.87.0", Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
			opts := ExecOptions{Cwd: t.TempDir(), Timeout: 10 * time.Second}
			if provider == "pi" {
				cfg.Env = map[string]string{"MULTICA_TEST_PI_RPC": "1"}
				opts.ResumeSessionID = filepath.Join(t.TempDir(), "session.jsonl")
				if err := os.WriteFile(opts.ResumeSessionID, []byte("{\"type\":\"session\"}\n"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				cfg.Env = map[string]string{"MULTICA_TEST_CODEX_INTERACTIVE": "1"}
			}
			backend, err := New(provider, cfg)
			if err != nil {
				t.Fatal(err)
			}
			session, err := backend.(InteractiveBackend).ExecuteInteractive(ctx, "work", opts)
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				for range session.Messages {
				}
			}()
			for session.Control.Snapshot().State == InteractionStarting {
				select {
				case <-deadline.Done():
					t.Fatal("startup timeout")
				case <-time.After(time.Millisecond):
				}
			}
			receipt, err := session.Control.Submit(deadline, InteractionCommand{ID: "pause", Kind: "interrupt", Activity: 1})
			if err != nil || receipt.Snapshot.State != InteractionAwaitingInput {
				t.Fatalf("pause: %+v %v", receipt, err)
			}
			cancel()
			select {
			case result := <-session.Result:
				if result.Status != "aborted" {
					t.Fatalf("cancel status: %+v", result)
				}
			case <-deadline.Done():
				t.Fatal("paused process did not exit")
			}
			if session.Control.Snapshot().State != InteractionFinished {
				t.Fatal("controller survived cancellation")
			}
			if provider == "pi" {
				lock, ok, err := tryLockPiSessionFile(opts.ResumeSessionID)
				if err != nil || !ok {
					t.Fatalf("session lock leaked: %v", err)
				}
				releasePiSessionFileLock(lock)
			}
		})
	}
}

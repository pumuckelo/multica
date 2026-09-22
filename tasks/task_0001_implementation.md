# Interactive issue conversations — implementation notes

## Enable and use

Build/deploy the matching server, daemon, and web/desktop client from this checkout. Apply migration 536 through the normal migration command. This change does not update a previously installed Multica binary or desktop app automatically.

In a Pi or Codex agent's Custom args tab, enable **Interactive task sessions** and save. This stores `interactive_task_sessions: true` in that agent's existing runtime configuration. Only new issue runs use it. Standalone chats and other providers retain their previous behavior.

Open the issue and choose **Open conversation**. It displays the actual worker's task-message stream, with run-history selectors and durable human instructions. This is an issue conversation view, not a second standalone `chat_session` or a new agent.

- **Send** while working sends native steering to the existing worker.
- **Interrupt** stops the current native activity, then shows **Awaiting input**. The run, provider process, session lock, execution slot, worktree, and task credentials stay alive.
- Send a correction to continue that same process/run.
- **Cancel run** remains the existing terminal cancellation action.
- A normal reply now leaves the run awaiting input. **Finish run** explicitly closes an idle run successfully; failure, cancellation, or the displayed deadline also closes it. There is no post-completion warm pool. See `task_0002_multica_acp.md` for the ACP bridge and lifecycle update.
- Opening finished history is read-only. **Start follow-up run** explicitly creates a new run and process, pinned to the selected source run's provider history.

A delegated child issue uses the same issue execution path and its assigned agent's opt-in setting. There is no separate subagent transport to maintain.

## Runtime requirements and limits

Pi uses native `--mode rpc`, with `prompt`, `steer`, `clear_queue`, and `abort`. The run completes on `agent_settled`, not `agent_end` or a command acknowledgement. The adapter requires a detected Pi version at least 0.87.0, the protocol baseline inspected for this feature. A custom wrapper must forward `--version` and all RPC arguments, keep stdin open, and reserve stdout for JSON. Existing runtime executable/prefix/environment configuration is retained, including a Nono wrapper. No Nono profile, sandbox permission, or provider login is modified here.

Codex uses the existing app-server transport and configured approval/sandbox behavior. Native `turn/steer` targets the current turn; `turn/interrupt` is confirmed by the native terminal notification. Continuation starts a new native turn on the same thread and process. Fake protocol tests model Codex 0.147.0; this feature does not install/upgrade Codex or change its existing version validation.

Pi extension dialogs (`select`, `confirm`, `input`, `editor`) are not routed into this UI. They fail the run with an explicit unsupported-dialog error rather than silently granting an approval or leaving an invisible blocking prompt. Codex approval behavior is inherited from the existing adapter; this is not a new approvals UI.

Live tool previews use `tool_progress` snapshots. Pi partial results and Codex command-output deltas appear in the tool inspector without marking the call completed. Final results remain separate. Codex exposed reasoning deltas are included. Existing output preview/redaction/truncation limits still apply; this is not an unlimited terminal recording.

The pause deadline is the earliest of the configured execution timeout, parent deadline, a 23-hour ceiling, and the task token expiry minus one minute. Human pauses suspend semantic-idle checks, not process liveness or explicit cancellation. Waiting occupies the original execution slot and counts in wall-clock duration.

## Persistence and delivery

- `agent_task_queue.interaction` is the canonical durable record for this run's owner, phase, deadline, instructions, receipts, and follow-up request keys. No foreign keys, indexes, or secondary conversation tables were added.
- Worker output continues through existing task-message storage and realtime/query caches. Human instructions are projected from the interaction record, not also posted as issue comments.
- `GET/POST /api/tasks/{taskId}/interaction` reads or accepts run-scoped input/interrupt commands. Mutations require a human actor, workspace/private-agent access, and agent invocation permission.
- `POST /api/daemon/runtimes/{runtimeId}/tasks/{taskId}/interaction` registers ownership, acknowledges delivery, publishes phase, and polls the inbox. The daemon polls every 500 ms; this does not depend on a WebSocket frame reaching it.
- Acceptance and natural finishing lock the same task row. A pending accepted command prevents natural finish until delivery is resolved. Request IDs, actor identity, owner generation, and activity IDs fence duplicates and stale sends.
- One control operation may be outstanding per run. There are at most 128 durable controls per run; text is capped at 64 KiB. Drafts and uncertain HTTP request IDs survive browser reloads in the shared draft store.
- A native acknowledgement proves protocol acceptance, not that the model followed the instruction. A process loss during delivery is reported as unconfirmed, not automatically replayed in a replacement process. This is not a distributed exactly-once guarantee.
- `POST /api/tasks/{taskId}/interaction/follow-up` atomically enqueues a source-pinned continuation and records its retry key. Publishing/waking the worker happens after commit. Existing issue/agent attribution and invocation restrictions apply.
- Explicit follow-ups carry `require_session_resume` in existing task context/claim data. A changed runtime, missing provider locator, missing workdir/session store, or refused Codex resume fails rather than claiming a fresh conversation preserved history. Interactive executions do not use the daemon's automatic fresh-session retry.
- Deleting a task removes its embedded control record. Browser closure does not stop a run. Daemon restart does not claim the original process survived.

## Important inherited limitation

The existing worker transcript reporter is best-effort across a **daemon-to-server outage**: failed output batches are not retried by the baseline transport. Browser reconnects can recover persisted history, and control delivery uses a durable inbox, but these are not a durable spool for every output byte during a server outage. Provider-native session files remain the source for provider history. Fixing transcript transport requires idempotent batch persistence and a bounded retry/spool design; do not add blind retries to the current non-idempotent insert endpoint.

## Verification

Tests use re-executed test binaries, not installed providers or accounts. Coverage includes same-PID interruption/continuation for Pi and Codex, explicit cancellation after pause, Pi queue clearing and no-assistant-message aborts, rejecting missing/unsupported Pi sessions, rejecting Codex fresh-thread fallback, durable control fencing/deduplication, the daemon inbox bridge, source-pinned follow-up transactions, invocation permissions, malformed API payloads, tool-progress pairing, separate UI Interrupt/Cancel wiring, uncertain-send retry identity, and read-only finished-history opening.

Focused Go tests use the race detector where practical; database tests use this checkout's isolated managed PostgreSQL. Related existing completion/cancellation and standalone-chat regression tests are included in verification. Shared core/views typechecking, focused frontend tests, lint, and `git diff --check` accompany these checks.

Not claimed: a live paid-agent/Nono smoke test, a packaged Electron installation test, or the entire repository's full test matrix. Real-agent testing requires explicit authorization. The feature is disabled by default so it can be enabled on a single agent first.

## Main implementation locations

- Provider contract/controller: `server/pkg/agent/interactive.go`
- Pi RPC lifecycle: `server/pkg/agent/pi_interactive.go`
- Codex lifecycle: `server/pkg/agent/codex.go`, `codex_interactive.go`
- Daemon ownership/inbox bridge: `server/internal/daemon/interactive.go`
- Durable state/API: `server/internal/interaction/record.go`, `server/internal/handler/task_interaction.go`
- Follow-up enqueue transaction: `server/internal/service/interactive_followup.go`
- Shared issue view: `packages/views/issues/components/issue-conversation.tsx`
- Queries/schema/drafts: `packages/core/chat/task-interaction.ts`, `issue-conversation-drafts.ts`, `packages/core/api/task-interaction-schema.ts`

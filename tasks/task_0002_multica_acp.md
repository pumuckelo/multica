# Multica ACP: join issue workers from Zed

## Scope and identity

`multica acp` is an ACP stdio server backed by the existing Multica HTTP API. It never launches Pi, Codex, or a second sandbox, and never reads provider JSONL files. There is no Zed extension requirement: register it as a custom external agent.

An ACP session represents `(workspace UUID, issue UUID, agent UUID)`, encoded in that order with `/` separators. Runs remain execution records inside that conversation. Discovery groups the existing agent run lists by issue, excluding standalone chats and other issue-less runs. Current titles include issue key/title, agent, and selected run status. The list is workspace-scoped, not filtered to the editor's directory. Its `cwd` is the worker's recorded workdir (or the supplied editor directory when unavailable), not a request to relocate the worker. Open the actual worker checkout in Zed to inspect its edits.

The active run is selected when exactly one nonterminal run exists for that issue/agent pair; otherwise the latest run is selected. Multiple active runs fail explicitly rather than sending input to an arbitrary worker. Different agents on one issue are distinct conversations. This is not a guarantee that all historical runs used the same native provider branch.

Discovery currently composes existing agent/issue/run endpoints. It uses N+1 reads and recomputes the list for pagination; it is intended for the initial self-hosted workflow, not a large-company indexed conversation search service. A dedicated indexed endpoint is a future optimization.

## Build and Zed configuration

From the repository root:

```sh
cd server
go build -p 1 -o bin/multica-acp-dev ./cmd/multica
```

Configure a signed-in **human** CLI profile for the same backend/workspace as the desktop app. Do not supply provider credentials or a task-scoped `mat_` token to the bridge. Existing CLI workspace/private-agent checks are retained; input/finish/follow-up additionally use the server's human-actor and invocation gates.

Example Zed settings for this checkout's current test workspace (adjust profile/workspace for other installations):

```json
{
  "agent_servers": {
    "Multica": {
      "type": "custom",
      "command": "/Users/abdou/github/multica-fork/multica/server/bin/multica-acp-dev",
      "args": [
        "acp",
        "--profile", "desktop-localhost-18675",
        "--workspace-id", "1b075ba2-c3ec-487e-a88f-82613d0f0fe5"
      ]
    }
  }
}
```

The normal CLI execution-context safety checks still apply. Launch the bridge outside a daemon-managed task environment; an inherited task token or task-directory marker is not silently promoted to the human profile. Authenticate using the ordinary CLI setup before launching Zed. Credentials are not written into Zed settings.

Use the external agent's session history to select an existing issue conversation. `session/new` intentionally returns guidance to use existing history; this bridge does not create standalone chats or issues. Listing/loading is read-only. Loading replays Multica's recorded run output and human instructions, then polls new output. It does not notify or prompt the model.

Rebuild/restart the **matching backend and worker daemon** before testing the new finish/waiting behavior. For desktop-owned runtimes, the worker is the desktop's bundled CLI, not necessarily `server/bin/multica`; rebuild/restart the desktop bundle too. Do this only after ending existing runs. The separate ACP binary does not replace the installed CLI or automatically restart any service.

## Controls

| Editor action | Meaning |
| --- | --- |
| Normal text | Input/steering to the selected open worker; never creates a new process |
| ACP Stop (`session/cancel`) | Native turn interruption; run and process stay open |
| `/interrupt` | Same operation, usable when attaching to work that began outside Zed |
| `/status` | Current run, activity, working directory, and deadline |
| `/finish-run` | Successfully close an idle run; does not set the issue to done |
| `/cancel-run` | Cancel the entire run through Multica's existing cancellation endpoint |
| `/follow-up <message>` | Explicitly enqueue a new run from the latest finished run's saved provider session |
| Close the ACP connection | Detach only; no remote cancellation or completion |

Slash commands are parsed by the bridge, not sent to the LLM. Unknown commands fail visibly. Only one prompt per attached conversation runs at a time; Stop is independently handled. If Zed does not allow sending during an ACP turn, Stop, then send the correction. When joining a worker that began outside Zed, the editor may not display a native Stop button because no ACP prompt is outstanding; `/interrupt` is the fallback. Actual Zed UI behavior still needs an end-to-end editor smoke test.

Normal native replies now move opted-in issue runs to `awaiting_input`. Both Pi RPC and Codex app-server retain their process until explicit Finish/Cancel, failure, or deadline. Paused/idle runs still occupy execution slots and count wall-clock time. No process survives into a completed run's successor. Noninteractive and standalone execution paths are unchanged. The shared Multica issue UI also has an idle-only Finish run button.

## Transport and boundaries

- ACP protocol version 1, newline-delimited JSON-RPC, bounded 1 MiB frames and 16 concurrent requests, at most eight attached conversations per bridge process.
- Text prompts only. Images/resource blocks are explicitly rejected rather than silently dropped. There is no editor filesystem/terminal delegation or new approval UI; the existing worker retains its configured tools, sandbox, and approvals.
- Persisted text/thinking and tool-call/progress/result records are translated into ACP updates. Native tool-call IDs are scoped by run to prevent collisions. Existing daemon redaction/truncation applies.
- Polling uses the task-message sequence cursor, plus authoritative run/interaction records. Private-agent access is rechecked on refresh and controls. Replay uses Multica records, not the complete native provider history; work done independently in Pi ACP is not imported.
- Accepted control commands retain the existing durable owner/activity/idempotency fences. HTTP uncertainty is reported with a request ID; the bridge does not silently replay uncertain commands or fall back to a fresh provider session. Inspect status/run history before manually resending.
- A completed ACP prompt is not a completed Multica run. A confirmed interrupt returns ACP `cancelled`, while the Multica run stays running/awaiting input.
- Finishing is idle-only and blocks later durable input. The provider waits for its finish receipt to be persisted before crossing the final run boundary.
- The inherited daemon transcript transport is best-effort during a daemon-to-server outage; this bridge does not add a durable output spool. Tool previews are bounded, not an unlimited terminal recording.
- An ACP connection is an attachment, not ownership of the worker: reload/EOF never kills the worker. Other clients can still use the same durable input queue.

## Verification

Fake-provider tests cover Pi/Codex normal reply → wait → another reply → explicit finish, interruption, cancellation, and the durable daemon finish acknowledgement. Bridge tests cover JSON-RPC initialization/discovery/load, no execution on open, Stop versus cancel, direct slash commands, explicit follow-up, workspace isolation, access revocation, unsupported content, and reload without mutation. Shared UI tests cover idle-only Finish and separate Cancel/Interrupt. Tests do not invoke installed agent providers.

The built bridge was also checked against the local development API with initialization and session discovery only. It discovered TEST-1/fullstack dev without creating a run. This is not yet a live Zed conversation/steering smoke test, nor a packaged desktop installation test.

References: [ACP prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn), [ACP slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands), [Zed external agents](https://zed.dev/docs/ai/external-agents).

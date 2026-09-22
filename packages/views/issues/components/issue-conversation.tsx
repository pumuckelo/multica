"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueTasksOptions } from "@multica/core/issues/queries";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import { taskInteractionOptions, useTaskInteraction, useIssueConversationDrafts, type TaskInteractionCommand } from "@multica/core/chat";
import type { AgentTask } from "@multica/core/types";
import { createSafeId } from "@multica/core/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Field, FieldGroup, FieldLabel, FieldError } from "@multica/ui/components/ui/field";
import { Alert, AlertDescription } from "@multica/ui/components/ui/alert";
import { AgentTranscriptDialog } from "../../common/task-transcript/agent-transcript-dialog";
import { issueConversationTimeline } from "./issue-conversation-timeline";
import { useT } from "../../i18n";

export function IssueConversationButton({ issueId, tasks }: { issueId: string; tasks: AgentTask[] }) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  if (!tasks.length) return null;
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{t(($) => $.interaction.open)}</Button>
    {open && <IssueConversation issueId={issueId} initialTasks={tasks} onClose={() => setOpen(false)} />}
  </>;
}

function IssueConversation({ issueId, initialTasks, onClose }: { issueId: string; initialTasks: AgentTask[]; onClose: () => void }) {
  const { t } = useT("agents");
  const { data: tasks = initialTasks } = useQuery({ ...issueTasksOptions(issueId), initialData: initialTasks, refetchInterval: 1000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const running = tasks.filter((task) => task.status === "running");
  const task = tasks.find((task) => task.id === selectedId) ?? running[0] ?? tasks[0];
  if (!task) return null;
  return <IssueRunConversation key={task.id} task={task} onClose={onClose} onFollowup={setSelectedId}
    ambiguous={running.length > 1}
    history={<div className="flex flex-wrap gap-2" role="navigation" aria-label={t(($) => $.interaction.history)}>
      {tasks.map((run, index) => <Button key={run.id} variant="ghost" size="xs" aria-current={run.id === task.id ? "true" : undefined} onClick={() => setSelectedId(run.id)}>
        {t(($) => $.interaction.run, { number: tasks.length - index })} · {run.status}
      </Button>)}
    </div>}
  />;
}

function IssueRunConversation({ task, history, ambiguous, onClose, onFollowup }: {
  task: AgentTask; history: React.ReactNode; ambiguous: boolean; onClose: () => void; onFollowup: (id: string) => void;
}) {
  const { t } = useT("agents");
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const interactionQuery = useQuery(taskInteractionOptions(workspaceId, task.id, true));
  const record = interactionQuery.data;
  const { data: agent } = useQuery({ queryKey: ["issue-conversation-agent", workspaceId, task.agent_id], queryFn: () => api.getAgent(task.agent_id), staleTime: 30000 });
  const { data: messages = [] } = useQuery({ ...taskMessagesOptions(task.id), refetchInterval: task.status === "running" ? 1000 : false });
  const mutation = useTaskInteraction(workspaceId, task.id);
  const draftKey = `${workspaceId}:${task.issue_id}:${task.id}`;
  const draft = useIssueConversationDrafts((state) => state.drafts[draftKey]);
  const setDraft = useIssueConversationDrafts((state) => state.setDraft);
  const text = draft?.text ?? "";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const terminal = ["completed", "cancelled", "failed"].includes(task.status);
  const pending = record?.commands.some((command) => !command.receipt && !command.error) ?? false;
  const connected = !!record && Date.now() - new Date(record.updatedAt).getTime() < 15000;
  const ready = !!record && !ambiguous && (terminal || (connected && !record.finishing && ["working", "awaiting_input"].includes(record.state.state)));
  const disabled = !ready || pending || mutation.isPending || busy;
  const stateLabel = !record ? t(($) => $.interaction.unavailable)
    : terminal ? t(($) => $.interaction.finished)
    : !connected ? t(($) => $.interaction.disconnected)
    : record.state.state === "awaiting_input" ? t(($) => $.interaction.awaiting)
    : record.state.state === "interrupting" || record.commands.some((command) => command.kind === "interrupt" && !command.receipt && !command.error) ? t(($) => $.interaction.interrupting)
    : t(($) => $.interaction.working);

  useEffect(() => {
    if (!draft?.pending || draft.followup) return;
    const accepted = record?.commands.find((command) => command.id === draft.pending?.id);
    if (accepted) setDraft(draftKey, { text: accepted.error ? draft.text : draft.pending.kind === "input" ? "" : draft.text });
  }, [draft, draftKey, record, setDraft]);

  const send = async (kind: "input" | "interrupt") => {
    if (!record || disabled) return;
    setError("");
    const command: TaskInteractionCommand = draft?.pending ?? {
      owner: record.owner, id: createSafeId(), activity: record.state.activity, kind,
      ...(kind === "input" ? { text } : {}),
    };
    // An uncertain live send must never silently become a new run's prompt.
    const followup = draft?.pending ? draft.followup === true : terminal;
    setDraft(draftKey, { text, pending: command, followup });
    setBusy(true);
    try {
      if (followup) {
        const result = await api.followupTaskInteraction(task.id, command.id, command.text ?? "");
        if (!result) throw new Error(t(($) => $.interaction.uncertain));
        setDraft(draftKey, { text: "" });
        await queryClient.invalidateQueries({ queryKey: issueTasksOptions(task.issue_id).queryKey });
        onFollowup(result.runId);
      } else {
        const result = await mutation.mutateAsync(command);
        if (!result) throw new Error(t(($) => $.interaction.uncertain));
        setDraft(draftKey, { text: command.kind === "input" ? "" : text });
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) setDraft(draftKey, { text });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  // Human controls are projections of their durable records, not duplicate
  // task-message writes. Existing rendering retains tool IDs and file diffs.
  const items = issueConversationTimeline(messages, [
    ...(record?.openingInput ? [{ id: "opening", createdAt: task.created_at, text: `**${t(($) => $.interaction.human)}**\n\n${record.openingInput}` }] : []),
    ...(record?.commands ?? []).map((command) => ({
      id: command.id, createdAt: command.createdAt,
      text: `**${t(($) => $.interaction.human)}**\n\n${command.kind === "interrupt" ? t(($) => $.interaction.interrupt) : command.text}\n\n${command.error || (!command.receipt ? t(($) => $.interaction.pending) : "")}`,
    })),
  ]);

  return <AgentTranscriptDialog open onOpenChange={(open) => { if (!open) onClose(); }} task={task}
    agentName={agent?.name ?? t(($) => $.interaction.agent)} items={items} isLive={!terminal}
    headerSlot={history}
    footerSlot={<div className="max-h-[45vh] shrink-0 overflow-y-auto p-4">
      <FieldGroup>
        <p role="status">{stateLabel}</p>
        {record && !terminal && <p className="text-caption text-muted-foreground">{t(($) => $.interaction.deadline, { time: new Date(record.deadline).toLocaleString() })}</p>}
        {ambiguous && <Alert><AlertDescription>{t(($) => $.interaction.ambiguous)}</AlertDescription></Alert>}
        <Field data-invalid={!!error}>
          <FieldLabel htmlFor={`live-input-${task.id}`}>{terminal ? t(($) => $.interaction.followup) : t(($) => $.interaction.message)}</FieldLabel>
          <Textarea id={`live-input-${task.id}`} value={text} maxLength={65536} disabled={!!draft?.pending || !record}
            aria-invalid={!!error} onChange={(event) => setDraft(draftKey, { text: event.target.value })}
            onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void send("input"); } }} />
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled || (!draft?.pending && !text.trim())} onClick={() => void send(draft?.pending?.kind ?? "input")}>
            {draft?.pending ? t(($) => $.interaction.retry) : terminal ? t(($) => $.interaction.followup) : t(($) => $.interaction.send)}
          </Button>
          {!terminal && <>
            <Button variant="outline" disabled={disabled || !!draft?.pending || record?.state.state !== "working"} onClick={() => void send("interrupt")}>{t(($) => $.interaction.interrupt)}</Button>
            <Button variant="ghost" disabled={busy} onClick={async () => {
              setBusy(true); setError("");
              try { await api.cancelTaskById(task.id); await queryClient.invalidateQueries({ queryKey: issueTasksOptions(task.issue_id).queryKey }); }
              catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setBusy(false); }
            }}>{t(($) => $.interaction.cancel)}</Button>
          </>}
        </div>
        {(record?.commands ?? []).flatMap((command) => [...(command.receipt?.clearedSteering ?? []), ...(command.receipt?.clearedFollowUp ?? [])].map((cleared, index) => (
          <details key={`${command.id}-${index}`}><summary>{t(($) => $.interaction.cleared)}</summary><p className="whitespace-pre-wrap">{cleared}</p></details>
        )))}
      </FieldGroup>
    </div>}
  />;
}

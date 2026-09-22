import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { api } from "@multica/core/api";
import type { AgentTask } from "@multica/core/types";
import type { TaskInteraction } from "@multica/core/chat";
import { useIssueConversationDrafts } from "@multica/core/chat";
import { renderWithI18n } from "../../test/i18n";
import { IssueConversationButton } from "./issue-conversation";

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));
vi.mock("../../common/task-transcript/agent-transcript-dialog", () => ({
  AgentTranscriptDialog: ({ headerSlot, footerSlot }: { headerSlot: ReactNode; footerSlot: ReactNode }) => <div role="dialog">{headerSlot}{footerSlot}</div>,
}));
const id = "4a2e8d1c-7f9b-4e2a-9c1d-123456789abc";
const task: AgentTask = { id, agent_id: "agent", runtime_id: "runtime", issue_id: "issue", status: "running", priority: 0,
  created_at: "2026-09-07T00:00:00Z", started_at: "2026-09-07T00:00:00Z", dispatched_at: null, completed_at: null, result: null, error: null };
let record: TaskInteraction;
const clients: QueryClient[] = [];
beforeEach(() => {
  record = { owner: "process", state: { state: "working", activity: 1 }, openingInput: "", deadline: new Date(Date.now() + 3600000).toISOString(), updatedAt: new Date().toISOString(), finishing: false, commands: [] };
  useIssueConversationDrafts.setState({ drafts: {} });
  vi.spyOn(api, "getTaskInteraction").mockImplementation(async () => record);
  vi.spyOn(api, "getAgent").mockResolvedValue({ name: "Worker" } as Awaited<ReturnType<typeof api.getAgent>>);
  vi.spyOn(api, "listTaskMessages").mockResolvedValue([]);
  vi.spyOn(api, "listTasksByIssue").mockResolvedValue([task]);
  vi.spyOn(api, "cancelTaskById").mockResolvedValue({} as Awaited<ReturnType<typeof api.cancelTaskById>>);
  vi.spyOn(api, "sendTaskInteraction").mockResolvedValue(record);
  vi.spyOn(api, "followupTaskInteraction").mockResolvedValue({ runId: "next" });
});
afterEach(() => { cleanup(); clients.forEach((client) => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
async function open(run = task) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  renderWithI18n(<QueryClientProvider client={client}><IssueConversationButton issueId="issue" tasks={[run]} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Interrupt" })).toBeEnabled());
  return client;
}

describe("issue worker conversation", () => {
  it("Interrupt uses the live control endpoint, never Cancel run", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    await waitFor(() => expect(api.sendTaskInteraction).toHaveBeenCalledWith(id, expect.objectContaining({ owner: "process", activity: 1, kind: "interrupt" })));
    expect(api.cancelTaskById).not.toHaveBeenCalled();
    expect(api.followupTaskInteraction).not.toHaveBeenCalled();
  });
  it("sends corrections to the actual run and preserves the request ID after an uncertain response", async () => {
    vi.mocked(api.sendTaskInteraction).mockRejectedValueOnce(new Error("connection lost"));
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "Message the worker" }), { target: { value: "Stop editing that file" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("connection lost");
    const first = vi.mocked(api.sendTaskInteraction).mock.calls[0]![1];
    fireEvent.click(screen.getByRole("button", { name: "Retry delivery" }));
    await waitFor(() => expect(api.sendTaskInteraction).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendTaskInteraction).mock.calls[1]![1]).toEqual(first);
    expect(first).toMatchObject({ kind: "input", text: "Stop editing that file" });
    expect(api.followupTaskInteraction).not.toHaveBeenCalled();
  });
  it("Cancel run remains a separate terminal action", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(api.cancelTaskById).toHaveBeenCalledWith(id));
    expect(api.sendTaskInteraction).not.toHaveBeenCalled();
  });
});

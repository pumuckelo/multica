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

vi.mock("@multica/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multica/core/api")>(),
  api: {
    getTaskInteraction: vi.fn(), getAgent: vi.fn(), listTaskMessages: vi.fn(),
    listTasksByIssue: vi.fn(), cancelTaskById: vi.fn(), sendTaskInteraction: vi.fn(),
    followupTaskInteraction: vi.fn(),
  },
}));

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "workspace" }));
vi.mock("../../common/task-transcript/agent-transcript-dialog", () => ({
  AgentTranscriptDialog: ({ headerSlot, footerSlot, conversationSlot }: { headerSlot: ReactNode; footerSlot: ReactNode; conversationSlot?: ReactNode }) => <div role="dialog">{headerSlot}{conversationSlot ?? <div>Transcript inspector</div>}{footerSlot}</div>,
}));
vi.mock("./issue-conversation-chat", () => ({ IssueConversationChat: () => <div>Chat presentation</div> }));
const id = "4a2e8d1c-7f9b-4e2a-9c1d-123456789abc";
const task: AgentTask = { id, agent_id: "agent", runtime_id: "runtime", issue_id: "issue", status: "running", priority: 0,
  created_at: "2026-09-07T00:00:00Z", started_at: "2026-09-07T00:00:00Z", dispatched_at: null, completed_at: null, result: null, error: null };
let record: TaskInteraction;
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.clearAllMocks();
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
  await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
  return client;
}

describe("issue worker conversation", () => {
  it("defaults to chat and switching to logs preserves the draft without executing", async () => {
    await open();
    expect(screen.getByText("Chat presentation")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByText("Transcript inspector")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("keep this draft");
    expect(api.sendTaskInteraction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("Chat presentation")).toBeInTheDocument();
  });
  it("Finish run uses the explicit finish control only while idle", async () => {
    record.state.state = "awaiting_input";
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Finish run" }));
    await waitFor(() => expect(api.sendTaskInteraction).toHaveBeenCalledWith(id, expect.objectContaining({ kind: "finish", activity: 1 })));
    expect(api.cancelTaskById).not.toHaveBeenCalled();
  });
  it("cannot finish while the worker is executing", async () => {
    await open();
    expect(screen.getByRole("button", { name: "Finish run" })).toBeDisabled();
  });
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
  it("opening completed history does not execute; explicit send creates a follow-up", async () => {
    const completed = { ...task, status: "completed" as const };
    vi.mocked(api.listTasksByIssue).mockResolvedValue([completed]);
    await open(completed);
    expect(api.followupTaskInteraction).not.toHaveBeenCalled();
    expect(api.sendTaskInteraction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "One more change" } });
    fireEvent.click(screen.getByRole("button", { name: "Start follow-up run" }));
    await waitFor(() => expect(api.followupTaskInteraction).toHaveBeenCalledWith(id, expect.any(String), "One more change"));
    expect(api.sendTaskInteraction).not.toHaveBeenCalled();
  });
});

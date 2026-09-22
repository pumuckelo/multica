import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderWithI18n } from "../../test/i18n";
import { IssueConversationChat } from "./issue-conversation-chat";
import type { ConversationTimelineItem } from "./issue-conversation-timeline";

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent }: { data: ConversationTimelineItem[]; itemContent: (index: number, item: ConversationTimelineItem) => ReactNode }) =>
    <div>{data.map((item, index) => <div key={item.seq}>{itemContent(index, item)}</div>)}</div>,
}));
vi.mock("../../rich-content", () => ({ RichContent: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock("../components/comment-card", () => ({ AttachmentList: () => null }));

afterEach(cleanup);

describe("issue conversation chat", () => {
  it("shows ordered human/assistant text with thinking and tools collapsed even while live", () => {
    const { container } = renderWithI18n(<IssueConversationChat isLive items={[
      { seq: -1, humanId: "human", type: "text", content: "my question" },
      { seq: 1, type: "thinking", content: "private detail" },
      { seq: 2, type: "tool_use", tool: "read", input: { path: "example.ts" } },
      { seq: 3, type: "tool_result", tool: "read", output: "file contents" },
      { seq: 4, type: "text", content: "my answer" },
    ]} />);
    expect(screen.getByText("my question").compareDocumentPosition(screen.getByText("my answer")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Collapsed rows retain a one-line preview, not the expanded body.
    expect(container.querySelector("pre")).toBeNull();
    const collapsed = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-expanded") === "false");
    expect(collapsed).toHaveLength(3);
    fireEvent.click(collapsed[0]!);
    expect(container.querySelector("pre")).toHaveTextContent("private detail");
  });
});

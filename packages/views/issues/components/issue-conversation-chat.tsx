"use client";

import { Virtuoso } from "react-virtuoso";
import { ItemRow, UserMessageContent } from "../../chat/components/chat-message-list";
import { RichContent } from "../../rich-content";
import { CHAT_COLUMN } from "../../chat/components/chat-column";
import type { ConversationTimelineItem } from "./issue-conversation-timeline";

/** Presentation only: never invokes the standalone chat controller or starts a run. */
export function IssueConversationChat({ items, isLive }: {
  items: ConversationTimelineItem[]; isLive: boolean;
}) {
  return <Virtuoso
    style={{ height: "100%" }}
    data={items}
    initialTopMostItemIndex={{ index: "LAST", align: "end" }}
    followOutput={(atBottom) => atBottom ? "auto" : false}
    computeItemKey={(_, item) => `${item.runId ?? ""}:${item.divider ? "divider" : item.humanId ?? item.seq}`}
    itemContent={(_, item) => <div className={CHAT_COLUMN}>
      <div className="py-2">
        {item.divider ? <p className="text-caption text-muted-foreground" role="separator">{item.content}</p>
          : item.humanId ? <UserMessageContent content={item.content ?? ""} attachments={[]} />
          : item.type === "text" ? <RichContent content={item.content ?? ""} density="compact" phase={isLive ? "streaming" : "settled"} />
          : <ItemRow item={item} />}
      </div>
    </div>}
  />;
}

import type { TaskMessagePayload } from "@multica/core/types/events";
import { buildTimeline, type TimelineItem } from "../../common/task-transcript/build-timeline";
import { redactSecrets } from "../../common/task-transcript/redact";

export interface HumanTimelineEntry { id: string; text: string; createdAt: string }

/** Keep native sequence order and split coalescing at human-input boundaries. */
export function issueConversationTimeline(messages: TaskMessagePayload[], human: HumanTimelineEntry[]): TimelineItem[] {
  const pending = [...human].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const items: TimelineItem[] = [];
  let buffer: TaskMessagePayload[] = [];
  let cursor = 0;
  const appendHuman = () => {
    items.push(...buildTimeline(buffer));
    buffer = [];
    const entry = pending[cursor]!;
    items.push({ seq: -cursor - 1, type: "text", content: redactSecrets(entry.text), created_at: entry.createdAt });
    cursor++;
  };
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    while (cursor < pending.length && message.created_at && pending[cursor]!.createdAt <= message.created_at) appendHuman();
    buffer.push(message);
  }
  items.push(...buildTimeline(buffer));
  buffer = [];
  while (cursor < pending.length) appendHuman();
  return items;
}

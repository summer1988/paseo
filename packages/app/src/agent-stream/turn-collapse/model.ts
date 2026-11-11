import { isTurnBoundary, isTurnTrigger } from "../turn-membership";
import {
  getStreamItemMessageId,
  type StreamItem,
  type ThoughtItem,
  type TimelinePosition,
  type ToolCallItem,
  type TurnSummaryItem,
} from "@/types/stream";
import { summarizeToolCalls, type OverviewSummary } from "@/tool-calls/detail-level/overview/model";

export interface TurnCollapse {
  tail: StreamItem[];
  /** Rows of expanded turns, which render inside the turn's indent rail. */
  nestedItemIds: ReadonlySet<string>;
  /** The host of the turn a folded message belongs to, for surfaces that must reveal it. */
  hostIdByFoldedMessageId: ReadonlyMap<string, string>;
  /** Mounted rows replaced by a closed turn's host, for preserving the reading position. */
  hostIdByHiddenRowId: ReadonlyMap<string, string>;
  /**
   * The summary rows by host. A mounted row renders again only when its item changes, so a fold
   * keeps the previous row object for a turn whose work and open state are unchanged.
   */
  summaryRowsByHostId: ReadonlyMap<string, TurnSummaryItem>;
}

export interface CollapseTurnsInput {
  tail: StreamItem[];
  /** The latest turn is still producing output, so it stays unfolded. */
  isLatestTurnOpen: boolean;
  expandedHostIds: ReadonlySet<string>;
  /** The calls a tool-call group row stands for; undefined for a single call. */
  getGroupedCalls: (itemId: string) => readonly (ToolCallItem | ThoughtItem)[] | undefined;
  /** The previous fold of the same history, whose unchanged summary rows are reused. */
  previousSummaryRowsByHostId: ReadonlyMap<string, TurnSummaryItem>;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_ROWS: ReadonlyMap<string, TurnSummaryItem> = new Map();
const EMPTY_HOSTS: ReadonlyMap<string, string> = new Map();

function summarizeTurn(
  items: readonly StreamItem[],
  getGroupedCalls: CollapseTurnsInput["getGroupedCalls"],
): OverviewSummary {
  const calls: (ToolCallItem | ThoughtItem)[] = [];
  for (const item of items) {
    if ((item.kind === "tool_call" || item.kind === "thought") && !isTurnTrigger(item))
      calls.push(...(getGroupedCalls(item.id) ?? [item]));
  }
  return summarizeToolCalls(calls);
}

function hasWork(tools: OverviewSummary): boolean {
  const { paseoActions, thoughtCount: _thoughtCount, ...counts } = tools;
  return Object.keys(paseoActions).length > 0 || Object.values(counts).some((count) => count > 0);
}

function hasSameWork(a: OverviewSummary, b: OverviewSummary): boolean {
  const { paseoActions: actionsA, ...countsA } = a;
  const { paseoActions: actionsB, ...countsB } = b;
  return hasSameCounts(countsA, countsB) && hasSameCounts(actionsA, actionsB);
}

function hasSamePosition(a: TimelinePosition | undefined, b: TimelinePosition | undefined) {
  return a === b || (a !== undefined && b !== undefined && a.epoch === b.epoch && a.seq === b.seq);
}

function hasSameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function summaryRow(
  host: StreamItem,
  expanded: boolean,
  tools: OverviewSummary,
  previous: TurnSummaryItem | undefined,
): TurnSummaryItem {
  if (
    previous &&
    previous.expanded === expanded &&
    hasSameWork(previous.tools, tools) &&
    hasSamePosition(previous.timelineCursor, host.timelineCursor)
  ) {
    return previous;
  }
  return {
    kind: "turn_summary",
    id: `turn-summary:${host.id}`,
    // The row stands at its host's place in the timeline, so the reading position over it
    // still resolves to the turn's prompt.
    ...(host.timelineCursor !== undefined ? { timelineCursor: host.timelineCursor } : {}),
    ...(host.turnId !== undefined ? { turnId: host.turnId } : {}),
    timestamp: host.timestamp,
    hostId: host.id,
    expanded,
    tools,
  };
}

function staysVisibleWhenCollapsed(item: StreamItem): boolean {
  return isTurnTrigger(item) || item.kind === "compaction" || isAssistantReply(item);
}

function isAssistantReply(item: StreamItem): boolean {
  return (
    item.kind === "assistant_message" ||
    (item.kind === "plugin" && item.sourceKind === "assistant_message")
  );
}

function findLastReplyIndex(tail: StreamItem[], start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    const item = tail[index]!;
    if (!isAssistantReply(item)) continue;
    const messageId = getStreamItemMessageId(item);
    // A transformer can split one reply into several cards; keep the whole reply visible.
    while (index > start) {
      const previous = tail[index - 1]!;
      if (!isAssistantReply(previous) || getStreamItemMessageId(previous) !== messageId) break;
      index -= 1;
    }
    return index;
  }
  return -1;
}

function placeFolded(
  items: readonly StreamItem[],
  expanded: boolean,
  hostId: string,
  input: CollapseTurnsInput,
  maps: {
    hostIdByFoldedMessageId: Map<string, string>;
    hostIdByHiddenRowId: Map<string, string>;
    nestedItemIds: Set<string>;
  },
): StreamItem[] {
  const revealed = expanded
    ? items.flatMap<StreamItem>((item) =>
        item.kind === "tool_call" || item.kind === "thought"
          ? [...(input.getGroupedCalls(item.id) ?? [item])]
          : [item],
      )
    : [...items];
  for (const item of revealed) {
    if (staysVisibleWhenCollapsed(item)) continue;
    maps.hostIdByFoldedMessageId.set(getStreamItemMessageId(item), hostId);
    if (expanded) maps.nestedItemIds.add(item.id);
    else maps.hostIdByHiddenRowId.set(item.id, hostId);
  }
  return expanded ? revealed : revealed.filter((item) => staysVisibleWhenCollapsed(item));
}

function isFoldableWork(item: StreamItem): boolean {
  return (item.kind === "tool_call" || item.kind === "thought") && !isTurnTrigger(item);
}

function replySpanEnd(tail: StreamItem[], replyIndex: number, end: number): number {
  const messageId = getStreamItemMessageId(tail[replyIndex]!);
  let index = replyIndex + 1;
  while (index < end) {
    const item = tail[index]!;
    if (!isAssistantReply(item) || getStreamItemMessageId(item) !== messageId) break;
    index += 1;
  }
  return index;
}

/**
 * Folds each answered turn behind a summary row under its user message. Tool calls and reasoning
 * collapse into that row. Every assistant reply stays in the chat, in order. A turn folds once it
 * is complete, has tool work, and its user message is loaded. Reasoning is revealed only when the
 * turn opens.
 */
export function collapseTurns(input: CollapseTurnsInput): TurnCollapse {
  const { tail } = input;
  const output: StreamItem[] = [];
  const summaryRowsByHostId = new Map<string, TurnSummaryItem>();
  const nestedItemIds = new Set<string>();
  const hostIdByFoldedMessageId = new Map<string, string>();
  const hostIdByHiddenRowId = new Map<string, string>();

  let runStart = 0;
  const flushRun = (runEnd: number) => {
    const host = tail[runStart - 1];
    const isClosed = runEnd < tail.length || !input.isLatestTurnOpen;
    const replyIndex = findLastReplyIndex(tail, runStart, runEnd);
    if (
      !host ||
      (host.kind !== "user_message" && host.kind !== "tool_call") ||
      !isClosed ||
      replyIndex < 0
    ) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const replyEnd = replySpanEnd(tail, replyIndex, runEnd);
    const before = tail.slice(runStart, replyIndex);
    const after = tail.slice(replyEnd, runEnd);
    const folded = [...before.filter(isFoldableWork), ...after.filter(isFoldableWork)];
    const tools = summarizeTurn(folded, input.getGroupedCalls);
    if (folded.length === 0 || !hasWork(tools)) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const expanded = input.expandedHostIds.has(host.id);
    const summary = summaryRow(
      host,
      expanded,
      tools,
      input.previousSummaryRowsByHostId.get(host.id),
    );
    summaryRowsByHostId.set(host.id, summary);
    output.push(summary);
    output.push(
      ...placeFolded(before, expanded, host.id, input, {
        hostIdByFoldedMessageId,
        hostIdByHiddenRowId,
        nestedItemIds,
      }),
    );
    output.push(...tail.slice(replyIndex, replyEnd));
    for (const item of after) {
      if (!isFoldableWork(item)) {
        output.push(item);
        continue;
      }
      output.push(
        ...placeFolded([item], expanded, host.id, input, {
          hostIdByFoldedMessageId,
          hostIdByHiddenRowId,
          nestedItemIds,
        }),
      );
    }
  };

  for (let index = 0; index < tail.length; index += 1) {
    if (
      !(index === 0 && isTurnTrigger(tail[index]!)) &&
      !isTurnBoundary(tail[index - 1] ?? null, tail[index] ?? null)
    )
      continue;
    flushRun(index);
    output.push(tail[index]!);
    runStart = index + 1;
  }
  flushRun(tail.length);

  if (summaryRowsByHostId.size === 0) {
    return {
      tail,
      nestedItemIds: EMPTY_IDS,
      hostIdByFoldedMessageId: EMPTY_HOSTS,
      hostIdByHiddenRowId: EMPTY_HOSTS,
      summaryRowsByHostId: EMPTY_ROWS,
    };
  }
  return {
    tail: output,
    nestedItemIds,
    hostIdByFoldedMessageId,
    hostIdByHiddenRowId,
    summaryRowsByHostId,
  };
}

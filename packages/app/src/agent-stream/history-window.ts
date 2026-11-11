import type { StreamItem } from "@/types/stream";
import { continuesTurn } from "./turn-membership";

export const DEFAULT_MOUNTED_RECENT_STREAM_ITEMS = 20;
/** One history page. A longer run keeps its latest rows and leaves the rest for Load earlier. */
export const MAX_MOUNTED_STREAM_ITEMS = 500;

type MountedRecentStreamItemsE2ETestGlobals = typeof globalThis & {
  __PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS?: unknown;
  __PASEO_E2E_WEB_MOUNTED_STREAM_ITEM_CAP?: unknown;
};

function readPositiveIntegerOverride(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value as number);
  return normalized > 0 ? normalized : null;
}

export function getMountedRecentStreamItems(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as MountedRecentStreamItemsE2ETestGlobals)
      .__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS,
  );
  return override ?? DEFAULT_MOUNTED_RECENT_STREAM_ITEMS;
}

export function getMaxMountedStreamItems(): number {
  const override = readPositiveIntegerOverride(
    (globalThis as MountedRecentStreamItemsE2ETestGlobals).__PASEO_E2E_WEB_MOUNTED_STREAM_ITEM_CAP,
  );
  return override ?? MAX_MOUNTED_STREAM_ITEMS;
}

export function findMountedWindowStart(input: {
  items: StreamItem[];
  minMountedCount: number;
  maxMountedCount?: number;
}): number {
  const { items, minMountedCount } = input;
  const maxMountedCount = input.maxMountedCount ?? getMaxMountedStreamItems();
  if (items.length <= minMountedCount) {
    return 0;
  }

  const floor = Math.max(0, items.length - maxMountedCount);
  let startIndex = Math.max(items.length - minMountedCount, floor);
  while (startIndex > floor && continuesTurn(items[startIndex - 1], items[startIndex])) {
    startIndex -= 1;
  }
  return startIndex;
}

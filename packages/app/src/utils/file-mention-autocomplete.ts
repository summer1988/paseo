export interface FileMentionRange {
  start: number;
  end: number;
  query: string;
}

interface FindActiveFileMentionInput {
  text: string;
  cursorIndex: number;
}

interface ApplyFileMentionReplacementInput {
  text: string;
  mention: FileMentionRange;
  relativePath: string;
}

const INVALID_MENTION_QUERY_CHARS = /[\s\n\r\t"'<>]/;

export function findActiveFileMention(input: FindActiveFileMentionInput): FileMentionRange | null {
  const clampedCursor = Math.max(0, Math.min(input.cursorIndex, input.text.length));
  const beforeCursor = input.text.slice(0, clampedCursor);

  for (
    let atIndex = beforeCursor.lastIndexOf("@");
    atIndex >= 0;
    atIndex = atIndex === 0 ? -1 : beforeCursor.lastIndexOf("@", atIndex - 1)
  ) {
    // Skip @ that looks like part of an email address (local-part char immediately before @).
    if (atIndex > 0 && /[\w+]/.test(beforeCursor[atIndex - 1]!)) {
      continue;
    }

    const query = beforeCursor.slice(atIndex + 1);
    if (INVALID_MENTION_QUERY_CHARS.test(query)) {
      continue;
    }
    return {
      start: atIndex,
      end: clampedCursor,
      query,
    };
  }

  return null;
}

export function formatQuotedFileMentionPath(relativePath: string): string {
  const safePath = relativePath.replace(/"/g, '\\"');
  // The leading @ marks a completed mention. Ordinary quotes stay prose.
  return `"@${safePath}"`;
}

export type FileMentionRun =
  | { kind: "text"; text: string }
  | { kind: "pad"; text: string }
  | { kind: "path"; text: string };

export function fileMentionRuns(text: string): FileMentionRun[] | null {
  const quotedPath = /"((?:\\.|[^"\\\n])*)"/g;
  const runs: FileMentionRun[] = [];
  let cursor = 0;
  let found = false;
  for (const match of text.matchAll(quotedPath)) {
    const rawInner = match[1] ?? "";
    const start = match.index ?? 0;
    const marked = rawInner.startsWith("@");
    const body = marked ? rawInner.slice(1) : rawInner;
    if (!isDisplayedFileMention(body, marked)) continue;
    found = true;
    if (start > cursor) runs.push({ kind: "text", text: text.slice(cursor, start) });
    runs.push({ kind: "pad", text: '"' });
    if (marked) runs.push({ kind: "pad", text: "@" });
    if (body.length > 0) runs.push({ kind: "path", text: body });
    runs.push({ kind: "pad", text: '"' });
    cursor = start + match[0].length;
  }
  if (!found) return null;
  if (cursor < text.length) runs.push({ kind: "text", text: text.slice(cursor) });
  return runs;
}

function isDisplayedFileMention(path: string, marked: boolean): boolean {
  if (!isSafeMentionPath(path)) return false;
  if (marked) return true;
  if (path.includes(" ")) return false;
  return path.includes("/") || /(?:^|\/)[^/]+\.[A-Za-z0-9]{1,12}$/.test(path);
}

function isSafeMentionPath(path: string): boolean {
  if (!path || path.length > 512) return false;
  if (/[\n\r\t<>|?*]/.test(path)) return false;
  if (/[,;:!?，。！？、]/.test(path)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0);
}

export function applyFileMentionReplacement(input: ApplyFileMentionReplacementInput): string {
  const before = input.text.slice(0, input.mention.start);
  const after = input.text.slice(input.mention.end);
  return `${before}${formatQuotedFileMentionPath(input.relativePath)}${after}`;
}

const ALERT: Readonly<Record<string, string>> = {
  info: "NOTE",
  note: "NOTE",
  success: "TIP",
  tip: "TIP",
  important: "IMPORTANT",
  warning: "WARNING",
  danger: "CAUTION",
  error: "CAUTION",
  caution: "CAUTION",
};

const FENCE_LABEL = /^dsh-ui([>`"'.,;:)\]】」』]*)([ \t][\s\S]*)?$/i;

/**
 * Closed ```dsh-ui fences become Markdown. A fence whose JSON object is already
 * complete renders too, so a missing closer does not leave the card as source.
 * An unfinished object stays a code block until it closes.
 */
export function renderDshUiCards(source: string): string {
  if (!source.toLowerCase().includes("```dsh-ui")) return source;
  let cursor = 0;
  let rendered = "";
  while (cursor < source.length) {
    const at = source.toLowerCase().indexOf("```dsh-ui", cursor);
    if (at < 0) {
      rendered += source.slice(cursor);
      break;
    }
    const fence = readFence(source, at);
    if (!fence) {
      rendered += source.slice(cursor, at + 3);
      cursor = at + 3;
      continue;
    }
    const card = renderCard(fence.body);
    rendered += source.slice(cursor, at);
    if (card && fence.end < source.length && !card.endsWith("\n")) rendered += `${card}\n`;
    else rendered += card ?? source.slice(at, fence.end);
    cursor = fence.end;
  }
  return rendered;
}

function readFence(source: string, at: number): { end: number; body: string } | undefined {
  const lineEnd = source.indexOf("\n", at);
  const line = source.slice(at + 3, lineEnd < 0 ? source.length : lineEnd);
  const label = FENCE_LABEL.exec(line);
  if (!label) return undefined;
  const inline = (label[2] ?? "").trim();
  if (lineEnd < 0) return { end: source.length, body: inline };
  let index = lineEnd + 1;
  while (index <= source.length) {
    const next = source.indexOf("\n", index);
    const row = source.slice(index, next < 0 ? source.length : next);
    if (/^```[ \t]*$/.test(row)) {
      const body = joinBody(inline, source.slice(lineEnd + 1, index));
      return { end: next < 0 ? source.length : next + 1, body };
    }
    if (next < 0) break;
    index = next + 1;
  }
  return { end: source.length, body: joinBody(inline, source.slice(lineEnd + 1)) };
}

function joinBody(inline: string, rest: string): string {
  if (!inline) return rest.trim();
  if (!rest.trim()) return inline;
  return `${inline}\n${rest}`.trim();
}

function renderCard(source: string): string | undefined {
  const parsed = parseSpec(source);
  if (!parsed || !Array.isArray(parsed.items)) return undefined;
  const parts: string[] = [];
  if (typeof parsed.title === "string" && parsed.title.trim())
    parts.push(`**${parsed.title.trim()}**`);
  const body = blocks(parsed.items, 0);
  if (body) parts.push(body);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function parseSpec(source: string): Record<string, unknown> | undefined {
  const trimmed = source.trim();
  const direct = parseRecord(trimmed);
  if (direct) return direct;
  const repaired = repairJson(trimmed);
  return repaired ? parseRecord(repaired) : undefined;
}

function parseRecord(source: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Close a truncated object or array so a finished prefix can render. */
function repairJson(source: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") stack.pop();
  }
  if (inString || stack.length === 0) return undefined;
  return source.replace(/,\s*$/, "") + stack.toReversed().join("");
}

function blocks(items: unknown, depth: number): string | undefined {
  if (!Array.isArray(items) || depth > 8) return undefined;
  const parts = items.flatMap((item) => {
    const rendered = renderItem(item, depth);
    return rendered ? [rendered] : [];
  });
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function renderItem(item: unknown, depth: number): string | undefined {
  if (!isRecord(item) || typeof item.type !== "string") return text(item);
  switch (item.type) {
    case "text":
      return textBlock(item);
    case "callout":
      return callout(item.tone, item.title, item.content);
    case "table":
      return table(item.columns, item.rows);
    case "keyvalue":
      return keyValue(item.pairs);
    case "list":
      return bulletList(item.items, depth);
    case "steps":
      return steps(item.steps);
    case "row":
      return layoutRow(item.items, depth);
    case "col":
    case "grid":
    case "card":
      return container(item, depth);
    case "tabs":
      return tabs(item.tabs, depth);
    case "accordion":
      return tabs(item.items, depth);
    default:
      return renderLeaf(item, depth);
  }
}

function renderLeaf(item: Record<string, unknown>, depth: number): string | undefined {
  switch (item.type) {
    case "stat":
    case "progress":
      return stat(item);
    case "hero":
      return [text(item.title), text(item.subtitle ?? item.content)].filter(Boolean).join("\n\n");
    case "badge":
      return text(item.label ?? item.content);
    case "chart":
      return chart(item.data);
    case "timeline":
      return timeline(item.items);
    case "divider":
      return divider(item.label);
    case "diff":
      return diff(item);
    case "code":
      return fenced(text(item.lang) ?? "text", item.code ?? item.content);
    case "json":
      return jsonBlock(item.value);
    case "mermaid":
      return fenced("mermaid", item.content ?? item.code ?? item.value);
    case "file-tree":
      return fenced("text", tree(item.items, 0));
    default:
      return text(item.content) ?? blocks(item.items, depth + 1);
  }
}

function textBlock(item: Record<string, unknown>): string | undefined {
  const content = text(item.content);
  if (!content) return undefined;
  if (item.size === "display" || item.size === "h1") return `# ${content}`;
  if (item.size === "h2") return `## ${content}`;
  if (item.size === "h3") return `### ${content}`;
  return content;
}

function container(item: Record<string, unknown>, depth: number): string | undefined {
  const parts = [text(item.eyebrow), text(item.title) ? `**${text(item.title)}**` : undefined];
  const body = blocks(item.items, depth + 1);
  if (body) parts.push(body);
  const rendered = parts.filter(Boolean);
  return rendered.length > 0 ? rendered.join("\n\n") : undefined;
}

function tabs(value: unknown, depth: number): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((tab) => {
    if (!isRecord(tab)) return [];
    const label = text(tab.label ?? tab.title);
    const body = blocks(tab.items, depth + 1);
    return [label ? `**${label}**` : undefined, body].filter(Boolean);
  });
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function layoutRow(items: unknown, depth: number): string | undefined {
  if (!Array.isArray(items)) return undefined;
  if (items.every((item) => isRecord(item) && item.type === "stat")) return stats(items);
  return blocks(items, depth + 1);
}

function stat(item: Record<string, unknown>): string | undefined {
  const label = text(item.label ?? item.title);
  const value = text(item.value ?? item.content);
  if (!label && !value) return undefined;
  return label ? `**${label}** ${value ?? ""}`.trim() : value;
}

function chart(data: unknown): string | undefined {
  if (!Array.isArray(data)) return undefined;
  return table(
    ["", ""],
    data.flatMap((datum) =>
      isRecord(datum) ? [[datum.label ?? datum.name, datum.value ?? datum.content]] : [],
    ),
  );
}

function timeline(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const lines = items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const title = text(item.title ?? item.label);
    const when = text(item.time);
    const desc = text(item.desc ?? item.content);
    const head = [when, title].filter(Boolean).join(" ");
    if (!head && !desc) return [];
    return [`- ${head}${desc ? `\n  ${desc}` : ""}`];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function callout(tone: unknown, title: unknown, content: unknown): string | undefined {
  const body = text(content);
  const heading = text(title);
  if (!body && !heading) return undefined;
  const kind = ALERT[typeof tone === "string" ? tone : ""] ?? "NOTE";
  const lines = [`> [!${kind}]`];
  if (heading) lines.push(`> **${heading}**`);
  if (body) lines.push(...body.split(/\r?\n/).map((line) => `> ${line}`));
  return lines.join("\n");
}

function table(columns: unknown, rows: unknown): string | undefined {
  if (!Array.isArray(columns) || !Array.isArray(rows) || columns.length === 0) return undefined;
  const header = columns.map((column) => cell(columnHeader(column)));
  const body = rows.flatMap((entry) =>
    Array.isArray(entry) ? [entry.map((value) => cell(value))] : [],
  );
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((cells) => `| ${pad(cells, header.length).join(" | ")} |`),
  ].join("\n");
}

function columnHeader(column: unknown): unknown {
  if (isRecord(column)) return column.label ?? column.title ?? column.key ?? column.name;
  return column;
}

function keyValue(pairs: unknown): string | undefined {
  if (!Array.isArray(pairs)) return undefined;
  const lines = pairs.flatMap((pair) => {
    if (!isRecord(pair)) return [];
    const key = text(pair.key ?? pair.label);
    const value = text(pair.value ?? pair.content);
    if (!key && !value) return [];
    return [`- **${key ?? ""}**: ${value ?? ""}`];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function listLine(item: unknown, depth: number): string | undefined {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return undefined;
  if (typeof item.type === "string") return renderItem(item, depth + 1);
  const title = text(item.title ?? item.content ?? item.label);
  const desc = text(item.desc ?? item.description);
  if (!title) return desc;
  return desc ? `${title} — ${desc}` : title;
}

function bulletList(items: unknown, depth: number): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const lines = items.flatMap((item) => {
    const line = listLine(item, depth);
    return line ? [`- ${line.replace(/\r?\n/g, " ")}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function steps(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value.flatMap((step, index) => {
    if (!isRecord(step)) return [];
    const title = text(step.title ?? step.content);
    const desc = text(step.desc ?? step.description);
    if (!title) return [];
    return [`${index + 1}. ${title.replace(/\r?\n/g, " ")}${desc ? ` — ${desc}` : ""}`];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function stats(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  const labels: string[] = [];
  const values: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const label = text(item.label ?? item.title);
    const value = text(item.value ?? item.content);
    if (!label && !value) continue;
    labels.push(cell(label));
    values.push(cell(value));
  }
  if (labels.length === 0) return undefined;
  return [
    `| ${labels.join(" | ")} |`,
    `| ${labels.map(() => "---").join(" | ")} |`,
    `| ${values.join(" | ")} |`,
  ].join("\n");
}

function divider(label: unknown): string {
  const title = text(label);
  return title ? `---\n\n**${title}**` : "---";
}

function diff(item: Record<string, unknown>): string | undefined {
  if (typeof item.content === "string") return fenced("diff", item.content);
  if (!Array.isArray(item.diffs)) return undefined;
  const body = item.diffs
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const path = text(entry.path);
      const next = typeof entry.newText === "string" ? entry.newText : "";
      const previous = typeof entry.oldText === "string" ? entry.oldText : "";
      return [`${path ?? ""}`, previous && `-${previous}`, next && `+${next}`].filter(Boolean);
    })
    .join("\n");
  return fenced("diff", body);
}

function jsonBlock(value: unknown): string | undefined {
  if (typeof value === "string") return fenced("json", value);
  if (value === undefined) return undefined;
  try {
    return fenced("json", JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

function fenced(info: string, content: unknown): string | undefined {
  const body = text(content);
  if (!body) return undefined;
  return `\`\`\`${info}\n${body}\n\`\`\``;
}

function tree(items: unknown, depth: number): string | undefined {
  if (!Array.isArray(items) || depth > 8) return undefined;
  const lines: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      lines.push(`${"  ".repeat(depth)}${item}`);
      continue;
    }
    if (!isRecord(item) || typeof item.name !== "string") continue;
    const name = item.type === "dir" ? `${item.name}/` : item.name;
    lines.push(`${"  ".repeat(depth)}${name}`);
    const nested = tree(item.children ?? item.items, depth + 1);
    if (nested) lines.push(nested);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function pad(cells: string[], width: number): string[] {
  return Array.from({ length: width }, (_, index) => cells[index] ?? "");
}

function cell(value: unknown): string {
  return (text(value) ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

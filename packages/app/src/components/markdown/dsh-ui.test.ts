import { expect, it } from "vitest";
import { prepareMarkdownSource } from "./source";
import { renderDshUiCards } from "./dsh-ui";

const card = {
  title: "v0.13 · 六项决策落点",
  gap: 12,
  items: [
    {
      type: "table",
      columns: ["决策", "结论", "落点"],
      rows: [
        ["Q1 租户模型", "Phase 0 即装 tenants", "ADR 0003"],
        ["Q2 认证", "自建：PyJWT", "ADR 0002"],
      ],
    },
    {
      type: "callout",
      tone: "warning",
      content: "Q11 定了「个人号」后，交接率不能一刀切。",
    },
  ],
};

it("renders a closed dsh-ui card as a title, table and warning", () => {
  const source = `前文\n\n\`\`\`dsh-ui\n${JSON.stringify(card)}\n\`\`\`\n\n后文`;
  expect(renderDshUiCards(source)).toBe(
    [
      "前文",
      "",
      "**v0.13 · 六项决策落点**",
      "",
      "| 决策 | 结论 | 落点 |",
      "| --- | --- | --- |",
      "| Q1 租户模型 | Phase 0 即装 tenants | ADR 0003 |",
      "| Q2 认证 | 自建：PyJWT | ADR 0002 |",
      "",
      "> [!WARNING]",
      "> Q11 定了「个人号」后，交接率不能一刀切。",
      "",
      "后文",
    ].join("\n"),
  );
  expect(prepareMarkdownSource(source).render()).toContain("| Q1 租户模型 |");
});

it("leaves an unclosed dsh-ui fence unchanged", () => {
  const source = '```dsh-ui\n{"title":"还没写完"}';
  expect(renderDshUiCards(source)).toBe(source);
});

it("renders the other card parts", () => {
  const source = `\`\`\`dsh-ui
${JSON.stringify({
  items: [
    { type: "steps", steps: [{ title: "建模板" }, { title: "开任务" }] },
    { type: "list", items: ["第一条", "第二条"] },
    { type: "keyvalue", pairs: [{ key: "校验", value: "断链 0" }] },
    { type: "row", items: [{ type: "stat", label: "文件", value: "23" }] },
    { type: "diff", content: "- old\n+ new" },
    {
      type: "file-tree",
      items: [
        { name: "docs/adr", type: "dir" },
        { name: "0001.md", type: "file" },
      ],
    },
    { type: "divider", label: "目录结构" },
  ],
})}
\`\`\``;
  const rendered = renderDshUiCards(source);
  expect(rendered).toContain("1. 建模板\n2. 开任务");
  expect(rendered).toContain("- 第一条");
  expect(rendered).toContain("- **校验**: 断链 0");
  expect(rendered).toContain("| 文件 |\n| --- |\n| 23 |");
  expect(rendered).toContain("```diff\n- old\n+ new\n```");
  expect(rendered).toContain("docs/adr/\n0001.md");
  expect(rendered).toContain("---\n\n**目录结构**");
});

it("accepts a punctuated label and nested cards", () => {
  const source = `\`\`\`dsh-ui>\n${JSON.stringify({
    title: "标点",
    items: [
      {
        type: "card",
        title: "内层",
        items: [{ type: "stat", label: "文件", value: "2" }],
      },
      { type: "code", lang: "ts", code: "const n = 1" },
    ],
  })}\n\`\`\``;
  const rendered = renderDshUiCards(source);
  expect(rendered).toContain("**标点**");
  expect(rendered).toContain("**内层**");
  expect(rendered).toContain("**文件** 2");
  expect(rendered).toContain("```ts\nconst n = 1\n```");
});

it("renders a finished card that has not closed its fence", () => {
  const source = `\`\`\`dsh-ui\n${JSON.stringify({
    items: [{ type: "text", content: "已经写完" }],
  })}`;
  expect(renderDshUiCards(source)).toBe("已经写完");
});

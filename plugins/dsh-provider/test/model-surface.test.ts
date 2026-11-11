import { describe, expect, it } from "vitest";
import {
  contextControl,
  contextMutation,
  formatCapacity,
  readModelSurface,
  selectionFromProjection,
} from "../server/model-surface.js";

const providers = [
  { provider: "deepseek", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
  {
    provider: "openai",
    displayName: "OpenAI",
    settingsNs: "llm-pi-ai",
    settingsPath: ["providers", "openai"],
  },
];

describe("model surface", () => {
  it("prefers the pending selection over the last request", () => {
    expect(
      selectionFromProjection({
        kind: "sequenced",
        values: {
          modelSelection: {
            lastUsed: { provider: "deepseek", model: "v4", reasoningEffort: "high" },
            next: { provider: "deepseek", model: "v4", reasoningEffort: "max" },
          },
        },
      }),
    ).toEqual({ provider: "deepseek", model: "v4", reasoningEffort: "max" });
  });

  it("spells capacities the way the host does", () => {
    expect(formatCapacity(1_000_000)).toBe("1M");
    expect(formatCapacity(256_000)).toBe("256K");
    expect(formatCapacity(8192)).toBe("8192");
  });

  it("offers only windows the profile already contains", () => {
    const surface = readModelSurface(providers, {
      namespaces: [
        {
          ns: "llm-deepseek",
          revision: 4,
          value: { defaultContextWindow: 1_000_000, models: [{ id: "v4", name: "V4" }] },
          base: {
            defaultContextWindow: 1_000_000,
            models: [
              { id: "v4", name: "V4" },
              { id: "other", name: "Other", contextWindow: 256_000 },
            ],
          },
        },
      ],
    });
    expect(contextControl(surface, "deepseek", "v4")?.controls[0]?.choices).toEqual([
      { value: "256000", label: "256K" },
      { value: "1000000", label: "1M" },
    ]);
    expect(contextMutation(surface, "deepseek", "v4", 256_000)).toEqual({
      ns: "llm-deepseek",
      expectedRevision: 4,
      ops: [
        {
          op: "set",
          path: ["models"],
          value: [
            { id: "v4", name: "V4", contextWindow: 256_000 },
            { id: "other", name: "Other", contextWindow: 256_000 },
          ],
        },
      ],
    });
  });

  it("sets defaultContextWindow when the profile has no model list to copy", () => {
    const surface = readModelSurface(providers, {
      namespaces: [
        {
          ns: "llm-pi-ai",
          revision: 1,
          value: { providers: { openai: { defaultContextWindow: 200_000 } } },
        },
      ],
    });
    expect(contextControl(surface, "openai", "gpt")?.providerOptions).toEqual({
      contextWindow: "200000",
    });
    expect(contextMutation(surface, "openai", "gpt", 200_000)?.ops).toEqual([
      { op: "set", path: ["providers", "openai", "defaultContextWindow"], value: 200_000 },
    ]);
  });
});

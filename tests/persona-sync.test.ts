import { readFile } from "node:fs/promises";

import { parse } from "dotenv";
import { describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "../src/persona.js";

describe("铃铃酱提示词单一版本", () => {
  it("代码默认值、环境模板和人设文档逐字一致", async () => {
    const [environmentTemplate, personaDocument] = await Promise.all([
      readFile(".env.example", "utf8"),
      readFile("docs/PERSONA.md", "utf8"),
    ]);
    const documentedPrompt = /```text\r?\n([\s\S]*?)\r?\n```/
      .exec(personaDocument)?.[1]
      ?.trim();

    expect(documentedPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(parse(environmentTemplate).AI_SYSTEM_PROMPT).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
  });
});

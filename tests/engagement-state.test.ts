import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatDayKey,
  PersistentEngagementState,
} from "../src/engagement-state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("主动互动持久化状态", () => {
  it("保存每日次数、冷却和热点记录，但不保存群聊正文", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qq-engagement-state-"));
    directories.push(directory);
    const filePath = join(directory, "state.json");
    const now = Date.parse("2026-07-19T04:00:00.000Z");
    const store = new PersistentEngagementState(filePath, "Asia/Shanghai");

    await store.recordProactiveText("10001", now, "热点投喂内容");
    await store.recordReaction("10001", now + 1_000);
    await store.setNextHotTopicAt("10001", now + 86_400_000, now);
    await store.recordMorningRadarAttempt("10001", now);
    await store.recordDailyRoastAttempt("10001", now, "20002");

    const reloaded = new PersistentEngagementState(filePath, "Asia/Shanghai");
    await expect(reloaded.get("10001", now + 2_000)).resolves.toMatchObject({
      proactiveTextCount: 1,
      reactionCount: 1,
      lastProactiveTextAt: now,
      lastReactionAt: now + 1_000,
      nextHotTopicAt: now + 86_400_000,
      lastMorningRadarDayKey: "2026-07-19",
      lastDailyRoastDayKey: "2026-07-19",
      lastRoastSenderId: "20002",
      recentHotTopics: ["热点投喂内容"],
    });

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("群友聊天正文");
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("跨自然日重置每日次数并保留下一次热点时间", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qq-engagement-day-"));
    directories.push(directory);
    const filePath = join(directory, "state.json");
    const firstDay = Date.parse("2026-07-19T04:00:00.000Z");
    const secondDay = Date.parse("2026-07-20T04:00:00.000Z");
    const nextHotTopicAt = secondDay + 3_600_000;
    const store = new PersistentEngagementState(filePath, "Asia/Shanghai");

    await store.recordProactiveText("10001", firstDay);
    await store.recordReaction("10001", firstDay);
    await store.setNextHotTopicAt("10001", nextHotTopicAt, firstDay);

    await expect(store.get("10001", secondDay)).resolves.toMatchObject({
      dayKey: "2026-07-20",
      proactiveTextCount: 0,
      reactionCount: 0,
      nextHotTopicAt,
    });
  });

  it("按指定时区生成日键", () => {
    const timestamp = Date.parse("2026-07-19T17:00:00.000Z");
    expect(formatDayKey(timestamp, "Asia/Shanghai")).toBe("2026-07-20");
  });
});

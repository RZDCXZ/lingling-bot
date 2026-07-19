import { describe, expect, it, vi } from "vitest";

import type { AiImage, AiService } from "../src/ai/types.js";
import type { AppConfig } from "../src/config.js";
import {
  DailyLongevityCoordinator,
  parseDailyLongevityReply,
} from "../src/daily-longevity.js";

const config: AppConfig["longevity"] = {
  enabled: true,
  timeZone: "Asia/Shanghai",
  submitterUserId: "20002",
  targetGroupIds: ["10001"],
  reminderMinutes: 21 * 60 + 50,
  sendMinutes: 22 * 60,
  catchUpEndMinutes: 22 * 60 + 10,
  maxImages: 6,
  archiveDirectory: "/tmp/daily-sese-test",
};

const archiveImages = () => Promise.resolve();

function image(label: string): AiImage {
  return {
    dataUrl: `data:image/png;base64,${Buffer.from(label).toString("base64")}`,
    detail: "auto",
  };
}

function ports() {
  return {
    allowGeneration: vi.fn(() => true),
    sendPrivateText: vi.fn().mockResolvedValue(undefined),
    sendGroupPost: vi.fn().mockResolvedValue(undefined),
  };
}

describe("延年益寿定时环节", () => {
  it("二十一点五十分只提醒指定主号一次", async () => {
    const now = Date.parse("2026-07-19T13:50:00.000Z");
    const coordinator = new DailyLongevityCoordinator({
      ai: { generateReply: vi.fn<AiService["generateReply"]>() },
      config,
      tickMs: 30_000,
      now: () => now,
      archiveImages,
    });
    const scheduledPorts = ports();

    await coordinator.runScheduledTick(scheduledPorts);
    await coordinator.runScheduledTick(scheduledPorts);

    expect(scheduledPorts.sendPrivateText).toHaveBeenCalledOnce();
    expect(scheduledPorts.sendPrivateText).toHaveBeenCalledWith(
      "20002",
      expect.stringContaining("【延年益寿】"),
    );
    expect(scheduledPorts.sendPrivateText.mock.calls[0]?.[1]).toContain(
      "明确成年、非露骨、非真人",
    );
  });

  it("征集窗口缓存指定主号投稿并在二十二点审核后发群", async () => {
    let now = Date.parse("2026-07-19T13:52:00.000Z");
    const first = image("first");
    const second = image("second");
    const third = image("third");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[LONGEVITY:1,3]]今晚这份养生套餐，有点让人舍不得早睡喵~");
    const coordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config,
      tickMs: 30_000,
      now: () => now,
      archiveImages,
    });
    const scheduledPorts = ports();

    await expect(coordinator.acceptImages("30003", [first])).resolves.toBeNull();
    await expect(
      coordinator.acceptImages("20002", [first, second, third]),
    ).resolves.toEqual({
      accepted: 3,
      ignored: 0,
      total: 3,
      max: 6,
    });
    now = Date.parse("2026-07-19T14:00:00.000Z");

    await coordinator.runScheduledTick(scheduledPorts);

    expect(generateReply).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: "submitted_image_count: 3",
          images: [first, second, third],
        },
      ],
      { mode: "daily-longevity" },
    );
    expect(scheduledPorts.sendGroupPost).toHaveBeenCalledWith(
      "10001",
      expect.stringContaining("【延年益寿】"),
      [first, third],
    );
  });

  it("没有投稿或全部未通过时不向群里发消息", async () => {
    let now = Date.parse("2026-07-19T14:00:00.000Z");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[SILENT]]");
    const emptyCoordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config,
      tickMs: 30_000,
      now: () => now,
      archiveImages,
    });
    const emptyPorts = ports();

    await emptyCoordinator.runScheduledTick(emptyPorts);
    expect(generateReply).not.toHaveBeenCalled();
    expect(emptyPorts.sendGroupPost).not.toHaveBeenCalled();

    now = Date.parse("2026-07-20T13:55:00.000Z");
    const rejectedCoordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config,
      tickMs: 30_000,
      now: () => now,
      archiveImages,
    });
    await rejectedCoordinator.acceptImages("20002", [image("rejected")]);
    now = Date.parse("2026-07-20T14:00:00.000Z");
    const rejectedPorts = ports();

    await rejectedCoordinator.runScheduledTick(rejectedPorts);
    expect(generateReply).toHaveBeenCalledOnce();
    expect(rejectedPorts.sendGroupPost).not.toHaveBeenCalled();
  });

  it("允许投稿人查看数量并清空当晚投稿", async () => {
    const now = Date.parse("2026-07-19T13:55:00.000Z");
    const coordinator = new DailyLongevityCoordinator({
      ai: { generateReply: vi.fn<AiService["generateReply"]>() },
      config,
      tickMs: 30_000,
      now: () => now,
      archiveImages,
    });
    await coordinator.acceptImages("20002", [image("a"), image("b")]);

    await expect(coordinator.submissionCount("20002")).resolves.toBe(2);
    await expect(coordinator.cancelSubmission("20002")).resolves.toBe(2);
    await expect(coordinator.submissionCount("20002")).resolves.toBe(0);
  });
});

describe("延年益寿输出解析", () => {
  it("只接受存在且不重复的附图序号", () => {
    expect(
      parseDailyLongevityReply("[[LONGEVITY:1,3]]配文", 3),
    ).toEqual({ imageIndexes: [1, 3], text: "配文" });
    expect(
      parseDailyLongevityReply("[[LONGEVITY:1,1]]重复", 3),
    ).toBeNull();
    expect(parseDailyLongevityReply("[[LONGEVITY:4]]越界", 3)).toBeNull();
    expect(parseDailyLongevityReply("[[SILENT]]", 3)).toBeNull();
  });
});

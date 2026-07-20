import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  sendMinutes: 22 * 60,
  catchUpEndMinutes: 22 * 60 + 10,
  maxImages: 6,
  archiveDirectory: "/tmp/daily-sese-test",
};

const archiveRoots: string[] = [];

async function isolatedConfig(): Promise<AppConfig["longevity"]> {
  const archiveDirectory = await mkdtemp(
    join(tmpdir(), `daily-longevity-${process.pid}-`),
  );
  archiveRoots.push(archiveDirectory);
  return { ...config, archiveDirectory };
}

afterEach(async () => {
  await Promise.all(
    archiveRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

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
  it("二十一点五十分不再私聊提醒", async () => {
    const now = Date.parse("2026-07-19T13:50:00.000Z");
    const coordinator = new DailyLongevityCoordinator({
      ai: { generateReply: vi.fn<AiService["generateReply"]>() },
      config: await isolatedConfig(),
      tickMs: 30_000,
      now: () => now,
    });
    const scheduledPorts = ports();

    await coordinator.runScheduledTick(scheduledPorts);
    await coordinator.runScheduledTick(scheduledPorts);

    expect(scheduledPorts.sendPrivateText).not.toHaveBeenCalled();
    expect(scheduledPorts.sendGroupPost).not.toHaveBeenCalled();
  });

  it("随时预审指定主号投稿并在二十二点复审后发群", async () => {
    let now = Date.parse("2026-07-19T13:52:00.000Z");
    const first = image("first");
    const second = image("second");
    const third = image("third");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValueOnce("[[LONGEVITY:1,3]]预审完成")
      .mockResolvedValueOnce(
        "[[LONGEVITY:1,2]]今晚这份养生套餐，有点让人舍不得早睡喵~",
      );
    const coordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config: await isolatedConfig(),
      tickMs: 30_000,
      now: () => now,
    });
    const scheduledPorts = ports();

    await expect(coordinator.acceptImages("30003", [first])).resolves.toBeNull();
    await expect(
      coordinator.acceptImages("20002", [first, second, third]),
    ).resolves.toEqual({
      archived: 3,
      accepted: 2,
      ignored: 0,
      total: 2,
      max: 6,
      scheduledDayKey: "2026-07-19",
      approvedIndexes: [1, 3],
      rejectedIndexes: [2],
    });
    now = Date.parse("2026-07-19T14:00:00.000Z");

    await coordinator.runScheduledTick(scheduledPorts);

    expect(generateReply).toHaveBeenCalledWith(
      [
        {
          role: "user",
          content: "submitted_image_count: 2",
          images: [first, third],
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

  it("二十二点后提交的图片归入次日目录并在次日二十二点发布", async () => {
    let now = Date.parse("2026-07-19T14:05:00.000Z");
    const submitted = image("next-day");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValueOnce("[[LONGEVITY:1]]预审通过")
      .mockResolvedValueOnce("[[LONGEVITY:1]]明晚的养生库存已经备好喵~");
    const nextDayConfig = await isolatedConfig();
    const coordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config: nextDayConfig,
      tickMs: 30_000,
      now: () => now,
    });

    await expect(
      coordinator.acceptImages("20002", [submitted]),
    ).resolves.toMatchObject({ scheduledDayKey: "2026-07-20" });

    expect(
      (await readdir(join(nextDayConfig.archiveDirectory, "2026-07-20"))).filter(
        (fileName) => !fileName.startsWith("."),
      ),
    ).toEqual(["001.png"]);

    now = Date.parse("2026-07-20T14:00:00.000Z");
    const scheduledPorts = ports();
    await coordinator.runScheduledTick(scheduledPorts);

    expect(generateReply).toHaveBeenCalledTimes(2);
    expect(scheduledPorts.sendGroupPost).toHaveBeenCalledWith(
      "10001",
      expect.stringContaining("【延年益寿】"),
      [submitted],
    );
  });

  it("没有投稿或全部未通过时不向群里发消息", async () => {
    let now = Date.parse("2026-07-19T14:00:00.000Z");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[SILENT]]");
    const emptyCoordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config: await isolatedConfig(),
      tickMs: 30_000,
      now: () => now,
    });
    const emptyPorts = ports();

    await emptyCoordinator.runScheduledTick(emptyPorts);
    expect(generateReply).not.toHaveBeenCalled();
    expect(emptyPorts.sendGroupPost).not.toHaveBeenCalled();

    now = Date.parse("2026-07-20T13:55:00.000Z");
    const rejectedConfig = await isolatedConfig();
    const rejectedCoordinator = new DailyLongevityCoordinator({
      ai: { generateReply },
      config: rejectedConfig,
      tickMs: 30_000,
      now: () => now,
    });
    await expect(
      rejectedCoordinator.acceptImages("20002", [image("rejected")]),
    ).resolves.toMatchObject({
      archived: 1,
      accepted: 0,
      approvedIndexes: [],
      rejectedIndexes: [1],
      total: 0,
    });
    expect(
      (await readdir(join(rejectedConfig.archiveDirectory, "2026-07-20"))).filter(
        (fileName) => !fileName.startsWith("."),
      ),
    ).toEqual(["001.png"]);
    now = Date.parse("2026-07-20T14:00:00.000Z");
    const rejectedPorts = ports();

    await rejectedCoordinator.runScheduledTick(rejectedPorts);
    expect(generateReply).toHaveBeenCalledOnce();
    expect(rejectedPorts.sendGroupPost).not.toHaveBeenCalled();
  });

  it("预审暂时失败时仍保留已收到的归档原图但不加入待发布清单", async () => {
    const now = Date.parse("2026-07-19T01:00:00.000Z");
    const failedReviewConfig = await isolatedConfig();
    const coordinator = new DailyLongevityCoordinator({
      ai: {
        generateReply: vi
          .fn<AiService["generateReply"]>()
          .mockRejectedValue(new Error("预审暂时不可用")),
      },
      config: failedReviewConfig,
      tickMs: 30_000,
      now: () => now,
    });

    await expect(
      coordinator.acceptImages("20002", [image("saved-before-review")]),
    ).rejects.toThrow("预审暂时不可用");
    expect(
      (await readdir(join(failedReviewConfig.archiveDirectory, "2026-07-19"))).filter(
        (fileName) => !fileName.startsWith("."),
      ),
    ).toEqual(["001.png"]);
    await expect(coordinator.submissionCount("20002")).resolves.toBe(0);
  });

  it("允许投稿人查看数量并清空当晚投稿", async () => {
    const now = Date.parse("2026-07-19T13:55:00.000Z");
    const coordinator = new DailyLongevityCoordinator({
      ai: {
        generateReply: vi
          .fn<AiService["generateReply"]>()
          .mockResolvedValue("[[LONGEVITY:1,2]]预审通过"),
      },
      config: await isolatedConfig(),
      tickMs: 30_000,
      now: () => now,
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

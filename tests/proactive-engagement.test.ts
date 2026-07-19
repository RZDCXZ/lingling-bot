import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../src/ai/types.js";
import type { AppConfig } from "../src/config.js";
import type {
  EngagementSnapshot,
  EngagementStatePort,
} from "../src/engagement-state.js";
import {
  GroupParticipationCoordinator,
  isWithinActiveHours,
} from "../src/group-participation.js";

class MemoryEngagementState implements EngagementStatePort {
  readonly records = new Map<string, EngagementSnapshot>();

  async get(groupId: string): Promise<EngagementSnapshot> {
    return this.records.get(groupId) ?? {
      dayKey: "2026-07-19",
      proactiveTextCount: 0,
      reactionCount: 0,
      recentHotTopics: [],
    };
  }

  async recordProactiveText(
    groupId: string,
    now: number,
    hotTopicText?: string,
  ): Promise<void> {
    const current = await this.get(groupId);
    this.records.set(groupId, {
      ...current,
      proactiveTextCount: current.proactiveTextCount + 1,
      lastProactiveTextAt: now,
      recentHotTopics: hotTopicText
        ? [hotTopicText, ...current.recentHotTopics].slice(0, 3)
        : current.recentHotTopics,
    });
  }

  async recordReaction(groupId: string, now: number): Promise<void> {
    const current = await this.get(groupId);
    this.records.set(groupId, {
      ...current,
      reactionCount: current.reactionCount + 1,
      lastReactionAt: now,
    });
  }

  async setNextHotTopicAt(
    groupId: string,
    timestamp: number,
  ): Promise<void> {
    const current = await this.get(groupId);
    this.records.set(groupId, { ...current, nextHotTopicAt: timestamp });
  }
}

const participationConfig = {
  enabled: false,
  minMessages: 3,
  cooldownMs: 120_000,
  probability: 0.3,
  contextMessages: 8,
  oldJokeMemoryMessages: 30,
};

function proactive(
  overrides: Partial<AppConfig["proactive"]> = {},
): AppConfig["proactive"] {
  return {
    enabled: true,
    timeZone: "UTC",
    activeStartMinutes: 0,
    activeEndMinutes: 24 * 60 - 1,
    dailyTextLimit: 4,
    textCooldownMs: 60_000,
    tickMs: 30_000,
    unansweredEnabled: true,
    unansweredDelayMs: 180_000,
    revivalEnabled: true,
    revivalMinSilenceMs: 3_600_000,
    revivalMaxSilenceMs: 7_200_000,
    revivalProbability: 0.2,
    hotTopicEnabled: true,
    hotTopicIntervalMs: 86_400_000,
    hotTopicInitialMinMs: 3_600_000,
    hotTopicInitialMaxMs: 10_800_000,
    hotTopics: ["AI", "明日方舟：终末地", "绝区零", "异环", "鸣潮"],
    ...overrides,
  };
}

const reactionDisabled: AppConfig["reaction"] = {
  enabled: false,
  probability: 0,
  cooldownMs: 300_000,
  dailyLimit: 12,
  emojiIds: ["14", "66", "76"],
};

function message(content: string, index: number) {
  return {
    groupId: "10001",
    senderId: String(20_000 + index),
    senderName: `群友${index}`,
    messageId: String(30_000 + index),
    content,
  };
}

function scheduledPorts() {
  return {
    sendGroupText: vi.fn().mockResolvedValue(undefined),
    sendGroupReply: vi.fn().mockResolvedValue(undefined),
  };
}

describe("主动互动调度", () => {
  it("只在配置时区的活跃时段内工作", () => {
    const config = {
      timeZone: "Asia/Singapore",
      activeStartMinutes: 9 * 60,
      activeEndMinutes: 23 * 60 + 30,
    };

    expect(
      isWithinActiveHours(Date.parse("2026-07-19T01:00:00.000Z"), config),
    ).toBe(true);
    expect(
      isWithinActiveHours(Date.parse("2026-07-19T15:30:00.000Z"), config),
    ).toBe(false);
  });

  it("问题三分钟无人接话时由 Codex 判断是否救场", async () => {
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REPLY]]这个我会，答案是先重启试试喵~");
    const engagementState = new MemoryEngagementState();
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: participationConfig,
      proactive: proactive(),
      reaction: reactionDisabled,
      engagementState,
      now: () => now,
      random: () => 0,
    });
    coordinator.observeHuman(message("大家知道这个怎么解决吗？", 1));
    now += 3 * 60 * 1_000;
    const ports = scheduledPorts();

    await coordinator.runScheduledTick({
      groupIds: ["10001"],
      ports,
      allowGeneration: () => true,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.any(Array),
      { mode: "unanswered-question" },
    );
    expect(ports.sendGroupReply).toHaveBeenCalledWith(
      {
        groupId: "10001",
        senderId: "20001",
        messageId: "30001",
      },
      "这个我会，答案是先重启试试喵~",
    );
  });

  it("问题之后已有群友说话时取消无人回答救场", async () => {
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const generateReply = vi.fn<AiService["generateReply"]>();
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: participationConfig,
      proactive: proactive({ hotTopicEnabled: false, revivalEnabled: false }),
      reaction: reactionDisabled,
      now: () => now,
      random: () => 0,
    });
    coordinator.observeHuman(message("大家知道答案吗？", 1));
    coordinator.observeHuman(message("我来回答你", 2));
    now += 3 * 60 * 1_000;

    await coordinator.runScheduledTick({
      groupIds: ["10001"],
      ports: scheduledPorts(),
      allowGeneration: () => true,
    });

    expect(generateReply).not.toHaveBeenCalled();
  });

  it("冷场达到随机等待时间后只尝试一次续聊", async () => {
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REPLY]]刚才那个梗现在想想还是很有工伤气质喵~");
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: participationConfig,
      proactive: proactive({
        unansweredEnabled: false,
        hotTopicEnabled: false,
        revivalMinSilenceMs: 1_000,
        revivalMaxSilenceMs: 1_000,
        revivalProbability: 1,
      }),
      reaction: reactionDisabled,
      now: () => now,
      random: () => 0,
    });
    coordinator.observeHuman(message("今天加班", 1));
    coordinator.observeHuman(message("工位是第二个家", 2));
    coordinator.observeHuman(message("公司欠我房租", 3));
    now += 1_000;
    const ports = scheduledPorts();

    await coordinator.runScheduledTick({
      groupIds: ["10001"],
      ports,
      allowGeneration: () => true,
    });
    await coordinator.runScheduledTick({
      groupIds: ["10001"],
      ports,
      allowGeneration: () => true,
    });

    expect(generateReply).toHaveBeenCalledOnce();
    expect(generateReply).toHaveBeenCalledWith(expect.any(Array), {
      mode: "cold-revival",
    });
    expect(ports.sendGroupText).toHaveBeenCalledOnce();
  });

  it("热点到期后搜索指定领域并记录投喂，避免重启重复", async () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue(
        "[[REPLY]]终末地刚放了新公告，哥哥们可以开瓜了：https://example.com 喵~",
      );
    const engagementState = new MemoryEngagementState();
    await engagementState.setNextHotTopicAt("10001", now);
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: participationConfig,
      proactive: proactive({
        unansweredEnabled: false,
        revivalEnabled: false,
      }),
      reaction: reactionDisabled,
      engagementState,
      now: () => now,
      random: () => 0,
    });
    coordinator.observeHuman(message("早", 1));
    coordinator.observeHuman(message("中", 2));
    coordinator.observeHuman(message("晚", 3));
    const ports = scheduledPorts();

    await coordinator.runScheduledTick({
      groupIds: ["10001"],
      ports,
      allowGeneration: () => true,
    });

    expect(generateReply).toHaveBeenCalledWith(
      expect.any(Array),
      {
        mode: "hot-topic-feed",
        hotTopics: ["AI", "明日方舟：终末地", "绝区零", "异环", "鸣潮"],
      },
    );
    expect((await engagementState.get("10001")).recentHotTopics).toHaveLength(1);
    expect((await engagementState.get("10001")).nextHotTopicAt).toBe(
      now + 86_400_000,
    );
  });

  it("达到每日主动文字上限后不再调用 Codex", async () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const generateReply = vi.fn<AiService["generateReply"]>();
    const engagementState = new MemoryEngagementState();
    engagementState.records.set("10001", {
      dayKey: "2026-07-19",
      proactiveTextCount: 4,
      reactionCount: 0,
      nextHotTopicAt: now,
      recentHotTopics: [],
    });
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: participationConfig,
      proactive: proactive({ unansweredEnabled: false, revivalEnabled: false }),
      reaction: reactionDisabled,
      engagementState,
      now: () => now,
      random: () => 0,
    });
    coordinator.observeHuman(message("一", 1));
    coordinator.observeHuman(message("二", 2));
    coordinator.observeHuman(message("三", 3));

    await coordinator.runScheduledTick({
      groupIds: ["10001"],
      ports: scheduledPorts(),
      allowGeneration: () => true,
    });

    expect(generateReply).not.toHaveBeenCalled();
  });
});

describe("轻量表情与旧梗", () => {
  it("由 Codex 从白名单表情中选择消息回应", async () => {
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[REACTION:76]]");
    const react = vi.fn().mockResolvedValue(undefined);
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: participationConfig,
      proactive: proactive({ enabled: true }),
      reaction: {
        enabled: true,
        probability: 1,
        cooldownMs: 300_000,
        dailyLimit: 12,
        emojiIds: ["14", "66", "76"],
      },
      now: () => now,
      random: () => 0,
    });

    await expect(
      coordinator.handleUnmentioned(message("这波操作可以", 1), {
        send: vi.fn(),
        react,
      }),
    ).resolves.toBe("reaction");

    expect(generateReply).toHaveBeenCalledWith(expect.any(Array), {
      mode: "group-reaction",
      reactionEmojiIds: ["14", "66", "76"],
    });
    expect(react).toHaveBeenCalledWith("30001", "76");
  });

  it("较早群聊片段只作为旧梗回旋镖上下文传给 Codex", async () => {
    const generateReply = vi
      .fn<AiService["generateReply"]>()
      .mockResolvedValue("[[SILENT]]");
    const coordinator = new GroupParticipationCoordinator({
      ai: { generateReply },
      config: {
        ...participationConfig,
        enabled: true,
        minMessages: 5,
        probability: 1,
        contextMessages: 3,
        oldJokeMemoryMessages: 10,
      },
      random: () => 0,
    });

    for (let index = 1; index <= 5; index += 1) {
      await coordinator.handleUnmentioned(message(`第${index}句`, index), {
        send: vi.fn(),
      });
    }

    const context = generateReply.mock.calls[0]?.[0];
    expect(context?.[0]?.content).toContain("较早群聊片段");
    expect(context?.[0]?.content).toContain("第1句");
    expect(context?.slice(-3)).toEqual([
      { role: "user", content: "[群友：群友3] 第3句" },
      { role: "user", content: "[群友：群友4] 第4句" },
      { role: "user", content: "[群友：群友5] 第5句" },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { ConfigurationError, parseConfig } from "../src/config.js";
import { DEFAULT_SYSTEM_PROMPT } from "../src/persona.js";

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ONEBOT_ACCESS_TOKEN: "onebot-token",
    ONEBOT_ALLOWED_GROUP_IDS: "123456789, 987654321",
    ...overrides,
  };
}

describe("parseConfig", () => {
  it("使用受限 Codex CLI 并填充安全默认值", () => {
    const config = parseConfig(validEnv());

    expect(config.ai.command).toBe("codex");
    expect(config.ai.model).toBe("gpt-5.6-luna");
    expect(config.ai.reasoningEffort).toBe("medium");
    expect(config.ai.liveSearch).toBe(true);
    expect(config.ai.timeoutMs).toBe(300_000);
    expect(config.ai.maxConcurrent).toBe(2);
    expect(config.ai.maxQueue).toBe(12);
    expect(config.ai.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(config.conversation.maxTurns).toBe(20);
    expect(config.conversation.ttlMs).toBe(24 * 60 * 60 * 1_000);
    expect(config.groupParticipation).toEqual({
      enabled: true,
      minMessages: 3,
      cooldownMs: 120_000,
      probability: 0.3,
      contextMessages: 8,
      oldJokeMemoryMessages: 30,
    });
    expect(config.proactive).toEqual({
      enabled: true,
      timeZone: "Asia/Shanghai",
      activeStartMinutes: 9 * 60,
      activeEndMinutes: 23 * 60 + 30,
      dailyTextLimit: 4,
      textCooldownMs: 600_000,
      tickMs: 30_000,
      unansweredEnabled: true,
      unansweredDelayMs: 180_000,
      revivalEnabled: true,
      revivalMinSilenceMs: 3_600_000,
      revivalMaxSilenceMs: 7_200_000,
      revivalProbability: 0.2,
      hotTopicEnabled: false,
      hotTopicIntervalMs: 86_400_000,
      hotTopicInitialMinMs: 3_600_000,
      hotTopicInitialMaxMs: 10_800_000,
      hotTopics: ["AI", "明日方舟：终末地", "绝区零", "异环", "鸣潮"],
      morningRadarEnabled: true,
      morningRadarMinutes: 8 * 60,
      morningRadarCatchUpEndMinutes: 9 * 60,
      morningRadarLocation: "中国四川成都",
      dailyRoastEnabled: true,
      dailyRoastMinutes: 21 * 60,
      dailyRoastCatchUpEndMinutes: 22 * 60,
      dailyRoastMinMessages: 3,
      dailyRoastMaxMessages: 120,
    });
    expect(config.longevity).toEqual({
      enabled: false,
      timeZone: "Asia/Shanghai",
      submitterUserId: "",
      targetGroupIds: [],
      reminderMinutes: 21 * 60 + 50,
      sendMinutes: 22 * 60,
      catchUpEndMinutes: 22 * 60 + 10,
      maxImages: 6,
    });
    expect(config.reaction).toEqual({
      enabled: true,
      probability: 0.12,
      cooldownMs: 300_000,
      dailyLimit: 12,
      emojiIds: ["14", "66", "76"],
    });
    expect(config.oneBot.wsUrl).toBe("ws://127.0.0.1:3001");
    expect([...config.oneBot.allowedGroupIds]).toEqual([
      "123456789",
      "987654321",
    ]);
    expect(config.oneBot.allowedPrivateUserIds.size).toBe(0);
  });

  it("支持只启用好友私聊白名单", () => {
    const config = parseConfig(
      validEnv({
        ONEBOT_ALLOWED_GROUP_IDS: "",
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002, 30003",
      }),
    );

    expect(config.oneBot.allowedGroupIds.size).toBe(0);
    expect([...config.oneBot.allowedPrivateUserIds]).toEqual(["20002", "30003"]);
  });

  it("支持覆盖 Codex 模型、推理、搜索和并发配置", () => {
    const config = parseConfig(
      validEnv({
        CODEX_COMMAND: "/opt/bin/codex",
        CODEX_MODEL: "gpt-5.6-terra",
        CODEX_REASONING_EFFORT: "high",
        CODEX_LIVE_SEARCH: "false",
        CODEX_TIMEOUT_MS: "180000",
        CODEX_MAX_CONCURRENT: "1",
        CODEX_MAX_QUEUE: "4",
      }),
    );

    expect(config.ai).toMatchObject({
      command: "/opt/bin/codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      liveSearch: false,
      timeoutMs: 180_000,
      maxConcurrent: 1,
      maxQueue: 4,
    });
  });

  it("支持覆盖会话轮数和闲置过期时间", () => {
    const config = parseConfig(
      validEnv({
        CONVERSATION_MAX_TURNS: "30",
        CONVERSATION_TTL_MS: "172800000",
      }),
    );

    expect(config.conversation).toEqual({
      maxTurns: 30,
      ttlMs: 2 * 24 * 60 * 60 * 1_000,
    });
  });

  it("支持覆盖群聊参与策略", () => {
    const config = parseConfig(
      validEnv({
        GROUP_PARTICIPATION_ENABLED: "false",
        GROUP_PARTICIPATION_MIN_MESSAGES: "5",
        GROUP_PARTICIPATION_COOLDOWN_MS: "300000",
        GROUP_PARTICIPATION_PROBABILITY: "0.15",
        GROUP_PARTICIPATION_CONTEXT_MESSAGES: "12",
        GROUP_OLD_JOKE_MEMORY_MESSAGES: "40",
      }),
    );

    expect(config.groupParticipation).toEqual({
      enabled: false,
      minMessages: 5,
      cooldownMs: 300_000,
      probability: 0.15,
      contextMessages: 12,
      oldJokeMemoryMessages: 40,
    });
  });

  it("支持覆盖主动互动、定时任务和轻量表情策略", () => {
    const config = parseConfig(
      validEnv({
        PROACTIVE_ENGAGEMENT_ENABLED: "false",
        PROACTIVE_TIME_ZONE: "Asia/Shanghai",
        PROACTIVE_ACTIVE_START: "10:15",
        PROACTIVE_ACTIVE_END: "22:45",
        PROACTIVE_DAILY_TEXT_LIMIT: "2",
        PROACTIVE_UNANSWERED_DELAY_MS: "600000",
        PROACTIVE_REVIVAL_PROBABILITY: "0.1",
        PROACTIVE_HOT_TOPICS: "AI,绝区零",
        MORNING_RADAR_TIME: "07:30",
        MORNING_RADAR_CATCH_UP_END: "08:15",
        MORNING_RADAR_LOCATION: "中国四川绵阳",
        DAILY_ROAST_TIME: "20:30",
        DAILY_ROAST_CATCH_UP_END: "21:15",
        DAILY_ROAST_MIN_MESSAGES: "5",
        DAILY_ROAST_MAX_MESSAGES: "80",
        ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
        DAILY_LONGEVITY_ENABLED: "true",
        DAILY_LONGEVITY_SUBMITTER_USER_ID: "20002",
        DAILY_LONGEVITY_TARGET_GROUP_IDS: "123456789",
        DAILY_LONGEVITY_REMINDER_TIME: "21:40",
        DAILY_LONGEVITY_SEND_TIME: "21:55",
        DAILY_LONGEVITY_CATCH_UP_END: "22:05",
        DAILY_LONGEVITY_MAX_IMAGES: "4",
        GROUP_REACTION_ENABLED: "false",
        GROUP_REACTION_PROBABILITY: "0.2",
        GROUP_REACTION_EMOJI_IDS: "66,76",
      }),
    );

    expect(config.proactive).toMatchObject({
      enabled: false,
      timeZone: "Asia/Shanghai",
      activeStartMinutes: 10 * 60 + 15,
      activeEndMinutes: 22 * 60 + 45,
      dailyTextLimit: 2,
      unansweredDelayMs: 600_000,
      revivalProbability: 0.1,
      hotTopics: ["AI", "绝区零"],
      morningRadarMinutes: 7 * 60 + 30,
      morningRadarCatchUpEndMinutes: 8 * 60 + 15,
      morningRadarLocation: "中国四川绵阳",
      dailyRoastMinutes: 20 * 60 + 30,
      dailyRoastCatchUpEndMinutes: 21 * 60 + 15,
      dailyRoastMinMessages: 5,
      dailyRoastMaxMessages: 80,
    });
    expect(config.reaction).toMatchObject({
      enabled: false,
      probability: 0.2,
      emojiIds: ["66", "76"],
    });
    expect(config.longevity).toEqual({
      enabled: true,
      timeZone: "Asia/Shanghai",
      submitterUserId: "20002",
      targetGroupIds: ["123456789"],
      reminderMinutes: 21 * 60 + 40,
      sendMinutes: 21 * 60 + 55,
      catchUpEndMinutes: 22 * 60 + 5,
      maxImages: 4,
    });
  });

  it("拒绝非法 Codex 配置", () => {
    expect(() =>
      parseConfig(validEnv({ CODEX_MODEL: "gpt-5.6-sol; rm" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(validEnv({ CODEX_LIVE_SEARCH: "yes" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(validEnv({ GROUP_PARTICIPATION_PROBABILITY: "1.5" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(validEnv({ PROACTIVE_TIME_ZONE: "Moon/Base" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(validEnv({ GROUP_REACTION_EMOJI_IDS: "66,nope" })),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(
        validEnv({
          MORNING_RADAR_TIME: "09:00",
          MORNING_RADAR_CATCH_UP_END: "08:00",
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(
        validEnv({
          DAILY_LONGEVITY_ENABLED: "true",
          DAILY_LONGEVITY_SUBMITTER_USER_ID: "20002",
          DAILY_LONGEVITY_TARGET_GROUP_IDS: "123456789",
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(
        validEnv({
          ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002",
          DAILY_LONGEVITY_ENABLED: "true",
          DAILY_LONGEVITY_SUBMITTER_USER_ID: "20002",
          DAILY_LONGEVITY_TARGET_GROUP_IDS: "999999999",
        }),
      ),
    ).toThrow(ConfigurationError);
    expect(() =>
      parseConfig(
        validEnv({
          DAILY_ROAST_MIN_MESSAGES: "20",
          DAILY_ROAST_MAX_MESSAGES: "10",
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("拒绝非 WebSocket 地址和非法群号", () => {
    expect(() =>
      parseConfig(
        validEnv({
          ONEBOT_WS_URL: "https://127.0.0.1:3001",
          ONEBOT_ALLOWED_GROUP_IDS: "123456789,*",
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("拒绝非法私聊 QQ 号以及两个空白名单", () => {
    expect(() =>
      parseConfig(
        validEnv({
          ONEBOT_ALLOWED_GROUP_IDS: "",
          ONEBOT_ALLOWED_PRIVATE_USER_IDS: "20002,*",
        }),
      ),
    ).toThrow(ConfigurationError);

    expect(() =>
      parseConfig(
        validEnv({
          ONEBOT_ALLOWED_GROUP_IDS: "",
          ONEBOT_ALLOWED_PRIVATE_USER_IDS: "",
        }),
      ),
    ).toThrow(ConfigurationError);
  });
});

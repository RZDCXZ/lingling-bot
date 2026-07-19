import { config as loadDotenv } from "dotenv";
import { z } from "zod";

import { DEFAULT_SYSTEM_PROMPT } from "./persona.js";

const integerFromEnv = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : Number(value)),
    z.number().int().min(min).max(max),
  );

const numberFromEnv = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : Number(value)),
    z.number().min(min).max(max),
  );

const booleanFromEnv = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === "") return fallback;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return value;
  }, z.boolean());

const timeOfDayFromEnv = (fallback: string) =>
  z
    .string()
    .trim()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "必须使用 HH:MM 格式")
    .default(fallback)
    .transform((value) => {
      const [hours, minutes] = value.split(":").map(Number);
      return (hours ?? 0) * 60 + (minutes ?? 0);
    });

const timeZoneSchema = z
  .string()
  .trim()
  .default("Asia/Singapore")
  .superRefine((value, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    } catch {
      context.addIssue({ code: "custom", message: "不是有效的 IANA 时区" });
    }
  });

const commaSeparatedList = (fallback: string, label: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((value, context) => {
      const items = [
        ...new Set(
          value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
      if (items.length === 0) {
        context.addIssue({ code: "custom", message: `${label}不能为空` });
        return z.NEVER;
      }
      return items;
    });

const reactionEmojiIdsSchema = commaSeparatedList(
  "14,66,76",
  "表情 ID",
).superRefine((ids, context) => {
  const invalid = ids.filter((id) => !/^\d{1,8}$/.test(id));
  if (invalid.length > 0) {
    context.addIssue({
      code: "custom",
      message: `表情 ID 只能是数字：${invalid.join(", ")}`,
    });
  }
});

const oneBotUrlSchema = z
  .string()
  .trim()
  .url("必须是完整 WebSocket URL，例如 ws://127.0.0.1:3001")
  .superRefine((value, context) => {
    const protocol = new URL(value).protocol;
    if (protocol !== "ws:" && protocol !== "wss:") {
      context.addIssue({
        code: "custom",
        message: "协议必须是 ws:// 或 wss://",
      });
    }
  });

const numericIdListSchema = (label: string) =>
  z
    .string()
    .trim()
    .default("")
    .transform((value, context) => {
      const ids = [
        ...new Set(
          value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ];
      const invalid = ids.filter((item) => !/^\d+$/.test(item));
      if (invalid.length > 0) {
        context.addIssue({
          code: "custom",
          message: `${label}只能包含数字，多个号码用英文逗号分隔：${invalid.join(", ")}`,
        });
        return z.NEVER;
      }
      return ids;
    });

const envSchema = z
  .object({
    ONEBOT_WS_URL: oneBotUrlSchema.default("ws://127.0.0.1:3001"),
    ONEBOT_ACCESS_TOKEN: z
      .string()
      .trim()
      .min(1, "ONEBOT_ACCESS_TOKEN 不能为空"),
    ONEBOT_ALLOWED_GROUP_IDS: numericIdListSchema("群号"),
    ONEBOT_ALLOWED_PRIVATE_USER_IDS: numericIdListSchema("私聊 QQ 号"),
    ONEBOT_RECONNECT_INTERVAL_MS: integerFromEnv(5_000, 1_000, 60_000),
    ONEBOT_ACTION_TIMEOUT_MS: integerFromEnv(10_000, 1_000, 60_000),
    CODEX_COMMAND: z.string().trim().min(1).default("codex"),
    CODEX_MODEL: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]+$/, "CODEX_MODEL 包含非法字符")
      .default("gpt-5.6-luna"),
    CODEX_REASONING_EFFORT: z
      .enum(["low", "medium", "high", "xhigh"])
      .default("medium"),
    CODEX_LIVE_SEARCH: booleanFromEnv(true),
    CODEX_TIMEOUT_MS: integerFromEnv(300_000, 30_000, 600_000),
    CODEX_MAX_CONCURRENT: integerFromEnv(2, 1, 4),
    CODEX_MAX_QUEUE: integerFromEnv(12, 0, 100),
    AI_SYSTEM_PROMPT: z
      .string()
      .trim()
      .min(1)
      .default(DEFAULT_SYSTEM_PROMPT),
    CONVERSATION_MAX_TURNS: integerFromEnv(8, 1, 50),
    CONVERSATION_TTL_MS: integerFromEnv(
      24 * 60 * 60 * 1_000,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
    ),
    GROUP_PARTICIPATION_ENABLED: booleanFromEnv(true),
    GROUP_PARTICIPATION_MIN_MESSAGES: integerFromEnv(3, 1, 20),
    GROUP_PARTICIPATION_COOLDOWN_MS: integerFromEnv(
      2 * 60 * 1_000,
      10_000,
      24 * 60 * 60 * 1_000,
    ),
    GROUP_PARTICIPATION_PROBABILITY: numberFromEnv(0.3, 0, 1),
    GROUP_PARTICIPATION_CONTEXT_MESSAGES: integerFromEnv(8, 3, 30),
    GROUP_OLD_JOKE_MEMORY_MESSAGES: integerFromEnv(30, 8, 100),
    PROACTIVE_ENGAGEMENT_ENABLED: booleanFromEnv(true),
    PROACTIVE_TIME_ZONE: timeZoneSchema,
    PROACTIVE_ACTIVE_START: timeOfDayFromEnv("09:00"),
    PROACTIVE_ACTIVE_END: timeOfDayFromEnv("23:30"),
    PROACTIVE_DAILY_TEXT_LIMIT: integerFromEnv(4, 0, 50),
    PROACTIVE_TEXT_COOLDOWN_MS: integerFromEnv(
      10 * 60 * 1_000,
      60_000,
      24 * 60 * 60 * 1_000,
    ),
    PROACTIVE_TICK_MS: integerFromEnv(30_000, 5_000, 5 * 60 * 1_000),
    PROACTIVE_UNANSWERED_ENABLED: booleanFromEnv(true),
    PROACTIVE_UNANSWERED_DELAY_MS: integerFromEnv(
      3 * 60 * 1_000,
      60_000,
      60 * 60 * 1_000,
    ),
    PROACTIVE_REVIVAL_ENABLED: booleanFromEnv(true),
    PROACTIVE_REVIVAL_MIN_SILENCE_MS: integerFromEnv(
      60 * 60 * 1_000,
      10 * 60 * 1_000,
      24 * 60 * 60 * 1_000,
    ),
    PROACTIVE_REVIVAL_MAX_SILENCE_MS: integerFromEnv(
      2 * 60 * 60 * 1_000,
      10 * 60 * 1_000,
      24 * 60 * 60 * 1_000,
    ),
    PROACTIVE_REVIVAL_PROBABILITY: numberFromEnv(0.2, 0, 1),
    PROACTIVE_HOT_TOPIC_ENABLED: booleanFromEnv(true),
    PROACTIVE_HOT_TOPIC_INTERVAL_MS: integerFromEnv(
      24 * 60 * 60 * 1_000,
      60 * 60 * 1_000,
      7 * 24 * 60 * 60 * 1_000,
    ),
    PROACTIVE_HOT_TOPIC_INITIAL_MIN_MS: integerFromEnv(
      60 * 60 * 1_000,
      10 * 60 * 1_000,
      24 * 60 * 60 * 1_000,
    ),
    PROACTIVE_HOT_TOPIC_INITIAL_MAX_MS: integerFromEnv(
      3 * 60 * 60 * 1_000,
      10 * 60 * 1_000,
      24 * 60 * 60 * 1_000,
    ),
    PROACTIVE_HOT_TOPICS: commaSeparatedList(
      "AI,明日方舟：终末地,绝区零,异环,鸣潮",
      "热点主题",
    ),
    GROUP_REACTION_ENABLED: booleanFromEnv(true),
    GROUP_REACTION_PROBABILITY: numberFromEnv(0.12, 0, 1),
    GROUP_REACTION_COOLDOWN_MS: integerFromEnv(
      5 * 60 * 1_000,
      30_000,
      24 * 60 * 60 * 1_000,
    ),
    GROUP_REACTION_DAILY_LIMIT: integerFromEnv(12, 0, 100),
    GROUP_REACTION_EMOJI_IDS: reactionEmojiIdsSchema,
    RATE_LIMIT_MAX_REQUESTS: integerFromEnv(6, 1, 100),
    RATE_LIMIT_WINDOW_MS: integerFromEnv(60_000, 1_000, 3_600_000),
  })
  .superRefine((value, context) => {
    if (
      value.ONEBOT_ALLOWED_GROUP_IDS.length === 0 &&
      value.ONEBOT_ALLOWED_PRIVATE_USER_IDS.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["ONEBOT_ALLOWED_PRIVATE_USER_IDS"],
        message: "群白名单和私聊白名单至少填写一项",
      });
    }
    if (
      value.PROACTIVE_REVIVAL_MIN_SILENCE_MS >
      value.PROACTIVE_REVIVAL_MAX_SILENCE_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["PROACTIVE_REVIVAL_MAX_SILENCE_MS"],
        message: "必须大于等于最短冷场时间",
      });
    }
    if (
      value.PROACTIVE_HOT_TOPIC_INITIAL_MIN_MS >
      value.PROACTIVE_HOT_TOPIC_INITIAL_MAX_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["PROACTIVE_HOT_TOPIC_INITIAL_MAX_MS"],
        message: "必须大于等于热点首次等待下限",
      });
    }
    if (
      value.GROUP_OLD_JOKE_MEMORY_MESSAGES <
      value.GROUP_PARTICIPATION_CONTEXT_MESSAGES
    ) {
      context.addIssue({
        code: "custom",
        path: ["GROUP_OLD_JOKE_MEMORY_MESSAGES"],
        message: "不能少于群聊参与上下文条数",
      });
    }
  });

export interface AppConfig {
  oneBot: {
    wsUrl: string;
    accessToken: string;
    allowedGroupIds: ReadonlySet<string>;
    allowedPrivateUserIds: ReadonlySet<string>;
    reconnectIntervalMs: number;
    actionTimeoutMs: number;
  };
  ai: {
    command: string;
    model: string;
    reasoningEffort: "low" | "medium" | "high" | "xhigh";
    systemPrompt: string;
    timeoutMs: number;
    liveSearch: boolean;
    maxConcurrent: number;
    maxQueue: number;
  };
  conversation: {
    maxTurns: number;
    ttlMs: number;
  };
  groupParticipation: {
    enabled: boolean;
    minMessages: number;
    cooldownMs: number;
    probability: number;
    contextMessages: number;
    oldJokeMemoryMessages: number;
  };
  proactive: {
    enabled: boolean;
    timeZone: string;
    activeStartMinutes: number;
    activeEndMinutes: number;
    dailyTextLimit: number;
    textCooldownMs: number;
    tickMs: number;
    unansweredEnabled: boolean;
    unansweredDelayMs: number;
    revivalEnabled: boolean;
    revivalMinSilenceMs: number;
    revivalMaxSilenceMs: number;
    revivalProbability: number;
    hotTopicEnabled: boolean;
    hotTopicIntervalMs: number;
    hotTopicInitialMinMs: number;
    hotTopicInitialMaxMs: number;
    hotTopics: readonly string[];
  };
  reaction: {
    enabled: boolean;
    probability: number;
    cooldownMs: number;
    dailyLimit: number;
    emojiIds: readonly string[];
  };
  rateLimit: {
    maxRequests: number;
    windowMs: number;
  };
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function parseConfig(
  env: Record<string, string | undefined>,
): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "配置"}: ${issue.message}`)
      .join("\n");
    throw new ConfigurationError(`环境变量配置有误：\n${details}`);
  }

  const parsed = result.data;
  return {
    oneBot: {
      wsUrl: parsed.ONEBOT_WS_URL.replace(/\/+$/, ""),
      accessToken: parsed.ONEBOT_ACCESS_TOKEN,
      allowedGroupIds: new Set(parsed.ONEBOT_ALLOWED_GROUP_IDS),
      allowedPrivateUserIds: new Set(parsed.ONEBOT_ALLOWED_PRIVATE_USER_IDS),
      reconnectIntervalMs: parsed.ONEBOT_RECONNECT_INTERVAL_MS,
      actionTimeoutMs: parsed.ONEBOT_ACTION_TIMEOUT_MS,
    },
    ai: {
      command: parsed.CODEX_COMMAND,
      model: parsed.CODEX_MODEL,
      reasoningEffort: parsed.CODEX_REASONING_EFFORT,
      systemPrompt: parsed.AI_SYSTEM_PROMPT,
      timeoutMs: parsed.CODEX_TIMEOUT_MS,
      liveSearch: parsed.CODEX_LIVE_SEARCH,
      maxConcurrent: parsed.CODEX_MAX_CONCURRENT,
      maxQueue: parsed.CODEX_MAX_QUEUE,
    },
    conversation: {
      maxTurns: parsed.CONVERSATION_MAX_TURNS,
      ttlMs: parsed.CONVERSATION_TTL_MS,
    },
    groupParticipation: {
      enabled: parsed.GROUP_PARTICIPATION_ENABLED,
      minMessages: parsed.GROUP_PARTICIPATION_MIN_MESSAGES,
      cooldownMs: parsed.GROUP_PARTICIPATION_COOLDOWN_MS,
      probability: parsed.GROUP_PARTICIPATION_PROBABILITY,
      contextMessages: parsed.GROUP_PARTICIPATION_CONTEXT_MESSAGES,
      oldJokeMemoryMessages: parsed.GROUP_OLD_JOKE_MEMORY_MESSAGES,
    },
    proactive: {
      enabled: parsed.PROACTIVE_ENGAGEMENT_ENABLED,
      timeZone: parsed.PROACTIVE_TIME_ZONE,
      activeStartMinutes: parsed.PROACTIVE_ACTIVE_START,
      activeEndMinutes: parsed.PROACTIVE_ACTIVE_END,
      dailyTextLimit: parsed.PROACTIVE_DAILY_TEXT_LIMIT,
      textCooldownMs: parsed.PROACTIVE_TEXT_COOLDOWN_MS,
      tickMs: parsed.PROACTIVE_TICK_MS,
      unansweredEnabled: parsed.PROACTIVE_UNANSWERED_ENABLED,
      unansweredDelayMs: parsed.PROACTIVE_UNANSWERED_DELAY_MS,
      revivalEnabled: parsed.PROACTIVE_REVIVAL_ENABLED,
      revivalMinSilenceMs: parsed.PROACTIVE_REVIVAL_MIN_SILENCE_MS,
      revivalMaxSilenceMs: parsed.PROACTIVE_REVIVAL_MAX_SILENCE_MS,
      revivalProbability: parsed.PROACTIVE_REVIVAL_PROBABILITY,
      hotTopicEnabled: parsed.PROACTIVE_HOT_TOPIC_ENABLED,
      hotTopicIntervalMs: parsed.PROACTIVE_HOT_TOPIC_INTERVAL_MS,
      hotTopicInitialMinMs: parsed.PROACTIVE_HOT_TOPIC_INITIAL_MIN_MS,
      hotTopicInitialMaxMs: parsed.PROACTIVE_HOT_TOPIC_INITIAL_MAX_MS,
      hotTopics: parsed.PROACTIVE_HOT_TOPICS,
    },
    reaction: {
      enabled: parsed.GROUP_REACTION_ENABLED,
      probability: parsed.GROUP_REACTION_PROBABILITY,
      cooldownMs: parsed.GROUP_REACTION_COOLDOWN_MS,
      dailyLimit: parsed.GROUP_REACTION_DAILY_LIMIT,
      emojiIds: parsed.GROUP_REACTION_EMOJI_IDS,
    },
    rateLimit: {
      maxRequests: parsed.RATE_LIMIT_MAX_REQUESTS,
      windowMs: parsed.RATE_LIMIT_WINDOW_MS,
    },
  };
}

export function loadConfig(): AppConfig {
  loadDotenv({ path: ".env.local", quiet: true });
  return parseConfig(process.env);
}

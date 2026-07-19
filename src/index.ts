import { CodexCliAi } from "./ai/codex-cli-ai.js";
import { loadConfig } from "./config.js";
import { ConversationMemory } from "./conversation-memory.js";
import { createBotRuntime } from "./create-bot.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ai = new CodexCliAi(config.ai);
  const memory = new ConversationMemory({
    maxTurns: config.conversation.maxTurns,
    ttlMs: config.conversation.ttlMs,
  });
  const runtime = createBotRuntime(config, ai, memory);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`[app] 收到 ${signal}，正在停止`);
    runtime.stop();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info("[app] 正在启动 QQ 群 AI 机器人", {
    oneBotEndpoint: new URL(config.oneBot.wsUrl).host,
    aiProvider: "codex-cli",
    model: config.ai.model,
    reasoningEffort: config.ai.reasoningEffort,
    liveSearch: config.ai.liveSearch,
    maxConcurrent: config.ai.maxConcurrent,
    conversationMaxTurns: config.conversation.maxTurns,
    conversationTtlHours: config.conversation.ttlMs / (60 * 60 * 1_000),
    groupParticipationEnabled: config.groupParticipation.enabled,
    groupParticipationMinMessages: config.groupParticipation.minMessages,
    groupParticipationCooldownSeconds:
      config.groupParticipation.cooldownMs / 1_000,
    groupParticipationProbability: config.groupParticipation.probability,
    proactiveEngagementEnabled: config.proactive.enabled,
    proactiveDailyTextLimit: config.proactive.dailyTextLimit,
    proactiveActiveHours: `${String(Math.floor(config.proactive.activeStartMinutes / 60)).padStart(2, "0")}:${String(config.proactive.activeStartMinutes % 60).padStart(2, "0")}-${String(Math.floor(config.proactive.activeEndMinutes / 60)).padStart(2, "0")}:${String(config.proactive.activeEndMinutes % 60).padStart(2, "0")}`,
    proactiveHotTopicEnabled: config.proactive.hotTopicEnabled,
    groupReactionEnabled: config.reaction.enabled,
  });

  await runtime.start();
}

main().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  logger.error("[app] 启动失败", {
    name: normalized.name,
    message: normalized.message,
  });
  process.exitCode = 1;
});

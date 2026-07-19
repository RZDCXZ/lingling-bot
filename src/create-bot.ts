import { resolve } from "node:path";

import type { AiGeneratedImage, AiService } from "./ai/types.js";
import type { AppConfig } from "./config.js";
import { ConversationMemory } from "./conversation-memory.js";
import { DailyLongevityCoordinator } from "./daily-longevity.js";
import {
  PersistentEngagementState,
  type EngagementStatePort,
} from "./engagement-state.js";
import { UserFacingError } from "./errors.js";
import { createChatHandler } from "./group-chat-handler.js";
import { GroupParticipationCoordinator } from "./group-participation.js";
import { logger } from "./logger.js";
import { OneBotWebSocketClient } from "./onebot/client.js";
import {
  OneBotImageLoader,
  type ImageLoader,
} from "./onebot/image-loader.js";
import { parseAllowedOneBotMessage } from "./onebot/message.js";
import {
  sendOneBotGroupMessage,
  sendOneBotGroupReply,
  sendOneBotPrivateMessage,
  sendOneBotReply,
} from "./onebot/reply.js";
import type {
  OneBotActionCaller,
  OneBotEventHandler,
} from "./onebot/types.js";
import {
  DeduplicationCache,
  KeyedTaskQueue,
  WindowRateLimiter,
} from "./runtime-guards.js";

export interface OneBotClientPort extends OneBotActionCaller {
  start(eventHandler: OneBotEventHandler): Promise<void>;
  stop(): void;
}

export interface BotRuntime {
  start(): Promise<void>;
  stop(): void;
}

export function createBotRuntime(
  config: AppConfig,
  ai: AiService,
  memory: ConversationMemory,
  providedClient?: OneBotClientPort,
  providedImageLoader?: ImageLoader,
  providedEngagementState?: EngagementStatePort,
): BotRuntime {
  const client =
    providedClient ??
    new OneBotWebSocketClient(
      {
        url: config.oneBot.wsUrl,
        accessToken: config.oneBot.accessToken,
        reconnectIntervalMs: config.oneBot.reconnectIntervalMs,
        actionTimeoutMs: config.oneBot.actionTimeoutMs,
      },
      logger,
    );
  const imageLoader = providedImageLoader ?? new OneBotImageLoader(client);
  const handler = createChatHandler({ ai, memory });
  const deduplication = new DeduplicationCache(60_000, 2_000);
  const senderLimiter = new WindowRateLimiter(
    config.rateLimit.maxRequests,
    config.rateLimit.windowMs,
  );
  const chatLimiter = new WindowRateLimiter(
    Math.max(config.rateLimit.maxRequests * 5, 20),
    config.rateLimit.windowMs,
  );
  const globalLimiter = new WindowRateLimiter(
    Math.max(config.rateLimit.maxRequests * 20, 100),
    config.rateLimit.windowMs,
  );
  const queue = new KeyedTaskQueue(4);
  const engagementState =
    providedEngagementState ??
    new PersistentEngagementState(
      resolve("data/group-engagement-state.json"),
      config.proactive.timeZone,
    );
  const participation = new GroupParticipationCoordinator({
    ai,
    config: config.groupParticipation,
    proactive: config.proactive,
    reaction: config.reaction,
    engagementState,
  });
  const longevity = new DailyLongevityCoordinator({
    ai,
    config: config.longevity,
    tickMs: config.proactive.tickMs,
  });

  const onEvent: OneBotEventHandler = async (event) => {
    const message = parseAllowedOneBotMessage(
      event,
      config.oneBot.allowedGroupIds,
      config.oneBot.allowedPrivateUserIds,
    );
    if (!message) return;

    const chatId =
      message.scope === "group" ? message.groupId : message.senderId;
    const deduplicationKey = `${message.scope}:${chatId}:${message.messageId}`;
    if (!deduplication.accept(deduplicationKey)) return;

    if (message.scope === "private") {
      const command = message.content.trim();
      if (command === "/取消延年益寿") {
        const removed = await longevity.cancelSubmission(message.senderId);
        if (removed !== null) {
          await sendOneBotPrivateMessage(
            client,
            message.senderId,
            removed > 0
              ? `今晚已缓存的 ${removed} 张投稿已经清空。`
              : "今晚还没有缓存投稿。",
          );
          return;
        }
      }
      if (command === "/延年益寿状态") {
        const count = await longevity.submissionCount(message.senderId);
        if (count !== null) {
          await sendOneBotPrivateMessage(
            client,
            message.senderId,
            `今晚已缓存 ${count}/${config.longevity.maxImages} 张投稿。`,
          );
          return;
        }
      }
      if (
        message.images?.length &&
        longevity.isSubmissionWindow(message.senderId)
      ) {
        try {
          const images = await imageLoader.load(message.images);
          const result = await longevity.acceptImages(message.senderId, images);
          if (result) {
            const ignored = result.ignored
              ? `，另有 ${result.ignored} 张因达到数量上限未收录`
              : "";
            await sendOneBotPrivateMessage(
              client,
              message.senderId,
              `收到 ${result.accepted} 张，已保存到当天归档文件夹；今晚已缓存 ${result.total}/${result.max} 张${ignored}。22:00 会先审核，通过后再发到群里。`,
            );
          }
        } catch (error) {
          const publicMessage =
            error instanceof UserFacingError
              ? error.publicMessage
              : "暂时无法读取或保存这次投稿图片，请检查图片和归档目录后重试。";
          await sendOneBotPrivateMessage(client, message.senderId, publicMessage);
        }
        return;
      }
    }

    if (message.scope === "group" && !message.mentioned) {
      try {
        const replied = await participation.handleUnmentioned(
          {
            groupId: message.groupId,
            senderId: message.senderId,
            ...(message.senderName ? { senderName: message.senderName } : {}),
            messageId: message.messageId,
            content: message.content,
            imageCount: message.images?.length ?? 0,
          },
          {
            send: (text) =>
              sendOneBotGroupMessage(client, message.groupId, text),
            react: async (messageId, emojiId) => {
              await client.call("set_msg_emoji_like", {
                message_id: messageId,
                emoji_id: emojiId,
                set: true,
              });
            },
          },
          () =>
            chatLimiter.allow(`group:${message.groupId}`) &&
            globalLimiter.allow("global"),
        );
        if (replied === "text") {
          logger.info("[app] 铃铃酱已自然加入群聊话题");
        } else if (replied === "reaction") {
          logger.debug("[app] 铃铃酱已用表情轻量回应群消息");
        }
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        logger.warn("[app] 群聊互动处理失败，本轮保持潜水", {
          name: normalized.name,
          message: normalized.message,
        });
      }
      return;
    }

    if (message.scope === "group") {
      participation.observeHuman({
        groupId: message.groupId,
        senderId: message.senderId,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        messageId: message.messageId,
        content: message.content,
        imageCount: message.images?.length ?? 0,
      });
    }

    const reply = {
      send: async (text: string, images?: readonly AiGeneratedImage[]) => {
        await sendOneBotReply(client, message, text, images);
        if (message.scope === "group") {
          participation.recordBotReply(message.groupId, text);
        }
      },
    };
    const senderKey = `${message.scope}:${chatId}:${message.senderId}`;
    const allowed =
      senderLimiter.allow(senderKey) &&
      chatLimiter.allow(`${message.scope}:${chatId}`) &&
      globalLimiter.allow("global");
    if (!allowed) {
      await reply.send("请求有点频繁，请稍后再试。");
      return;
    }

    const accepted = queue.enqueue(senderKey, async () => {
      try {
        const imageReferences = message.images;
        const images = imageReferences?.length
          ? await imageLoader.load(imageReferences)
          : [];
        const chatMessage =
          message.scope === "group"
            ? {
                scope: "group" as const,
                groupId: message.groupId,
                senderId: message.senderId,
                content: message.content,
              }
            : {
                scope: "private" as const,
                senderId: message.senderId,
                content: message.content,
              };
        await handler.handle(
          {
            ...chatMessage,
            ...(images.length > 0 ? { images } : {}),
          },
          reply,
        );
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        logger.error("[app] 处理 QQ 消息失败", {
          name: normalized.name,
          message: normalized.message,
          scope: message.scope,
          chatId,
          senderId: message.senderId,
        });
        const publicMessage =
          error instanceof UserFacingError
            ? error.publicMessage
            : "暂时无法处理这条消息，请稍后重试。";
        try {
          await reply.send(publicMessage);
        } catch (replyError) {
          const normalizedReplyError =
            replyError instanceof Error
              ? replyError
              : new Error(String(replyError));
          logger.error("[app] 发送错误提示失败", {
            message: normalizedReplyError.message,
          });
        }
      }
    });

    if (!accepted) {
      await reply.send("当前排队请求较多，请稍后重新发送。");
    }
  };

  return {
    start: async () => {
      await client.start(onEvent);
      participation.startScheduler({
        groupIds: [...config.oneBot.allowedGroupIds],
        ports: {
          sendGroupText: (groupId, text) =>
            sendOneBotGroupMessage(client, groupId, text),
          sendGroupReply: (target, text) =>
            sendOneBotGroupReply(
              client,
              {
                scope: "group",
                groupId: target.groupId,
                senderId: target.senderId,
                messageId: target.messageId,
              },
              text,
            ),
        },
        allowGeneration: (groupId) =>
          chatLimiter.allow(`group:${groupId}`) &&
          globalLimiter.allow("global"),
        onError: (error) =>
          logger.warn("[app] 主动互动调度失败，本轮跳过", {
            name: error.name,
            message: error.message,
          }),
      });
      longevity.startScheduler({
        allowGeneration: () =>
          config.longevity.targetGroupIds.every((groupId) =>
            chatLimiter.allow(`group:${groupId}`),
          ) && globalLimiter.allow("global"),
        sendPrivateText: (userId, text) =>
          sendOneBotPrivateMessage(client, userId, text),
        sendGroupPost: (groupId, text, images) =>
          sendOneBotGroupMessage(client, groupId, text, images),
        onError: (error) =>
          logger.warn("[app] 延年益寿调度失败，本轮跳过", {
            name: error.name,
            message: error.message,
          }),
      });
      logger.info("[app] QQ AI 机器人已就绪", {
        allowedGroupCount: config.oneBot.allowedGroupIds.size,
        allowedPrivateUserCount: config.oneBot.allowedPrivateUserIds.size,
        groupParticipationEnabled: config.groupParticipation.enabled,
        proactiveEngagementEnabled: config.proactive.enabled,
        morningRadarEnabled: config.proactive.morningRadarEnabled,
        dailyRoastEnabled: config.proactive.dailyRoastEnabled,
        dailyLongevityEnabled: config.longevity.enabled,
        groupReactionEnabled: config.reaction.enabled,
      });
    },
    stop: () => {
      participation.stopScheduler();
      longevity.stopScheduler();
      client.stop();
    },
  };
}

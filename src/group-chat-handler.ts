import type {
  AiGeneratedImage,
  AiImage,
  AiMessage,
  AiReplyResult,
  AiService,
} from "./ai/types.js";
import { ConversationMemory } from "./conversation-memory.js";

export interface ChatMessage {
  scope: "private" | "group";
  groupId?: string;
  senderId: string;
  content: string;
  images?: readonly AiImage[];
}

export interface ReplyPort {
  send(text: string, images?: readonly AiGeneratedImage[]): Promise<void>;
}

export interface ChatHandler {
  handle(
    message: ChatMessage,
    reply: ReplyPort,
    signal?: AbortSignal,
  ): Promise<void>;
}

const HELP_COMMANDS = new Set(["/帮助", "/help"]);
const RESET_COMMANDS = new Set(["/重置", "/reset"]);
const MAX_USER_MESSAGE_CHARS = 4_000;
const IMAGE_ONLY_PROMPT = "请描述这张图片。";

export function createChatHandler(options: {
  ai: AiService;
  memory: ConversationMemory;
}): ChatHandler {
  const { ai, memory } = options;

  return {
    async handle(message, reply, signal) {
      const content = message.content.trim();
      const images = message.images ?? [];
      const conversationKey = buildConversationKey(message);

      if (HELP_COMMANDS.has(content.toLowerCase())) {
        await reply.send(
          (message.scope === "group"
            ? "使用方法：在群里 @我 后发送文字或图片；我也会偶尔自然加入正在聊的话题。\n"
            : "使用方法：直接发送文字或图片即可。\n") +
            "我可以联网搜索、识别图片，也可以按要求生成或编辑图片。\n" +
            "命令：/重置 清除你的当前对话；/帮助 查看说明。",
        );
        return;
      }

      if (RESET_COMMANDS.has(content.toLowerCase())) {
        memory.clear(conversationKey);
        await reply.send("已清除当前对话记录。");
        return;
      }

      if (!content && images.length === 0) {
        await reply.send(
          message.scope === "group"
            ? "请在 @我 后输入问题，例如：@机器人 帮我解释闭包。"
            : "请发送文字问题，例如：帮我解释闭包。",
        );
        return;
      }

      if (content.length > MAX_USER_MESSAGE_CHARS) {
        await reply.send(`消息太长，请控制在 ${MAX_USER_MESSAGE_CHARS} 个字符以内。`);
        return;
      }

      const prompt = content || IMAGE_ONLY_PROMPT;
      const currentMessage: AiMessage = {
        role: "user",
        content: prompt,
        ...(images.length > 0 ? { images } : {}),
      };
      const messages: AiMessage[] = [
        ...memory.get(conversationKey),
        currentMessage,
      ];
      const result = await ai.generateReply(
        messages,
        signal ? { signal } : undefined,
      );
      const answer = normalizeReply(result);

      if (answer.images?.length) {
        await reply.send(answer.text, answer.images);
      } else {
        await reply.send(answer.text);
      }
      const memoryContent =
        images.length > 0
          ? `${prompt}\n[本轮附带 ${images.length} 张图片，图片本身未保留。]`
          : prompt;
      memory.appendTurn(conversationKey, memoryContent, answer.text);
    },
  };
}

function normalizeReply(result: AiReplyResult): {
  text: string;
  images?: readonly AiGeneratedImage[];
} {
  return typeof result === "string" ? { text: result } : result;
}

function buildConversationKey(message: ChatMessage): string {
  return message.scope === "group"
    ? `group:${message.groupId}:sender:${message.senderId}`
    : `private:${message.senderId}`;
}

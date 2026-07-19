export type AiRole = "user" | "assistant";

export interface AiImage {
  dataUrl: string;
  detail: "auto" | "low" | "high";
}

export interface AiGeneratedImage {
  dataUrl: string;
}

export interface AiReply {
  text: string;
  images?: readonly AiGeneratedImage[];
}

export type AiReplyResult = string | AiReply;

export interface AiMessage {
  role: AiRole;
  content: string;
  images?: readonly AiImage[];
}

export interface GenerateReplyOptions {
  signal?: AbortSignal;
  mode?:
    | "direct-reply"
    | "group-participation"
    | "group-reaction"
    | "unanswered-question"
    | "cold-revival"
    | "hot-topic-feed";
  reactionEmojiIds?: readonly string[];
  hotTopics?: readonly string[];
}

export interface AiService {
  generateReply(
    messages: readonly AiMessage[],
    options?: GenerateReplyOptions,
  ): Promise<AiReplyResult>;
}

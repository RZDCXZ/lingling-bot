import type { OneBotMessageSegment } from "./types.js";

export interface OneBotImageReference {
  file?: string;
  url?: string;
  path?: string;
  fileSize?: number;
  summary?: string;
}

export interface MentionedGroupMessage {
  scope: "group";
  groupId: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  content: string;
  images?: OneBotImageReference[];
}

export interface AllowedGroupMessage extends MentionedGroupMessage {
  mentioned: boolean;
}

export interface AllowedPrivateMessage {
  scope: "private";
  senderId: string;
  messageId: string;
  content: string;
  images?: OneBotImageReference[];
}

export type AllowedOneBotMessage =
  | AllowedGroupMessage
  | AllowedPrivateMessage;

export function parseAllowedOneBotMessage(
  input: unknown,
  allowedGroupIds: ReadonlySet<string>,
  allowedPrivateUserIds: ReadonlySet<string>,
): AllowedOneBotMessage | null {
  if (!isRecord(input) || input.post_type !== "message") return null;

  if (input.message_type === "private") {
    return parseAllowedPrivateMessage(input, allowedPrivateUserIds);
  }
  if (input.message_type === "group") {
    return parseAllowedGroupMessage(input, allowedGroupIds);
  }
  return null;
}

export function parseMentionedGroupMessage(
  input: unknown,
  allowedGroupIds: ReadonlySet<string>,
): MentionedGroupMessage | null {
  const parsed = parseAllowedGroupMessage(input, allowedGroupIds);
  if (!parsed?.mentioned) return null;

  const { mentioned: _mentioned, ...message } = parsed;
  return message;
}

export function parseAllowedGroupMessage(
  input: unknown,
  allowedGroupIds: ReadonlySet<string>,
): AllowedGroupMessage | null {
  if (!isRecord(input)) return null;
  if (input.post_type !== "message" || input.message_type !== "group") {
    return null;
  }

  const selfId = readId(input.self_id);
  const senderId = readId(input.user_id);
  const groupId = readId(input.group_id);
  const messageId = readId(input.message_id);
  if (!selfId || !senderId || !groupId || !messageId) return null;
  if (senderId === selfId || !allowedGroupIds.has(groupId)) return null;

  const extracted = Array.isArray(input.message)
    ? extractArrayMessage(input.message, selfId)
    : extractStringMessage(
        typeof input.raw_message === "string"
          ? input.raw_message
          : input.message,
        selfId,
      );

  const senderName = readSenderName(input.sender);
  return {
    scope: "group",
    groupId,
    senderId,
    ...(senderName ? { senderName } : {}),
    messageId,
    content: extracted.content,
    mentioned: extracted.mentioned,
    ...(extracted.images.length > 0 ? { images: extracted.images } : {}),
  };
}

export function parseAllowedPrivateMessage(
  input: unknown,
  allowedPrivateUserIds: ReadonlySet<string>,
): AllowedPrivateMessage | null {
  if (!isRecord(input)) return null;
  if (input.post_type !== "message" || input.message_type !== "private") {
    return null;
  }

  const selfId = readId(input.self_id);
  const senderId = readId(input.user_id);
  const messageId = readId(input.message_id);
  if (!selfId || !senderId || !messageId) return null;
  if (senderId === selfId || !allowedPrivateUserIds.has(senderId)) return null;

  const extracted = Array.isArray(input.message)
    ? extractArrayContent(input.message)
    : extractStringContent(
        typeof input.raw_message === "string"
          ? input.raw_message
          : input.message,
      );

  return {
    scope: "private",
    senderId,
    messageId,
    content: extracted.content,
    ...(extracted.images.length > 0 ? { images: extracted.images } : {}),
  };
}

function extractArrayMessage(
  input: unknown[],
  selfId: string,
): { mentioned: boolean; content: string; images: OneBotImageReference[] } {
  let mentioned = false;
  const textParts: string[] = [];
  const images: OneBotImageReference[] = [];

  for (const candidate of input) {
    const segment = readSegment(candidate);
    if (!segment) continue;

    if (segment.type === "at" && readId(segment.data.qq) === selfId) {
      mentioned = true;
      continue;
    }
    if (segment.type === "text" && typeof segment.data.text === "string") {
      textParts.push(segment.data.text);
      continue;
    }
    if (segment.type === "image") {
      const image = readImageReference(segment.data);
      if (image) images.push(image);
    }
  }

  return { mentioned, content: textParts.join("").trim(), images };
}

function extractStringMessage(
  input: unknown,
  selfId: string,
): { mentioned: boolean; content: string; images: OneBotImageReference[] } {
  if (typeof input !== "string") {
    return { mentioned: false, content: "", images: [] };
  }

  const mentionPattern = new RegExp(
    `\\[CQ:at,qq=${escapeRegExp(selfId)}(?:,[^\\]]*)?\\]`,
    "g",
  );
  const mentioned = mentionPattern.test(input);
  const extracted = extractStringContent(
    input
    .replace(mentionPattern, "")
  );
  return { mentioned, ...extracted };
}

function extractArrayContent(
  input: unknown[],
): { content: string; images: OneBotImageReference[] } {
  const textParts: string[] = [];
  const images: OneBotImageReference[] = [];
  for (const candidate of input) {
    const segment = readSegment(candidate);
    if (segment?.type === "text" && typeof segment.data.text === "string") {
      textParts.push(segment.data.text);
      continue;
    }
    if (segment?.type === "image") {
      const image = readImageReference(segment.data);
      if (image) images.push(image);
    }
  }
  return { content: textParts.join("").trim(), images };
}

function extractStringContent(
  input: unknown,
): { content: string; images: OneBotImageReference[] } {
  if (typeof input !== "string") return { content: "", images: [] };

  const images: OneBotImageReference[] = [];
  for (const match of input.matchAll(/\[CQ:image((?:,[^\]]*)?)\]/g)) {
    const data = parseCqData(match[1] ?? "");
    const image = readImageReference(data);
    if (image) images.push(image);
  }

  return {
    content: decodeCqValue(input.replace(/\[CQ:[^\]]+\]/g, "")).trim(),
    images,
  };
}

function readImageReference(
  data: Record<string, unknown>,
): OneBotImageReference | null {
  const file = readNonEmptyString(data.file);
  const url = readNonEmptyString(data.url);
  const path = readNonEmptyString(data.path);
  if (!file && !url && !path) return null;

  const summary = readNonEmptyString(data.summary);
  const fileSize = readNonNegativeNumber(data.file_size);
  return {
    ...(file ? { file } : {}),
    ...(url ? { url } : {}),
    ...(path ? { path } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
    ...(summary ? { summary } : {}),
  };
}

function parseCqData(input: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const parameters = input.startsWith(",") ? input.slice(1) : input;
  if (!parameters) return data;

  for (const part of parameters.split(",")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    data[part.slice(0, separator)] = decodeCqValue(part.slice(separator + 1));
  }
  return data;
}

function decodeCqValue(input: string): string {
  return input
    .replaceAll("&#44;", ",")
    .replaceAll("&#91;", "[")
    .replaceAll("&#93;", "]")
    .replaceAll("&amp;", "&");
}

function readNonEmptyString(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  return input.trim() || undefined;
}

function readNonNegativeNumber(input: unknown): number | undefined {
  if (typeof input !== "number" && typeof input !== "string") return undefined;
  const number = Number(input);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function readSegment(input: unknown): OneBotMessageSegment | null {
  if (!isRecord(input) || typeof input.type !== "string") return null;
  if (!isRecord(input.data)) return null;
  return { type: input.type, data: input.data };
}

function readId(input: unknown): string | null {
  if (typeof input === "string") return input.trim() || null;
  if (typeof input === "number" && Number.isFinite(input)) return String(input);
  return null;
}

function readSenderName(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return readNonEmptyString(input.card) ?? readNonEmptyString(input.nickname);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

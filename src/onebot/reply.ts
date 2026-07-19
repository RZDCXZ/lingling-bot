import type { OneBotActionCaller, OneBotMessageSegment } from "./types.js";

const QQ_SAFE_CHUNK_LENGTH = 4_000;
const QQ_MAX_REPLIES = 5;
const TRUNCATED_SUFFIX = "\n（回复过长，已截断）";
const MAX_REPLY_IMAGES = 2;
const MAX_GROUP_ALBUM_IMAGES = 6;
const MAX_REPLY_IMAGE_BYTES = 12 * 1024 * 1024;

export interface OneBotReplyImage {
  dataUrl: string;
}

export interface OneBotGroupReplyTarget {
  scope: "group";
  groupId: string;
  senderId: string;
  messageId: string;
}

export interface OneBotPrivateReplyTarget {
  scope: "private";
  senderId: string;
  messageId: string;
}

export type OneBotReplyTarget =
  | OneBotGroupReplyTarget
  | OneBotPrivateReplyTarget;

export function splitReplyText(
  input: string,
  chunkLength = QQ_SAFE_CHUNK_LENGTH,
  maxChunks = QQ_MAX_REPLIES,
): string[] {
  if (chunkLength < 20 || maxChunks < 1) {
    throw new RangeError("无效的 QQ 消息分段配置");
  }

  let text = input.trim();
  if (!text) return [];

  const maximumLength = chunkLength * maxChunks;
  if (text.length > maximumLength) {
    text = `${text.slice(0, maximumLength - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
  }

  const chunks: string[] = [];
  while (text.length > chunkLength) {
    const splitAt = findNaturalBoundary(text, chunkLength);
    chunks.push(text.slice(0, splitAt).trim());
    text = text.slice(splitAt).trimStart();
  }
  if (text) chunks.push(text);
  return chunks;
}

export async function sendOneBotGroupText(
  client: OneBotActionCaller,
  target: OneBotGroupReplyTarget,
  text: string,
): Promise<void> {
  await sendOneBotGroupReply(client, target, text);
}

export async function sendOneBotGroupMessage(
  client: OneBotActionCaller,
  groupId: string,
  text: string,
  images: readonly OneBotReplyImage[] = [],
): Promise<void> {
  const chunks = splitReplyText(text);
  const messages = chunks.length > 0 ? chunks : images.length > 0 ? [""] : [];
  const imageSegments = toImageSegments(images, MAX_GROUP_ALBUM_IMAGES);
  for (const [index, chunk] of messages.entries()) {
    const prefix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）\n` : "";
    const message: OneBotMessageSegment[] = [];
    if (chunk) {
      message.push({ type: "text", data: { text: `${prefix}${chunk}` } });
    }
    if (index === messages.length - 1) message.push(...imageSegments);
    await client.call("send_group_msg", {
      group_id: groupId,
      message,
    });
  }
}

export async function sendOneBotPrivateMessage(
  client: OneBotActionCaller,
  userId: string,
  text: string,
): Promise<void> {
  const chunks = splitReplyText(text);
  for (const [index, chunk] of chunks.entries()) {
    const prefix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）\n` : "";
    await client.call("send_private_msg", {
      user_id: userId,
      message: [{ type: "text", data: { text: `${prefix}${chunk}` } }],
    });
  }
}

export async function sendOneBotGroupReply(
  client: OneBotActionCaller,
  target: OneBotGroupReplyTarget,
  text: string,
  images: readonly OneBotReplyImage[] = [],
): Promise<void> {
  const chunks = splitReplyText(text);
  const messages = chunks.length > 0 ? chunks : [""];
  const imageSegments = toImageSegments(images);

  for (const [index, chunk] of messages.entries()) {
    const prefix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）\n` : "";
    const message: OneBotMessageSegment[] = [];

    if (index === 0) {
      message.push({ type: "reply", data: { id: target.messageId } });
    }
    message.push({ type: "at", data: { qq: target.senderId } });
    if (chunk) {
      message.push({ type: "text", data: { text: ` ${prefix}${chunk}` } });
    }
    if (index === messages.length - 1) message.push(...imageSegments);

    await client.call("send_group_msg", {
      group_id: target.groupId,
      message,
    });
  }
}

export async function sendOneBotPrivateText(
  client: OneBotActionCaller,
  target: OneBotPrivateReplyTarget,
  text: string,
): Promise<void> {
  await sendOneBotPrivateReply(client, target, text);
}

export async function sendOneBotPrivateReply(
  client: OneBotActionCaller,
  target: OneBotPrivateReplyTarget,
  text: string,
  images: readonly OneBotReplyImage[] = [],
): Promise<void> {
  const chunks = splitReplyText(text);
  const messages = chunks.length > 0 ? chunks : [""];
  const imageSegments = toImageSegments(images);

  for (const [index, chunk] of messages.entries()) {
    const prefix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）\n` : "";
    const message: OneBotMessageSegment[] = [];
    if (chunk) {
      message.push({ type: "text", data: { text: `${prefix}${chunk}` } });
    }
    if (index === messages.length - 1) message.push(...imageSegments);
    await client.call("send_private_msg", {
      user_id: target.senderId,
      message,
    });
  }
}

export async function sendOneBotReply(
  client: OneBotActionCaller,
  target: OneBotReplyTarget,
  text: string,
  images: readonly OneBotReplyImage[] = [],
): Promise<void> {
  if (target.scope === "private") {
    await sendOneBotPrivateReply(client, target, text, images);
    return;
  }
  await sendOneBotGroupReply(client, target, text, images);
}

export async function sendOneBotText(
  client: OneBotActionCaller,
  target: OneBotReplyTarget,
  text: string,
): Promise<void> {
  await sendOneBotReply(client, target, text);
}

function toImageSegments(
  images: readonly OneBotReplyImage[],
  maxImages = MAX_REPLY_IMAGES,
): OneBotMessageSegment[] {
  if (images.length > maxImages) {
    throw new RangeError(`单次最多发送 ${maxImages} 张图片`);
  }

  return images.map((image) => {
    const match = /^data:image\/(?:gif|jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      image.dataUrl,
    );
    if (!match?.[1]) throw new TypeError("生成图片不是受支持的 data URL");
    const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
    const bytes = Math.floor((match[1].length * 3) / 4) - padding;
    if (bytes <= 0 || bytes > MAX_REPLY_IMAGE_BYTES) {
      throw new RangeError("生成图片为空或超过 QQ 发送大小限制");
    }
    return { type: "image", data: { file: `base64://${match[1]}` } };
  });
}

function findNaturalBoundary(text: string, limit: number): number {
  const minimum = Math.floor(limit * 0.55);
  const candidates = ["\n", "。", "！", "？", "；", " "];
  let best = -1;

  for (const separator of candidates) {
    const index = text.lastIndexOf(separator, limit - 1);
    const boundary = index + separator.length;
    if (index >= 0 && boundary >= minimum) {
      best = Math.max(best, boundary);
    }
  }

  return best > 0 ? best : limit;
}

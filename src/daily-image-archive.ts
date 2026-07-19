import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AiImage } from "./ai/types.js";

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVED_IMAGE_PATTERN = /^(\d+)\.(?:gif|jpg|png|webp)$/;
const IMAGE_DATA_URL_PATTERN =
  /^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

export async function archiveDailyImages(
  rootDirectory: string,
  dayKey: string,
  images: readonly AiImage[],
): Promise<readonly string[]> {
  if (images.length === 0) return [];
  if (!DAY_KEY_PATTERN.test(dayKey)) {
    throw new Error(`归档日期格式无效：${dayKey}`);
  }

  const decodedImages = images.map((image) => decodeImage(image.dataUrl));
  const dayDirectory = join(rootDirectory, dayKey);
  await mkdir(dayDirectory, { recursive: true, mode: 0o700 });

  const entries = await readdir(dayDirectory, { withFileTypes: true });
  let nextSequence =
    entries.reduce((highest, entry) => {
      if (!entry.isFile()) return highest;
      const match = ARCHIVED_IMAGE_PATTERN.exec(entry.name);
      return Math.max(highest, match?.[1] ? Number(match[1]) : 0);
    }, 0) + 1;

  const archivedPaths: string[] = [];
  for (const image of decodedImages) {
    while (true) {
      const fileName = `${String(nextSequence).padStart(3, "0")}.${image.extension}`;
      const filePath = join(dayDirectory, fileName);
      nextSequence += 1;
      try {
        await writeFile(filePath, image.bytes, {
          flag: "wx",
          mode: 0o600,
        });
        archivedPaths.push(filePath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
  }

  return archivedPaths;
}

function decodeImage(dataUrl: string): {
  bytes: Buffer;
  extension: "gif" | "jpg" | "png" | "webp";
} {
  const match = IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new Error("投稿图片不是受支持的图片 data URL");
  }

  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0) throw new Error("投稿图片内容为空");

  const extension =
    match[1] === "image/jpeg"
      ? "jpg"
      : (match[1].slice(6) as "gif" | "png" | "webp");
  return { bytes, extension };
}

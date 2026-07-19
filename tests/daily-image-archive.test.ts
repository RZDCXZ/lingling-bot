import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AiImage } from "../src/ai/types.js";
import { archiveDailyImages } from "../src/daily-image-archive.js";

function image(content: string, mimeType = "image/png"): AiImage {
  return {
    dataUrl: `data:${mimeType};base64,${Buffer.from(content).toString("base64")}`,
    detail: "auto",
  };
}

describe("延年益寿图片归档", () => {
  it("按年月日建目录并为同日图片连续编号", async () => {
    const root = join(
      tmpdir(),
      `qq-bot-daily-sese-${process.pid}-${Date.now()}`,
    );
    try {
      const firstBatch = await archiveDailyImages(root, "2026-07-19", [
        image("first"),
        image("second", "image/jpeg"),
      ]);
      const secondBatch = await archiveDailyImages(root, "2026-07-19", [
        image("third", "image/webp"),
      ]);

      expect(firstBatch.map((filePath) => basename(filePath))).toEqual([
        "001.png",
        "002.jpg",
      ]);
      expect(secondBatch.map((filePath) => basename(filePath))).toEqual([
        "003.webp",
      ]);
      expect(await readdir(join(root, "2026-07-19"))).toEqual([
        "001.png",
        "002.jpg",
        "003.webp",
      ]);
      await expect(readFile(firstBatch[0]!)).resolves.toEqual(
        Buffer.from("first"),
      );
      expect((await stat(firstBatch[0]!)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("拒绝不安全的日期目录名和无效图片数据", async () => {
    await expect(
      archiveDailyImages("/tmp/archive", "../escape", [image("x")]),
    ).rejects.toThrow("日期格式无效");
    await expect(
      archiveDailyImages("/tmp/archive", "2026-07-19", [
        { dataUrl: "data:text/plain;base64,eA==", detail: "auto" },
      ]),
    ).rejects.toThrow("受支持");
  });
});

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { AiImage } from "./ai/types.js";
import { archiveDailyImages } from "./daily-image-archive.js";

const MANIFEST_VERSION = 1;
const MANIFEST_FILE_NAME = ".pending.json";
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const IMAGE_FILE_PATTERN = /^\d+\.(?:gif|jpg|png|webp)$/;
const MAX_PENDING_FILES = 100;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface PendingManifest {
  version: typeof MANIFEST_VERSION;
  files: string[];
}

export interface LongevityArchiveSubmission {
  accepted: number;
  ignored: number;
  total: number;
}

export interface SavedLongevitySubmission {
  queue(
    approvedIndexes: readonly number[],
    maxImages: number,
  ): Promise<LongevityArchiveSubmission>;
}

export class DailyLongevityArchive {
  constructor(private readonly rootDirectory: string) {}

  async save(
    dayKey: string,
    images: readonly AiImage[],
  ): Promise<SavedLongevitySubmission> {
    const archivedPaths = await archiveDailyImages(
      this.rootDirectory,
      dayKey,
      images,
    );
    const archivedFiles = archivedPaths.map((filePath) => basename(filePath));
    return {
      queue: (approvedIndexes, maxImages) =>
        this.queueFiles(dayKey, archivedFiles, approvedIndexes, maxImages),
    };
  }

  async count(dayKey: string): Promise<number> {
    return (await this.readPendingFiles(dayKey)).length;
  }

  async clear(dayKey: string): Promise<number> {
    const files = await this.readPendingFiles(dayKey);
    if (files.length > 0) await this.writePendingFiles(dayKey, []);
    return files.length;
  }

  async load(dayKey: string): Promise<readonly AiImage[]> {
    const dayDirectory = this.dayDirectory(dayKey);
    const files = await this.readPendingFiles(dayKey);
    return Promise.all(
      files.map(async (fileName) => {
        const filePath = join(dayDirectory, fileName);
        const metadata = await stat(filePath);
        if (!metadata.isFile() || metadata.size <= 0) {
          throw new Error(`延年益寿待发布图片无效：${fileName}`);
        }
        if (metadata.size > MAX_IMAGE_BYTES) {
          throw new Error(`延年益寿待发布图片超过大小限制：${fileName}`);
        }
        const bytes = await readFile(filePath);
        return {
          dataUrl: `data:${mimeTypeFor(fileName)};base64,${bytes.toString("base64")}`,
          detail: "auto" as const,
        };
      }),
    );
  }

  private async queueFiles(
    dayKey: string,
    archivedFiles: readonly string[],
    approvedIndexes: readonly number[],
    maxImages: number,
  ): Promise<LongevityArchiveSubmission> {
    if (!areValidIndexes(approvedIndexes, archivedFiles.length)) {
      throw new Error("延年益寿预审结果包含无效图片序号");
    }
    const pendingFiles = await this.readPendingFiles(dayKey);
    const remaining = Math.max(0, maxImages - pendingFiles.length);
    const approvedFiles = approvedIndexes.map(
      (index) => archivedFiles[index - 1]!,
    );
    const acceptedFiles = approvedFiles.slice(0, remaining);
    if (acceptedFiles.length > 0) {
      pendingFiles.push(...acceptedFiles);
      await this.writePendingFiles(dayKey, pendingFiles);
    }
    return {
      accepted: acceptedFiles.length,
      ignored: approvedFiles.length - acceptedFiles.length,
      total: pendingFiles.length,
    };
  }

  private async readPendingFiles(dayKey: string): Promise<string[]> {
    const manifestPath = this.manifestPath(dayKey);
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isPendingManifest(parsed)) {
        throw new Error(`延年益寿待发布清单格式无效：${manifestPath}`);
      }
      return [...parsed.files];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writePendingFiles(
    dayKey: string,
    files: readonly string[],
  ): Promise<void> {
    const dayDirectory = this.dayDirectory(dayKey);
    await mkdir(dayDirectory, { recursive: true, mode: 0o700 });
    const manifestPath = join(dayDirectory, MANIFEST_FILE_NAME);
    const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    const manifest: PendingManifest = {
      version: MANIFEST_VERSION,
      files: [...files],
    };
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, manifestPath);
  }

  private manifestPath(dayKey: string): string {
    return join(this.dayDirectory(dayKey), MANIFEST_FILE_NAME);
  }

  private dayDirectory(dayKey: string): string {
    if (!DAY_KEY_PATTERN.test(dayKey)) {
      throw new Error(`归档日期格式无效：${dayKey}`);
    }
    return join(this.rootDirectory, dayKey);
  }
}

function isPendingManifest(input: unknown): input is PendingManifest {
  if (!isRecord(input) || input.version !== MANIFEST_VERSION) return false;
  if (!Array.isArray(input.files) || input.files.length > MAX_PENDING_FILES) {
    return false;
  }
  return (
    input.files.every(
      (fileName) =>
        typeof fileName === "string" && IMAGE_FILE_PATTERN.test(fileName),
    ) && new Set(input.files).size === input.files.length
  );
}

function areValidIndexes(
  indexes: readonly number[],
  imageCount: number,
): boolean {
  return (
    new Set(indexes).size === indexes.length &&
    indexes.every(
      (index) => Number.isInteger(index) && index >= 1 && index <= imageCount,
    )
  );
}

function mimeTypeFor(
  fileName: string,
): "image/gif" | "image/jpeg" | "image/png" | "image/webp" {
  if (fileName.endsWith(".gif")) return "image/gif";
  if (fileName.endsWith(".jpg")) return "image/jpeg";
  if (fileName.endsWith(".png")) return "image/png";
  return "image/webp";
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

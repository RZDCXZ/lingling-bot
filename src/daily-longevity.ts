import type { AiImage, AiReplyResult, AiService } from "./ai/types.js";
import type { AppConfig } from "./config.js";
import { DailyLongevityArchive } from "./daily-longevity-archive.js";
import { formatDayKey } from "./engagement-state.js";
import { isWithinTimeWindow } from "./group-participation.js";

const SILENT_MARKER = "[[SILENT]]";
const LONGEVITY_PATTERN =
  /^\[\[LONGEVITY:([1-9]\d*(?:,[1-9]\d*)*)\]\]\s*([\s\S]+)$/;

export interface DailyLongevityPorts {
  allowGeneration(): boolean;
  sendGroupPost(
    groupId: string,
    text: string,
    images: readonly AiImage[],
  ): Promise<void>;
  onError?(error: Error): void;
}

export interface DailyLongevityOptions {
  ai: AiService;
  config: AppConfig["longevity"];
  tickMs: number;
  now?: () => number;
}

export interface LongevitySubmissionResult {
  archived: number;
  accepted: number;
  ignored: number;
  total: number;
  max: number;
  scheduledDayKey: string;
  approvedIndexes: readonly number[];
  rejectedIndexes: readonly number[];
}

export class DailyLongevityCoordinator {
  private readonly now: () => number;
  private readonly archive: DailyLongevityArchive;
  private submissionOperation = Promise.resolve();
  private sentDayKey: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: DailyLongevityOptions) {
    this.now = options.now ?? Date.now;
    this.archive = new DailyLongevityArchive(options.config.archiveDirectory);
  }

  canSubmit(userId: string): boolean {
    return (
      this.options.config.enabled &&
      userId === this.options.config.submitterUserId
    );
  }

  async acceptImages(
    userId: string,
    images: readonly AiImage[],
    now = this.now(),
  ): Promise<LongevitySubmissionResult | null> {
    return this.runSubmissionOperation(async () => {
      if (!this.canSubmit(userId) || images.length === 0) {
        return null;
      }

      const dayKey = this.submissionDayKey(now);
      const submitted = images.map((image) => ({
        dataUrl: image.dataUrl,
        detail: image.detail,
      }));
      const saved = await this.archive.save(dayKey, submitted);
      const reviewResult = await this.options.ai.generateReply(
        [
          {
            role: "user",
            content: `submitted_image_count: ${submitted.length}`,
            images: submitted,
          },
        ],
        { mode: "daily-longevity" },
      );
      const review = requireDailyLongevityReply(
        reviewResult,
        submitted.length,
      );
      const approvedIndexes = review?.imageIndexes ?? [];
      const approvedSet = new Set(approvedIndexes);
      const rejectedIndexes = submitted
        .map((_, index) => index + 1)
        .filter((index) => !approvedSet.has(index));
      const stored = await saved.queue(
        approvedIndexes,
        this.options.config.maxImages,
      );
      return {
        archived: submitted.length,
        ...stored,
        max: this.options.config.maxImages,
        scheduledDayKey: dayKey,
        approvedIndexes,
        rejectedIndexes,
      };
    });
  }

  async cancelSubmission(
    userId: string,
    now = this.now(),
  ): Promise<number | null> {
    return this.runSubmissionOperation(() => {
      if (
        !this.options.config.enabled ||
        userId !== this.options.config.submitterUserId
      ) {
        return null;
      }
      return this.archive.clear(this.submissionDayKey(now));
    });
  }

  async submissionCount(
    userId: string,
    now = this.now(),
  ): Promise<number | null> {
    return this.runSubmissionOperation(() => {
      if (
        !this.options.config.enabled ||
        userId !== this.options.config.submitterUserId
      ) {
        return null;
      }
      return this.archive.count(this.submissionDayKey(now));
    });
  }

  startScheduler(ports: DailyLongevityPorts): void {
    if (!this.options.config.enabled || this.timer) return;
    const run = () => {
      void this.runScheduledTick(ports).catch((error: unknown) => {
        ports.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    };
    this.timer = setInterval(run, this.options.tickMs);
    this.timer.unref();
    run();
  }

  stopScheduler(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runScheduledTick(ports: DailyLongevityPorts): Promise<void> {
    if (!this.options.config.enabled || this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const dayKey = formatDayKey(now, this.options.config.timeZone);
      if (
        this.sentDayKey === dayKey ||
        !isWithinTimeWindow(
          now,
          this.options.config.timeZone,
          this.options.config.sendMinutes,
          this.options.config.catchUpEndMinutes,
        )
      ) {
        return;
      }

      const submitted = await this.runSubmissionOperation(() =>
        this.archive.load(dayKey),
      );
      if (submitted.length === 0) {
        this.sentDayKey = dayKey;
        return;
      }
      if (!ports.allowGeneration()) return;

      const result = await this.options.ai.generateReply(
        [
          {
            role: "user",
            content: `submitted_image_count: ${submitted.length}`,
            images: submitted,
          },
        ],
        { mode: "daily-longevity" },
      );
      const post = requireDailyLongevityReply(result, submitted.length);
      if (post) {
        const selected = post.imageIndexes.map(
          (index) => submitted[index - 1]!,
        );
        const titledText = post.text.includes("【延年益寿】")
          ? post.text
          : `【延年益寿】\n${post.text}`;
        for (const groupId of this.options.config.targetGroupIds) {
          await ports.sendGroupPost(groupId, titledText, selected);
        }
      }
      await this.runSubmissionOperation(() => this.archive.clear(dayKey));
      this.sentDayKey = dayKey;
    } finally {
      this.running = false;
    }
  }

  private submissionDayKey(now: number): string {
    const todayKey = formatDayKey(now, this.options.config.timeZone);
    return isWithinTimeWindow(
      now,
      this.options.config.timeZone,
      0,
      this.options.config.sendMinutes,
    )
      ? todayKey
      : nextDayKey(todayKey);
  }

  private runSubmissionOperation<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const result = this.submissionOperation.then(operation);
    this.submissionOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function nextDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const nextDay = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return nextDay.toISOString().slice(0, 10);
}

export function parseDailyLongevityReply(
  result: AiReplyResult,
  imageCount: number,
): { imageIndexes: number[]; text: string } | null {
  const text = longevityReplyText(result);
  if (text === SILENT_MARKER) return null;
  const match = LONGEVITY_PATTERN.exec(text);
  const caption = match?.[2]?.trim();
  if (!match?.[1] || !caption) return null;

  const rawIndexes = match[1].split(",").map(Number);
  const imageIndexes = [...new Set(rawIndexes)];
  if (
    imageIndexes.length === 0 ||
    imageIndexes.length !== rawIndexes.length ||
    imageIndexes.some(
      (index) => !Number.isInteger(index) || index < 1 || index > imageCount,
    )
  ) {
    return null;
  }
  return { imageIndexes, text: caption };
}

function requireDailyLongevityReply(
  result: AiReplyResult,
  imageCount: number,
): { imageIndexes: number[]; text: string } | null {
  const parsed = parseDailyLongevityReply(result, imageCount);
  if (parsed || longevityReplyText(result) === SILENT_MARKER) return parsed;
  throw new Error("延年益寿审核输出格式无效");
}

function longevityReplyText(result: AiReplyResult): string {
  return (typeof result === "string" ? result : result.text).trim();
}

import type { AiImage, AiReplyResult, AiService } from "./ai/types.js";
import type { AppConfig } from "./config.js";
import { formatDayKey } from "./engagement-state.js";
import { isWithinTimeWindow } from "./group-participation.js";

const SILENT_MARKER = "[[SILENT]]";
const LONGEVITY_PATTERN =
  /^\[\[LONGEVITY:([1-9]\d*(?:,[1-9]\d*)*)\]\]\s*([\s\S]+)$/;

export interface DailyLongevityPorts {
  allowGeneration(): boolean;
  sendPrivateText(userId: string, text: string): Promise<void>;
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
  accepted: number;
  ignored: number;
  total: number;
  max: number;
}

export class DailyLongevityCoordinator {
  private readonly now: () => number;
  private readonly images: AiImage[] = [];
  private currentDayKey: string | undefined;
  private remindedDayKey: string | undefined;
  private sentDayKey: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: DailyLongevityOptions) {
    this.now = options.now ?? Date.now;
  }

  isSubmissionWindow(userId: string, now = this.now()): boolean {
    return (
      this.options.config.enabled &&
      userId === this.options.config.submitterUserId &&
      isWithinTimeWindow(
        now,
        this.options.config.timeZone,
        this.options.config.reminderMinutes,
        this.options.config.sendMinutes,
      )
    );
  }

  acceptImages(
    userId: string,
    images: readonly AiImage[],
    now = this.now(),
  ): LongevitySubmissionResult | null {
    if (!this.isSubmissionWindow(userId, now) || images.length === 0) {
      return null;
    }

    const dayKey = this.syncDay(now);
    this.remindedDayKey = dayKey;
    const remaining = Math.max(
      0,
      this.options.config.maxImages - this.images.length,
    );
    const acceptedImages = images.slice(0, remaining).map((image) => ({
      dataUrl: image.dataUrl,
      detail: image.detail,
    }));
    this.images.push(...acceptedImages);
    return {
      accepted: acceptedImages.length,
      ignored: images.length - acceptedImages.length,
      total: this.images.length,
      max: this.options.config.maxImages,
    };
  }

  cancelSubmission(userId: string, now = this.now()): number | null {
    if (
      !this.options.config.enabled ||
      userId !== this.options.config.submitterUserId
    ) {
      return null;
    }
    this.syncDay(now);
    const removed = this.images.length;
    this.images.splice(0);
    return removed;
  }

  submissionCount(userId: string, now = this.now()): number | null {
    if (
      !this.options.config.enabled ||
      userId !== this.options.config.submitterUserId
    ) {
      return null;
    }
    this.syncDay(now);
    return this.images.length;
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
      const dayKey = this.syncDay(now);
      if (
        this.remindedDayKey !== dayKey &&
        isWithinTimeWindow(
          now,
          this.options.config.timeZone,
          this.options.config.reminderMinutes,
          this.options.config.sendMinutes,
        )
      ) {
        this.remindedDayKey = dayKey;
        await ports.sendPrivateText(
          this.options.config.submitterUserId,
          `【延年益寿】\n今晚 22:00 的环节开始征集图片啦。请在 10 分钟内直接发图，最多 ${this.options.config.maxImages} 张；只提交你有权转发、明确成年、非露骨、非真人的二次元图片。发送 /取消延年益寿 可以清空今晚投稿。`,
        );
        return;
      }

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

      this.sentDayKey = dayKey;
      const submitted = this.images.splice(0);
      if (submitted.length === 0) return;
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
      const post = parseDailyLongevityReply(result, submitted.length);
      if (!post) return;
      const selected = post.imageIndexes.map((index) => submitted[index - 1]!);
      const titledText = post.text.includes("【延年益寿】")
        ? post.text
        : `【延年益寿】\n${post.text}`;
      for (const groupId of this.options.config.targetGroupIds) {
        await ports.sendGroupPost(groupId, titledText, selected);
      }
    } finally {
      this.running = false;
    }
  }

  private syncDay(now: number): string {
    const dayKey = formatDayKey(now, this.options.config.timeZone);
    if (this.currentDayKey !== dayKey) {
      this.currentDayKey = dayKey;
      this.images.splice(0);
    }
    return dayKey;
  }
}

export function parseDailyLongevityReply(
  result: AiReplyResult,
  imageCount: number,
): { imageIndexes: number[]; text: string } | null {
  const text = (typeof result === "string" ? result : result.text).trim();
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

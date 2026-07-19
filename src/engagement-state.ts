import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

const STATE_VERSION = 1;
const MAX_RECENT_HOT_TOPICS = 3;
const MAX_HOT_TOPIC_CHARS = 1_000;

export interface EngagementSnapshot {
  dayKey: string;
  proactiveTextCount: number;
  reactionCount: number;
  lastProactiveTextAt?: number;
  lastReactionAt?: number;
  nextHotTopicAt?: number;
  recentHotTopics: readonly string[];
}

export interface EngagementStatePort {
  get(groupId: string, now: number): Promise<EngagementSnapshot>;
  recordProactiveText(
    groupId: string,
    now: number,
    hotTopicText?: string,
  ): Promise<void>;
  recordReaction(groupId: string, now: number): Promise<void>;
  setNextHotTopicAt(
    groupId: string,
    timestamp: number,
    now: number,
  ): Promise<void>;
}

interface StoredGroupState {
  dayKey: string;
  proactiveTextCount: number;
  reactionCount: number;
  lastProactiveTextAt?: number;
  lastReactionAt?: number;
  nextHotTopicAt?: number;
  recentHotTopics: string[];
}

interface StoredState {
  version: number;
  groups: Record<string, StoredGroupState>;
}

export class PersistentEngagementState implements EngagementStatePort {
  private data: StoredState = { version: STATE_VERSION, groups: {} };
  private loadPromise: Promise<void> | undefined;
  private writeChain = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly timeZone: string,
  ) {}

  async get(groupId: string, now: number): Promise<EngagementSnapshot> {
    await this.ensureLoaded();
    const record = this.getMutableRecord(groupId, now);
    return {
      ...record,
      recentHotTopics: [...record.recentHotTopics],
    };
  }

  async recordProactiveText(
    groupId: string,
    now: number,
    hotTopicText?: string,
  ): Promise<void> {
    await this.ensureLoaded();
    const record = this.getMutableRecord(groupId, now);
    record.proactiveTextCount += 1;
    record.lastProactiveTextAt = now;
    const normalizedTopic = hotTopicText?.trim().slice(0, MAX_HOT_TOPIC_CHARS);
    if (normalizedTopic) {
      record.recentHotTopics = [
        normalizedTopic,
        ...record.recentHotTopics.filter((item) => item !== normalizedTopic),
      ].slice(0, MAX_RECENT_HOT_TOPICS);
    }
    await this.persist();
  }

  async recordReaction(groupId: string, now: number): Promise<void> {
    await this.ensureLoaded();
    const record = this.getMutableRecord(groupId, now);
    record.reactionCount += 1;
    record.lastReactionAt = now;
    await this.persist();
  }

  async setNextHotTopicAt(
    groupId: string,
    timestamp: number,
    now: number,
  ): Promise<void> {
    await this.ensureLoaded();
    const record = this.getMutableRecord(groupId, now);
    record.nextHotTopicAt = timestamp;
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredState(parsed)) {
        throw new Error("主动互动状态文件格式无效");
      }
      this.data = parsed;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }

  private getMutableRecord(groupId: string, now: number): StoredGroupState {
    const dayKey = formatDayKey(now, this.timeZone);
    let record = this.data.groups[groupId];
    if (!record) {
      record = {
        dayKey,
        proactiveTextCount: 0,
        reactionCount: 0,
        recentHotTopics: [],
      };
      this.data.groups[groupId] = record;
    } else if (record.dayKey !== dayKey) {
      record.dayKey = dayKey;
      record.proactiveTextCount = 0;
      record.reactionCount = 0;
    }
    return record;
  }

  private async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const directory = dirname(this.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    });
    await this.writeChain;
  }
}

export function formatDayKey(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isStoredState(input: unknown): input is StoredState {
  if (!isRecord(input) || input.version !== STATE_VERSION) return false;
  if (!isRecord(input.groups)) return false;
  return Object.values(input.groups).every(isStoredGroupState);
}

function isStoredGroupState(input: unknown): input is StoredGroupState {
  if (!isRecord(input)) return false;
  return (
    typeof input.dayKey === "string" &&
    isNonNegativeInteger(input.proactiveTextCount) &&
    isNonNegativeInteger(input.reactionCount) &&
    isOptionalTimestamp(input.lastProactiveTextAt) &&
    isOptionalTimestamp(input.lastReactionAt) &&
    isOptionalTimestamp(input.nextHotTopicAt) &&
    Array.isArray(input.recentHotTopics) &&
    input.recentHotTopics.every((item) => typeof item === "string")
  );
}

function isOptionalTimestamp(input: unknown): boolean {
  return input === undefined || (typeof input === "number" && Number.isFinite(input));
}

function isNonNegativeInteger(input: unknown): boolean {
  return Number.isInteger(input) && Number(input) >= 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

import type { AiMessage, AiReplyResult, AiService } from "./ai/types.js";
import type { AppConfig } from "./config.js";
import type {
  EngagementSnapshot,
  EngagementStatePort,
} from "./engagement-state.js";

const SILENT_MARKER = "[[SILENT]]";
const REPLY_MARKER = "[[REPLY]]";
const REACTION_PATTERN = /^\[\[REACTION:(\d{1,8})\]\]$/;
const MAX_CONTEXT_LINE_CHARS = 1_000;
const MAX_NEW_MESSAGES_WHILE_THINKING = 2;
const OLD_JOKE_CONTEXT_MESSAGES = 4;
const HOT_TOPIC_RETRY_WITHOUT_CONTEXT_MS = 60 * 60 * 1_000;

export interface GroupParticipationConfig {
  enabled: boolean;
  minMessages: number;
  cooldownMs: number;
  probability: number;
  contextMessages: number;
  oldJokeMemoryMessages?: number;
}

export interface ObservedGroupMessage {
  groupId: string;
  senderId: string;
  senderName?: string;
  messageId?: string;
  content: string;
  imageCount?: number;
}

export interface GroupParticipationReplyPort {
  send(text: string): Promise<void>;
  react?(messageId: string, emojiId: string): Promise<void>;
}

export interface ScheduledGroupReplyTarget {
  groupId: string;
  senderId: string;
  messageId: string;
}

export interface ScheduledGroupPorts {
  sendGroupText(groupId: string, text: string): Promise<void>;
  sendGroupReply(target: ScheduledGroupReplyTarget, text: string): Promise<void>;
}

export interface GroupParticipationOptions {
  ai: AiService;
  config: GroupParticipationConfig;
  proactive?: AppConfig["proactive"];
  reaction?: AppConfig["reaction"];
  engagementState?: EngagementStatePort;
  now?: () => number;
  random?: () => number;
}

export type GroupInteractionOutcome = "none" | "reaction" | "text";

interface TimedMessage {
  at: number;
  message: AiMessage;
}

interface PendingQuestion {
  askedAt: number;
  content: string;
  messageId: string;
  senderId: string;
}

interface GroupState {
  history: TimedMessage[];
  humanMessagesSinceDecision: number;
  humanMessagesSinceBot: number;
  sequence: number;
  lastBotReplyAt?: number;
  lastHumanAt?: number;
  pendingQuestion?: PendingQuestion;
  revivalDueAt?: number;
  deciding: boolean;
}

interface SchedulerRegistration {
  groupIds: readonly string[];
  ports: ScheduledGroupPorts;
  allowGeneration: (groupId: string) => boolean;
  onError?: (error: Error) => void;
}

const DEFAULT_PROACTIVE_CONFIG: AppConfig["proactive"] = {
  enabled: false,
  timeZone: "Asia/Singapore",
  activeStartMinutes: 9 * 60,
  activeEndMinutes: 23 * 60 + 30,
  dailyTextLimit: 4,
  textCooldownMs: 10 * 60 * 1_000,
  tickMs: 30_000,
  unansweredEnabled: true,
  unansweredDelayMs: 3 * 60 * 1_000,
  revivalEnabled: true,
  revivalMinSilenceMs: 60 * 60 * 1_000,
  revivalMaxSilenceMs: 2 * 60 * 60 * 1_000,
  revivalProbability: 0.2,
  hotTopicEnabled: true,
  hotTopicIntervalMs: 24 * 60 * 60 * 1_000,
  hotTopicInitialMinMs: 60 * 60 * 1_000,
  hotTopicInitialMaxMs: 3 * 60 * 60 * 1_000,
  hotTopics: ["AI", "明日方舟：终末地", "绝区零", "异环", "鸣潮"],
};

const DEFAULT_REACTION_CONFIG: AppConfig["reaction"] = {
  enabled: false,
  probability: 0.12,
  cooldownMs: 5 * 60 * 1_000,
  dailyLimit: 12,
  emojiIds: ["14", "66", "76"],
};

export class GroupParticipationCoordinator {
  private readonly states = new Map<string, GroupState>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly proactive: AppConfig["proactive"];
  private readonly reaction: AppConfig["reaction"];
  private readonly engagementState: EngagementStatePort;
  private schedulerTimer: NodeJS.Timeout | undefined;
  private schedulerRunning = false;

  constructor(private readonly options: GroupParticipationOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.proactive = options.proactive ?? DEFAULT_PROACTIVE_CONFIG;
    this.reaction = options.reaction ?? DEFAULT_REACTION_CONFIG;
    this.engagementState = options.engagementState ?? new VolatileEngagementState();
  }

  observeHuman(message: ObservedGroupMessage): void {
    if (!this.isAnyGroupFeatureEnabled()) return;

    const content = renderHumanMessage(message);
    if (!content) return;

    const now = this.now();
    const state = this.getState(message.groupId);
    delete state.pendingQuestion;
    state.history.push({ at: now, message: { role: "user", content } });
    this.trimHistory(state);
    state.humanMessagesSinceDecision += 1;
    state.humanMessagesSinceBot += 1;
    state.sequence += 1;
    state.lastHumanAt = now;

    if (this.proactive.enabled && this.proactive.revivalEnabled) {
      state.revivalDueAt =
        now +
        randomBetween(
          this.proactive.revivalMinSilenceMs,
          this.proactive.revivalMaxSilenceMs,
          this.random,
        );
    }

    if (
      this.proactive.enabled &&
      this.proactive.unansweredEnabled &&
      message.messageId &&
      message.content.trim() &&
      looksLikeOpenQuestion(message.content)
    ) {
      state.pendingQuestion = {
        askedAt: now,
        content: message.content.trim(),
        messageId: message.messageId,
        senderId: message.senderId,
      };
    }
  }

  async handleUnmentioned(
    message: ObservedGroupMessage,
    reply: GroupParticipationReplyPort,
    allowGeneration: () => boolean = () => true,
  ): Promise<GroupInteractionOutcome> {
    this.observeHuman(message);
    if (
      !message.content.trim() ||
      (this.proactive.enabled &&
        !isWithinActiveHours(this.now(), this.proactive))
    ) {
      return "none";
    }

    const state = this.getState(message.groupId);
    if (state.deciding) return "none";

    const participation = await this.maybeJoinTopic(
      message,
      state,
      reply,
      allowGeneration,
    );
    if (participation.attempted) {
      return participation.sent ? "text" : "none";
    }

    return await this.maybeReact(message, state, reply, allowGeneration);
  }

  recordBotReply(groupId: string, content: string): void {
    if (!this.isAnyGroupFeatureEnabled() || !content.trim()) return;

    const state = this.getState(groupId);
    state.history.push({
      at: this.now(),
      message: { role: "assistant", content: content.trim() },
    });
    this.trimHistory(state);
    state.humanMessagesSinceDecision = 0;
    state.humanMessagesSinceBot = 0;
    delete state.pendingQuestion;
    delete state.revivalDueAt;
    state.lastBotReplyAt = this.now();
  }

  startScheduler(registration: SchedulerRegistration): void {
    if (!this.proactive.enabled || this.schedulerTimer) return;
    const run = () => {
      void this.runScheduledTick(registration).catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        registration.onError?.(normalized);
      });
    };
    this.schedulerTimer = setInterval(run, this.proactive.tickMs);
    this.schedulerTimer.unref();
    run();
  }

  stopScheduler(): void {
    if (!this.schedulerTimer) return;
    clearInterval(this.schedulerTimer);
    this.schedulerTimer = undefined;
  }

  async runScheduledTick(registration: SchedulerRegistration): Promise<void> {
    if (!this.proactive.enabled || this.schedulerRunning) return;
    this.schedulerRunning = true;
    try {
      const now = this.now();
      for (const groupId of registration.groupIds) {
        await this.ensureHotTopicSchedule(groupId, now);
      }
      if (!isWithinActiveHours(now, this.proactive)) return;

      for (const groupId of registration.groupIds) {
        await this.runGroupScheduledTask(groupId, registration, now);
      }
    } finally {
      this.schedulerRunning = false;
    }
  }

  private async maybeJoinTopic(
    message: ObservedGroupMessage,
    state: GroupState,
    reply: GroupParticipationReplyPort,
    allowGeneration: () => boolean,
  ): Promise<{ attempted: boolean; sent: boolean }> {
    if (!this.options.config.enabled || this.isParticipationCoolingDown(state)) {
      return { attempted: false, sent: false };
    }

    const addressedByName = mentionsBotName(message.content);
    const requiredMessages = addressedByName
      ? 1
      : this.options.config.minMessages;
    if (state.humanMessagesSinceDecision < requiredMessages) {
      return { attempted: false, sent: false };
    }

    const probability = addressedByName
      ? 1
      : looksLikeOpenQuestion(message.content)
        ? Math.max(this.options.config.probability, 0.7)
        : this.options.config.probability;

    state.humanMessagesSinceDecision = 0;
    if (probability <= 0 || this.random() >= probability) {
      return { attempted: false, sent: false };
    }
    const decisionSequence = state.sequence;
    state.deciding = true;
    try {
      if (!(await this.canSendProactiveText(message.groupId, state, false))) {
        return { attempted: false, sent: false };
      }
      if (!allowGeneration()) return { attempted: false, sent: false };

      const result = await this.options.ai.generateReply(this.buildContext(state), {
        mode: "group-participation",
      });
      const answer = parseParticipationReply(result);
      if (!answer || this.isStale(state, decisionSequence)) {
        return { attempted: true, sent: false };
      }

      await reply.send(answer);
      this.recordBotReply(message.groupId, answer);
      await this.engagementState.recordProactiveText(
        message.groupId,
        this.now(),
      );
      return { attempted: true, sent: true };
    } finally {
      state.deciding = false;
    }
  }

  private async maybeReact(
    message: ObservedGroupMessage,
    state: GroupState,
    reply: GroupParticipationReplyPort,
    allowGeneration: () => boolean,
  ): Promise<GroupInteractionOutcome> {
    if (
      !this.reaction.enabled ||
      !reply.react ||
      !message.messageId ||
      looksLikeOpenQuestion(message.content) ||
      message.content.trim().startsWith("/") ||
      this.reaction.probability <= 0 ||
      this.random() >= this.reaction.probability
    ) {
      return "none";
    }

    const decisionSequence = state.sequence;
    state.deciding = true;
    try {
      const snapshot = await this.engagementState.get(message.groupId, this.now());
      if (
        snapshot.reactionCount >= this.reaction.dailyLimit ||
        (snapshot.lastReactionAt !== undefined &&
          this.now() - snapshot.lastReactionAt < this.reaction.cooldownMs)
      ) {
        return "none";
      }
      if (!allowGeneration()) return "none";

      const result = await this.options.ai.generateReply(
        this.buildRecentContext(state),
        {
          mode: "group-reaction",
          reactionEmojiIds: this.reaction.emojiIds,
        },
      );
      const emojiId = parseReactionReply(result, this.reaction.emojiIds);
      if (!emojiId || this.isStale(state, decisionSequence)) return "none";

      await reply.react(message.messageId, emojiId);
      await this.engagementState.recordReaction(message.groupId, this.now());
      return "reaction";
    } finally {
      state.deciding = false;
    }
  }

  private async runGroupScheduledTask(
    groupId: string,
    registration: SchedulerRegistration,
    now: number,
  ): Promise<void> {
    const state = this.states.get(groupId);
    if (state?.deciding) return;

    if (
      state?.pendingQuestion &&
      now - state.pendingQuestion.askedAt >= this.proactive.unansweredDelayMs
    ) {
      const question = state.pendingQuestion;
      delete state.pendingQuestion;
      if (
        state.humanMessagesSinceBot >= 1 &&
        (await this.canSendProactiveText(groupId, state, true))
      ) {
        await this.runScheduledTextDecision(
          groupId,
          state,
          "unanswered-question",
          registration,
          (text) =>
            registration.ports.sendGroupReply(
              {
                groupId,
                senderId: question.senderId,
                messageId: question.messageId,
              },
              text,
            ),
        );
        return;
      }
    }

    if (state?.revivalDueAt !== undefined && state.revivalDueAt <= now) {
      delete state.revivalDueAt;
      if (
        state.humanMessagesSinceBot >= 3 &&
        this.random() < this.proactive.revivalProbability &&
        (await this.canSendProactiveText(groupId, state, true))
      ) {
        await this.runScheduledTextDecision(
          groupId,
          state,
          "cold-revival",
          registration,
          (text) => registration.ports.sendGroupText(groupId, text),
        );
        return;
      }
    }

    if (!this.proactive.hotTopicEnabled) return;
    const snapshot = await this.engagementState.get(groupId, now);
    if (snapshot.nextHotTopicAt === undefined || snapshot.nextHotTopicAt > now) {
      return;
    }
    if (!state || state.humanMessagesSinceBot < 3) {
      await this.engagementState.setNextHotTopicAt(
        groupId,
        now + HOT_TOPIC_RETRY_WITHOUT_CONTEXT_MS,
        now,
      );
      return;
    }

    await this.engagementState.setNextHotTopicAt(
      groupId,
      now + this.proactive.hotTopicIntervalMs,
      now,
    );
    if (!(await this.canSendProactiveText(groupId, state, true))) return;
    if (!registration.allowGeneration(groupId)) return;

    state.deciding = true;
    try {
      const recentHotTopics = snapshot.recentHotTopics.length
        ? snapshot.recentHotTopics.join("\n---\n")
        : "（暂无历史投喂）";
      const result = await this.options.ai.generateReply(
        [
          {
            role: "user",
            content: `recent_hot_topics:\n${recentHotTopics}`,
          },
        ],
        {
          mode: "hot-topic-feed",
          hotTopics: this.proactive.hotTopics,
        },
      );
      const answer = parseParticipationReply(result);
      if (!answer) return;

      await registration.ports.sendGroupText(groupId, answer);
      this.recordBotReply(groupId, answer);
      await this.engagementState.recordProactiveText(groupId, this.now(), answer);
    } finally {
      state.deciding = false;
    }
  }

  private async runScheduledTextDecision(
    groupId: string,
    state: GroupState,
    mode: "cold-revival" | "unanswered-question",
    registration: SchedulerRegistration,
    send: (text: string) => Promise<void>,
  ): Promise<void> {
    if (!registration.allowGeneration(groupId)) return;
    state.deciding = true;
    const decisionSequence = state.sequence;
    try {
      const result = await this.options.ai.generateReply(this.buildContext(state), {
        mode,
      });
      const answer = parseParticipationReply(result);
      if (!answer || this.isStale(state, decisionSequence)) return;

      await send(answer);
      this.recordBotReply(groupId, answer);
      await this.engagementState.recordProactiveText(groupId, this.now());
    } finally {
      state.deciding = false;
    }
  }

  private async canSendProactiveText(
    groupId: string,
    state: GroupState,
    scheduled: boolean,
  ): Promise<boolean> {
    const snapshot = await this.engagementState.get(groupId, this.now());
    if (snapshot.proactiveTextCount >= this.proactive.dailyTextLimit) return false;

    const cooldownMs = scheduled
      ? this.proactive.textCooldownMs
      : this.options.config.cooldownMs;
    const lastReplyAt = Math.max(
      state.lastBotReplyAt ?? 0,
      snapshot.lastProactiveTextAt ?? 0,
    );
    return lastReplyAt === 0 || this.now() - lastReplyAt >= cooldownMs;
  }

  private async ensureHotTopicSchedule(
    groupId: string,
    now: number,
  ): Promise<void> {
    if (!this.proactive.hotTopicEnabled) return;
    const snapshot = await this.engagementState.get(groupId, now);
    if (snapshot.nextHotTopicAt !== undefined) return;
    await this.engagementState.setNextHotTopicAt(
      groupId,
      now +
        randomBetween(
          this.proactive.hotTopicInitialMinMs,
          this.proactive.hotTopicInitialMaxMs,
          this.random,
        ),
      now,
    );
  }

  private getState(groupId: string): GroupState {
    let state = this.states.get(groupId);
    if (!state) {
      state = {
        history: [],
        humanMessagesSinceDecision: 0,
        humanMessagesSinceBot: 0,
        sequence: 0,
        deciding: false,
      };
      this.states.set(groupId, state);
    }
    return state;
  }

  private buildRecentContext(state: GroupState): AiMessage[] {
    return state.history
      .slice(-this.options.config.contextMessages)
      .map((item) => ({ ...item.message }));
  }

  private buildContext(state: GroupState): AiMessage[] {
    const recentStart = Math.max(
      0,
      state.history.length - this.options.config.contextMessages,
    );
    const recent = state.history.slice(recentStart);
    const older = state.history
      .slice(0, recentStart)
      .slice(-OLD_JOKE_CONTEXT_MESSAGES);
    const messages: AiMessage[] = [];
    if (older.length > 0) {
      messages.push({
        role: "user",
        content: [
          "[较早群聊片段：仅在当前话题确实呼应时用于旧梗回旋镖]",
          ...older.map((item) => item.message.content),
        ].join("\n"),
      });
    }
    messages.push(...recent.map((item) => ({ ...item.message })));
    return messages;
  }

  private isParticipationCoolingDown(state: GroupState): boolean {
    return (
      state.lastBotReplyAt !== undefined &&
      this.now() - state.lastBotReplyAt < this.options.config.cooldownMs
    );
  }

  private isStale(state: GroupState, decisionSequence: number): boolean {
    return (
      state.sequence - decisionSequence > MAX_NEW_MESSAGES_WHILE_THINKING
    );
  }

  private trimHistory(state: GroupState): void {
    const limit =
      this.options.config.oldJokeMemoryMessages ??
      this.options.config.contextMessages;
    state.history = state.history.slice(-limit);
  }

  private isAnyGroupFeatureEnabled(): boolean {
    return (
      this.options.config.enabled ||
      this.proactive.enabled ||
      this.reaction.enabled
    );
  }
}

export function parseParticipationReply(result: AiReplyResult): string | null {
  const text = (typeof result === "string" ? result : result.text).trim();
  if (text === SILENT_MARKER) return null;
  if (!text.startsWith(REPLY_MARKER)) return null;

  const answer = text.slice(REPLY_MARKER.length).trim();
  return answer || null;
}

export function parseReactionReply(
  result: AiReplyResult,
  allowedIds: readonly string[],
): string | null {
  const text = (typeof result === "string" ? result : result.text).trim();
  if (text === SILENT_MARKER) return null;
  const match = REACTION_PATTERN.exec(text);
  return match?.[1] && allowedIds.includes(match[1]) ? match[1] : null;
}

export function isWithinActiveHours(
  timestamp: number,
  config: Pick<
    AppConfig["proactive"],
    "activeEndMinutes" | "activeStartMinutes" | "timeZone"
  >,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minutes = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  const current = hours * 60 + minutes;

  if (config.activeStartMinutes <= config.activeEndMinutes) {
    return (
      current >= config.activeStartMinutes && current < config.activeEndMinutes
    );
  }
  return current >= config.activeStartMinutes || current < config.activeEndMinutes;
}

function renderHumanMessage(message: ObservedGroupMessage): string {
  const text = message.content.trim();
  const imageLabel = message.imageCount
    ? `[附带 ${message.imageCount} 张图片，图片内容未读取]`
    : "";
  if (!text && !imageLabel) return "";

  const sender = normalizeSenderName(message.senderName, message.senderId);
  const body = [text, imageLabel].filter(Boolean).join(" ");
  return `[群友：${sender}] ${body.slice(0, MAX_CONTEXT_LINE_CHARS)}`;
}

function normalizeSenderName(name: string | undefined, senderId: string): string {
  const normalized = name?.replace(/\s+/g, " ").trim().slice(0, 40);
  return normalized || `群友${senderId.slice(-2)}`;
}

function mentionsBotName(content: string): boolean {
  return /铃铃(?:酱)?|机器人/i.test(content);
}

function looksLikeOpenQuestion(content: string): boolean {
  const text = content.trim();
  return (
    /[?？]$/.test(text) ||
    /(?:大家|哥哥们|各位|你们|有人|谁).{0,20}(?:知道|觉得|推荐|会不会|能不能|有没有)/.test(
      text,
    )
  );
}

function randomBetween(min: number, max: number, random: () => number): number {
  if (max <= min) return min;
  return Math.floor(min + random() * (max - min));
}

export class VolatileEngagementState implements EngagementStatePort {
  private readonly records = new Map<string, EngagementSnapshot>();

  async get(groupId: string): Promise<EngagementSnapshot> {
    return this.records.get(groupId) ?? {
      dayKey: "volatile",
      proactiveTextCount: 0,
      reactionCount: 0,
      recentHotTopics: [],
    };
  }

  async recordProactiveText(
    groupId: string,
    now: number,
    hotTopicText?: string,
  ): Promise<void> {
    const current = await this.get(groupId);
    this.records.set(groupId, {
      ...current,
      proactiveTextCount: current.proactiveTextCount + 1,
      lastProactiveTextAt: now,
      recentHotTopics: hotTopicText
        ? [hotTopicText, ...current.recentHotTopics].slice(0, 3)
        : current.recentHotTopics,
    });
  }

  async recordReaction(groupId: string, now: number): Promise<void> {
    const current = await this.get(groupId);
    this.records.set(groupId, {
      ...current,
      reactionCount: current.reactionCount + 1,
      lastReactionAt: now,
    });
  }

  async setNextHotTopicAt(
    groupId: string,
    timestamp: number,
    _now: number,
  ): Promise<void> {
    const current = await this.get(groupId);
    this.records.set(groupId, { ...current, nextHotTopicAt: timestamp });
  }
}

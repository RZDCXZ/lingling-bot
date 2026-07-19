import type { AiMessage, AiReplyResult, AiService } from "./ai/types.js";
import type { AppConfig } from "./config.js";
import {
  formatDayKey,
  type EngagementSnapshot,
  type EngagementStatePort,
} from "./engagement-state.js";

const SILENT_MARKER = "[[SILENT]]";
const REPLY_MARKER = "[[REPLY]]";
const REACTION_PATTERN = /^\[\[REACTION:(\d{1,8})\]\]$/;
const DAILY_ROAST_PATTERN = /^\[\[ROAST:(p\d+)\]\]\s*([\s\S]+)$/;
const MAX_CONTEXT_LINE_CHARS = 1_000;
const MAX_DAILY_ROAST_MESSAGE_CHARS = 240;
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

interface DailyRoastMessage {
  at: number;
  dayKey: string;
  senderId: string;
  senderName: string;
  content: string;
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
  dailyRoastDayKey?: string;
  dailyRoastMessages: DailyRoastMessage[];
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
  timeZone: "Asia/Shanghai",
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
  hotTopicEnabled: false,
  hotTopicIntervalMs: 24 * 60 * 60 * 1_000,
  hotTopicInitialMinMs: 60 * 60 * 1_000,
  hotTopicInitialMaxMs: 3 * 60 * 60 * 1_000,
  hotTopics: ["AI", "明日方舟：终末地", "绝区零", "异环", "鸣潮"],
  morningRadarEnabled: true,
  morningRadarMinutes: 8 * 60,
  morningRadarCatchUpEndMinutes: 9 * 60,
  morningRadarLocation: "中国四川成都",
  dailyRoastEnabled: true,
  dailyRoastMinutes: 21 * 60,
  dailyRoastCatchUpEndMinutes: 22 * 60,
  dailyRoastMinMessages: 3,
  dailyRoastMaxMessages: 120,
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
    this.engagementState =
      options.engagementState ??
      new VolatileEngagementState(this.proactive.timeZone);
  }

  observeHuman(message: ObservedGroupMessage): void {
    if (!this.isAnyGroupFeatureEnabled()) return;

    const content = renderHumanMessage(message);
    if (!content) return;

    const now = this.now();
    const state = this.getState(message.groupId);
    this.trackDailyRoastMessage(state, message, now);
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
      const fixedTaskHandled = new Set<string>();
      for (const groupId of registration.groupIds) {
        await this.ensureHotTopicSchedule(groupId, now);
        if (await this.runFixedScheduledTask(groupId, registration, now)) {
          fixedTaskHandled.add(groupId);
        }
      }
      if (!isWithinActiveHours(now, this.proactive)) return;

      for (const groupId of registration.groupIds) {
        if (fixedTaskHandled.has(groupId)) continue;
        await this.runGroupScheduledTask(groupId, registration, now);
      }
    } finally {
      this.schedulerRunning = false;
    }
  }

  private async runFixedScheduledTask(
    groupId: string,
    registration: SchedulerRegistration,
    now: number,
  ): Promise<boolean> {
    if (await this.runMorningRadar(groupId, registration, now)) return true;
    return await this.runDailyRoast(groupId, registration, now);
  }

  private async runMorningRadar(
    groupId: string,
    registration: SchedulerRegistration,
    now: number,
  ): Promise<boolean> {
    if (
      !this.proactive.morningRadarEnabled ||
      !isWithinTimeWindow(
        now,
        this.proactive.timeZone,
        this.proactive.morningRadarMinutes,
        this.proactive.morningRadarCatchUpEndMinutes,
      )
    ) {
      return false;
    }

    const dayKey = formatDayKey(now, this.proactive.timeZone);
    const snapshot = await this.engagementState.get(groupId, now);
    if (snapshot.lastMorningRadarDayKey === dayKey) return false;

    const state = this.getState(groupId);
    if (state.deciding) return true;
    if (!(await this.canSendProactiveText(groupId, state, true, false))) {
      await this.engagementState.recordMorningRadarAttempt(groupId, now);
      return true;
    }

    await this.engagementState.recordMorningRadarAttempt(groupId, now);
    if (!registration.allowGeneration(groupId)) return true;

    state.deciding = true;
    try {
      const result = await this.options.ai.generateReply(
        [
          {
            role: "user",
            content: `morning_radar_date: ${dayKey}`,
          },
        ],
        {
          mode: "morning-radar",
          hotTopics: this.proactive.hotTopics,
          weatherLocation: this.proactive.morningRadarLocation,
        },
      );
      const answer = parseParticipationReply(result);
      if (!answer) return true;
      const titledAnswer = withScheduledTaskTitle(answer, "情报雷达");

      await registration.ports.sendGroupText(groupId, titledAnswer);
      this.recordBotReply(groupId, titledAnswer);
      await this.engagementState.recordProactiveText(groupId, this.now());
      return true;
    } finally {
      state.deciding = false;
    }
  }

  private async runDailyRoast(
    groupId: string,
    registration: SchedulerRegistration,
    now: number,
  ): Promise<boolean> {
    if (
      !this.proactive.dailyRoastEnabled ||
      !isWithinTimeWindow(
        now,
        this.proactive.timeZone,
        this.proactive.dailyRoastMinutes,
        this.proactive.dailyRoastCatchUpEndMinutes,
      )
    ) {
      return false;
    }

    const dayKey = formatDayKey(now, this.proactive.timeZone);
    const snapshot = await this.engagementState.get(groupId, now);
    if (snapshot.lastDailyRoastDayKey === dayKey) return false;

    const state = this.getState(groupId);
    this.resetDailyRoastMessagesIfNeeded(state, dayKey);
    if (state.deciding) return true;

    const eligibleMessages = state.dailyRoastMessages.filter(
      (message) => message.senderId !== snapshot.lastRoastSenderId,
    );
    const candidatePeople = groupDailyRoastMessagesBySender(eligibleMessages);
    if (
      state.dailyRoastMessages.length < this.proactive.dailyRoastMinMessages ||
      candidatePeople.length === 0
    ) {
      await this.engagementState.recordDailyRoastAttempt(groupId, now);
      state.dailyRoastMessages = [];
      return true;
    }

    if (!(await this.canSendProactiveText(groupId, state, true, false))) {
      await this.engagementState.recordDailyRoastAttempt(groupId, now);
      state.dailyRoastMessages = [];
      return true;
    }

    await this.engagementState.recordDailyRoastAttempt(groupId, now);
    if (!registration.allowGeneration(groupId)) {
      state.dailyRoastMessages = [];
      return true;
    }

    const labeledCandidates = candidatePeople.map((person, index) => ({
      label: `p${index + 1}`,
      senderName: person.senderName,
      messages: person.messages,
    }));
    const personByLabel = new Map(
      candidatePeople.map((person, index) => [`p${index + 1}`, person]),
    );

    state.deciding = true;
    try {
      const result = await this.options.ai.generateReply(
        [
          {
            role: "user",
            content: `daily_roast_candidates_json: ${JSON.stringify(labeledCandidates)}`,
          },
        ],
        { mode: "daily-roast" },
      );
      const roast = parseDailyRoastReply(
        result,
        labeledCandidates.map((candidate) => candidate.label),
      );
      if (!roast) return true;

      const target = personByLabel.get(roast.label);
      if (!target) return true;
      const titledRoast = withScheduledTaskTitle(roast.text, "批斗大会");
      await registration.ports.sendGroupText(groupId, titledRoast);
      this.recordBotReply(groupId, titledRoast);
      await this.engagementState.recordDailyRoastAttempt(
        groupId,
        this.now(),
        target.senderId,
      );
      await this.engagementState.recordProactiveText(groupId, this.now());
      return true;
    } finally {
      state.dailyRoastMessages = [];
      state.deciding = false;
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
    reserveFixedTasks = true,
  ): Promise<boolean> {
    const snapshot = await this.engagementState.get(groupId, this.now());
    const reservedSlots = reserveFixedTasks
      ? this.countPendingFixedTaskSlots(snapshot, this.now())
      : 0;
    const availableBeforeFixedTasks = Math.max(
      0,
      this.proactive.dailyTextLimit - reservedSlots,
    );
    if (snapshot.proactiveTextCount >= availableBeforeFixedTasks) return false;

    const cooldownMs = scheduled
      ? this.proactive.textCooldownMs
      : this.options.config.cooldownMs;
    const lastReplyAt = Math.max(
      state.lastBotReplyAt ?? 0,
      snapshot.lastProactiveTextAt ?? 0,
    );
    return lastReplyAt === 0 || this.now() - lastReplyAt >= cooldownMs;
  }

  private countPendingFixedTaskSlots(
    snapshot: EngagementSnapshot,
    now: number,
  ): number {
    const dayKey = formatDayKey(now, this.proactive.timeZone);
    const currentMinutes = getMinutesInTimeZone(now, this.proactive.timeZone);
    let count = 0;
    if (
      this.proactive.morningRadarEnabled &&
      snapshot.lastMorningRadarDayKey !== dayKey &&
      currentMinutes < this.proactive.morningRadarCatchUpEndMinutes
    ) {
      count += 1;
    }
    if (
      this.proactive.dailyRoastEnabled &&
      snapshot.lastDailyRoastDayKey !== dayKey &&
      currentMinutes < this.proactive.dailyRoastCatchUpEndMinutes
    ) {
      count += 1;
    }
    return count;
  }

  private trackDailyRoastMessage(
    state: GroupState,
    message: ObservedGroupMessage,
    now: number,
  ): void {
    if (!this.proactive.enabled || !this.proactive.dailyRoastEnabled) return;

    const dayKey = formatDayKey(now, this.proactive.timeZone);
    this.resetDailyRoastMessagesIfNeeded(state, dayKey);
    const content = message.content.replace(/\s+/g, " ").trim();
    if (!content || content.startsWith("/") || content.length < 2) return;

    state.dailyRoastMessages.push({
      at: now,
      dayKey,
      senderId: message.senderId,
      senderName: normalizeSenderName(message.senderName, message.senderId),
      content: content.slice(0, MAX_DAILY_ROAST_MESSAGE_CHARS),
    });
    state.dailyRoastMessages = state.dailyRoastMessages.slice(
      -this.proactive.dailyRoastMaxMessages,
    );
  }

  private resetDailyRoastMessagesIfNeeded(
    state: GroupState,
    dayKey: string,
  ): void {
    if (state.dailyRoastDayKey === dayKey) return;
    state.dailyRoastDayKey = dayKey;
    state.dailyRoastMessages = [];
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
        dailyRoastMessages: [],
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

export function parseDailyRoastReply(
  result: AiReplyResult,
  allowedLabels: readonly string[],
): { label: string; text: string } | null {
  const text = (typeof result === "string" ? result : result.text).trim();
  if (text === SILENT_MARKER) return null;
  const match = DAILY_ROAST_PATTERN.exec(text);
  const label = match?.[1];
  const answer = match?.[2]?.trim();
  if (!label || !answer || !allowedLabels.includes(label)) return null;
  return { label, text: answer };
}

export function isWithinActiveHours(
  timestamp: number,
  config: Pick<
    AppConfig["proactive"],
    "activeEndMinutes" | "activeStartMinutes" | "timeZone"
  >,
): boolean {
  return isWithinTimeWindow(
    timestamp,
    config.timeZone,
    config.activeStartMinutes,
    config.activeEndMinutes,
  );
}

export function isWithinTimeWindow(
  timestamp: number,
  timeZone: string,
  startMinutes: number,
  endMinutes: number,
): boolean {
  const current = getMinutesInTimeZone(timestamp, timeZone);

  if (startMinutes <= endMinutes) {
    return current >= startMinutes && current < endMinutes;
  }
  return current >= startMinutes || current < endMinutes;
}

function getMinutesInTimeZone(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hours = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minutes = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  return hours * 60 + minutes;
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

function groupDailyRoastMessagesBySender(
  messages: readonly DailyRoastMessage[],
): Array<{ senderId: string; senderName: string; messages: string[] }> {
  const people = new Map<
    string,
    { senderId: string; senderName: string; messages: string[] }
  >();
  for (const message of messages) {
    const existing = people.get(message.senderId);
    if (existing) {
      existing.senderName = message.senderName;
      existing.messages.push(message.content);
      continue;
    }
    people.set(message.senderId, {
      senderId: message.senderId,
      senderName: message.senderName,
      messages: [message.content],
    });
  }
  return [...people.values()];
}

function withScheduledTaskTitle(text: string, title: string): string {
  const marker = `【${title}】`;
  return text.includes(marker) ? text : `${marker}\n${text}`;
}

function randomBetween(min: number, max: number, random: () => number): number {
  if (max <= min) return min;
  return Math.floor(min + random() * (max - min));
}

export class VolatileEngagementState implements EngagementStatePort {
  private readonly records = new Map<string, EngagementSnapshot>();

  constructor(private readonly timeZone = "UTC") {}

  async get(groupId: string, now = Date.now()): Promise<EngagementSnapshot> {
    const dayKey = formatDayKey(now, this.timeZone);
    const current = this.records.get(groupId);
    if (current?.dayKey === dayKey) return current;

    const next: EngagementSnapshot = {
      ...current,
      dayKey,
      proactiveTextCount: 0,
      reactionCount: 0,
      recentHotTopics: current?.recentHotTopics ?? [],
    };
    this.records.set(groupId, next);
    return next;
  }

  async recordProactiveText(
    groupId: string,
    now: number,
    hotTopicText?: string,
  ): Promise<void> {
    const current = await this.get(groupId, now);
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
    const current = await this.get(groupId, now);
    this.records.set(groupId, {
      ...current,
      reactionCount: current.reactionCount + 1,
      lastReactionAt: now,
    });
  }

  async setNextHotTopicAt(
    groupId: string,
    timestamp: number,
    now: number,
  ): Promise<void> {
    const current = await this.get(groupId, now);
    this.records.set(groupId, { ...current, nextHotTopicAt: timestamp });
  }

  async recordMorningRadarAttempt(groupId: string, now: number): Promise<void> {
    const current = await this.get(groupId, now);
    this.records.set(groupId, {
      ...current,
      lastMorningRadarDayKey: formatDayKey(now, this.timeZone),
    });
  }

  async recordDailyRoastAttempt(
    groupId: string,
    now: number,
    senderId?: string,
  ): Promise<void> {
    const current = await this.get(groupId, now);
    this.records.set(groupId, {
      ...current,
      lastDailyRoastDayKey: formatDayKey(now, this.timeZone),
      ...(senderId ? { lastRoastSenderId: senderId } : {}),
    });
  }
}

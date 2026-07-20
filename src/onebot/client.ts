import { randomUUID } from "node:crypto";

import WebSocket, { type ClientOptions, type RawData } from "ws";

import type { Logger } from "../logger.js";
import type { OneBotActionCaller, OneBotEventHandler } from "./types.js";

export interface OneBotWebSocketClientConfig {
  url: string;
  accessToken: string;
  reconnectIntervalMs: number;
  actionTimeoutMs: number;
}

interface PendingAction {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class OneBotWebSocketClient implements OneBotActionCaller {
  private socket: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private eventHandler: OneBotEventHandler | undefined;
  private stopping = true;
  private readonly pendingActions = new Map<string, PendingAction>();

  constructor(
    private readonly config: OneBotWebSocketClientConfig,
    private readonly logger: Logger,
  ) {}

  async start(eventHandler: OneBotEventHandler): Promise<void> {
    if (!this.stopping) return;
    this.stopping = false;
    this.eventHandler = eventHandler;
    try {
      await this.connect();
    } catch (error: unknown) {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.logger.warn("[onebot] 首次连接失败，将在后台重试", {
        message: normalized.message,
      });
      this.scheduleReconnect();
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.rejectPending(new Error("OneBot 连接已停止"));

    const socket = this.socket;
    this.socket = undefined;
    if (socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, "application shutdown");
    }
  }

  async call<T = unknown>(
    action: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("NapCat OneBot WebSocket 当前未连接");
    }

    const echo = randomUUID();
    const payload = JSON.stringify({ action, params, echo });
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingActions.delete(echo);
        reject(new Error(`OneBot 接口 ${action} 响应超时`));
      }, this.config.actionTimeoutMs);

      this.pendingActions.set(echo, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      socket.send(payload, (error) => {
        if (!error) return;
        const pending = this.pendingActions.get(echo);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingActions.delete(echo);
        pending.reject(error);
      });
    });
  }

  private async connect(): Promise<void> {
    if (this.stopping) throw new Error("OneBot 连接已停止");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return await this.connecting;

    this.connecting = this.openSocket();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: ClientOptions = {
        headers: { Authorization: `Bearer ${this.config.accessToken}` },
      };
      const socket = new WebSocket(this.config.url, options);
      this.socket = socket;
      let opened = false;
      let initialSettled = false;

      socket.once("open", () => {
        opened = true;
        initialSettled = true;
        this.logger.info("[onebot] 已连接 NapCat WebSocket", {
          endpoint: redactEndpoint(this.config.url),
        });
        resolve();
      });

      socket.on("message", (data) => this.handleMessage(data));
      socket.on("unexpected-response", (_request, response) => {
        this.logger.error("[onebot] NapCat 拒绝 WebSocket 连接", {
          statusCode: response.statusCode,
          hint:
            response.statusCode === 401 || response.statusCode === 403
              ? "请检查 ONEBOT_ACCESS_TOKEN 是否与 NapCat 一致"
              : undefined,
        });
      });
      socket.on("error", (error) => {
        this.logger.error("[onebot] WebSocket 错误", {
          name: error.name,
          message: error.message,
        });
        if (!opened && !initialSettled) {
          initialSettled = true;
          reject(error);
        }
      });
      socket.once("close", (code, reason) => {
        if (this.socket === socket) this.socket = undefined;
        this.rejectPending(new Error("NapCat OneBot WebSocket 已断开"));
        this.logger.warn("[onebot] WebSocket 已断开", {
          code,
          reason: reason.toString() || undefined,
        });

        if (!opened && !initialSettled) {
          initialSettled = true;
          reject(new Error(`NapCat WebSocket 在连接前关闭（${code}）`));
        }
        this.scheduleReconnect();
      });
    });
  }

  private handleMessage(data: RawData): void {
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      this.logger.warn("[onebot] 忽略无法解析的 WebSocket 数据");
      return;
    }
    if (!isRecord(payload)) return;

    const echo = typeof payload.echo === "string" ? payload.echo : undefined;
    if (echo) {
      const pending = this.pendingActions.get(echo);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingActions.delete(echo);

      if (payload.status === "ok" && payload.retcode === 0) {
        pending.resolve(payload.data);
      } else {
        pending.reject(
          new Error(
            `OneBot 接口调用失败：retcode=${String(payload.retcode)}, message=${String(payload.message ?? payload.wording ?? "unknown")}`,
          ),
        );
      }
      return;
    }

    if (!this.eventHandler || typeof payload.post_type !== "string") return;
    void Promise.resolve(this.eventHandler(payload)).catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.logger.error("[onebot] 处理事件失败", {
        name: normalized.name,
        message: normalized.message,
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.logger.info("[onebot] 将尝试重新连接", {
      delayMs: this.config.reconnectIntervalMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.logger.error("[onebot] 重新连接失败", {
          message: normalized.message,
        });
        this.scheduleReconnect();
      });
    }, this.config.reconnectIntervalMs);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingActions.clear();
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function redactEndpoint(input: string): string {
  const url = new URL(input);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

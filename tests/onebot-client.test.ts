import type { AddressInfo } from "node:net";

import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../src/logger.js";
import { OneBotWebSocketClient } from "../src/onebot/client.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("OneBotWebSocketClient", () => {
  it("首次连接失败时保持运行，并在 NapCat 就绪后自动重连", async () => {
    const portReservation = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) =>
      portReservation.once("listening", resolve),
    );
    const address = portReservation.address() as AddressInfo;
    await new Promise<void>((resolve) => portReservation.close(() => resolve()));

    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const client = new OneBotWebSocketClient(
      {
        url: `ws://127.0.0.1:${address.port}`,
        accessToken: "test-onebot-token",
        reconnectIntervalMs: 20,
        actionTimeoutMs: 1_000,
      },
      logger,
    );

    await expect(client.start(vi.fn())).resolves.toBeUndefined();

    const server = new WebSocketServer({ port: address.port });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        "[onebot] 已连接 NapCat WebSocket",
        expect.any(Object),
      ),
    );

    client.stop();
  });

  it("携带 Bearer Token、接收事件并按 echo 匹配接口响应", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as AddressInfo;
    let authorization: string | undefined;

    server.on("connection", (socket, request) => {
      authorization = request.headers.authorization;
      socket.on("message", (raw) => {
        const action = JSON.parse(raw.toString()) as {
          action: string;
          echo: string;
        };
        socket.send(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { message_id: "reply-1", action: action.action },
            echo: action.echo,
          }),
        );
      });
    });

    const logger: Logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const client = new OneBotWebSocketClient(
      {
        url: `ws://127.0.0.1:${address.port}`,
        accessToken: "test-onebot-token",
        reconnectIntervalMs: 1_000,
        actionTimeoutMs: 1_000,
      },
      logger,
    );
    const onEvent = vi.fn();
    await client.start(onEvent);

    const result = await client.call<{ message_id: string; action: string }>(
      "send_group_msg",
      { group_id: "10001", message: "hello" },
    );
    expect(authorization).toBe("Bearer test-onebot-token");
    expect(result).toEqual({
      message_id: "reply-1",
      action: "send_group_msg",
    });

    const socket = [...server.clients][0];
    socket?.send(
      JSON.stringify({
        post_type: "message",
        message_type: "group",
        group_id: "10001",
      }),
    );
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());

    client.stop();
  });
});

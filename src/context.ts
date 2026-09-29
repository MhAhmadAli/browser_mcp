import type { WebSocket } from "ws";

import {
  CloseCode,
  type MessagePayload,
  type MessageResult,
  type MessageType,
  NO_CONNECTED_TAB_ERROR,
  type RequestMessage,
} from "@/protocol";

const noConnectionMessage = `No connection to browser extension. In order to proceed, you must first connect a tab by clicking the Browser MCP extension icon in the browser toolbar and clicking the 'Connect' button.`;

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class Context {
  private _ws: WebSocket | undefined;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();

  /** Makes `ws` the active extension connection, replacing any previous one. */
  attach(ws: WebSocket) {
    if (this._ws) {
      this._ws.close(CloseCode.Replaced, "Another browser connected");
      this.rejectPending("Browser extension was replaced by a new connection");
    }
    this._ws = ws;
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => {
      if (this._ws === ws) {
        this._ws = undefined;
        this.rejectPending("Browser extension disconnected");
      }
    });
  }

  async sendSocketMessage<T extends MessageType>(
    type: T,
    payload: MessagePayload<T>,
    { timeoutMs = 30000 }: { timeoutMs?: number } = {},
  ): Promise<MessageResult<T>> {
    const ws = this._ws;
    if (!ws) {
      throw new Error(noConnectionMessage);
    }

    const id = this.nextRequestId++;
    const request: RequestMessage = { id, type, payload };
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Timed out after ${timeoutMs / 1000}s waiting for the browser to respond to ${type}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(request), (error) => {
        if (error) {
          this.settle(id, { error: error.message });
        }
      });
    });
    return result as MessageResult<T>;
  }

  async close() {
    this.rejectPending("Server is shutting down");
    this._ws?.close();
  }

  private handleMessage(raw: string) {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      typeof message.id !== "number"
    ) {
      // Keep-alive pings and anything else that isn't a response
      return;
    }
    if ("error" in message) {
      this.settle(message.id, { error: String(message.error) });
    } else {
      this.settle(message.id, {
        result: "result" in message ? message.result : undefined,
      });
    }
  }

  private settle(
    id: number,
    outcome: { result: unknown } | { error: string },
  ) {
    const request = this.pending.get(id);
    if (!request) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(request.timer);
    if ("error" in outcome) {
      request.reject(
        new Error(
          outcome.error === NO_CONNECTED_TAB_ERROR
            ? noConnectionMessage
            : outcome.error,
        ),
      );
    } else {
      request.resolve(outcome.result);
    }
  }

  private rejectPending(reason: string) {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

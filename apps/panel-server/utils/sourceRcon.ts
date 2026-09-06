import net from "net";

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

const MAX_PACKET_SIZE = 8 * 1024 * 1024;

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

interface PendingRequest {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  parts: string[];
}

interface AuthPending {
  id: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SourceRconOptions {
  host?: string;
  port?: number;
  timeout?: number;
}

let nextRequestId = 1;

function allocRequestId(): number {
  nextRequestId = (nextRequestId % 0x7fffffff) + 1;
  return nextRequestId;
}

function encodePacket(
  id: number,
  type: number,
  body: string | null | undefined,
): Buffer {
  const bodyBuf = Buffer.from(body ?? "", "utf8");
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  let offset = 0;
  buf.writeInt32LE(size, offset);
  offset += 4;
  buf.writeInt32LE(id, offset);
  offset += 4;
  buf.writeInt32LE(type, offset);
  offset += 4;
  bodyBuf.copy(buf, offset);
  offset += bodyBuf.length;
  buf.writeUInt8(0, offset);
  offset += 1;
  buf.writeUInt8(0, offset);
  return buf;
}

export class PacketReader {
  private _buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): RconPacket[] {
    this._buf =
      this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    const packets: RconPacket[] = [];
    for (;;) {
      if (this._buf.length < 4) break;
      const size = this._buf.readInt32LE(0);
      if (size < 10 || size > MAX_PACKET_SIZE) {
        this._buf = Buffer.alloc(0);
        break;
      }
      const totalLen = 4 + size;
      if (this._buf.length < totalLen) break;

      const id = this._buf.readInt32LE(4);
      const type = this._buf.readInt32LE(8);
      const body = this._buf.toString("utf8", 12, totalLen - 2);
      packets.push({ id, type, body });

      this._buf = this._buf.subarray(totalLen);
    }
    return packets;
  }
}

export class SourceRconClient {
  host: string;
  port: number;
  timeout: number;
  socket: net.Socket | null;
  reader: PacketReader;
  private _pending: Map<number, PendingRequest>;
  private _authPending: AuthPending | null;
  private _destroyed: boolean;

  constructor({
    host = "",
    port = 0,
    timeout = 5000,
  }: SourceRconOptions = {}) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.socket = null;
    this.reader = new PacketReader();
    this._pending = new Map();
    this._authPending = null;
    this._destroyed = false;
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed);
  }

  authenticate(password: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        try {
          socket.destroy();
        } catch {
          // The socket may already be closed.
        }
        reject(error);
      };

      const connectTimer = setTimeout(
        () => fail(new Error("RCON connection timed out")),
        this.timeout,
      );

      socket.once("error", (error: Error) => fail(error));
      socket.once("close", () => {
        if (!settled) {
          fail(new Error("RCON connection closed before authentication completed"));
        }
      });

      socket.connect(this.port, this.host, () => {
        clearTimeout(connectTimer);
        socket.setNoDelay(true);

        socket.on("data", (chunk: Buffer) => this._onData(chunk));
        socket.on("close", () => this._onClose());
        socket.on("error", (error: Error) => this._onSocketError(error));

        const authId = allocRequestId();
        const authTimer = setTimeout(() => {
          if (this._authPending) {
            this._authPending = null;
            fail(new Error("RCON authentication timed out"));
          }
        }, this.timeout);

        this._authPending = {
          id: authId,
          resolve: () => {
            settled = true;
            clearTimeout(authTimer);
            resolve();
          },
          reject: (error: Error) => {
            clearTimeout(authTimer);
            fail(error);
          },
        };

        socket.write(encodePacket(authId, TYPE_AUTH, password));
      });
    });
  }

  private _onSocketError(error: Error): void {
    if (this._authPending) {
      const pending = this._authPending;
      this._authPending = null;
      pending.reject(error);
      return;
    }
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this._pending.clear();
  }

  private _onClose(): void {
    const closeError = new Error("RCON connection closed");
    if (this._authPending) {
      const pending = this._authPending;
      this._authPending = null;
      pending.reject(closeError);
    }
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(closeError);
    }
    this._pending.clear();
  }

  private _onData(chunk: Buffer): void {
    const packets = this.reader.push(chunk);
    for (const packet of packets) {
      if (this._authPending && packet.type === TYPE_AUTH_RESPONSE) {
        const pending = this._authPending;
        this._authPending = null;
        if (packet.id === -1) {
          pending.reject(new Error("RCON authentication failed (wrong password)"));
        } else {
          pending.resolve();
        }
        continue;
      }
      if (packet.type === TYPE_RESPONSE_VALUE) {
        const entry = this._pending.get(packet.id);
        if (entry) {
          entry.parts.push(packet.body);
          clearTimeout(entry.timer);
          this._pending.delete(packet.id);
          entry.resolve(entry.parts.join(""));
        }
      }
    }
  }

  execute(
    command: string,
    { timeoutMs = 8000 }: { timeoutMs?: number } = {},
  ): Promise<string> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error("RCON not connected"));
    }
    return new Promise((resolve, reject) => {
      const id = allocRequestId();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`RCON command timed out: ${command}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, parts: [] });
      socket.write(encodePacket(id, TYPE_EXECCOMMAND, command), (error) => {
        if (error) {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(error);
        }
      });
    });
  }

  disconnect(): void {
    this._destroyed = true;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // The socket may already be closed.
      }
    }
    this.socket = null;
  }
}

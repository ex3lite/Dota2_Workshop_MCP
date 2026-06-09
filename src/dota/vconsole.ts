// VConsole2 client — the TCP protocol that vconsole2.exe uses to talk to a Source 2
// game. In Dota 2 "-tools" mode the game listens on 127.0.0.1:29000 (override with
// the -vconport launch flag). This is the only reliable live console channel on
// Windows: the classic -netconport telnet console is broken on Windows, and
// console.log is buffered until the client exits.
//
// Wire format: a stream of length-prefixed chunks.
//   header (12 bytes): char type[4]; uint32 magic(0x00D20000, BE); uint16 length(BE, incl header); uint16 pad
//   payload: length - 12 bytes
// We send commands as "CMND" chunks (command text + NUL) and read output from
// "PRNT" chunks. Protocol ported from Penguinwizzard/VConsoleLib (C) and
// uilton-oliveira/VConsoleLib.python.

import net from "node:net";
import { EventEmitter } from "node:events";

// Protocol version marker in each chunk header. Current Dota 2 release uses 0xD4
// (the game rejects CMND chunks sent with the older 0xD2: "Message Version Mismatch").
const MAGIC = 0x00d40000;

// PRNT chunk body layout (verified against a live 0xD4 client): a 28-byte sub-header
// (channel id at offset 0, color/flags follow) then the message text + a trailing NUL.
const PRNT_TEXT_OFFSET = 28;

export interface ConsoleLine {
  channel: number;
  text: string;
  at: number;
}

export class VConsoleClient extends EventEmitter {
  private socket?: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private connected = false;
  private connecting?: Promise<void>;
  private ring: ConsoleLine[] = [];
  private readonly ringMax = 4000;

  constructor(
    public readonly host = "127.0.0.1",
    public readonly port = 29000,
  ) {
    super();
    this.setMaxListeners(50); // many short-lived sendAndCapture listeners can overlap
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Connect (idempotent). Rejects if the game isn't listening. */
  connect(timeoutMs = 8000): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      // net.connect can throw synchronously (e.g. an out-of-range port). Guard it so a
      // sync throw clears this.connecting instead of poisoning the cached promise.
      let sock: net.Socket;
      try {
        sock = net.connect({ host: this.host, port: this.port });
      } catch (err) {
        this.connecting = undefined;
        reject(err);
        return;
      }
      const timer = setTimeout(() => {
        sock.destroy();
        this.connecting = undefined;
        reject(new Error(`VConsole connect timed out (${this.host}:${this.port}). Is Dota running in -tools mode?`));
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        this.socket = sock;
        this.connected = true;
        this.connecting = undefined;
        resolve();
      });
      sock.on("data", (d) => this.onData(d));
      sock.once("error", (err) => {
        clearTimeout(timer);
        this.connected = false;
        this.connecting = undefined;
        reject(err);
      });
      sock.on("close", () => {
        this.connected = false;
        this.socket = undefined;
      });
      // After the initial connect, swallow late socket errors (game closing, etc.)
      sock.on("error", () => {
        this.connected = false;
      });
    });
    return this.connecting;
  }

  /** Poll-connect: retry until the game accepts or the deadline passes. */
  async connectWithRetry(deadlineMs = 30000, intervalMs = 500): Promise<void> {
    const end = Date.now() + deadlineMs;
    let lastErr: unknown;
    while (Date.now() < end) {
      try {
        await this.connect(Math.min(4000, intervalMs * 4));
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("VConsole connect retry exhausted");
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.connected = false;
    // Drop any in-flight attempt so a later connect() opens a fresh socket
    // (important for the restart -> reconnect flow).
    this.connecting = undefined;
  }

  /** Send a console command. */
  send(command: string): void {
    if (!this.socket || !this.connected) throw new Error("VConsole is not connected.");
    const payload = Buffer.from(command + "\0", "utf8");
    const header = Buffer.alloc(12);
    header.write("CMND", 0, "ascii");
    header.writeUInt32BE(MAGIC, 4);
    header.writeUInt16BE(payload.length + 12, 8);
    header.writeUInt16BE(0, 10);
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Recent console output captured from PRNT chunks (newest last). */
  recent(limit = 200): ConsoleLine[] {
    return this.ring.slice(-limit);
  }

  /** Drop the buffered console output (e.g. to watch only output after an action). */
  clearRing(): void {
    this.ring.length = 0;
  }

  /**
   * Send a command and capture the console output it produces, using a sentinel
   * echo to know when output has drained. Returns the lines printed in between.
   */
  async sendAndCapture(command: string, sentinel: string, waitMs = 2000): Promise<ConsoleLine[]> {
    // Accumulate matching lines in the listener itself, so the result is immune to
    // ring-buffer trimming, and clean the listener up on BOTH the sentinel and timeout
    // paths to avoid leaking listeners on the shared client.
    const captured: ConsoleLine[] = [];
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        this.off("print", onPrint);
        resolve();
      };
      const onPrint = (line: ConsoleLine) => {
        if (line.text.includes(sentinel)) {
          done();
          return;
        }
        captured.push(line);
      };
      timer = setTimeout(done, waitMs);
      this.on("print", onPrint);
      // Send after the listener is attached so we never miss fast output.
      try {
        this.send(command);
        this.send(`echo ${sentinel}`);
      } catch {
        done();
      }
    });
    return captured;
  }

  /**
   * Resolve when a console line satisfies `test`. Optionally scans the recent ring
   * first (scanRecent) so an already-printed match returns immediately. Returns the
   * matching line, or undefined on timeout.
   */
  async waitForLine(
    test: (line: ConsoleLine) => boolean,
    timeoutMs = 10000,
    scanRecent = false,
  ): Promise<ConsoleLine | undefined> {
    if (scanRecent) {
      const hit = [...this.ring].reverse().find(test);
      if (hit) return hit;
    }
    return new Promise<ConsoleLine | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const onPrint = (line: ConsoleLine) => {
        if (test(line)) {
          clearTimeout(timer);
          this.off("print", onPrint);
          resolve(line);
        }
      };
      timer = setTimeout(() => {
        this.off("print", onPrint);
        resolve(undefined);
      }, timeoutMs);
      this.on("print", onPrint);
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 12) {
      const magic = this.buf.readUInt32BE(4);
      const length = this.buf.readUInt16BE(8); // includes the 12-byte header
      // Validate the header; if it doesn't look like a real chunk we've desynced
      // (e.g. after an oversized chunk) — drop a byte and resync to the next header.
      if (magic !== MAGIC || length < 12) {
        this.buf = this.buf.subarray(1);
        continue;
      }
      if (this.buf.length < length) break;
      const type = this.buf.toString("ascii", 0, 4);
      const body = this.buf.subarray(12, length);
      this.buf = this.buf.subarray(length);
      this.handleChunk(type, body);
    }
  }

  private handleChunk(type: string, body: Buffer): void {
    if (type !== "PRNT") return; // CHAN/CVAR/AINF etc. are ignored for now
    // PRNT body: a PRNT_TEXT_OFFSET-byte sub-header (channel id at 0) then the message + NUL.
    if (body.length < PRNT_TEXT_OFFSET) return;
    const channel = body.readUInt32LE(0);
    let end = body.length;
    if (end > PRNT_TEXT_OFFSET && body[end - 1] === 0) end--; // strip trailing NUL
    let text = body.subarray(PRNT_TEXT_OFFSET, end).toString("utf8").replace(/\r?\n$/, "");
    if (text.length === 0) return;
    const line: ConsoleLine = { channel, text, at: Date.now() };
    this.ring.push(line);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    this.emit("print", line);
  }
}

// One shared client per (host, port) so all tools see the same live stream.
const clients = new Map<string, VConsoleClient>();

function validPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}

export function getVConsole(port?: number): VConsoleClient {
  const p = validPort(port) ? port : defaultVconPort();
  const key = `127.0.0.1:${p}`;
  let c = clients.get(key);
  if (!c) {
    c = new VConsoleClient("127.0.0.1", p);
    clients.set(key, c);
  }
  return c;
}

export function defaultVconPort(): number {
  const p = Number(process.env.DOTA2_VCONPORT);
  return validPort(p) ? p : 29000;
}

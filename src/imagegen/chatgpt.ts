// Image generation through a ChatGPT Plus/Pro/Team subscription — NO OpenAI API key.
//
// This rides the same backend the Codex CLI uses ("Sign in with ChatGPT"): the OAuth token
// `codex login` writes to ~/.codex/auth.json is POSTed to backend-api/codex/responses, whose
// built-in `image_generation` tool returns the rendered image as base64 over an SSE stream.
//
// HONEST CAVEAT: this is an UNDOCUMENTED endpoint, not a public API. It's covered by the user's
// Plus subscription (no per-image billing), but OpenAI can change or restrict it at any time, and
// using it is the user's call re: the OpenAI Terms of Use. For production/high-volume/transparent
// backgrounds/edits, the official gpt-image API (with a key) is the supported path.
//
// Mechanism mirrors github.com/leeguooooo/chatgpt-imagegen (the known-working reference).

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
// Sent as the `version`/User-Agent the Codex CLI advertises. NOT just cosmetic: the backend gates
// some models on a minimum Codex version (e.g. gpt-5.5 → "requires a newer version of Codex"), so
// this must look like a recent CLI. Defaults to a current build; override via CODEX_CLI_VERSION if
// the backend ever raises the floor again (check your installed `codex --version`).
const CODEX_VERSION = process.env.CODEX_CLI_VERSION?.trim() || "0.139.0";

export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageBackground = "auto" | "transparent" | "opaque";

export interface CodexTokens {
  access_token: string;
  account_id?: string;
  refresh_token?: string;
  id_token?: string;
}
export interface CodexAuth {
  tokens?: CodexTokens;
  last_refresh?: string;
  [k: string]: unknown;
}

/** Raised when ~/.codex/auth.json is absent or has no usable token — the user must `codex login`. */
export class CodexAuthMissingError extends Error {}

export const SETUP_HELP =
  "ChatGPT-account image generation isn't set up yet. It uses your ChatGPT Plus login (the same " +
  '"Sign in with ChatGPT" the Codex CLI uses) — no OpenAI API key, no per-image charge beyond Plus.\n\n' +
  "One-time setup (in a normal terminal):\n" +
  "  1) npm i -g @openai/codex\n" +
  "  2) codex login        # opens a browser — sign in with your ChatGPT Plus account\n\n" +
  "That writes the OAuth token to ~/.codex/auth.json, which this tool reads automatically. " +
  "Then run image_generate again.";

export function codexHome(): string {
  const env = process.env.CODEX_HOME?.trim();
  return env ? env : join(homedir(), ".codex");
}
export function codexAuthPath(): string {
  return join(codexHome(), "auth.json");
}

export async function readCodexAuth(): Promise<CodexAuth> {
  const p = codexAuthPath();
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    throw new CodexAuthMissingError(`No Codex auth found at ${p}.`);
  }
  let auth: CodexAuth;
  try {
    auth = JSON.parse(raw) as CodexAuth;
  } catch {
    throw new Error(`${p} exists but is not valid JSON. Re-run \`codex login\`.`);
  }
  if (!auth.tokens?.access_token) {
    throw new CodexAuthMissingError(`${p} has no access token. Re-run \`codex login\`.`);
  }
  return auth;
}

/** Milliseconds-since-epoch expiry from a JWT's `exp`, or null if unreadable. */
function jwtExpMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Exchange the refresh token for a fresh access token, persisting the result back to auth.json. */
async function refreshAuth(auth: CodexAuth): Promise<CodexAuth> {
  const refresh_token = auth.tokens?.refresh_token;
  if (!refresh_token) {
    throw new CodexAuthMissingError("No refresh_token in ~/.codex/auth.json — re-run `codex login`.");
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token,
      scope: "openai profile email",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}). Re-run \`codex login\`. ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
  const tokens: CodexTokens = {
    ...auth.tokens!,
    access_token: data.access_token ?? auth.tokens!.access_token,
    refresh_token: data.refresh_token ?? refresh_token,
    id_token: data.id_token ?? auth.tokens!.id_token,
  };
  const updated: CodexAuth = { ...auth, tokens, last_refresh: new Date().toISOString() };
  // Best-effort persist so the next call (and the Codex CLI itself) sees the fresh token.
  await writeFile(codexAuthPath(), JSON.stringify(updated, null, 2)).catch(() => {});
  return updated;
}

/** Refresh proactively if the access token is expired/near-expiry, or when `force`d (after a 401). */
async function ensureFreshToken(auth: CodexAuth, force = false): Promise<CodexAuth> {
  if (force) return refreshAuth(auth);
  const exp = jwtExpMs(auth.tokens!.access_token);
  const nearExpiry = exp !== null && exp - Date.now() < 60_000;
  return nearExpiry ? refreshAuth(auth) : auth;
}

function requestHeaders(tokens: CodexTokens): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: "text/event-stream",
    Connection: "Keep-Alive",
    version: CODEX_VERSION,
    session_id: randomUUID(),
    "x-client-request-id": randomUUID(),
    "User-Agent": `codex_cli_rs/${CODEX_VERSION} (Windows 11; x64)`,
    originator: "codex_cli_rs",
  };
  if (tokens.account_id) h["chatgpt-account-id"] = tokens.account_id;
  return h;
}

export function mimeForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

export interface InputImage {
  data: Buffer;
  mime: string;
}

/** The JSON body posted to backend-api/codex/responses to drive the built-in image_generation tool. */
export function buildPayload(opts: {
  prompt: string;
  size: string;
  format: ImageFormat;
  model: string;
  background?: ImageBackground;
  inputImages?: InputImage[];
}) {
  // The image_generation tool supports `background: "transparent"` (alpha) on PNG/WebP.
  const imageTool: Record<string, unknown> = { type: "image_generation", output_format: opts.format, size: opts.size };
  if (opts.background) imageTool.background = opts.background;
  // input_image parts (if any) turn this into an EDIT / reference-guided generation.
  const content: Array<Record<string, unknown>> = [];
  for (const im of opts.inputImages ?? []) {
    content.push({ type: "input_image", image_url: `data:${im.mime};base64,${im.data.toString("base64")}` });
  }
  content.push({ type: "input_text", text: opts.prompt });
  const editing = (opts.inputImages?.length ?? 0) > 0;
  return {
    model: opts.model,
    stream: true,
    instructions: editing
      ? "You are an image editing assistant. Apply the requested change to the provided image and output the " +
        "edited image using the image_generation tool. Do not ask clarifying questions."
      : "You are an image generation assistant. Generate the requested image using the image_generation tool. " +
        "Do not ask clarifying questions; produce the image directly.",
    input: [{ type: "message", role: "user", content }],
    tools: [imageTool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
  };
}

// ---- SSE parsing (pure + testable) -----------------------------------------

interface SseState {
  b64: string | null; // final image from output_item.done / response.completed
  lastPartial: string | null; // newest partial_image, used only as a fallback
  error: string | null;
}
function newSseState(): SseState {
  return { b64: null, lastPartial: null, error: null };
}

/** Feed one raw SSE line into the running state. Only `data:` lines carry payloads. */
function feedSseLine(state: SseState, rawLine: string): void {
  const line = rawLine.replace(/\r$/, "").trimStart();
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return;
  let obj: any;
  try {
    obj = JSON.parse(payload);
  } catch {
    return;
  }
  const ev: string | undefined = obj?.type;
  if (ev === "response.output_item.done" && obj.item?.type === "image_generation_call" && typeof obj.item.result === "string") {
    state.b64 = obj.item.result;
  } else if (ev === "response.image_generation_call.partial_image" && typeof obj.partial_image_b64 === "string") {
    state.lastPartial = obj.partial_image_b64;
  } else if (ev === "response.completed" && Array.isArray(obj.response?.output)) {
    for (const item of obj.response.output) {
      if (item?.type === "image_generation_call" && typeof item.result === "string") state.b64 = item.result;
    }
  } else if (ev === "response.failed") {
    state.error = obj.response?.error?.message ?? "response.failed";
  } else if (ev === "error" || obj?.error) {
    state.error = obj?.error?.message ?? obj?.message ?? "stream error";
  }
}

export interface SseImageResult {
  b64: string | null;
  error: string | null;
}

/** Parse a full SSE blob and return the image (or the failure message). Used by tests. */
export function parseSseForImage(fullText: string): SseImageResult {
  const state = newSseState();
  for (const line of fullText.split("\n")) feedSseLine(state, line);
  return { b64: state.b64 ?? state.lastPartial, error: state.error };
}

// ---- Generation ------------------------------------------------------------

export interface GenerateOptions {
  prompt: string;
  size?: string; // "auto" | "1024x1024" | ...
  format?: ImageFormat;
  background?: ImageBackground; // "transparent" for an alpha channel (PNG/WebP)
  inputImages?: InputImage[]; // present ⇒ edit/reference-guided generation
  model?: string;
  timeoutMs?: number; // total wall-clock budget
  stallMs?: number; // max silence between stream chunks
}
export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
  format: ImageFormat;
}

type StreamOutcome =
  | { kind: "ok"; b64: string }
  | { kind: "unauthorized"; message: string }
  | { kind: "error"; message: string };

async function streamOnce(
  tokens: CodexTokens,
  payload: unknown,
  timeoutMs: number,
  stallMs: number,
): Promise<StreamOutcome> {
  const controller = new AbortController();
  const abort = (why: string) => controller.abort(new Error(why));
  const total = setTimeout(() => abort("total timeout"), timeoutMs);
  let stall = setTimeout(() => abort("stall timeout"), stallMs);
  const resetStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => abort("stall timeout"), stallMs);
  };
  try {
    const res = await fetch(RESPONSES_URL, {
      method: "POST",
      headers: requestHeaders(tokens),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      return { kind: "unauthorized", message: `Unauthorized (${res.status}). ${body.slice(0, 200)}` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { kind: "error", message: `ChatGPT responses endpoint returned ${res.status}. ${body.slice(0, 300)}` };
    }
    if (!res.body) return { kind: "error", message: "Empty response body from ChatGPT." };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const state = newSseState();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        feedSseLine(state, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      // The full image arrives in one event; once we have it, stop reading.
      if (state.b64) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (buf) feedSseLine(state, buf);

    if (!state.b64) {
      if (state.lastPartial) return { kind: "ok", b64: state.lastPartial };
      return { kind: "error", message: state.error ? `Image generation failed: ${state.error}` : "The stream ended without returning an image." };
    }
    return { kind: "ok", b64: state.b64 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (controller.signal.aborted) return { kind: "error", message: `Timed out waiting for ChatGPT (${msg}).` };
    return { kind: "error", message: `Request to ChatGPT failed: ${msg}` };
  } finally {
    clearTimeout(total);
    clearTimeout(stall);
  }
}

/** Generate one image. Throws CodexAuthMissingError if not logged in; Error on any failure. */
export async function generateImage(opts: GenerateOptions): Promise<GeneratedImage> {
  const format = opts.format ?? "png";
  const size = opts.size ?? "auto";
  const model = opts.model ?? "gpt-5.5";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const stallMs = opts.stallMs ?? 120_000;
  const payload = buildPayload({ prompt: opts.prompt, size, format, model, background: opts.background, inputImages: opts.inputImages });

  let auth = await readCodexAuth();
  auth = await ensureFreshToken(auth);

  for (let attempt = 1; ; attempt++) {
    const outcome = await streamOnce(auth.tokens!, payload, timeoutMs, stallMs);
    if (outcome.kind === "ok") {
      return { buffer: Buffer.from(outcome.b64, "base64"), mimeType: mimeForFormat(format), format };
    }
    if (outcome.kind === "unauthorized" && attempt === 1) {
      auth = await ensureFreshToken(auth, true); // force a refresh, then retry once
      continue;
    }
    throw new Error(outcome.message);
  }
}

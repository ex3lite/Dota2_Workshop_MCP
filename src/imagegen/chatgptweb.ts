// ChatGPT WEB image generation — drives the real chatgpt.com web pipeline via the user's browser
// session cookies (no OpenAI API key, no Codex). This is the ONLY no-key path that yields NATIVE
// transparency (true alpha PNG) and the full web image tool. PRIMARY image path; the Codex responses
// path (src/imagegen/chatgpt.ts) is the fallback when this is unavailable.
//
// Flow (all verified live): cookies → accessToken → antibot (sentinel PoW; Turnstile is not enforced
// for a logged-in session) → POST /conversation (NORMAL chat — temporary chats disable the image
// tool) → poll until the turn FINISHES (image streams blurry→sharp; we must wait for the final) →
// download → if a transparent image came back opaque, ask the chat to "remove the background" (the
// web tool does this natively) → file the conversation into the "Automatic Image Generate" project.
// Cookies live in ~/.dota2-workshop-mcp/chatgpt_cookies.txt (Netscape export); a live secret — never log.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const COOKIE_FILE = join(homedir(), ".dota2-workshop-mcp", "chatgpt_cookies.txt");
const PROJECT_NAME = "Automatic Image Generate";
const PROJECT_INSTRUCTIONS = "Automated image generation for the Dota 2 addon via the dota2-workshop-mcp image_generate tool. Conversations here are created programmatically.";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const ORIGIN = "https://chatgpt.com";
const PHASE_TIMEOUT = 120_000; // per generate/edit turn

/** Thrown when the web path can't be used (no/expired cookies, blocked) — signals the caller to fall back to Codex. */
export class WebUnavailableError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  cookie: string;
  deviceId: string;
  accessToken: string;
}

export function webCookiesPresent(): Promise<boolean> {
  return readFile(COOKIE_FILE, "utf8").then(
    (s) => s.includes("__Secure-next-auth.session-token"),
    () => false,
  );
}

async function loadCookies(): Promise<{ cookie: string; deviceId: string }> {
  let raw: string;
  try {
    raw = await readFile(COOKIE_FILE, "utf8");
  } catch {
    throw new WebUnavailableError(`no ChatGPT cookies at ${COOKIE_FILE} (export them with a Cookie-Editor extension)`);
  }
  const pairs: string[] = [];
  let deviceId = "";
  for (let line of raw.split(/\r?\n/)) {
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#") || !line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    pairs.push(`${f[5]}=${f[6]}`);
    if (f[5] === "oai-did") deviceId = f[6];
  }
  if (!pairs.length) throw new WebUnavailableError("cookie file is empty or not in Netscape format");
  return { cookie: pairs.join("; "), deviceId };
}

function baseHeaders(cookie: string): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: ORIGIN + "/",
    Origin: ORIGIN,
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not?A_Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    Cookie: cookie,
  };
}

async function openSession(): Promise<Session> {
  const { cookie, deviceId } = await loadCookies();
  let res: Response;
  try {
    res = await fetch(`${ORIGIN}/api/auth/session`, { headers: baseHeaders(cookie) });
  } catch (e) {
    throw new WebUnavailableError(`session request failed: ${e instanceof Error ? e.message : e}`);
  }
  const j = (await res.json().catch(() => ({}))) as { accessToken?: string };
  if (!j.accessToken) throw new WebUnavailableError("cookies expired or invalid — re-export ChatGPT cookies");
  return { cookie, deviceId, accessToken: j.accessToken };
}

function authHeaders(s: Session, extra: Record<string, string> = {}): Record<string, string> {
  return { ...baseHeaders(s.cookie), Authorization: `Bearer ${s.accessToken}`, "oai-device-id": s.deviceId, ...extra };
}

// The server only verifies SHA3-512(seed + base) meets the difficulty prefix — config contents are
// cosmetic — so a simple counter sweep solves it (≈tens of iterations).
function solveProofOfWork(seed: string, difficulty: string): string {
  const config = [2400, new Date().toUTCString(), 4294705152, 0, UA, "", "", "en-US", "en-US,en", 0, "_reactListening", "location", 0];
  for (let i = 0; i < 500000; i++) {
    config[3] = i;
    const base = Buffer.from(JSON.stringify(config)).toString("base64");
    if (createHash("sha3-512").update(seed + base).digest("hex").slice(0, difficulty.length) <= difficulty) {
      return "gAAAAAB" + base;
    }
  }
  return "gAAAAAB" + Buffer.from(JSON.stringify(config)).toString("base64");
}

async function getSentinel(s: Session): Promise<{ token: string; proof: string }> {
  const res = await fetch(`${ORIGIN}/backend-api/sentinel/chat-requirements`, {
    method: "POST",
    headers: authHeaders(s, { "Content-Type": "application/json" }),
    body: JSON.stringify({ p: "" }),
  });
  if (!res.ok) throw new WebUnavailableError(`sentinel ${res.status}`);
  const j = (await res.json()) as { token: string; proofofwork: { seed: string; difficulty: string } };
  return { token: j.token, proof: solveProofOfWork(j.proofofwork.seed, j.proofofwork.difficulty) };
}

/** Find the "Automatic Image Generate" project, creating it if missing. Returns its gizmo id or null. */
async function ensureProject(s: Session): Promise<string | null> {
  try {
    const side = (await (await fetch(`${ORIGIN}/backend-api/gizmos/snorlax/sidebar`, { headers: authHeaders(s) })).json()) as {
      items?: Array<{ gizmo?: { id?: string; display?: { name?: string } } }>;
    };
    const hit = (side.items ?? []).find((it) => it.gizmo?.display?.name === PROJECT_NAME);
    if (hit?.gizmo?.id) return hit.gizmo.id;
    const res = await fetch(`${ORIGIN}/backend-api/projects`, {
      method: "POST",
      headers: authHeaders(s, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: PROJECT_NAME, instructions: PROJECT_INSTRUCTIONS }),
    });
    const j = (await res.json().catch(() => ({}))) as any;
    return j?.resource?.gizmo?.id ?? j?.gizmo?.id ?? j?.id ?? null;
  } catch {
    return null; // project filing is best-effort; never block generation on it
  }
}

// gizmo_id in the POST does NOT stick — file the conversation in afterwards via PATCH, and verify.
async function fileIntoProject(s: Session, convId: string, projectId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await fetch(`${ORIGIN}/backend-api/conversation/${convId}`, {
      method: "PATCH",
      headers: authHeaders(s, { "Content-Type": "application/json" }),
      body: JSON.stringify({ gizmo_id: projectId }),
    }).catch(() => {});
    const detail = await (await fetch(`${ORIGIN}/backend-api/conversation/${convId}`, { headers: authHeaders(s) })).text().catch(() => "");
    if (detail.includes(`"gizmo_id": "${projectId}"`) || detail.includes(`"gizmo_id":"${projectId}"`)) return true;
    await sleep(800);
  }
  return false;
}

interface SendResult {
  conversationId: string;
}

// Upload an image so it can be attached to a conversation (for editing). The bytes go to OpenAI's
// blob storage via a signed URL — that host occasionally connect-times-out, so retry the PUT.
async function uploadImage(s: Session, bytes: Buffer, name: string): Promise<{ fileId: string; width: number; height: number; size: number }> {
  const reg = (await (await fetch(`${ORIGIN}/backend-api/files`, {
    method: "POST",
    headers: authHeaders(s, { "Content-Type": "application/json" }),
    body: JSON.stringify({ file_name: name, file_size: bytes.length, use_case: "multimodal" }),
  })).json().catch(() => ({}))) as { file_id?: string; upload_url?: string };
  if (!reg.file_id || !reg.upload_url) throw new WebUnavailableError("image file registration failed");
  let ok = false;
  for (let attempt = 0; attempt < 4 && !ok; attempt++) {
    try {
      const put = await fetch(reg.upload_url, { method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "image/png", "x-ms-version": "2020-04-08" }, body: new Uint8Array(bytes) });
      ok = put.ok;
    } catch {
      await sleep(1500);
    }
  }
  if (!ok) throw new WebUnavailableError("image upload to storage failed (network)");
  await fetch(`${ORIGIN}/backend-api/files/${reg.file_id}/uploaded`, { method: "POST", headers: authHeaders(s, { "Content-Type": "application/json" }), body: "{}" }).catch(() => {});
  // The caller normalises inputs to PNG, so width/height come straight from the IHDR.
  const width = bytes.length > 24 ? bytes.readUInt32BE(16) : 0;
  const height = bytes.length > 24 ? bytes.readUInt32BE(20) : 0;
  return { fileId: reg.file_id, width, height, size: bytes.length };
}

/** Post a user message. `content` (+ optional attachments) overrides the default text message. */
async function postMessage(s: Session, opts: { text?: string; content?: unknown; attachments?: unknown[]; convId?: string; parentId?: string }): Promise<SendResult> {
  const sentinel = await getSentinel(s);
  const message: Record<string, unknown> = {
    id: randomUUID(),
    author: { role: "user" },
    content: opts.content ?? { content_type: "text", parts: [opts.text ?? ""] },
    create_time: Date.now() / 1000,
  };
  if (opts.attachments?.length) message.metadata = { attachments: opts.attachments };
  const body: Record<string, unknown> = {
    action: "next",
    messages: [message],
    parent_message_id: opts.parentId ?? randomUUID(),
    model: "auto",
    timezone_offset_min: -180,
    history_and_training_disabled: false, // CRITICAL: temporary chats disable the image tool
    conversation_mode: { kind: "primary_assistant" },
  };
  if (opts.convId) body.conversation_id = opts.convId;
  const res = await fetch(`${ORIGIN}/backend-api/conversation`, {
    method: "POST",
    headers: authHeaders(s, {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Openai-Sentinel-Chat-Requirements-Token": sentinel.token,
      "Openai-Sentinel-Proof-Token": sentinel.proof,
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new WebUnavailableError(`conversation ${res.status}`);
  let stream = "";
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stream += dec.decode(value, { stream: true });
    }
  }
  const convId = opts.convId ?? (stream.match(/"conversation_id":\s*"([^"]+)"/) || [])[1];
  if (!convId) throw new Error("web conversation did not return a conversation id");
  return { conversationId: convId };
}

interface PollResult {
  fileId: string;
  lastMessageId: string;
}

// Image streams blurry→sharp; the FINAL image lives in a message whose status is
// "finished_successfully" (the image is authored by the dalle TOOL, so we do NOT filter on author
// role). Take the latest such asset pointer; previews sit in still-"in_progress" messages and are
// ignored. Returns the conversation's current node as the parent for any follow-up.
async function pollForImage(s: Session, convId: string, timeoutMs: number, excludeIds: Set<string> = new Set()): Promise<PollResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(4000);
    let conv: any;
    try {
      conv = await (await fetch(`${ORIGIN}/backend-api/conversation/${convId}`, { headers: authHeaders(s) })).json();
    } catch {
      continue;
    }
    const mapping = conv?.mapping ?? {};
    let best: { fileId: string; t: number } | null = null;
    for (const k of Object.keys(mapping)) {
      const msg = mapping[k]?.message;
      if (!msg || msg.status !== "finished_successfully") continue;
      for (const part of msg.content?.parts ?? []) {
        if (part && typeof part === "object" && part.content_type === "image_asset_pointer" && typeof part.asset_pointer === "string") {
          const m = part.asset_pointer.match(/(file[-_][A-Za-z0-9]+)/);
          const t = msg.create_time ?? 0;
          if (m && !excludeIds.has(m[1]) && (!best || t >= best.t)) best = { fileId: m[1], t }; // skip the uploaded INPUT image
        }
      }
    }
    if (best) return { fileId: best.fileId, lastMessageId: conv.current_node };
  }
  return null;
}

async function downloadImage(s: Session, fileId: string): Promise<Buffer> {
  const meta = (await (await fetch(`${ORIGIN}/backend-api/files/${fileId}/download`, { headers: authHeaders(s) })).json().catch(() => ({}))) as { download_url?: string };
  if (!meta.download_url) throw new Error("no download_url for image asset");
  const img = Buffer.from(await (await fetch(meta.download_url, { headers: authHeaders(s) })).arrayBuffer());
  if (img[0] !== 0x89 || img[1] !== 0x50) throw new Error("downloaded asset is not a PNG");
  return img;
}

// PNG colour type lives at byte 25; 6 = RGBA, 4 = grey+alpha. Anything else has no alpha channel.
function hasAlphaChannel(png: Buffer): boolean {
  return png.length > 25 && (png[25] === 6 || png[25] === 4);
}

export interface WebGenerateOptions {
  prompt: string;
  transparent?: boolean; // OPT-IN; default keeps the natural (opaque) output / the input's format on edits
  inputImages?: Array<{ data: Buffer; name: string }>; // present ⇒ edit the uploaded image(s)
  timeoutMs?: number;
}
export interface WebGenerateResult {
  png: Buffer;
  conversationId: string;
  project: string | null;
  filedIntoProject: boolean;
  backgroundRemoved: boolean;
  edited: boolean;
}

/** Generate an image via the ChatGPT web pipeline. Throws WebUnavailableError to trigger a Codex fallback. */
export async function generateImageWeb(opts: WebGenerateOptions): Promise<WebGenerateResult> {
  const s = await openSession();
  const projectId = await ensureProject(s);
  const phase = opts.timeoutMs ?? PHASE_TIMEOUT;

  const editing = !!opts.inputImages?.length;
  // Transparency is OPT-IN. Only ask for it when explicitly requested — otherwise keep the natural
  // (opaque) output, and on an edit keep the source's format/context.
  const prompt = opts.transparent
    ? `${opts.prompt}\n\nMake the background fully transparent (alpha PNG) — no backdrop, no solid fill behind the subject.`
    : opts.prompt;

  // Build the message: a plain prompt, or a multimodal message with uploaded input image(s) to edit.
  const exclude = new Set<string>();
  let postOpts: { text?: string; content?: unknown; attachments?: unknown[] };
  if (editing) {
    const pointers: unknown[] = [];
    const attachments: unknown[] = [];
    for (const im of opts.inputImages!) {
      const up = await uploadImage(s, im.data, im.name);
      exclude.add(up.fileId); // never return the uploaded INPUT as the result
      pointers.push({ content_type: "image_asset_pointer", asset_pointer: "file-service://" + up.fileId, size_bytes: up.size, width: up.width, height: up.height });
      attachments.push({ id: up.fileId, name: im.name, mimeType: "image/png", width: up.width, height: up.height, size: up.size });
    }
    postOpts = { content: { content_type: "multimodal_text", parts: [...pointers, prompt] }, attachments };
  } else {
    postOpts = { text: prompt };
  }

  const { conversationId } = await postMessage(s, postOpts);
  // File into the project IMMEDIATELY — so a slow/failed generation never orphans the conversation
  // in the global chat list. We re-assert it at the end in case completion resets the field.
  let filed = projectId ? await fileIntoProject(s, conversationId, projectId) : false;

  let poll = await pollForImage(s, conversationId, phase, exclude);
  if (!poll) throw new Error("web image did not finish in time (the model may have replied with text instead)");
  let png = await downloadImage(s, poll.fileId);

  // Safety net: ONLY when transparency was requested but the result has no alpha — ask the chat to
  // remove the background (the web tool does this natively) and take the new result.
  let backgroundRemoved = false;
  if (opts.transparent && !hasAlphaChannel(png)) {
    exclude.add(poll.fileId);
    await postMessage(s, { convId: conversationId, parentId: poll.lastMessageId, text: "Remove the background entirely and return the exact same image with a fully transparent background (alpha PNG). Keep the subject identical." });
    const poll2 = await pollForImage(s, conversationId, phase, exclude);
    if (poll2) {
      const png2 = await downloadImage(s, poll2.fileId);
      if (hasAlphaChannel(png2)) {
        png = png2;
        backgroundRemoved = true;
      }
    }
  }

  if (projectId && !filed) filed = await fileIntoProject(s, conversationId, projectId);
  return { png, conversationId, project: projectId, filedIntoProject: filed, backgroundRemoved, edited: editing };
}

// Higher-level operations on an addon's KV files (npc_*_custom.txt and the
// localization file). Used by both the KV tools and the scaffolders.

import { join } from "node:path";
import {
  parseKV,
  serializeKV,
  KVDocument,
  KVBlock,
  newBlock,
  getWrapperBlock,
  upsertPair,
  removePair,
  findPair,
  isBlock,
} from "../kv/index.js";
import { readTextFile, writeTextFile, pathExists } from "../util/fsx.js";
import { AddonProject, NPC_FILES, NPC_WRAPPER, NpcFileKey } from "./project.js";

export function npcFilePath(project: AddonProject, key: NpcFileKey): string {
  return join(project.npcDir, NPC_FILES[key]);
}

export interface LoadedKV {
  path: string;
  doc: KVDocument;
  existed: boolean;
}

/** Read & parse an npc file; if missing, return an empty document with the wrapper. */
export async function loadNpcFile(project: AddonProject, key: NpcFileKey): Promise<LoadedKV> {
  const path = npcFilePath(project, key);
  if (await pathExists(path)) {
    const { text } = await readTextFile(path);
    return { path, doc: parseKV(text), existed: true };
  }
  const doc: KVDocument = {
    kind: "document",
    nodes: [
      { kind: "pair", key: NPC_WRAPPER[key], value: newBlock([{ kind: "pair", key: "Version", value: "1" }]) },
    ],
  };
  return { path, doc, existed: false };
}

/** Ensure the wrapper block exists with the right key and return it. */
export function ensureWrapper(doc: KVDocument, key: NpcFileKey): KVBlock {
  let wrapper = getWrapperBlock(doc);
  if (!wrapper) {
    wrapper = newBlock();
    doc.nodes.push({ kind: "pair", key: NPC_WRAPPER[key], value: wrapper });
  }
  return wrapper;
}

export async function writeNpcEntry(
  project: AddonProject,
  key: NpcFileKey,
  entityKey: string,
  block: KVBlock,
): Promise<{ path: string; action: "inserted" | "updated" }> {
  const { path, doc } = await loadNpcFile(project, key);
  const wrapper = ensureWrapper(doc, key);
  const action = upsertPair(wrapper, entityKey, block);
  await writeTextFile(path, serializeKV(doc), { encoding: "utf8" });
  return { path, action };
}

export async function removeNpcEntry(
  project: AddonProject,
  key: NpcFileKey,
  entityKey: string,
): Promise<{ path: string; removed: number }> {
  const { path, doc, existed } = await loadNpcFile(project, key);
  if (!existed) return { path, removed: 0 };
  const wrapper = getWrapperBlock(doc);
  if (!wrapper) return { path, removed: 0 };
  const removed = removePair(wrapper, entityKey);
  if (removed > 0) await writeTextFile(path, serializeKV(doc), { encoding: "utf8" });
  return { path, removed };
}

/** Upsert localization tokens into resource/addon_english.txt (UTF-16 LE, BOM). */
export async function addLocalizationTokens(
  project: AddonProject,
  tokens: Record<string, string>,
): Promise<{ path: string; added: string[]; updated: string[] }> {
  const path = project.localizationFile;
  let doc: KVDocument;
  let encoding: "utf8" | "utf16le" = "utf16le";
  let hadBom = true;

  if (await pathExists(path)) {
    const r = await readTextFile(path);
    doc = parseKV(r.text);
    encoding = r.encoding;
    hadBom = r.hadBom;
  } else {
    doc = {
      kind: "document",
      nodes: [
        {
          kind: "pair",
          key: "lang",
          value: newBlock([
            { kind: "pair", key: "Language", value: "English" },
            { kind: "pair", key: "Tokens", value: newBlock() },
          ]),
        },
      ],
    };
  }

  // Navigate lang -> Tokens.
  const langPair = doc.nodes.find((n) => n.kind === "pair" && (n as any).key.toLowerCase() === "lang");
  let langBlock: KVBlock;
  if (langPair && isBlock((langPair as any).value)) {
    langBlock = (langPair as any).value;
  } else {
    langBlock = newBlock([{ kind: "pair", key: "Language", value: "English" }]);
    doc.nodes.push({ kind: "pair", key: "lang", value: langBlock });
  }
  let tokensPair = findPair(langBlock, "Tokens");
  let tokensBlock: KVBlock;
  if (tokensPair && isBlock(tokensPair.value)) {
    tokensBlock = tokensPair.value;
  } else {
    tokensBlock = newBlock();
    upsertPair(langBlock, "Tokens", tokensBlock);
  }

  const added: string[] = [];
  const updated: string[] = [];
  for (const [k, v] of Object.entries(tokens)) {
    const action = upsertPair(tokensBlock, k, v);
    (action === "inserted" ? added : updated).push(k);
  }

  await writeTextFile(path, serializeKV(doc), { encoding, bom: hadBom || encoding === "utf16le" });
  return { path, added, updated };
}

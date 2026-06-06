// File helpers with byte-order-mark / encoding awareness. Dota localization files
// (resource/addon_*.txt) are UTF-16 LE with a BOM; the NPC script files are UTF-8.
// We detect on read and round-trip the same encoding on write.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

export type TextEncoding = "utf8" | "utf16le";

export interface ReadResult {
  text: string;
  encoding: TextEncoding;
  hadBom: boolean;
}

export async function readTextFile(path: string): Promise<ReadResult> {
  const buf = await readFile(path);
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString("utf16le"), encoding: "utf16le", hadBom: true };
  }
  // UTF-16 BE BOM -> swap to LE for decoding
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return { text: swapped.toString("utf16le"), encoding: "utf16le", hadBom: true };
  }
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf8", hadBom: true };
  }
  return { text: buf.toString("utf8"), encoding: "utf8", hadBom: false };
}

export async function writeTextFile(
  path: string,
  text: string,
  opts: { encoding?: TextEncoding; bom?: boolean } = {},
): Promise<void> {
  const encoding = opts.encoding ?? "utf8";
  const bom = opts.bom ?? false;
  await mkdir(dirname(path), { recursive: true });

  if (encoding === "utf16le") {
    const body = Buffer.from(text, "utf16le");
    const out = bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
    await writeFile(path, out);
  } else {
    const body = Buffer.from(text, "utf8");
    const out = bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
    await writeFile(path, out);
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

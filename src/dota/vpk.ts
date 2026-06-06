// Minimal reader for Valve VPK archives (v1/v2). Lets the MCP read base-game files
// (e.g. scripts/npc/npc_heroes.txt) straight out of pak01_dir.vpk without extraction.

import { readFile, open as openFile } from "node:fs/promises";

export interface VpkEntry {
  crc: number;
  archiveIndex: number;
  offset: number;
  length: number;
  preload: Buffer;
}

export class Vpk {
  private constructor(
    private readonly dirPath: string,
    private readonly dirBuf: Buffer,
    private readonly dataSectionStart: number,
    readonly entries: Map<string, VpkEntry>,
  ) {}

  static async open(dirVpkPath: string): Promise<Vpk> {
    const buf = await readFile(dirVpkPath);
    if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error(`Not a VPK file: ${dirVpkPath}`);
    const version = buf.readUInt32LE(4);
    const treeSize = buf.readUInt32LE(8);
    const headerSize = version >= 2 ? 28 : 12;
    let p = headerSize;

    const readStr = (): string => {
      let s = "";
      while (p < buf.length && buf[p] !== 0) {
        s += String.fromCharCode(buf[p]);
        p++;
      }
      p++; // skip NUL
      return s;
    };

    const entries = new Map<string, VpkEntry>();
    while (true) {
      const ext = readStr();
      if (ext === "") break;
      while (true) {
        const dir = readStr();
        if (dir === "") break;
        while (true) {
          const name = readStr();
          if (name === "") break;
          const crc = buf.readUInt32LE(p);
          p += 4;
          const preloadBytes = buf.readUInt16LE(p);
          p += 2;
          const archiveIndex = buf.readUInt16LE(p);
          p += 2;
          const offset = buf.readUInt32LE(p);
          p += 4;
          const length = buf.readUInt32LE(p);
          p += 4;
          p += 2; // 0xffff terminator
          const preload = Buffer.from(buf.subarray(p, p + preloadBytes));
          p += preloadBytes;
          const ePart = ext === " " ? "" : "." + ext;
          const dPart = dir === " " || dir === "" ? "" : dir + "/";
          entries.set((dPart + name + ePart).toLowerCase(), { crc, archiveIndex, offset, length, preload });
        }
      }
    }
    return new Vpk(dirVpkPath, buf, headerSize + treeSize, entries);
  }

  list(filter?: string): string[] {
    const f = filter?.toLowerCase();
    const all = [...this.entries.keys()];
    return (f ? all.filter((k) => k.includes(f)) : all).sort();
  }

  async read(path: string): Promise<Buffer> {
    const e = this.entries.get(path.toLowerCase());
    if (!e) throw new Error(`Not found in VPK: ${path}`);
    let data: Buffer = Buffer.alloc(0);
    if (e.length > 0) {
      if (e.archiveIndex === 0x7fff) {
        data = this.dirBuf.subarray(this.dataSectionStart + e.offset, this.dataSectionStart + e.offset + e.length);
      } else {
        const archivePath = this.dirPath.replace(/_dir\.vpk$/i, `_${String(e.archiveIndex).padStart(3, "0")}.vpk`);
        const fh = await openFile(archivePath, "r");
        try {
          const out = Buffer.alloc(e.length);
          await fh.read(out, 0, e.length, e.offset);
          data = out;
        } finally {
          await fh.close();
        }
      }
    }
    return Buffer.concat([e.preload, data]);
  }

  async readText(path: string): Promise<string> {
    return (await this.read(path)).toString("utf8");
  }
}

let cached: { path: string; vpk: Vpk } | undefined;

/** Open (and cache) the main Dota content VPK. */
export async function openDotaVpk(pak01DirPath: string): Promise<Vpk> {
  if (cached && cached.path === pak01DirPath) return cached.vpk;
  const vpk = await Vpk.open(pak01DirPath);
  cached = { path: pak01DirPath, vpk };
  return vpk;
}

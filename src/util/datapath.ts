// Resolve a bundled data file/dir that ships under src/data (works in dev via tsx
// from src, and in prod from dist, since src/data is included in the package).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathExists } from "./fsx.js";

export async function resolveDataPath(relative: string): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (await pathExists(join(dir, "package.json"))) {
      for (const base of ["src/data", "dist/data", "data"]) {
        const candidate = join(dir, ...base.split("/"), ...relative.split("/"));
        if (await pathExists(candidate)) return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Bundled data not found: ${relative}. Run the data build scripts (npm run build:data).`);
}

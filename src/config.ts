// Resolves which addon project a tool call operates on.
//
// Priority: explicit `projectRoot` tool argument > DOTA2_ADDON_DIR env var.
// (We deliberately do NOT default to process.cwd(): an MCP server's cwd is set by
//  the client and is unreliable, so we require an explicit source of truth.)

import { AddonProject, detectProject } from "./dota/project.js";
import { isDirectory } from "./util/fsx.js";

export function configuredAddonDir(): string | undefined {
  return process.env.DOTA2_ADDON_DIR;
}

export async function resolveProject(projectRoot?: string): Promise<AddonProject> {
  const root = projectRoot ?? configuredAddonDir();
  if (!root) {
    throw new Error(
      "No addon project specified. Pass `projectRoot` to this tool, or set the DOTA2_ADDON_DIR " +
        "environment variable to your addon's root folder (the one containing package.json / game / content).",
    );
  }
  if (!(await isDirectory(root))) {
    throw new Error(`Addon project directory does not exist: ${root}`);
  }
  return detectProject(root);
}

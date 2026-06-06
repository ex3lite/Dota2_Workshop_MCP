// Shared builder for Dota 2 launch arguments, used by the launch + restart tools.

export interface LaunchOpts {
  addon: string;
  map?: string;
  tools?: boolean; // -tools (default true; required for Workshop Tools + VConsole)
  console?: boolean; // -console (default true)
  insecure?: boolean; // -insecure
  dev?: boolean; // -dev -uidev (developer/UI dev mode)
  vconPort?: number; // -vconport <port> (pins the VConsole listener port)
  cheats?: boolean; // +sv_cheats 1 +developer 1 (default true when a map is launched)
}

export function buildLaunchArgs(o: LaunchOpts): string[] {
  const args = ["-novid"];
  if (o.tools !== false) args.push("-tools");
  args.push("-addon", o.addon);
  if (o.console !== false) args.push("-console");
  if (o.insecure) args.push("-insecure");
  if (o.dev) args.push("-dev", "-uidev");
  if (o.vconPort) args.push("-vconport", String(o.vconPort));
  if (o.map) {
    if (o.cheats !== false) args.push("+sv_cheats", "1", "+developer", "1");
    args.push("+dota_launch_custom_game", o.addon, o.map);
  }
  return args;
}

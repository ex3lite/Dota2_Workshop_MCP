// Search Dota 2 custom games by name via the public Steam Workshop. This mirrors the
// client's SteamUGC.CreateQueryAllUGCRequest + SendUGCQuery, but over the keyless web
// backend: scrape published-file ids from the community browse, then resolve titles +
// stats via ISteamRemoteStorage/GetPublishedFileDetails.

const APP_ID = "570";

export interface WorkshopHit {
  id: string;
  title: string;
  subscriptions?: number;
  fileSizeMB?: number;
}

export async function searchWorkshop(query: string, limit = 12): Promise<WorkshopHit[]> {
  const browse =
    "https://steamcommunity.com/workshop/browse/?appid=" + APP_ID +
    "&searchtext=" + encodeURIComponent(query) +
    "&browsesort=textsearch&section=readytouseitems&actualsort=textsearch&p=1";
  const html = await (await fetch(browse, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
  const ids = [...new Set([...html.matchAll(/filedetails\/\?id=(\d+)/g)].map((m) => m[1]))].slice(0, Math.min(limit, 30));
  if (!ids.length) return [];

  const form = new URLSearchParams();
  form.set("itemcount", String(ids.length));
  ids.forEach((id, i) => form.set("publishedfileids[" + i + "]", id));
  const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  const details: any[] = data?.response?.publishedfiledetails ?? [];
  const byId = new Map(details.map((d) => [String(d.publishedfileid), d]));

  return ids.map((id) => {
    const d = byId.get(id) ?? {};
    const size = Number(d.file_size);
    return {
      id,
      title: d.title || "(unknown)",
      subscriptions: d.subscriptions ?? d.lifetime_subscriptions,
      fileSizeMB: Number.isFinite(size) && size > 0 ? Math.round(size / 1048576) : undefined,
    };
  });
}

/** Resolve details for explicit ids (no search). */
export async function workshopDetails(ids: string[]): Promise<WorkshopHit[]> {
  if (!ids.length) return [];
  const form = new URLSearchParams();
  form.set("itemcount", String(ids.length));
  ids.forEach((id, i) => form.set("publishedfileids[" + i + "]", id));
  const res = await fetch("https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const data: any = await res.json().catch(() => ({}));
  const details: any[] = data?.response?.publishedfiledetails ?? [];
  return details.map((d) => {
    const size = Number(d.file_size);
    return { id: String(d.publishedfileid), title: d.title || "(unknown)", subscriptions: d.subscriptions, fileSizeMB: Number.isFinite(size) && size > 0 ? Math.round(size / 1048576) : undefined };
  });
}

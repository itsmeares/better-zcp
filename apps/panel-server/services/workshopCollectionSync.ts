
import { createLogger } from '../utils/logger.ts';
import { getSetting } from '../database/init.ts';

const log = createLogger('WorkshopCollectionSync');

const STEAM_API = 'https://api.steampowered.com';
const USER_AGENT = 'ZomboidControlPanel/1.0 (+collection-sync)';
const FETCH_TIMEOUT_MS = 15000;

interface WorkshopChild {
  filetype?: string | number;
  publishedfileid?: string | number;
}

interface CollectionDetail {
  result?: string | number;
  children?: WorkshopChild[];
  title?: string;
}

interface CollectionResponse {
  response?: { collectiondetails?: CollectionDetail[] };
}

interface PublishedFileDetail {
  publishedfileid?: string | number;
  title?: string;
}

interface PublishedFilesResponse {
  response?: { publishedfiledetails?: PublishedFileDetail[] };
}

type CollectionResult =
  | { ok: true; items: string[]; title: string | null }
  | { ok: false; items: string[]; error: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fetchWithTimeout(
  url: string,
  opts: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function isValidWorkshopId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{1,15}$/.test(id);
}

export async function getCollectionContents(
  collectionId: unknown,
): Promise<CollectionResult> {
  if (!isValidWorkshopId(collectionId)) {
    return { ok: false, items: [], error: 'Invalid collection ID' };
  }
  try {
    const body = new URLSearchParams();
    body.set('collectioncount', '1');
    body.set('publishedfileids[0]', collectionId);
    const res = await fetchWithTimeout(`${STEAM_API}/ISteamRemoteStorage/GetCollectionDetails/v1/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      return { ok: false, items: [], error: `Steam API HTTP ${res.status}` };
    }
    const json = (await res.json()) as CollectionResponse;
    const detail = json?.response?.collectiondetails?.[0];
    if (!detail) {
      return { ok: false, items: [], error: 'Empty Steam response' };
    }
    if (Number(detail.result) !== 1) {
      return { ok: false, items: [], error: `Steam result code ${detail.result}` };
    }
    const items = Array.isArray(detail.children)
      ? detail.children
          .filter((c) => Number(c.filetype) !== 2)
          .map((c) => String(c.publishedfileid))
      : [];
    return { ok: true, items, title: detail.title || null };
  } catch (err) {
    return { ok: false, items: [], error: errorMessage(err) || 'Network error' };
  }
}

export async function fetchPublishedFileTitles(
  workshopIds: unknown,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (Array.isArray(workshopIds) ? workshopIds : [])
    .map(String)
    .filter(isValidWorkshopId);
  if (ids.length === 0) return out;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    try {
      const body = new URLSearchParams();
      body.set('itemcount', String(slice.length));
      slice.forEach((id, idx) => body.set(`publishedfileids[${idx}]`, id));
      const res = await fetchWithTimeout(
        `${STEAM_API}/ISteamRemoteStorage/GetPublishedFileDetails/v1/`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: body.toString(),
        },
      );
      if (!res.ok) continue;
      const json = (await res.json()) as PublishedFilesResponse;
      const list = json?.response?.publishedfiledetails;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const id = item?.publishedfileid ? String(item.publishedfileid) : null;
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (id && title) out.set(id, title);
      }
    } catch (err) {
      log.warn(`fetchPublishedFileTitles chunk failed: ${errorMessage(err)}`);
    }
  }
  return out;
}

export async function computeDiff(
  trackedWorkshopIds: Array<string | number>,
) {
  const collectionId = await getSetting('workshopCollectionId');
  if (!isValidWorkshopId(collectionId)) {
    return { ok: false, error: 'Collection ID not configured', toAdd: [], toRemove: [], inCollection: [] };
  }
  const collection = await getCollectionContents(collectionId);
  if (!collection.ok) {
    return { ok: false, error: collection.error, toAdd: [], toRemove: [], inCollection: [] };
  }
  const trackedSet = new Set(trackedWorkshopIds.map(String));
  const collectionSet = new Set(collection.items);
  const toAdd = [...trackedSet].filter((id) => !collectionSet.has(id));
  const collectionOnly = [...collectionSet].filter((id) => !trackedSet.has(id));
  return {
    ok: true,
    title: collection.title,
    inCollection: [...collectionSet],
    toAdd,
    toRemove: [],
    collectionOnly,
  };
}

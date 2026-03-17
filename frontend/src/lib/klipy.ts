export interface KlipyGif {
  id: string;
  title: string;
  urls: {
    preview: string;
    tinygif: string;
    mediumgif: string;
    gif: string;
  };
}

interface KlipyMediaFormat {
  url: string;
  width: number;
  height: number;
  size: number;
}

interface KlipyMediaSizes {
  gif?: KlipyMediaFormat;
  webp?: KlipyMediaFormat;
  jpg?: KlipyMediaFormat;
  mp4?: KlipyMediaFormat;
  webm?: KlipyMediaFormat;
}

interface KlipyFile {
  hd?: KlipyMediaSizes;
  md?: KlipyMediaSizes;
  sm?: KlipyMediaSizes;
  xs?: KlipyMediaSizes;
}

interface KlipyResponse {
  result: boolean;
  data: {
    data: Array<{
      id: number;
      slug: string;
      title: string;
      file?: KlipyFile;
      blur_preview?: string;
      type: string;
    }>;
    current_page?: number;
    per_page?: number;
    has_next?: boolean;
  };
}

const KLIPY_API_BASE =
  import.meta.env.VITE_API_URL || "https://api.awful.chat/klipy";

function normalizeGif(item: KlipyResponse["data"]["data"][0]): KlipyGif {
  const file = item.file || {};
  const sm = file.sm || file.xs || {};
  const md = file.md || file.sm || {};
  const hd = file.hd || file.md || {};
  return {
    id: String(item.id),
    title: item.title || "",
    urls: {
      preview:
        (sm as KlipyMediaSizes).webp?.url ||
        (sm as KlipyMediaSizes).jpg?.url ||
        (md as KlipyMediaSizes).webp?.url ||
        "",
      tinygif: (sm as KlipyMediaSizes).gif?.url || "",
      mediumgif: (md as KlipyMediaSizes).gif?.url || "",
      gif:
        (hd as KlipyMediaSizes).gif?.url ||
        (md as KlipyMediaSizes).gif?.url ||
        (sm as KlipyMediaSizes).gif?.url ||
        "",
    },
  };
}

export interface KlipyResult {
  gifs: KlipyGif[];
  hasMore: boolean;
}

export async function searchGifs(
  query: string,
  limit = 12,
  page = 1
): Promise<KlipyResult> {
  try {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      page: String(page),
    });
    const res = await fetch(`${KLIPY_API_BASE}/search?${params}`);
    if (!res.ok) return { gifs: [], hasMore: false };
    const data: KlipyResponse = await res.json();
    if (!data.result) return { gifs: [], hasMore: false };
    return {
      gifs: data.data.data
        .map(normalizeGif)
        .filter((g) => g.urls.tinygif || g.urls.mediumgif),
      hasMore: data.data.has_next ?? false,
    };
  } catch {
    return { gifs: [], hasMore: false };
  }
}

export async function getTrendingGifs(
  limit = 12,
  page = 1
): Promise<KlipyResult> {
  try {
    const params = new URLSearchParams({
      limit: String(limit),
      page: String(page),
    });
    const res = await fetch(`${KLIPY_API_BASE}/trending?${params}`);
    if (!res.ok) return { gifs: [], hasMore: false };
    const data: KlipyResponse = await res.json();
    if (!data.result) return { gifs: [], hasMore: false };
    return {
      gifs: data.data.data
        .map(normalizeGif)
        .filter((g) => g.urls.tinygif || g.urls.mediumgif),
      hasMore: data.data.has_next ?? false,
    };
  } catch {
    return { gifs: [], hasMore: false };
  }
}

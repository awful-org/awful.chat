/**
 * AniList metadata lookup, called directly from the browser.
 *
 * AniList's GraphQL endpoint is HTTPS and sends `Access-Control-Allow-Origin: *`
 * on the actual response and the OPTIONS preflight alike, and needs no API
 * key. That combination means CORS is not blocking a direct call the way it
 * blocks most APIs, so this goes straight to `graphql.anilist.co` and never
 * touches `/plugin-proxy` - which is GET-only (`relay/pluginproxy.go`) and
 * could not carry a GraphQL POST body anyway. No PLUGIN_PROXY_HOSTS entry,
 * no secret, no operator configuration: same "Requirements: None" shape the
 * README asks built-in plugins to aim for.
 *
 * Network code lives here, never in `logic.ts`'s `reduce` - the host replays
 * persisted updates on every cold load, and a replayed fetch is a bug.
 */

const ANILIST_ENDPOINT = "https://graphql.anilist.co";

/** AniList's own image CDN. Cover URLs are also peer-supplied (they travel
 *  in the card payload), so `logic.ts` re-checks this same host before
 *  trusting one - this constant is the single place that host is spelled. */
export const ANILIST_COVER_HOST_RE = /^https:\/\/s4\.anilist\.co\//;

const SEARCH_QUERY = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      title {
        romaji
        english
      }
      coverImage {
        medium
      }
      episodes
    }
  }
`;

export interface AniListMatch {
  id: number;
  title: string;
  coverImageUrl: string | null;
  episodeCount: number | null;
}

/**
 * Look up one anime by title. Resolves to `null` on no match, a network
 * error, a non-2xx response, or a malformed body - metadata is a
 * convenience, never a gate, so every failure mode collapses to the same
 * "use the typed title" outcome rather than a distinct error the caller has
 * to handle.
 */
export async function searchAnime(
  title: string,
  opts?: { signal?: AbortSignal }
): Promise<AniListMatch | null> {
  const query = title.trim();
  if (!query) return null;
  try {
    const res = await fetch(ANILIST_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query } }),
      signal: opts?.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const media = json?.data?.Media;
    if (!media || typeof media.id !== "number") return null;
    const cover = media.coverImage?.medium;
    return {
      id: media.id,
      title: media.title?.english || media.title?.romaji || query,
      coverImageUrl:
        typeof cover === "string" && ANILIST_COVER_HOST_RE.test(cover) ? cover : null,
      episodeCount:
        typeof media.episodes === "number" && media.episodes > 0 ? media.episodes : null,
    };
  } catch {
    return null;
  }
}

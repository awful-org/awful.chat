import { isAllowedOrigin, withCors, apiError } from "./cors";

const KLIPY_API_BASE = "https://api.klipy.com/api/v1";
const KLIPY_API_KEY = process.env.KLIPY_API_KEY ?? "";

export async function handleKlipySearch(
  req: Request,
  url: URL,
): Promise<Response> {
  if (!isAllowedOrigin(req.headers.get("origin")))
    return apiError(req, "Origin not allowed", 403);
  if (!KLIPY_API_KEY) return apiError(req, "KLIPY_API_KEY not configured", 503);

  const q = url.searchParams.get("q") ?? "";
  const limit = url.searchParams.get("limit") ?? "18";
  const page = url.searchParams.get("page") ?? "1";

  try {
    const res = await fetch(
      `${KLIPY_API_BASE}/${KLIPY_API_KEY}/gifs/search?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}`,
    );
    if (!res.ok)
      return apiError(req, `Klipy API error: ${res.status}`, res.status);
    return withCors(req, Response.json(await res.json()));
  } catch (e) {
    return apiError(req, `Failed to fetch from Klipy: ${e}`);
  }
}

export async function handleKlipyTrending(
  req: Request,
  url: URL,
): Promise<Response> {
  if (!isAllowedOrigin(req.headers.get("origin")))
    return apiError(req, "Origin not allowed", 403);
  if (!KLIPY_API_KEY) return apiError(req, "KLIPY_API_KEY not configured", 503);

  const limit = url.searchParams.get("limit") ?? "18";
  const page = url.searchParams.get("page") ?? "1";

  try {
    const res = await fetch(
      `${KLIPY_API_BASE}/${KLIPY_API_KEY}/gifs/trending?limit=${limit}&page=${page}`,
    );
    if (!res.ok)
      return apiError(req, `Klipy API error: ${res.status}`, res.status);
    return withCors(req, Response.json(await res.json()));
  } catch (e) {
    return apiError(req, `Failed to fetch from Klipy: ${e}`);
  }
}


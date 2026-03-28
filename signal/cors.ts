const NODE_ENV = process.env.NODE_ENV ?? "development";
const DOMAIN = (process.env.DOMAIN ?? "").trim().toLowerCase();

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (NODE_ENV !== "production") return true;
  if (!DOMAIN) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === DOMAIN;
  } catch {
    return false;
  }
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowOrigin = NODE_ENV === "production" ? `https://${DOMAIN}` : (origin ?? "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function apiError(req: Request, msg: string, status = 500): Response {
  return withCors(
    req,
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}
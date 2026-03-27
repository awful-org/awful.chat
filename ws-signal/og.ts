import type { OgPreview } from "./types";
import { isAllowedOrigin, withCors, apiError } from "./cors";

const OG_REWRITE_RULES: Array<{
  hosts: string[];
  rewrites: Array<(u: URL) => string>;
}> = [
  {
    hosts: ["instagram.com", "www.instagram.com"],
    rewrites: [
      (u) => `https://d.vxinstagram.com${u.pathname}${u.search}`,
      (u) => `https://www.ddinstagram.com${u.pathname}${u.search}`,
    ],
  },
];

function getCandidateUrls(targetUrl: URL): string[] {
  const rule = OG_REWRITE_RULES.find((r) =>
    r.hosts.includes(targetUrl.hostname),
  );
  if (!rule) return [targetUrl.toString()];
  return rule.rewrites.map((fn) => fn(targetUrl));
}

function extractMetaContent(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`,
        "i",
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`,
        "i",
      ),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1].trim().replace(/&amp;/g, "&");
    }
  }
  return undefined;
}

function extractMetaNumber(html: string, keys: string[]): number | undefined {
  const val = extractMetaContent(html, keys);
  if (!val) return undefined;
  const n = parseInt(val, 10);
  return isNaN(n) ? undefined : n;
}

function absolutizeUrl(
  raw: string | undefined,
  base: string,
): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, base).toString();
  } catch {
    return undefined;
  }
}

export async function handleOgPreview(
  req: Request,
  url: URL,
): Promise<Response> {
  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return apiError(req, "Origin not allowed", 403);
  }

  const target = url.searchParams.get("url")?.trim();
  if (!target) return apiError(req, "Missing url parameter", 400);

  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return apiError(req, "Invalid URL", 400);
  }
  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return apiError(req, "Only http/https URLs are supported", 400);
  }

  const candidates = getCandidateUrls(targetUrl);

  let html = "";
  let finalUrl = targetUrl.toString();

  for (const candidate of candidates) {
    try {
      const upstream = await fetch(candidate, {
        redirect: "follow",
        headers: {
          "User-Agent": "TelegramBot (like TwitterBot)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!upstream.ok) continue;
      html = await upstream.text();
      finalUrl = upstream.url || candidate;
      break;
    } catch {
      continue;
    }
  }

  if (!html) return apiError(req, "All OG sources failed", 502);

  const title =
    extractMetaContent(html, ["og:title", "twitter:title"]) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();

  const description = extractMetaContent(html, [
    "og:description",
    "twitter:description",
    "description",
  ]);

  const siteName = extractMetaContent(html, ["og:site_name"]);

  const video = absolutizeUrl(
    extractMetaContent(html, [
      "og:video",
      "og:video:url",
      "og:video:secure_url",
      "twitter:player:stream",
    ]),
    finalUrl,
  );
  const videoWidth = extractMetaNumber(html, [
    "og:video:width",
    "twitter:player:width",
  ]);
  const videoHeight = extractMetaNumber(html, [
    "og:video:height",
    "twitter:player:height",
  ]);

  const videoContentType = extractMetaContent(html, [
    "og:video:type",
    "twitter:player:stream:content_type",
  ]);

  let image = absolutizeUrl(
    extractMetaContent(html, [
      "og:image",
      "twitter:image",
      "twitter:image:src",
    ]),
    finalUrl,
  );
  const imageWidth = extractMetaNumber(html, [
    "og:image:width",
    "twitter:image:width",
  ]);
  const imageHeight = extractMetaNumber(html, [
    "og:image:height",
    "twitter:image:height",
  ]);

  if (!image && video) {
    const posterMatch = html.match(/poster=["']([^"']+)["']/i);
    if (posterMatch?.[1]) image = absolutizeUrl(posterMatch[1], finalUrl);
  }

  const mediaType: OgPreview["mediaType"] = video
    ? "video"
    : image
      ? "image"
      : "none";

  return withCors(
    req,
    Response.json({
      url: finalUrl,
      title,
      description,
      siteName,
      image,
      imageWidth,
      imageHeight,
      video,
      videoWidth,
      videoHeight,
      videoContentType,
      mediaType,
    } satisfies OgPreview),
  );
}


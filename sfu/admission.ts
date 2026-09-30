import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * Who may open a signalling socket, and how many may sit unjoined.
 *
 * The WebSocket accepted any Origin and any number of sockets that never
 * sent their join. The Origin check is what stops a page on some other
 * site from using its visitors' browsers to talk to this SFU; the pending
 * cap is what stops one address from holding thousands of sockets open
 * for the ten seconds each is allowed before joining, over and over.
 */
export interface AdmissionConfig {
  /** Origins accepted, lowercased scheme://host[:port]. */
  allowedOrigins: Set<string>;
  /** Refuse any browser origin not in allowedOrigins. */
  strict: boolean;
  trustedProxies: BlockList;
  maxPendingPerClient: number;
  maxPendingPerProxy: number;
  maxPendingTotal: number;
}

function intFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

/** The private and loopback ranges, where the instance's own proxy lives. */
const PRIVATE_RANGES: Array<[string, number, "ipv4" | "ipv6"]> = [
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

/**
 * Reads the configuration from the environment.
 *
 *  - SFU_ALLOWED_ORIGINS: comma list of origins browsers may connect from.
 *    DOMAIN, the same variable the relay's CORS reads, adds https://DOMAIN.
 *    Either one, or NODE_ENV=production, makes the check strict: a browser
 *    origin outside the list is refused at the upgrade. With none of them
 *    - the local dev stack, where the app runs on http://localhost:5173 -
 *    any origin is accepted, as before. A request with NO Origin is always
 *    let through, as on the relay: only browsers send one, and what bounds
 *    anything else is the pending cap below, not a header it can forge.
 *  - SFU_TRUSTED_PROXY_CIDRS: whose X-Forwarded-For names the client.
 *    Default: loopback and the private ranges. That is right for both ways
 *    this SFU is deployed - behind the frontend's nginx on the compose's
 *    own "internal" network, or behind Caddy on the satellite's "sfu-net" -
 *    because nothing but that proxy can reach this port on either network.
 *  - SFU_MAX_PENDING_PER_IP (8), SFU_MAX_PENDING_PER_PROXY (256),
 *    SFU_MAX_PENDING (1024): sockets not yet joined, per client address
 *    (IPv6 per /64), per trusted proxy that named no client, and in total.
 */
export function loadAdmissionConfig(env: NodeJS.ProcessEnv = process.env): AdmissionConfig {
  const allowedOrigins = new Set<string>();
  for (const raw of (env.SFU_ALLOWED_ORIGINS ?? "").split(",")) {
    const origin = normalizeOrigin(raw.trim());
    if (origin) allowedOrigins.add(origin);
  }
  const domain = env.DOMAIN?.trim().toLowerCase();
  if (domain) allowedOrigins.add(`https://${domain}`);
  const strict =
    allowedOrigins.size > 0 || env.NODE_ENV?.trim().toLowerCase() === "production";

  const trustedProxies = new BlockList();
  const rawProxies = env.SFU_TRUSTED_PROXY_CIDRS?.trim();
  if (!rawProxies) {
    for (const [addr, bits, type] of PRIVATE_RANGES) trustedProxies.addSubnet(addr, bits, type);
  } else {
    for (const entry of rawProxies.split(",")) {
      const e = entry.trim();
      if (!e) continue;
      const [addr, bitsRaw] = e.split("/");
      const type = isIPv4(addr) ? "ipv4" : isIPv6(addr) ? "ipv6" : null;
      if (!type) throw new Error(`SFU_TRUSTED_PROXY_CIDRS: ${e} is not an address or CIDR`);
      const bits = bitsRaw === undefined ? (type === "ipv4" ? 32 : 128) : Number(bitsRaw);
      if (!Number.isInteger(bits) || bits < 0 || bits > (type === "ipv4" ? 32 : 128)) {
        throw new Error(`SFU_TRUSTED_PROXY_CIDRS: bad prefix length in ${e}`);
      }
      trustedProxies.addSubnet(addr, bits, type);
    }
  }

  return {
    allowedOrigins,
    strict,
    trustedProxies,
    maxPendingPerClient: intFrom(env, "SFU_MAX_PENDING_PER_IP", 8),
    maxPendingPerProxy: intFrom(env, "SFU_MAX_PENDING_PER_PROXY", 256),
    maxPendingTotal: intFrom(env, "SFU_MAX_PENDING", 1024),
  };
}

/** scheme://host[:port], lowercased, or null for anything that is not one. */
export function normalizeOrigin(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function originAllowed(cfg: AdmissionConfig, origin: string | undefined): boolean {
  if (!origin) return true;
  if (!cfg.strict) return true;
  const o = normalizeOrigin(origin);
  return o !== null && cfg.allowedOrigins.has(o);
}

function unmap(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1] : addr;
}

function isTrusted(cfg: AdmissionConfig, addr: string): boolean {
  if (isIPv4(addr)) return cfg.trustedProxies.check(addr, "ipv4");
  if (isIPv6(addr)) return cfg.trustedProxies.check(addr, "ipv6");
  return false;
}

/** The /64 an IPv6 address sits in, as a bucket key; IPv4 unchanged. */
export function bucketOf(addr: string): string {
  if (!isIPv6(addr)) return addr;
  const [head, tail = ""] = addr.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = addr.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export interface ClientKey {
  key: string;
  /** True when the key is a trusted proxy that named no client. */
  proxy: boolean;
}

/**
 * The bucket a socket is counted against: its client's address when the
 * socket peer is a trusted proxy that said who that is (the rightmost
 * X-Forwarded-For hop that is not itself trusted - the leftmost ones are
 * whatever the client wrote), the socket peer itself otherwise.
 */
export function clientKey(
  cfg: AdmissionConfig,
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
): ClientKey {
  const remote = unmap(remoteAddress ?? "");
  if (!isTrusted(cfg, remote)) return { key: bucketOf(remote), proxy: false };
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? "";
  const hops = header.split(",").map((h) => unmap(h.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!isIPv4(hop) && !isIPv6(hop)) continue;
    if (isTrusted(cfg, hop)) continue;
    return { key: bucketOf(hop), proxy: false };
  }
  return { key: `proxy:${remote}`, proxy: true };
}

/** Counts sockets that have not joined yet, per bucket and in total. */
export class PendingSockets {
  private perKey = new Map<string, number>();
  private total = 0;
  constructor(private cfg: AdmissionConfig) {}

  /** Takes a slot and returns its release (safe to call more than once),
   *  or null when the bucket or the total is full. */
  tryAcquire(k: ClientKey): (() => void) | null {
    const cap = k.proxy ? this.cfg.maxPendingPerProxy : this.cfg.maxPendingPerClient;
    const held = this.perKey.get(k.key) ?? 0;
    if (held >= cap || this.total >= this.cfg.maxPendingTotal) return null;
    this.perKey.set(k.key, held + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const n = (this.perKey.get(k.key) ?? 1) - 1;
      // Deleted at zero: the key space is client addresses.
      if (n > 0) this.perKey.set(k.key, n);
      else this.perKey.delete(k.key);
    };
  }

  get size(): number {
    return this.total;
  }
}

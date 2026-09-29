import { parseRoomSecret, type RoomSecret } from "./keys";

/** Capability links must never put their secret in a URL path or query. */
export function parseSecureInvitation(input: string): RoomSecret {
  const raw = input.trim();
  if (raw.startsWith("r2_")) return parseRoomSecret(raw);
  if (raw.startsWith("web+awfl://")) return parseProtocolInvitation(raw);
  const url = new URL(raw, "https://room.invalid");
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/r/" || url.search) {
    throw new Error("Invalid secure room invitation");
  }
  const fragment = decodeURIComponent(url.hash.slice(1));
  return fragment.startsWith("web+awfl://")
    ? parseProtocolInvitation(fragment)
    : parseRoomSecret(fragment);
}

function parseProtocolInvitation(input: string): RoomSecret {
  // Do not parse the secret as an HTTPS hostname or normalize its case.
  const value = input.slice("web+awfl://".length);
  return parseRoomSecret(value.startsWith("r/#") ? value.slice(3) : value);
}

export function secureInvitationLink(origin: string, secret: RoomSecret): string {
  parseRoomSecret(secret);
  const base = new URL(origin);
  if (!/^https?:$/.test(base.protocol)) throw new Error("Invalid invitation origin");
  return `${base.origin}/r/#${secret}`;
}

/**
 * Room codes.
 *
 * The code IS the membership secret: it names the gossipsub topic, keys the
 * relay's rendezvous, and is the SFU's join key. There is no roster and no
 * second factor, so anyone holding it reads the room's plaintext chat and can
 * consume its camera and screen streams.
 *
 * It used to be 3 random bytes - 24 bits, 16.7 million codes. Guessing is
 * online only (you have to reach the relay or the SFU to test one), but with R
 * rooms live the expected cost of hitting SOME room is 2^24/R, which is a few
 * hundred thousand tries on a busy instance: hours, not centuries.
 *
 * 8 bytes takes that to 2^64. At a wildly generous 10,000 guesses per second
 * against the network, exhausting a millionth of that space still takes
 * centuries, and there is no offline oracle to speed it up. 128 bits would buy
 * nothing further and doubles a string people sometimes read aloud.
 *
 * Length is not encoded anywhere: the relay, the SFU and the client all treat
 * a code as an opaque string, so old 6-character rooms keep working unchanged.
 * They keep their old entropy too - a room cannot be re-keyed without becoming
 * a different room.
 */
const ROOM_CODE_BYTES = 8;

export function newRoomCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(ROOM_CODE_BYTES)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

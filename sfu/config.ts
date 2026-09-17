/** Empty optional Compose variables mean default; malformed values fail closed. */
export function envInteger(name: string, fallback: number, min = 1, max = 2_147_483_647): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

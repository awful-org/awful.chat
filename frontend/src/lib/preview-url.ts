/** Remote previews must never receive fragment capabilities, including inside
 * nested/encoded URLs. Keep the original URL only for navigation and copying. */
export function remotePreviewUrl(input: string): string | null {
  // Inspect encoded wrappers too. Refuse excessive encoding rather than passing
  // a value whose eventual interpretation we have not checked to another server.
  let decoded = input;
  for (let depth = 0; depth < 8; depth++) {
    if (/r2_|web\+awfl:|#|\/pair(?:ing)?(?:[/?#]|$)|\/sync(?:[/?#]|$)/i.test(decoded)) return null;
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return null; }
    if (next === decoded) {
      try {
        const url = new URL(input);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        url.hash = '';
        return url.href;
      } catch { return null; }
    }
    decoded = next;
  }
  return null;
}

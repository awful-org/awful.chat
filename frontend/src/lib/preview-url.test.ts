import { describe, expect, it } from 'vitest';
import { remotePreviewUrl } from './preview-url';

describe('remote preview privacy boundary', () => {
  it('preserves ordinary HTTP links', () => {
    expect(remotePreviewUrl('https://example.org/article?q=hello%20world'))
      .toBe('https://example.org/article?q=hello%20world');
  });

  it('refuses secret invitations, fragments and encoded wrappers before fetching', () => {
    const secret = `r2_${'A'.repeat(43)}`;
    for (const input of [
      `https://example.org/r/#${secret}`,
      `https://example.org/r/${secret}`,
      `https://example.org/?invite=${secret}`,
      `web+awfl:${secret}`,
      'https://example.org/article#private-token',
      'https://example.org/pair/password',
      'https://example.org/sync/token',
    ]) {
      expect(remotePreviewUrl(input)).toBeNull();
      expect(remotePreviewUrl(`https://proxy.example/?url=${encodeURIComponent(input)}`)).toBeNull();
      expect(remotePreviewUrl(`https://proxy.example/?url=${encodeURIComponent(encodeURIComponent(input))}`)).toBeNull();
    }
  });

  it('fails closed on ambiguous encoding, credentials and unsupported schemes', () => {
    for (const input of ['not a url', 'file:///tmp/private', 'https://user:password@example.org/',
      'https://example.org/%ZZ', 'https://example.org/?q=%25252525252525252523secret']) {
      expect(remotePreviewUrl(input)).toBeNull();
    }
  });
});

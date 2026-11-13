/** netlify/functions/backend-token.ts: who may mint a token for the optional processing server. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../../netlify/functions/backend-token';

const SITE = 'https://example-site.netlify.app';
const post = (headers: Record<string, string> = {}) => handler(new Request(`${SITE}/.netlify/functions/backend-token`, { method: 'POST', headers }));

describe('backend-token function', () => {
  beforeEach(() => {
    vi.stubEnv('PROCESSING_SHARED_SECRET', 'test-secret');
    vi.stubEnv('URL', SITE);
    vi.stubEnv('DEPLOY_PRIME_URL', '');
    vi.stubEnv('DEPLOY_URL', '');
    vi.stubEnv('EXTRA_ALLOWED_ORIGINS', 'https://custom.example');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('gives a token to the site itself', async () => {
    const res = await post({ origin: SITE });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(j.exp).toBeGreaterThan(Date.now() / 1000);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts an extra allowed origin (a custom domain)', async () => {
    expect((await post({ origin: 'https://custom.example' })).status).toBe(200);
  });

  it('refuses a request with no Origin header', async () => {
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('token');
  });

  it('refuses other origins, including an empty or "null" one', async () => {
    for (const origin of ['https://evil.example', 'null', `${SITE}.evil.example`]) expect((await post({ origin })).status, origin).toBe(403);
  });

  it('accepts only POST', async () => {
    const res = await handler(new Request(`${SITE}/.netlify/functions/backend-token`, { headers: { origin: SITE } }));
    expect(res.status).toBe(405);
  });

  it('says so when no processing server is configured', async () => {
    vi.stubEnv('PROCESSING_SHARED_SECRET', '');
    expect((await post({ origin: SITE })).status).toBe(404);
  });
});

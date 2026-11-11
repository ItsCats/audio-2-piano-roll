/**
 * Mints short-lived access tokens for the optional processing server.
 *
 * The shared secret (PROCESSING_SHARED_SECRET) lives only in Netlify's environment and on
 * the processing server; the browser only ever receives a token valid for 10 minutes.
 * Requests from other origins are rejected so third-party sites can't mint tokens.
 */
import { createHmac, randomBytes } from 'node:crypto';

const TTL_SECONDS = 600;

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function allowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // same-origin fetches may omit Origin
  const allowed = [process.env.URL, process.env.DEPLOY_PRIME_URL, process.env.DEPLOY_URL, ...(process.env.EXTRA_ALLOWED_ORIGINS ?? '').split(',')]
    .map((s) => s?.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = process.env.PROCESSING_SHARED_SECRET;
  if (!secret) return Response.json({ error: 'Processing server is not configured' }, { status: 404 });
  if (!allowedOrigin(req.headers.get('origin'))) return Response.json({ error: 'Forbidden origin' }, { status: 403 });
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = b64url(Buffer.from(JSON.stringify({ exp, nonce: b64url(randomBytes(12)) })));
  const sig = b64url(createHmac('sha256', secret).update(payload).digest());
  return Response.json(
    { token: `${payload}.${sig}`, exp },
    { headers: { 'Cache-Control': 'no-store' } },
  );
};

export const config = { path: '/.netlify/functions/backend-token' };

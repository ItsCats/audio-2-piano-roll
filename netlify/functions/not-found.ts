/**
 * Real 404 for missing static files under /assets, /models, /samples and /pdfjs (netlify.toml
 * rewrites misses there to this function; files that exist are served as usual).
 *
 * Without it the single-page-app rule answered such a request with the app page and status 200,
 * and the /assets/* rule added a one-year immutable cache to that wrong answer. A tab opened
 * before a deploy then failed with a confusing error instead of noticing the new version.
 * A function is used, not a static 404 page, because Netlify's [[headers]] rules (the long
 * caches) are not applied to responses from functions: this 404 is never cached.
 */
export default async (): Promise<Response> =>
  new Response('Not found\n', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

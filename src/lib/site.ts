/**
 * Site-wide facts used by the Privacy, Terms and Copyright pages (src/pages/Legal.tsx) and anywhere
 * else the site names itself or a way to reach the people who run it.
 *
 * Change these in one place, or set them per deployment (Netlify → Site configuration → Environment
 * variables, then redeploy):
 *   VITE_SITE_URL       the public address, e.g. https://piano2vision.com (default: the address the page was opened from)
 *   VITE_CONTACT_EMAIL  a role address for general questions and privacy requests (default: none, the issues page is used)
 *   VITE_COPYRIGHT_EMAIL  where rights holders send copyright notices (default: VITE_CONTACT_EMAIL)
 * Use a role address (contact@…, copyright@…), not a personal one: it is shown publicly.
 *
 * VITE_PROCESSING_URL (README, docs/DEPLOYMENT.md) is read here too: when the site has its own
 * processing server, the Privacy page says so and names its host.
 */
import { SOURCE_CODE_URL } from './credits';

export const SITE_NAME = 'Piano2Vision';

const env = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The public address of the site, without a trailing slash. */
export const SITE_URL: string = (env(import.meta.env.VITE_SITE_URL) || (typeof location !== 'undefined' ? location.origin : '')).replace(/\/+$/, '');

/** Public issue tracker: always available as a way to get in touch. */
export const CONTACT_URL = `${SOURCE_CODE_URL}/issues`;

/** Optional e-mail for general and privacy questions. Empty until the owner sets one. */
export const CONTACT_EMAIL: string = env(import.meta.env.VITE_CONTACT_EMAIL);

/** Optional e-mail for copyright notices. Falls back to CONTACT_EMAIL. */
export const COPYRIGHT_EMAIL: string = env(import.meta.env.VITE_COPYRIGHT_EMAIL) || CONTACT_EMAIL;

/**
 * Host of the site's own processing server (VITE_PROCESSING_URL), or '' when there is none. Imports
 * use it when the user has not entered a server in Settings, so the Privacy page must mention it.
 */
export function processingHost(url: unknown): string {
  const v = env(url);
  if (!v) return '';
  try {
    return new URL(v).host;
  } catch {
    return v;
  }
}
export const SITE_PROCESSING_HOST: string = processingHost(import.meta.env.VITE_PROCESSING_URL);

/** Date shown as "Last updated" on the Privacy, Terms and Copyright pages. Change it whenever their text changes. */
export const LEGAL_LAST_UPDATED = '2026-11-13';

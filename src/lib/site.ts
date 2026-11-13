/**
 * Site-wide facts used by the Privacy, Terms and Copyright pages (src/pages/Legal.tsx) and anywhere
 * else the site names itself or a way to reach the people who run it.
 *
 * Change these in one place, or set them per deployment (Netlify → Site configuration → Environment
 * variables, then redeploy):
 *   VITE_SITE_URL       the public address, e.g. https://piano2vision.com (default: the address the page was opened from)
 *   VITE_CONTACT_EMAIL  the address for general questions and privacy requests (default: DEFAULT_CONTACT_EMAIL below)
 *   VITE_COPYRIGHT_EMAIL  where rights holders send copyright notices (default: the contact address)
 * Both are shown publicly, next to the GitHub issues link.
 *
 * VITE_PROCESSING_URL (README, docs/DEPLOYMENT.md) is read here too: when the site has its own
 * processing server, the Privacy page says so and names its host.
 */
import { SOURCE_REPO_URL } from './credits';

export const SITE_NAME = 'Piano2Vision';

const env = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The public address of the site, without a trailing slash. */
export const SITE_URL: string = (env(import.meta.env.VITE_SITE_URL) || (typeof location !== 'undefined' ? location.origin : '')).replace(/\/+$/, '');

/** Public issue tracker: always available as a way to get in touch. */
export const CONTACT_URL = `${SOURCE_REPO_URL}/issues`;

/** The site's contact address, used when VITE_CONTACT_EMAIL is not set. */
export const DEFAULT_CONTACT_EMAIL = 'jackanderson0616@gmail.com';

/** E-mail for general and privacy questions (shown as a mailto link). */
export const CONTACT_EMAIL: string = env(import.meta.env.VITE_CONTACT_EMAIL) || DEFAULT_CONTACT_EMAIL;

/** E-mail for copyright notices. Falls back to CONTACT_EMAIL. */
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

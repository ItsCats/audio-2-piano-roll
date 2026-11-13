import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { processingHost } from '../../src/lib/site';

/** The Privacy page as plain text, built with the given VITE_PROCESSING_URL. */
async function privacyText(processingUrl: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv('VITE_PROCESSING_URL', processingUrl);
  const { default: LegalPage } = await import('../../src/pages/Legal');
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LegalPage, { page: 'privacy' })));
  return html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');
}

describe('Privacy page and the processing server', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('names only the host of the processing server', () => {
    expect(processingHost('https://proc.example.org/api/')).toBe('proc.example.org');
    expect(processingHost('http://localhost:8000')).toBe('localhost:8000');
    expect(processingHost('  ')).toBe('');
    expect(processingHost(undefined)).toBe('');
  });

  it('without a site server: off unless the user sets one; recordings are not sent anywhere', async () => {
    const t = await privacyText('');
    expect(t).toContain('A processing server, only if one is set.');
    expect(t).toContain('They are not uploaded to us.');
    expect(t).toContain('are not sent anywhere');
    expect(t).not.toContain('Our processing server');
  });

  it('with VITE_PROCESSING_URL set: says audio can go to that server, and names it', async () => {
    const t = await privacyText('https://proc.example.org');
    expect(t).toContain('Our processing server.');
    expect(t).toContain('proc.example.org');
    expect(t).toContain('except audio sent to our processing server');
    expect(t).not.toContain('only if one is set');
    expect(t).not.toContain('are not sent anywhere');
  });
});

describe('Contact on the Privacy, Terms and Copyright pages', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function pageHtml(page: 'privacy' | 'terms' | 'copyright'): Promise<string> {
    vi.resetModules();
    const { default: LegalPage } = await import('../../src/pages/Legal');
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(LegalPage, { page })));
  }

  it('shows the site e-mail as a mailto link, and keeps the GitHub issues link', async () => {
    const { CONTACT_EMAIL, CONTACT_URL, DEFAULT_CONTACT_EMAIL } = await import('../../src/lib/site');
    expect(CONTACT_EMAIL).toBe(DEFAULT_CONTACT_EMAIL);
    expect(CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
    for (const page of ['privacy', 'terms', 'copyright'] as const) {
      const html = await pageHtml(page);
      expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`);
      expect(html).toContain(`href="${CONTACT_URL}"`);
    }
  });

  it('a deployment can set its own address', async () => {
    vi.stubEnv('VITE_CONTACT_EMAIL', 'hello@example.org');
    const html = await pageHtml('privacy');
    expect(html).toContain('href="mailto:hello@example.org"');
  });
});

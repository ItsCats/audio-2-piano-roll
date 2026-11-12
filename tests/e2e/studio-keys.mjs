/**
 * Studio arrow keys: one ← / → press on the song-position bar seeks once (5 s, Shift 1 s), and the
 * page-wide shortcut still works when the bar isn't focused. Phone and desktop widths.
 *
 *   npm run test:e2e:keys
 */
import { createServer } from 'vite';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const server = await createServer({ server: { port: 5184, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let failed = false;
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto('http://localhost:5184/studio');
    await page.getByRole('button', { name: 'Demo' }).first().click();
    const bar = page.locator('[aria-label^="Song position"]');
    await bar.waitFor({ timeout: 60000 });
    const at = async () => (await bar.getAttribute('aria-valuetext')) ?? '0:00';
    const expectTime = async (want, what) => {
      let got = await at();
      for (let i = 0; i < 40 && got !== want; i++) {
        await page.waitForTimeout(50);
        got = await at();
      }
      const ok = got === want;
      failed ||= !ok;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${viewport.width}px  ${what}: ${got}${ok ? '' : ` (expected ${want})`}`);
    };
    await expectTime('0:00', 'start');
    await bar.focus();
    await page.keyboard.press('ArrowRight');
    await expectTime('0:05', 'bar focused, →');
    await page.keyboard.press('ArrowRight');
    await expectTime('0:10', 'bar focused, → again');
    await page.keyboard.press('Shift+ArrowRight');
    await expectTime('0:11', 'bar focused, Shift+→');
    await page.keyboard.press('ArrowLeft');
    await expectTime('0:06', 'bar focused, ←');
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    await page.keyboard.press('ArrowRight');
    await expectTime('0:11', 'nothing focused, → (page shortcut)');
    await page.keyboard.press('Shift+ArrowLeft');
    await expectTime('0:10', 'nothing focused, Shift+← (page shortcut)');
    // edit mode: the page shortcut doesn't seek (arrows move notes), the bar still does, once
    await page.getByTitle('Edit notes (E)').click();
    await bar.focus();
    await page.keyboard.press('ArrowRight');
    await expectTime('0:15', 'edit mode, bar focused, →');
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);

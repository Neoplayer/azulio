// Drives the running Azul web app (http://localhost:5173) through each screen
// and saves a screenshot of every one into ./screenshots/.
// Run: npx --yes --package playwright node scripts/screenshots.mjs
const PW = process.env.PW_PATH ?? 'playwright';
const pw = await import(PW);
const chromium = pw.chromium ?? pw.default.chromium;
import { mkdirSync } from 'node:fs';

const BASE = process.env.AZUL_URL ?? 'http://localhost:5173';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}${name}.png`, animations: 'disabled', timeout: 60000 });
  console.log(`  ✓ ${name}.png`);
};

const browser = await chromium.launch();
// iPhone-ish portrait viewport — the app is a portrait-first PWA.
const ctx = await browser.newContext({
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 2,
  // The app registers a PWA service worker; blocking it keeps navigations from
  // being intercepted/stalled by a stale precache between runs.
  serviceWorkers: 'block',
});
const page = await ctx.newPage();

try {
  // 1) Login
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.locator('#nick').waitFor({ timeout: 15000 });
  await page.fill('#nick', 'Лена');
  await shot(page, '1-login');

  // 2) Lobby
  await page.getByRole('button', { name: 'Войти как гость' }).click();
  await page.getByRole('button', { name: '+ Создать комнату' }).waitFor();
  await shot(page, '2-lobby');

  // 3) Create-room form
  await page.getByRole('button', { name: '+ Создать комнату' }).click();
  await page.locator('.az-input').fill('Партия Лены');
  await shot(page, '3-create-room');

  // 4) Room (waiting) with a bot added
  await page.getByRole('button', { name: 'Создать' }).click();
  await page.getByRole('button', { name: /Запустить игру|Нужно минимум/ }).waitFor();
  // Click the actual "+ Добавить бота (…)" action button (ghost), not the
  // level-selector chips above it; retry until the bot row actually appears.
  const addBot = page.locator('button.az-btn-ghost', { hasText: 'Добавить бота' });
  const botTag = page.locator('.az-tag-bot');
  for (let i = 0; i < 5 && (await botTag.count()) === 0; i++) {
    await addBot.click();
    await botTag.first().waitFor({ timeout: 3000 }).catch(() => {});
  }
  await botTag.first().waitFor({ timeout: 5000 });
  await shot(page, '4-room');

  // 5) Game board
  await page.getByRole('button', { name: 'Запустить игру' }).click();
  await page.locator('.az-factories').waitFor({ timeout: 10000 });
  await page.waitForTimeout(1000);
  await shot(page, '5-game');
} catch (err) {
  console.error('Screenshot run failed:', err.message);
  await shot(page, 'error-state');
  process.exitCode = 1;
} finally {
  await browser.close();
}

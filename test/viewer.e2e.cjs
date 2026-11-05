// Browser test for the viewer (webapp-testing). Needs Playwright; run.sh skips it when missing.
// Usage: node test/viewer.e2e.cjs <port> <screenshot-dir>
const { chromium } = require('playwright');
const [port, shots] = process.argv.slice(2);
const assert = (c, m) => { if (!c) throw new Error('viewer e2e: ' + m); };
(async () => {
  const errors = [];
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1400, height: 850 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForLoadState('networkidle');

  assert(await page.locator('#projects').getByText('Imported from claude-mem').count() === 1, 'imported section');
  await page.getByRole('tab', { name: 'Notes' }).click();
  await page.waitForSelector('[data-n]');
  assert(await page.locator(".chip[data-t='bugfix']").count() === 1, 'type chip');
  await page.screenshot({ path: `${shots}/notes.png` });

  await page.keyboard.press('/');
  await page.keyboard.type('regex');
  await page.waitForSelector('mark');
  assert((await page.locator('#list').innerText()).includes('matches for'), 'search count');

  await page.locator('[data-n]').first().click();
  await page.waitForSelector('#a-pin');
  await page.click('#a-pin');
  await page.waitForSelector('text=Unpin');
  await page.click('#a-edit');
  await page.fill('#e-title', 'Email regex now allows plus signs');
  await page.click('text=Save');
  await page.waitForSelector('.mem >> text=Email regex now allows plus signs');
  await page.screenshot({ path: `${shots}/note.png` });

  await page.fill('#q', '');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Todos' }).click();
  await page.click('#showdone');
  await page.waitForSelector('[data-n]');

  await page.getByRole('tab', { name: 'Sessions' }).click();
  await page.locator('[data-s]').first().click();
  await page.waitForSelector('text=Captured activity');
  await page.screenshot({ path: `${shots}/session.png` });

  assert(await page.locator('button.item').count() > 3, 'items are buttons');
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: `${shots}/phone.png` });
  await b.close();
  assert(!errors.length, errors.join('\n'));
  console.log('viewer e2e ok');
})().catch((e) => { console.error(e.message); process.exit(1); });

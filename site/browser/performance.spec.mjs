import { test, expect } from '@playwright/test';

test('mobile startup stays under its download budget and loads nothing from other origins', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    reducedMotion: 'no-preference' });
  try {
    const page = await context.newPage();
    const requests = [];
    const downloads = [];
    const origin = new URL(testInfo.project.use.baseURL).origin;
    page.on('request', request => requests.push(new URL(request.url())));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin) downloads.push(response.body().then(async body => {
        const sizes = await response.request().sizes();
        return { path: url.pathname, bytes: sizes.responseBodySize, decodedBytes: body.length };
      }));
    });
    await page.route(/https:\/\//, route => route.abort());
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const assets = await Promise.all(downloads);
    const bytes = assets.reduce((total, asset) => total + asset.bytes, 0);
    await testInfo.attach('mobile-startup-bytes', { body: JSON.stringify({ bytes, assets }, null, 2), contentType: 'application/json' });
    expect(bytes, JSON.stringify(assets)).toBeLessThan(400000);
    expect(assets.filter(asset => /\.(css|js)$/.test(asset.path)).reduce((total, asset) => total + asset.bytes, 0)).toBeLessThan(50000);
    expect(requests.filter(url => url.origin !== origin).map(String)).toEqual([]);
    expect(requests.some(url => url.pathname.startsWith('/video/'))).toBe(false);
    expect(requests.filter(url => url.pathname.endsWith('.woff2')).every(url => url.pathname.startsWith('/fonts/'))).toBe(true);
    await expect(page.locator('.cinematic-media img')).toHaveJSProperty('currentSrc', `${origin}/img/kestrel-exterior.svg`);
    expect(await page.locator('.cinematic-media img').evaluate(img => img.naturalWidth), 'the hero image loads').toBeGreaterThan(0);
    expect(await page.evaluate(() => [...document.images].filter(img => img.complete && img.naturalWidth === 0 && img.loading !== 'lazy').map(img => img.src)), 'no broken images').toEqual([]);
  } finally { await context.close(); }
});

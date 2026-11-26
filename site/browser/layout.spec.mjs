import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const pages = ['/', '/services/', '/services/brakes/', '/about/', '/news/', '/contact/'];

for (const width of [390, 1280]) {
  test(`key pages retain accessible contrast and structure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route(/https:\/\//, route => route.abort());
    for (const path of pages) {
      await page.goto(path);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(result.violations, `${path} at ${width}px`).toEqual([]);
    }
  });
}

for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [1280, 900]]) {
  test(`key pages fit a ${width}px screen and keep navigation usable`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route(/https:\/\//, route => route.abort());
    for (const path of pages) {
      await page.goto(path);
      const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      expect(size.content, `${path} overflows at ${width}px`).toBeLessThanOrEqual(size.viewport);
      await expect(page.locator('main h1')).toBeVisible();
      if (path === '/') {
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.locator('main h1').evaluate(el => el.scrollWidth - el.clientWidth);
        expect(overflow, 'The hero heading should fit its column').toBeLessThanOrEqual(1);
        const facts = page.locator('.visit-details');
        await expect(facts.getByRole('heading', { name: 'Opening hours' })).toBeVisible();
        await expect(facts.getByRole('row', { name: 'Monday to Friday 8am to 5.30pm' })).toBeVisible();
        await expect(facts.getByRole('row', { name: 'Saturday 8.30am to 12.30pm' })).toBeVisible();
        await expect(facts.getByRole('row', { name: 'Sunday Closed' })).toBeVisible();
        await expect(page.locator('.cinematic-details')).toContainText('Monday to Friday');
      }
      if (width <= 900) {
        if (path === '/') await page.locator('.services-overview').evaluate(el => el.scrollIntoView({ block: 'start' }));
        const bar = page.getByRole('navigation', { name: 'Quick actions' });
        await expect(bar).toBeVisible();
        const call = bar.getByRole('link', { name: 'Call', exact: true });
        await expect(call).toHaveAttribute('href', 'tel:+441632960041');
        const target = await call.boundingBox();
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.width).toBeGreaterThanOrEqual(44);
      }
    }
    if (width <= 900) {
      const menu = page.getByRole('button', { name: 'Menu', exact: true });
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#site-nav').getByRole('link', { name: 'Services', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(menu).toBeFocused();
    }
  });
}

for (const javaScriptEnabled of [true, false]) {
  test(`visit details and quick actions work with JavaScript ${javaScriptEnabled ? 'enabled' : 'disabled'}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, javaScriptEnabled,
      viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const external = [];
      await page.route(/https:\/\//, route => { external.push(route.request().url()); return route.abort(); });
      await page.goto('/');
      if (!javaScriptEnabled) await expect(page.locator('.action-bar')).toBeVisible();
      await expect(page.locator('.visit-details')).toContainText('14 Mill Lane');
      await expect(page.locator('.visit-details')).toContainText('8am to 5.30pm');
      await expect(page.locator('.visit-details').getByRole('link', { name: 'Call the garage' })).toHaveAttribute('href', 'tel:+441632960041');
      await expect(page.locator('.footer')).toContainText('Website managed by Northlight');
      expect(external, 'the demo site loads nothing from other origins').toEqual([]);
    } finally { await context.close(); }
  });
}

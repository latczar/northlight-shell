import { test, expect } from '@playwright/test';
import { webkitLoopback } from '../test-support/webkit-loopback.mjs';
import site from '../site.json' with { type: 'json' };

test.beforeEach(async ({ context, page, browserName }) => {
  await context.route(/^https:\/\//, route => route.abort());
  await webkitLoopback(page, browserName);
});

test('phone viewport lets a visitor find brake repairs and the visit details', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Services' }).click();
  await page.getByRole('link', { name: 'Explore brakes' }).click();
  await expect(page).toHaveURL(/\/services\/brakes\/$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/brake/i);
  const actions = page.getByRole('navigation', { name: 'Quick actions' });
  await expect(actions.getByRole('link', { name: 'Call', exact: true })).toHaveAttribute('href', 'tel:+441632960041');
  await actions.getByRole('link', { name: /Directions/ }).click();
  await expect(page).toHaveURL(/\/contact\/$/);
  await expect(page.locator('.contact-info')).toContainText('14 Mill Lane');
  await page.goBack();
  await expect(page).toHaveURL(/\/services\/brakes\/$/);
});

test('phone viewport keeps the homepage heading inside its column after rotation and back navigation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.locator('#site-nav').getByRole('link', { name: 'Visit' }).click();
  await expect(page).toHaveURL(/\/contact\/$/);
  await page.setViewportSize({ width: 640, height: 320 });
  await page.goBack();
  const heading = page.getByRole('heading', { level: 1 });
  for (const [width, height] of [[640, 320], [320, 640]]) {
    await page.setViewportSize({ width, height });
    await expect(heading).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await heading.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
});

test('the public site has no assistant API or staff agent launcher', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Iris/i })).toHaveCount(0);
  expect((await request.get('/api/assistant/status')).status()).toBe(404);
});

test('the public Worker keeps the staff dashboard and its review endpoints private', async ({ request }) => {
  for (const path of ['/sandbox/iris-review/dashboard.js', '/dashboard', '/history', '/state/review']) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
  }
  const response = await request.post('/decision/review', {
    data: { id: 'public-site-isolation-test', decision: 'approve' },
  });
  expect([404, 405], 'the public website must refuse staff approvals').toContain(response.status());
});

test('until sign-in is configured on the Worker, the staff desk sends staff to the Northlight console', async ({request}) => {
  const result = await request.get('/staff/iris/', {maxRedirects: 0});
  expect(result.status()).toBe(302);
  expect(result.headers()['location']).toBe(site.staff.sign_in);
  expect(site.staff.sign_in).toMatch(/^https:\/\/[^/]+\/c\/kestrel\/iris$/);
});

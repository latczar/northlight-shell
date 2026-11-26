// The Worker fixture uses HTTP loopback. Preserve CSP except its HTTPS upgrade in WebKit's local document.
// The actual Worker security headers are tested separately without this browser-only adaptation.
export async function webkitLoopback(page, browserName) {
  if (browserName !== 'webkit') return;
  await page.route(/^http:\/\/127\.0\.0\.1:4317\/([^?#]*\/)?$/, async route => {
    const response = await route.fetch();
    const headers = response.headers();
    headers['content-security-policy'] = headers['content-security-policy']?.replace(/(?:^|;\s*)upgrade-insecure-requests(?=;|$)/g, '');
    await route.fulfill({ response, headers });
  });
}

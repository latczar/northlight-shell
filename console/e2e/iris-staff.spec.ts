import { test, expect, webkit, type Page } from "@playwright/test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/c\/kestrel$/);
}

const desk = "/c/kestrel/iris?tab=requests";

test("sign-in keeps the email and password through connection loss", async ({ page, context }) => {
  await page.goto("/sign-in");
  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await email.fill("alex@kestrel.example");
  await password.fill("alex-test-pass");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/reconnect and try again/i)).toBeVisible();
  await expect(email).toHaveValue("alex@kestrel.example");
  await expect(password).toHaveValue("alex-test-pass");

  await context.setOffline(false);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/c\/kestrel$/);
});

test("a wrong password and an unknown email get the same answer", async ({ page }) => {
  await page.goto("/sign-in");
  for (const [email, password] of [["alex@kestrel.example", "not-the-password"], ["nobody@kestrel.example", "alex-test-pass"]]) {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("That email and password don’t match. Check them and try again.")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  }
});

test("staff can sign in on a small phone and land on the desk they asked for", async ({ baseURL }) => {
  const browser = await webkit.launch();
  try {
    const phone = await browser.newPage({ baseURL, viewport: { width: 320, height: 568 }, isMobile: true });
    await phone.goto("/sign-in?next=" + encodeURIComponent(desk));
    await expect(phone.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(phone.getByRole("button", { name: "Sign in", exact: true })).toBeInViewport({ ratio: 1 });
    await phone.getByLabel("Email", { exact: true }).fill("alex@kestrel.example");
    await phone.getByLabel("Password", { exact: true }).fill("alex-test-pass");
    await phone.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(phone).toHaveURL(new URL(desk, baseURL).href);
    await expect(phone.getByRole("button", { name: /^Chat with Iris$/ })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  } finally {
    await browser.close();
  }
});

test("staff can change their own password and sign in with the new one", async ({ page }) => {
  await signIn(page, "jamie@kestrel.example", "jamie-test-pass");
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("link", { name: "Change password" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByLabel("Type it again", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Use at least 10 characters.", { exact: true })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("jamie-new-pass-2");
  await page.getByLabel("Type it again", { exact: true }).fill("jamie-new-pass-3");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("The two passwords don’t match.")).toBeVisible();
  await page.getByLabel("Type it again", { exact: true }).fill("jamie-new-pass-2");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Password changed. Use it next time you sign in.")).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, "jamie@kestrel.example", "jamie-new-pass-2");
  // put the shared fake account back for the other tests
  await page.goto("/account");
  await page.getByLabel("New password", { exact: true }).fill("jamie-test-pass");
  await page.getByLabel("Type it again", { exact: true }).fill("jamie-test-pass");
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByText("Password changed. Use it next time you sign in.")).toBeVisible();
});

test("staff request changes on desktop and approve the same revision on mobile", async ({ page, baseURL }, info) => {
  const mobile = await webkit.launch();
  try {
    const phone = await mobile.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await signIn(page, "alex@kestrel.example", "alex-test-pass");
    await signIn(phone, "alex@kestrel.example", "alex-test-pass");
    await page.goto(desk);
    const original = page.locator("#request-appr-kestrel-1");
    const feedback = "Keep Milbrook and end with how to contact the garage.";
    await original.getByRole("button", { name: "Request changes" }).click();
    await expect(original.getByRole("button", { name: "Send feedback" })).toBeDisabled();
    await original.getByRole("textbox").fill(feedback);
    await original.getByRole("button", { name: "Send feedback" }).click();
    const revision = page.locator('article[id^="request-appr-rev-"]');
    await expect(revision.getByRole("button", { name: "Approve this copy" })).toBeVisible();
    const revisionId = await revision.getAttribute("id");
    expect(revisionId).toBeTruthy();
    await phone.goto(desk);
    const onPhone = phone.locator("#" + revisionId);
    await expect(onPhone).toContainText("Sample revised description:");
    await onPhone.screenshot({ path: info.outputPath("mobile-revision.png") });
    await onPhone.getByRole("button", { name: "Approve this copy" }).click();
    await expect(onPhone.getByText("Done", { exact: true })).toBeVisible();
    await page.reload();
    await expect(revision).toHaveCount(1);
    await expect(revision.getByText("Done", { exact: true })).toBeVisible();
    await expect(original).toContainText(/declined/i);
    await expect(original).toContainText(feedback);
    await revision.screenshot({ path: info.outputPath("desktop-decision.png") });
  } finally {
    await mobile.close();
  }
});

test("a staff member without a handset assignment cannot open call history", async ({ page }) => {
  await signIn(page, "jamie@kestrel.example", "jamie-test-pass");
  await page.goto(desk);
  await expect(page.getByRole("link", { name: "Call history" })).toHaveCount(0);
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  const response = await page.goto("/c/kestrel/iris/calls");
  expect(response?.status()).toBe(404);
});

test("accepts an autofilled email and password when the browser sends no change event", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).evaluate(input => { (input as HTMLInputElement).value = "jamie@kestrel.example"; });
  await page.getByLabel("Password", { exact: true }).evaluate(input => { (input as HTMLInputElement).value = "jamie-test-pass"; });
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/c\/kestrel$/);
});

test("a failed staff job can be retried and finished from another device", async ({ page, browser, baseURL }) => {
  const mobile = await webkit.launch();
  const peer = await browser.newPage({ baseURL });
  try {
    const phone = await mobile.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await signIn(page, "alex@kestrel.example", "alex-test-pass");
    await signIn(phone, "alex@kestrel.example", "alex-test-pass");
    await signIn(peer, "jamie@kestrel.example", "jamie-test-pass");
    const chat = "/c/kestrel/iris?chat=1";
    const failed = "Migration check: fail the first inspection.";
    const retry = "Please try the homepage inspection again.";
    await page.goto(chat);
    async function send(text: string) {
      const box = page.getByRole("textbox", { name: /message to/i });
      await box.fill(text);
      const started = page.waitForResponse(r => r.url().endsWith("/jobs") && r.request().method() === "POST");
      await box.press("Enter");
      const response = await started;
      expect(response.ok()).toBe(true);
      return response.request().postDataJSON().id as string;
    }
    await send(failed);
    await expect(page.getByRole("log").getByText(/the page could not be read/i)).toBeVisible();
    await phone.goto(chat);
    await expect(phone.getByRole("log").getByText(failed, { exact: true })).toBeVisible();
    const peerHistory = peer.waitForResponse(r => new URL(r.url()).pathname.endsWith("/messages"));
    await peer.goto(chat);
    expect((await peerHistory).ok()).toBe(true);
    await expect(peer.getByRole("log")).not.toContainText(failed);

    const job = await send(retry);
    const request = phone.locator("#request-act-" + job);
    // The fake job files its request after inspecting the page. Read the shared list again until it appears.
    await expect(async () => {
      await phone.goto(desk);
      await expect(request).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 12_000 });
    await request.getByRole("button", { name: "Approve this copy" }).click();
    await expect(request.getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByRole("log").getByText(/All done.*approved/i)).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByRole("log").getByText(failed, { exact: true })).toHaveCount(1);
  } finally {
    await peer.close();
    await mobile.close();
  }
});

for (const device of ["desktop", "mobile"]) {
  test(`each signed-in caller can only read their own transcript on ${device}`, async ({ browser, baseURL }) => {
    const mobile = device === "mobile" ? await webkit.launch() : null;
    const path = "/c/kestrel/iris/calls";
    try {
      for (const [email, password, own, other] of [
        ["admin@northlight.example", "admin-test-pass", "Services alpha alignment", "Services beta brakes"],
        ["alex@kestrel.example", "alex-test-pass", "Services beta brakes", "Services alpha alignment"],
      ]) {
        const page = await (mobile ?? browser).newPage({
          baseURL, viewport: { width: mobile ? 375 : 1280, height: 812 }, isMobile: Boolean(mobile),
        });
        try {
          await page.goto("/sign-in?next=" + encodeURIComponent(path));
          await page.getByLabel("Email", { exact: true }).fill(email);
          await page.getByLabel("Password", { exact: true }).fill(password);
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await expect(page).toHaveURL(new URL(path, baseURL).href);
          const call = page.locator("details");
          await expect(call).toHaveCount(1);
          await call.locator("summary").click();
          await expect(call.getByText(own)).toBeVisible();
          await expect(call.getByText(email === "admin@northlight.example"
            ? "Iris ended the call." : "The caller’s phone line disconnected.")).toBeVisible();
          expect(await page.content()).not.toContain(other);
          expect(await page.content()).not.toContain("previous handset owner");
          await page.getByRole("link", { name: "Back to Iris" }).click();
          await expect(page.getByRole("button", { name: /^Iris .*Open chat$/i })).toBeVisible();
          const dial = page.getByRole("link", { name: /Call Iris/ });
          await expect(dial).toHaveAttribute("href", "tel:+441632960001");
          await expect(dial).toContainText("01632 960001");
          await page.getByRole("link", { name: "Call history" }).click();
          await page.getByRole("searchbox").fill("GARAGE’S   SERVICES");
          await page.getByRole("searchbox").press("Enter");
          await expect(call.locator("summary")).toContainText("Kestrel Garage's Services");
          await page.reload();
          await expect(call).toHaveCount(1);
          await call.locator("summary").click();
          await expect(call.getByText(own)).toBeVisible();
          await page.getByRole("searchbox").fill(other);
          await page.getByRole("button", { name: "Search calls" }).click();
          await expect(page.getByText("No matching calls in this range.")).toBeVisible();
          await expect(page.locator("details")).toHaveCount(0);
        } finally { await page.close(); }
      }
    } finally { await mobile?.close(); }
  });
}

test("a call draft survives concurrent creation, desktop feedback and mobile approval", async ({browser,baseURL}) => {
  const ios = await webkit.launch();
  const desktop = await browser.newContext({baseURL});
  const pc = await desktop.newPage();
  const phone = await ios.newPage({baseURL,viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  const history = "/c/kestrel/iris/calls";
  try {
    await Promise.all([signIn(pc,"alex@kestrel.example","alex-test-pass"),signIn(phone,"alex@kestrel.example","alex-test-pass")]);
    for (const page of [pc,phone]) {
      await page.goto(history);
      await page.locator("summary").click();
    }
    await Promise.all([pc,phone].map(p => p.getByRole("button",{name:"Create draft"}).click()));
    const original = pc.locator("article");
    await expect(original).toBeVisible();
    await expect(phone.locator("article")).toHaveAttribute("id",(await original.getAttribute("id"))!);
    const link = pc.url();
    const staleTab = await pc.context().newPage();
    await staleTab.goto(link);
    await expect(staleTab.locator("article")).toHaveAttribute("id", (await original.getAttribute("id"))!);
    await phone.context().setOffline(true);
    await original.getByRole("button",{name:"Request changes"}).click();
    await original.getByRole("textbox").fill("Start with brake repair and keep Milbrook.");
    await desktop.setOffline(true);
    await desktop.setOffline(false);
    await expect(original.getByRole("textbox")).toHaveValue("Start with brake repair and keep Milbrook.");
    await original.getByRole("button",{name:"Send feedback"}).click();
    await expect(pc.getByText("Original draft and feedback")).toBeVisible();
    // The disconnected phone recovers the revised title without a manual reload.
    await phone.context().setOffline(false);
    await expect(phone.locator("article")).toContainText("Sample revised title");
    await staleTab.locator("article").getByRole("button", { name: "Approve this copy" }).click();
    await expect(staleTab.locator("article")).toContainText("Sample revised title");
    await staleTab.close();
    await phone.reload();
    const revision = phone.locator("article");
    await expect(revision).toContainText("Sample revised title");
    await revision.getByRole("button",{name:"Approve this copy"}).click();
    await expect(revision.getByText("Done",{exact:true})).toBeVisible();
    const revisionId = await revision.getAttribute("id");
    await pc.goto(history);
    await pc.locator("summary").click();
    // The server accepted the retry, but the desktop lost the reply.
    await pc.route("**/calls", async route => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      await route.abort("connectionreset");
    });
    await pc.getByRole("button",{name:"Create draft"}).click();
    await expect(pc.getByRole("alert").filter({ hasText: "Connection interrupted" })).toBeVisible();
    await pc.unroute("**/calls");
    await pc.getByRole("button",{name:"Create draft"}).click();
    await expect(pc).toHaveURL(link);
    await expect(pc.locator("article")).toHaveAttribute("id",revisionId!);
    await pc.getByText("Original draft and feedback").click();
    await expect(pc.getByText("Start with brake repair and keep Milbrook.",{exact:true}).last()).toBeVisible();
    await pc.getByRole("link", { name: "Back to call history" }).click();
    await expect(pc).toHaveURL(/\?source=conv_beta&day=\d{4}-\d{2}-\d{2}#conv_beta$/);
    await expect(pc.locator("details#conv_beta")).toBeVisible();
    await expect(pc.getByRole("button",{name:"Approve this copy"})).toHaveCount(0);
    const writes: string[] = [];
    pc.on("request", request => {
      if (request.method() === "POST") writes.push(request.url());
    });
    await pc.getByRole("link", { name: "Open Services draft" }).click();
    await expect(pc.locator("article")).toHaveAttribute("id", revisionId!);
    await expect(pc.locator("article")).toContainText("Done");
    expect(writes).toEqual([]);
    expect((await pc.goto(history+"/conv_alpha/draft"))?.status()).toBe(404);
  } finally { await desktop.close(); await ios.close(); }
});

test("a direct link to a call about hours cannot start a Services draft", async ({ page }) => {
  await signIn(page, "alex@kestrel.example", "alex-test-pass");
  const response = await page.goto("/c/kestrel/iris/calls/conv_hours/draft");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("button", { name: "Create draft" })).toHaveCount(0);
});

test("an interrupted mobile search keeps a matching call and retries the missing batch", async ({ baseURL }) => {
  const ios = await webkit.launch();
  try {
    const page = await ios.newPage({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true });
    await signIn(page, "alex@kestrel.example", "alex-test-pass");
    const cursor = "interrupted-" + Date.now();
    await page.goto("/c/kestrel/iris/calls?topic=Services&cursor=" + cursor);
    const warning = page.getByRole("alert").filter({ hasText: "Some older calls could not be loaded." });
    await expect(warning).toBeVisible();
    await page.locator("#conv_beta summary").click();
    await expect(page.locator("#conv_beta ol")).toContainText("Services beta brakes");
    await warning.getByRole("link", { name: "Try again" }).click();
    await expect(page).toHaveURL(new RegExp("topic=Services&cursor=resume-" + cursor));
    await expect(page.locator("#conv_resumed summary")).toBeVisible();
    await expect(warning).toHaveCount(0);
  } finally { await ios.close(); }
});

test("retains both rounds of feedback after a second revision is approved", async ({ page, baseURL }) => {
  const mobile = await webkit.launch();
  const path = "/c/kestrel/iris/calls/conv_resumed/draft";
  const firstFeedback = "Lead with brake repair. Keep the shop name.";
  const secondFeedback = "Keep Milbrook and preserve the design.";
  try {
    const phone = await mobile.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await Promise.all([signIn(page, "alex@kestrel.example", "alex-test-pass"), signIn(phone, "alex@kestrel.example", "alex-test-pass")]);
    await page.goto(path);
    await page.getByRole("button", { name: "Create draft" }).click();
    for (const [device, feedback] of [[page, firstFeedback], [phone, secondFeedback]] as const) {
      await device.goto(path);
      const card = device.locator("article");
      const before = await card.getAttribute("id");
      await card.getByRole("button", { name: "Request changes" }).click();
      await card.getByRole("textbox").fill(feedback);
      await card.getByRole("button", { name: "Send feedback" }).click();
      await expect(card).not.toHaveAttribute("id", before!);
    }
    await page.goto(path);
    const latest = page.locator("article");
    await expect(latest).toContainText("(revised again)");
    const revisedId = await latest.getAttribute("id");
    await latest.getByRole("button", { name: "Approve this copy" }).click();
    await expect(latest.getByText("Done", { exact: true })).toBeVisible();
    await phone.reload();
    const saved = phone.locator("article");
    await expect(saved).toHaveAttribute("id", revisedId!);
    await saved.getByText("The earlier draft you declined").click();
    await expect(saved.getByText(secondFeedback, { exact: false }).last()).toBeVisible();
    await phone.getByText("Original draft and feedback").click();
    await expect(phone.getByText(firstFeedback, { exact: true })).toBeVisible();
  } finally { await mobile.close(); }
});

test("mobile staff recover from a wrong password and land on the page they asked for", async ({ baseURL }) => {
  const mobile = await webkit.launch();
  try {
    const page = await mobile.newPage({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true });
    const path = "/c/kestrel/iris/calls?topic=Services";
    await page.goto("/sign-in?next=" + encodeURIComponent(path));
    await page.getByLabel("Email", { exact: true }).fill("alex@kestrel.example");
    const password = page.getByLabel("Password", { exact: true });
    await password.fill("alex-wrong-pass");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText(/That email and password don’t match/)).toBeVisible();
    await expect(password).toBeFocused();
    await password.fill("alex-test-pass");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(new URL(path, baseURL).href);
  } finally { await mobile.close(); }
});

test("desktop and mobile can search past an unavailable transcript", async ({ page, baseURL }) => {
  const ios = await webkit.launch();
  try {
    const mobile = await ios.newPage({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true });
    for (const device of [page, mobile]) {
      await signIn(device, "alex@kestrel.example", "alex-test-pass");
      const path = "/c/kestrel/iris/calls?topic=Services&day=2027-01-15&cursor=";
      await device.goto(path + "partial-detail");
      const retry = device.getByRole("link", { name: "Try again" });
      await expect(retry).toHaveAttribute("href", path + "partial-detail");
      await retry.click();
      await expect(device.locator("#conv_beta summary")).toBeVisible();
      const older = device.getByRole("link", { name: "Search older calls" });
      await expect(older).toHaveAttribute("href", path + "after-partial");
      await older.click();
      await device.locator("#conv_resumed summary").click();
      await expect(device.locator("#conv_resumed ol")).toContainText("Services after the interruption");
      await expect(device.locator("#conv_alpha")).toHaveCount(0);
      await expect(device.getByRole("link", { name: "Try again" })).toHaveCount(0);
    }
  } finally { await ios.close(); }
});

test("retrying a saved draft reads the call again after a provider outage", async ({ page, baseURL }) => {
  const ios = await webkit.launch();
  try {
    const mobile = await ios.newPage({ baseURL, viewport: { width: 390, height: 844 }, isMobile: true });
    for (const [device, id] of [[page, "conv_retry_desktop"], [mobile, "conv_retry_mobile"]] as const) {
      await signIn(device, "alex@kestrel.example", "alex-test-pass");
      const path = "/c/kestrel/iris/calls/" + id + "/draft";
      await device.goto(path);
      await device.getByRole("button", { name: "Try again" }).click();
      await expect(device.getByRole("heading", { name: "Services draft" })).toBeVisible();
      await expect(device.getByRole("button", { name: "Create draft" })).toBeVisible();
      await expect(device).toHaveURL(new RegExp(path + "$"));
    }
  } finally { await ios.close(); }
});

test("a saved draft returns staff to the exact source even outside the first History results", async ({ page, baseURL }) => {
  const ios = await webkit.launch();
  try {
    const mobile = await ios.newPage({ baseURL, viewport: { width: 375, height: 812 }, isMobile: true });
    const history = "/c/kestrel/iris/calls";
    for (const device of [page, mobile]) {
      await signIn(device, "alex@kestrel.example", "alex-test-pass");
      await device.goto(history + "/conv_archived_source/draft");
      await device.getByRole("link", { name: "Back to call history" }).click();
      await expect(device.locator("#conv_archived_source ol")).toBeVisible();
      await expect(device.locator("#conv_archived_source ol")).toContainText("Services after the interruption");
      await device.reload();
      await expect(device.locator("#conv_archived_source ol")).toBeVisible();
      await expect(device.locator("details")).toHaveCount(1);
      await device.getByRole("link", { name: "Show calls from this day" }).click();
      await expect(device.locator("#conv_beta summary")).toBeVisible();
      await device.goto(history + "?source=conv_alpha");
      await expect(device.getByText("This call is unavailable.")).toBeVisible();
      await expect(device.locator("details")).toHaveCount(0);
    }
  } finally { await ios.close(); }
});

// End-to-end check of getting a ride: Profile › Connected apps shows Uber, Bolt and inDrive with
// what each really does, and an appointment's Ride button offers all three. Uber opens with the
// destination filled in; Bolt and inDrive copy the destination and open the app's page. People
// paying in naira see Bolt and inDrive first (Uber has left Nigeria).
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

// The test machine can't reach the ride apps' sites, so those pages are answered locally; the
// test only needs the address KROFT opened.
const fakeSites = ctx => ctx.route(/^https:\/\/(m\.uber\.com|bolt\.eu|indrive\.com|play\.google\.com)\//, r => r.fulfill({ status: 200, contentType: "text/html", body: "<title>ok</title>" }));

const server = await startServer();
const browser = await chromium.launch();

async function rideFromAppointment(page) {
  await page.locator('nav button[title="Workspace"]').click();
  await page.getByText("Calendar", { exact: true }).first().click();
  await page.getByRole("button", { name: "New appointment" }).click();
  await page.getByPlaceholder("Title *").fill("Client meeting");
  await page.getByPlaceholder("Time e.g. 4:00 PM").fill("4:00 PM");
  await page.getByPlaceholder("Location").fill("12 Admiralty Way, Lekki");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Ride", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Get a ride" });
}

try {
  const ctx = await newShellContext(browser, null);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
  await fakeSites(ctx);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);

  // Connected apps.
  await page.locator('nav button[title="Profile"]').click();
  await page.getByText("Connected apps", { exact: true }).first().click();
  const text = await page.locator("body").innerText();
  check("Connected apps: Uber as before", text.includes("No connection needed. KROFT opens Uber with your destination filled in, and you book there."));
  check("Connected apps: Bolt, the same way", text.includes("No connection needed. KROFT copies your destination and takes you to Bolt, where you paste it and book."));
  check("Connected apps: inDrive, the same way", text.includes("No connection needed. KROFT copies your destination and takes you to inDrive, where you paste it and book."));

  // From an appointment.
  const ride = await rideFromAppointment(page);
  const order = await ride.getByRole("button", { name: /^Continue to / }).evaluateAll(bs => bs.map(b => b.getAttribute("aria-label")));
  check("Ride offers all three", order.length === 3);
  check("paying in dollars: Uber first", JSON.stringify(order) === JSON.stringify(["Continue to Uber", "Continue to Bolt", "Continue to inDrive"]), JSON.stringify(order));

  let [popup] = await Promise.all([page.waitForEvent("popup"), ride.getByRole("button", { name: "Continue to Uber" }).click()]);
  check("Uber opens with the destination filled in", popup.url().startsWith("https://m.uber.com/ul/") && new globalThis.URL(popup.url()).searchParams.get("dropoff[formatted_address]") === "12 Admiralty Way, Lekki", popup.url());
  await popup.close();

  await page.getByRole("button", { name: "Ride", exact: true }).first().click();
  [popup] = await Promise.all([page.waitForEvent("popup"), page.getByRole("dialog", { name: "Get a ride" }).getByRole("button", { name: "Continue to Bolt" }).click()]);
  check("Bolt (not Android): bolt.eu", popup.url().startsWith("https://bolt.eu"), popup.url());
  await popup.close();
  check("…the destination is copied", (await page.evaluate(() => navigator.clipboard.readText())) === "12 Admiralty Way, Lekki");
  check("…and they're told to paste it", await page.getByText("Destination copied. Paste it in Bolt to book.").waitFor({ timeout: 5000 }).then(() => true, () => false));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // An Android phone, paying in naira.
  console.log("\nAndroid, naira");
  const ng = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" });
  await ng.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL });
  await fakeSites(ng);
  const p2 = await ng.newPage();
  await p2.goto(URL); await signUp(p2);
  // Switch the profile currency to naira.
  await p2.locator('nav button[title="Profile"]').click();
  await p2.getByText("Business", { exact: true }).first().click();
  const cur = p2.locator("select").filter({ has: p2.locator('option[value="NGN"]') }).first();
  await cur.selectOption("NGN");
  await p2.getByRole("button", { name: "Save", exact: true }).click();
  const r2 = await rideFromAppointment(p2);
  const order2 = await r2.getByRole("button", { name: /^Continue to / }).evaluateAll(bs => bs.map(b => b.getAttribute("aria-label")));
  check("paying in naira: Bolt and inDrive first", JSON.stringify(order2) === JSON.stringify(["Continue to Bolt", "Continue to inDrive", "Continue to Uber"]), JSON.stringify(order2));
  [popup] = await Promise.all([p2.waitForEvent("popup"), r2.getByRole("button", { name: "Continue to inDrive" }).click()]);
  check("Android: inDrive's Google Play page (Open starts it)", popup.url().startsWith("https://play.google.com/store/apps/details?id=sinet.startup.inDriver"), popup.url());
  await ng.close();
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

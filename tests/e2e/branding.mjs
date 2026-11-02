// End-to-end check of KROFT Pro branding: on Pro, the business's logo prints at the top of
// invoices and statements and the "Created with KROFT" line is gone; on Free or Plus, adding a
// logo opens the plans instead, and documents keep the KROFT line.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

// The preview image is the PDF page at 2 pixels per point. Reads the darkest pixel and the
// average colour in a box (in points), so the test can see what was drawn where.
const sample = (page, alt, box) => page.evaluate(async ({ alt, box }) => {
  const img = document.querySelector(`img[alt="${alt}"]`);
  await img.decode();
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(box.x * 2, box.y * 2, box.w * 2, box.h * 2).data;
  let min = 255, r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { min = Math.min(min, (d[i] + d[i + 1] + d[i + 2]) / 3); r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return { min, r: r / n, g: g / n, b: b / n };
}, { alt, box });
const LOGO_AREA = { x: 52, y: 40, w: 30, h: 20 };          // inside where a logo is drawn (top-left)
const FOOTER = { x: 595.28 - 48 - 90, y: 841.89 - 42, w: 88, h: 14 };   // where "Created with KROFT" goes

async function openInvoices(page) {
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
}
async function makeInvoice(page) {
  await page.getByRole("button", { name: "New invoice" }).click();
  await page.locator("label", { hasText: "Client name" }).locator("input").fill("Tunde Bakare");
  await page.getByLabel("Item 1 description").fill("Brand design");
  await page.getByLabel("Item 1 price").fill("50000");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.locator('img[alt="Preview of INV-0001"]').waitFor({ timeout: 15000 });
}

const server = await startServer();
const browser = await chromium.launch();
try {
  for (const who of ["Free", "Plus"]) {
    console.log(`\n${who}`);
    const ctx = await newShellContext(browser, null);
    if (who === "Plus") await ctx.addInitScript(() => localStorage.setItem("kroft-e2e-plus", "1"));
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(URL); await signUp(page);
    await openInvoices(page);
    await page.getByRole("button", { name: "Details" }).click();
    check(`${who}: the logo is marked Pro`, await page.getByText("Your logo on documents, without the KROFT line, with KROFT Pro.").isVisible());
    await page.getByRole("button", { name: "Add logo" }).click();
    check(`${who}: Add logo says it's a Pro feature`, await page.getByText("Your logo on invoices is a KROFT Pro feature.").isVisible());
    const sheet = page.getByRole("dialog", { name: "Choose your plan" });
    check(`${who}: …and opens the plans`, await sheet.isVisible());
    check(`${who}: the plans show ${who} as current`, (await sheet.innerText()).includes("CURRENT"));
    await sheet.getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await makeInvoice(page);
    const foot = await sample(page, "Preview of INV-0001", FOOTER);
    check(`${who}: the invoice keeps "Created with KROFT"`, foot.min < 200, JSON.stringify(foot));
    const top = await sample(page, "Preview of INV-0001", LOGO_AREA);
    check(`${who}: no logo printed (the business name sits there instead)`, top.r - top.g < 10, JSON.stringify(top));
    check(`${who}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  console.log("\nPro");
  const ctx = await newShellContext(browser, null);
  await ctx.addInitScript(() => localStorage.setItem("kroft-e2e-pro", "1"));
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await openInvoices(page);
  await page.getByRole("button", { name: "Details" }).click();
  check("Pro: no Pro tag on the logo", await page.getByText("Add it to every invoice, quote, receipt and statement.").isVisible());

  // Not a picture: refused kindly.
  await page.getByLabel("Choose your logo").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  // The message appears once the file has been checked, a moment after it's chosen.
  check("Pro: a file that isn't a picture is refused", await page.getByText("That file isn't a picture KROFT can use. Try a PNG or JPG.").waitFor({ timeout: 5000 }).then(() => true, () => false));

  // A red 300×100 logo.
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 300; c.height = 100; const x = c.getContext("2d"); x.fillStyle = "#d01010"; x.fillRect(0, 0, 300, 100); return c.toDataURL("image/png").split(",")[1]; });
  await page.getByLabel("Choose your logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.getByAltText("Your logo").waitFor({ timeout: 5000 });
  check("Pro: the logo shows in Invoice details", await page.getByRole("button", { name: "Change" }).isVisible() && await page.getByRole("button", { name: "Remove" }).isVisible());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await makeInvoice(page);
  const top = await sample(page, "Preview of INV-0001", LOGO_AREA);
  check("Pro: the logo prints at the top of the invoice", top.r > 150 && top.g < 90 && top.b < 90, JSON.stringify(top));
  const foot = await sample(page, "Preview of INV-0001", FOOTER);
  check('Pro: no "Created with KROFT" line', foot.min > 235, JSON.stringify(foot));

  // The PDF itself downloads as before.
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share (or download )?PDF/ }).click()]);
  const chunks = []; for await (const c of await dl.createReadStream()) chunks.push(c);
  check("Pro: the PDF downloads", Buffer.concat(chunks).toString("latin1").startsWith("%PDF-1.4"));

  // Statement (Pro includes Plus): logo too.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("tab", { name: "Clients" }).click();
  await page.getByText("Tunde Bakare").first().click();
  await page.getByRole("button", { name: "Statement of account" }).click();
  const alt = "Preview of the statement for Tunde Bakare";
  await page.locator(`img[alt="${alt}"]`).waitFor({ timeout: 15000 });
  const st = await sample(page, alt, LOGO_AREA);
  check("Pro: the logo prints on statements", st.r > 150 && st.g < 90 && st.b < 90, JSON.stringify(st));

  // Removing it.
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Details" }).click();
  await page.getByRole("button", { name: "Remove" }).click();
  check("Pro: Remove takes the logo off", await page.getByRole("button", { name: "Add logo" }).isVisible());
  check("Pro: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failureCount() ? `\n${failureCount()} FAILED` : "\nALL PASSED");
if (failureCount()) process.exit(1);

// End-to-end check of Scan receipt (Finance › Scan receipt): a photo goes to KROFT's AI (mocked
// here), what it read is shown to check, and it becomes an expense in the receipt's currency
// and category, or a bill to pay; plus what happens when it isn't a receipt or the AI is down.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

// A real (tiny) PNG, so the photo can be shrunk like a camera photo would be.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
const reply = obj => ({ status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(obj) }] }) });
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = n => ymd(new Date(Date.now() + n * 86400000));

const server = await startServer();
const browser = await chromium.launch();
try {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  let next = null, sent = null;
  await page.route("**/api/chat", async route => { sent = { usage: route.request().headers()["x-kroft-usage-type"], body: route.request().postDataJSON() }; await route.fulfill(next); });
  await page.goto(URL); await signUp(page);
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  const scan = async () => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Scan receipt" }).click()]);
    await chooser.setFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  };
  check("Finance has a Scan receipt button", await page.getByRole("button", { name: "Scan receipt" }).isVisible());

  // A paid receipt → expense.
  next = reply({ receipt: true, merchant: "Shoprite Lekki", date: inDays(-1), total: 12500, currency: "NGN", category: "Operations", due: "" });
  await scan();
  const sheet = page.getByRole("dialog", { name: "Scanned receipt" });
  await sheet.getByText("Shoprite Lekki").waitFor({ timeout: 10000 });
  const t = await sheet.innerText();
  check("shows what it read, to check", t.includes("₦12,500.00") && t.includes("Operations") && t.includes("Check it before you save"), t);
  check("the photo went to the AI as an image, counted as vision", sent?.usage === "vision" && sent.body.messages[0].content[0].type === "image" && sent.body.messages[0].content[0].source.media_type === "image/jpeg");
  await sheet.getByRole("button", { name: "Add as expense (paid)" }).click();
  check("opens the expense form filled in", await page.locator('input[value="Shoprite Lekki"]').isVisible());
  await page.getByRole("button", { name: /^(Add|Save)( Expense)?$/ }).last().click();
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("kroft:finance") || "null")?.expenses || []).length === 1, null, { timeout: 5000 }).catch(() => {});
  const exp = (await page.evaluate(() => JSON.parse(localStorage.getItem("kroft:finance") || "null")))?.expenses?.[0];
  check("saved as an expense in the receipt's currency, date and category", exp?.label === "Shoprite Lekki" && exp.amount === 12500 && exp.cur === "NGN" && exp.cat === "Operations" && exp.date === inDays(-1), JSON.stringify(exp));

  // An unpaid bill → bill to pay.
  next = reply({ receipt: true, merchant: "Ikeja Electric", date: inDays(-2), total: 45000, currency: "USD", category: "Utilities", due: inDays(5) });
  await scan();
  await sheet.getByText("Ikeja Electric").waitFor({ timeout: 10000 });
  check("a bill with a due date offers 'bill to pay' first", (await sheet.getByRole("button").allInnerTexts()).filter(x => /bill|expense/.test(x))[0] === "Save as a bill to pay");
  await sheet.getByRole("button", { name: "Save as a bill to pay" }).click();
  check("saved as a bill, and Bills opens", await page.getByRole("dialog", { name: "Bills" }).getByText("Ikeja Electric").first().isVisible() && await page.getByText("Due in 5 days").first().isVisible());
  await page.getByRole("dialog", { name: "Bills" }).getByRole("button", { name: "Back" }).click();

  // Not a receipt, and the AI down.
  next = reply({ receipt: false });
  await scan();
  check("not a receipt: says so", await page.getByText("That doesn't look like a receipt.").first().isVisible({ timeout: 5000 }).catch(() => false) || await page.getByText("That doesn't look like a receipt.").first().waitFor({ timeout: 5000 }).then(() => true, () => false));
  next = { status: 403, headers: { "Content-Type": "application/json" }, body: "{}" };
  await scan();
  check("AI unavailable: suggests adding it by hand", await page.getByText(/Couldn't read the receipt right now/).first().waitFor({ timeout: 5000 }).then(() => true, () => false));
  next = { status: 429, headers: { "Content-Type": "application/json" }, body: "{}" };
  await scan();
  check("daily limit reached: the plans open", await page.getByRole("dialog", { name: "Choose your plan" }).waitFor({ timeout: 5000 }).then(() => true, () => false));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

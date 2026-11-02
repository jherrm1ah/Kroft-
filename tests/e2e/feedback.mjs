// End-to-end check of in-app feedback: the button in the top bar and Profile › Send feedback
// open the same sheet; what's sent includes the kind, the message, the screen it was sent from
// and the app version; and if KROFT's server can't take it, the person is told it's going by
// email instead.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();
try {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const sent = [];
  let status = 200;
  await page.route("**/api/feedback", async route => { sent.push({ body: route.request().postDataJSON(), client: route.request().headers()["x-kroft-client"] }); await route.fulfill({ status, body: status === 200 ? '{"ok":true}' : "{}" }); });
  await page.goto(URL); await signUp(page);

  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: "Send feedback" }).click();
  const sheet = page.getByRole("dialog", { name: "Send feedback" });
  check("the top bar's ? opens the feedback sheet, noting the screen", await sheet.isVisible() && await sheet.getByText("Sent from Finance").isVisible());
  check("Send waits for a few words", await sheet.getByRole("button", { name: "Send" }).isDisabled());
  await sheet.getByRole("radio", { name: "An idea" }).click();
  await sheet.getByLabel("Your feedback").fill("Let me split one expense across two categories.");
  await sheet.getByRole("button", { name: "Send" }).click();
  await page.getByText("Thanks. Your feedback reached the KROFT team.").waitFor({ timeout: 5000 });
  check("sent with its kind, the words, the screen and the app version", sent[0]?.body.kind === "idea" && sent[0].body.message === "Let me split one expense across two categories." && sent[0].body.screen === "Finance" && typeof sent[0].client === "string", JSON.stringify(sent[0]));
  check("the sheet closes after sending", !(await sheet.isVisible()));

  // From Profile, and when the server can't take it.
  status = 500;
  await page.locator('nav button[title="Profile"]').click();
  await page.getByText("Send feedback", { exact: true }).click();
  check("Profile › Send feedback opens the same sheet", await sheet.isVisible() && await sheet.getByText("Sent from Profile").isVisible());
  await sheet.getByLabel("Your feedback").fill("The export button is hard to find.");
  await sheet.getByRole("button", { name: "Send" }).click();
  check("if the server can't take it, it goes by email instead", await page.getByText("Opening your email app to send it instead.").waitFor({ timeout: 5000 }).then(() => true, () => false) && sent[1]?.body.kind === "problem");
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

// End-to-end check of invoices: asking KROFT for one, the invoice screens, the PDF, getting paid,
// and sharing the PDF from the Android app (current and older APKs). The AI's reply is faked
// (/api/chat is answered by the test), so no account or network is needed.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DUE = iso(new Date(Date.now() + 30 * 86400000));

// A streamed reply in the shape /api/chat sends, ending with an action block.
const sse = (text, action) => {
  const full = `${text}<action>${JSON.stringify(action)}</action>`;
  const chunks = full.match(/[\s\S]{1,40}/g).map(t => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n\n`);
  return `${chunks.join("")}data: [DONE]\n\n`;
};

async function askKroft(page, message) {
  await page.getByRole("button", { name: /Ask Kroft/i }).first().click();
  const box = page.locator("textarea").last();
  await box.fill(message);
  await box.press("Enter");
}

async function openInvoices(page) {
  const closeChat = page.getByRole("button", { name: "Close Ask Kroft" });
  if (await closeChat.isVisible().catch(() => false)) await closeChat.click();
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
}

const pdfFromDownload = async dl => {
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks).toString("latin1");
};

async function website(browser) {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const prompts = [];
  let reply = null;
  await page.route("**/api/chat", async route => {
    prompts.push(route.request().postDataJSON()?.system || "");
    await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: reply });
  });
  await page.goto(URL);
  await signUp(page);

  // 1. Asking KROFT drafts an invoice.
  reply = sse("I've drafted that invoice for Tunde. Review it in Invoices and send it when you're ready.",
    { type: "add_invoice", client: "Tunde Bakare", items: [{ description: "Logo design", qty: 1, price: 50000 }], due: DUE });
  await askKroft(page, "Invoice Tunde Bakare 50,000 for the logo design");
  const drafted = await page.getByText(/Invoice INV-0001 drafted for Tunde Bakare/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("asking KROFT drafts INV-0001", drafted);
  check("KROFT is told about invoices and the add_invoice action", prompts.length > 0 && prompts[0].includes('"type":"add_invoice"') && prompts[0].includes("Invoices: 0 invoices on record"), prompts[0]?.slice(0, 80));
  check("the action block isn't shown in the reply", !(await page.locator("body").innerText()).includes("<action>"));

  // 2. It's in Finance › Invoices, with a preview.
  await openInvoices(page);
  await page.getByText("Tunde Bakare").first().click();
  const previewShown = await page.getByAltText(/Preview of INV-0001/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("invoice opens with a PDF preview", previewShown);
  const body = await page.locator("body").innerText();
  check("draft shows its total and due date", /50,000\.00/.test(body) && /DRAFT/.test(body), body.slice(0, 200));

  // 3. The PDF.
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share or download PDF/ }).click()]);
  const pdf = await pdfFromDownload(dl);
  check("PDF downloads with a readable name", dl.suggestedFilename() === "INV-0001 Tunde Bakare.pdf", dl.suggestedFilename());
  check("PDF is a valid one-page PDF", pdf.startsWith("%PDF-1.4") && /\/Count 1\b/.test(pdf) && pdf.trimEnd().endsWith("%%EOF"));
  check("sharing marks it sent", await page.getByText("SENT").first().isVisible());

  // 4. Getting paid: a deposit on an earlier date, then the rest. Each payment is income.
  const earlier = iso(new Date(Date.now() - 3 * 86400000));
  const amountBox = page.locator("label", { hasText: "Amount received" }).locator("input");
  const dateBox = page.locator("label", { hasText: "Date received" }).locator("input");
  await page.getByRole("button", { name: "Record payment" }).click();
  check("payment form offers the full balance", await amountBox.inputValue() === "50000");
  await amountBox.fill("20000");
  await dateBox.fill(earlier);
  await page.getByRole("button", { name: "Save payment" }).click();
  check("a deposit leaves it part paid with the balance shown", await page.getByText("PART PAID").first().isVisible() && await page.getByText(/30,000\.00 left/).first().isVisible());
  check("an invoice with payments can't be edited", !(await page.getByRole("button", { name: "Edit" }).isVisible()));
  await page.getByRole("button", { name: "Record payment" }).click();
  check("next payment offers what's left", await amountBox.inputValue() === "30000");
  await page.getByRole("button", { name: "Save payment" }).click();
  check("paid in full", await page.getByText("PAID", { exact: true }).first().isVisible());
  // Finance data is saved about a second after a change.
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("kroft:finance") || "null")?.invoices || []).some(i => i.status === "paid"), null, { timeout: 5000 }).catch(() => {});
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kroft:finance") || "null"));
  const inv = saved?.invoices?.find(i => i.number === "INV-0001");
  const incomes = (inv?.payments || []).map(p => saved.income.find(x => x.id === p.incomeId));
  check("each payment is in income, on the day it arrived", incomes.length === 2 && incomes[0]?.amount === 20000 && incomes[0]?.date === earlier && incomes[0]?.label.includes("part payment") && incomes[1]?.amount === 30000 && incomes.every(x => x?.cat === "Invoice"), JSON.stringify(incomes));

  // 5. A long invoice spills onto more pages.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  reply = sse("Done, it's drafted.", { type: "add_invoice", client: "Ọlá Stores", items: Array.from({ length: 40 }, (_, i) => ({ description: `Item ${i + 1}: supply and delivery of goods to the Ikeja warehouse`, qty: 2, price: 1500 })) });
  await askKroft(page, "Invoice Ọlá Stores for the 40 supplies");
  await page.getByText(/Invoice INV-0002 drafted/).waitFor({ timeout: 10000 }).catch(() => {});
  await openInvoices(page);
  await page.getByText("Ọlá Stores").first().click();
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share or download PDF/ }).click()]);
  const pdf2 = await pdfFromDownload(dl2);
  const pages = Number((pdf2.match(/\/Count (\d+)/) || [])[1]);
  check("40-item invoice runs to several pages", pages >= 2, `pages=${pages}`);

  // 6. Quote → accepted → invoice → paid.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: "Quotes" }).click();
  await page.getByRole("button", { name: "New quote" }).click();
  await page.locator("label", { hasText: "Client name" }).locator("input").fill("Chidi Okafor");
  await page.locator("label", { hasText: "Phone" }).locator("input").fill("08099998888");
  await page.getByLabel("Item 1 description").fill("Company website");
  await page.getByLabel("Item 1 price").fill("300000");
  await page.getByRole("button", { name: "Save quote" }).click();
  check("quote saved as QUO-0001", await page.getByRole("heading", { name: "QUO-0001" }).isVisible());
  const [qdl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share or download PDF/ }).click()]);
  const qpdf = await pdfFromDownload(qdl);
  check("quote PDF is titled as a quote", qpdf.includes("/Title (Quote QUO-0001)") && qdl.suggestedFilename() === "QUO-0001 Chidi Okafor.pdf", qdl.suggestedFilename());
  await page.getByRole("button", { name: "Client accepted" }).click();
  check("quote accepted", await page.getByText("ACCEPTED").first().isVisible());
  await page.getByRole("button", { name: "Turn into invoice" }).click();
  check("accepted quote becomes the next invoice, INV-0003", await page.getByRole("heading", { name: "INV-0003" }).isVisible() && await page.getByText("From quote QUO-0001.").isVisible());
  const [idl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share or download PDF/ }).click()]);
  await idl.cancel().catch(() => {});
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.getByRole("button", { name: "Save payment" }).click();
  check("invoice from the quote is paid", await page.getByText("PAID", { exact: true }).first().isVisible());

  // 7. Clients: who owes what.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: "Clients" }).click();
  const clientsText = await page.locator("body").innerText();
  const order = ["Ọlá Stores", "Chidi Okafor", "Tunde Bakare"].map(n => clientsText.indexOf(n));
  check("clients listed, the one who owes first", order.every(i => i >= 0) && order[0] < order[1] && order[0] < order[2], JSON.stringify(order));
  check("client balances shown", /OWES YOU/.test(clientsText) && /All paid/.test(clientsText));
  await page.getByText("Chidi Okafor").first().click();
  const chidiText = await page.locator("body").innerText();
  check("client page shows paid total and both documents", /300,000\.00/.test(chidiText) && chidiText.includes("QUO-0001") && chidiText.includes("INV-0003"), chidiText.slice(0, 300));
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem("kroft:contacts") || "null")?.contacts || JSON.parse(localStorage.getItem("kroft:contacts") || "[]")) && true, null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const contactNames = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("kroft:contacts") || "null")));
  check("new client saved to Contacts", contactNames.includes("Chidi Okafor") && contactNames.includes("08099998888"), contactNames.slice(0, 200));

  // 8. Asking KROFT for a quote.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  reply = sse("Here's a quote for Bisi, ready to review.", { type: "add_quote", client: "Bisi", items: [{ description: "Photo shoot", qty: 1, price: 75000 }] });
  await askKroft(page, "Quote Bisi 75k for the photo shoot");
  check("asking KROFT drafts QUO-0002", await page.getByText(/Quote QUO-0002 drafted for Bisi/).waitFor({ timeout: 10000 }).then(() => true, () => false));
  check("KROFT is told about quotes and who owes money", prompts.at(-1).includes('"type":"add_quote"') && prompts.at(-1).includes("Clients who owe money: Ọlá Stores"), prompts.at(-1).match(/Clients who owe money:[^\n]*/)?.[0]);

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

async function androidShare(browser, label, shell) {
  console.log(`\n${label}`);
  const ctx = await newShellContext(browser, shell);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL);
  await signUp(page);
  await openInvoices(page);
  await page.getByRole("button", { name: "New invoice" }).click();
  await page.locator("label", { hasText: "Client name" }).locator("input").fill("Chidi");
  await page.getByLabel("Item 1 description").fill("Website");
  await page.getByLabel("Item 1 price").fill("120000");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.getByRole("button", { name: "Share PDF" }).click();
  await page.waitForTimeout(2500);
  const calls = await page.evaluate(() => window.__calls);
  const args = await page.evaluate(() => window.__args || {});
  if (shell.plugins.includes("Filesystem")) {
    const w = args["Filesystem.writeFile"] || {};
    check("PDF is written to the phone as a binary file", calls.includes("Filesystem.writeFile") && w.path === "exports/INV-0001 Chidi.pdf" && !w.encoding && typeof w.data === "string" && w.data.startsWith("JVBERi0"), JSON.stringify({ path: w.path, encoding: w.encoding, start: String(w.data).slice(0, 8) }));
    const sh = args["Share.share"] || {};
    check("then handed to the share sheet with a message", calls.includes("Share.share") && sh.files?.length === 1 && String(sh.text).includes("INV-0001"), JSON.stringify(sh).slice(0, 160));
  } else {
    check("an APK without file saving is told to update", await page.getByText("Update the KROFT app to share PDFs.").isVisible());
  }
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  await website(browser);
  for (const [label, shell] of Object.entries(SHELLS)) await androidShare(browser, label, shell);
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);

// Tests the error log: cleaning out personal data, ignoring noise, counting repeats, batching,
// and the server's checks. Run with: npm test
import { scrub, scrubStack, toEntry, createLog } from "./errorLog.js";
import { toRows } from "../api/log-error.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

eq("emails, numbers and links' query strings are removed", scrub("Failed for ada@example.com paying 250000 to 0803 123 4567 at /api/x?token=abc"), "Failed for [email] paying [number] to [number] at /api/x");
eq("tokens and pasted files are removed", scrub("bad eyJhbGciOi.eyJzdWIiOi.sig and data:image/png;base64,iVBORw0KGgo="), "bad [token] and [data]");
eq("long text is cut", scrub("x".repeat(500)).length, 300);
eq("stack: site address dropped, 12 lines at most", scrubStack("Error: x\n at f (https://kroft-pied.vercel.app/assets/index-ab12.js:1:200)\n" + " at g (a.js:1:1)\n".repeat(20)).split("\n").length, 12);
eq("stack keeps file and line", scrubStack("at f (https://kroft-pied.vercel.app/assets/index-ab12.js:1:200)"), "at f (/assets/index-ab12.js:1:200)");

const e = toEntry("error", { message: "Cannot read properties of undefined (reading 'amount')", filename: "https://kroft-pied.vercel.app/assets/index-ab12.js", lineno: 1, colno: 99, stack: "TypeError: x\n at y (https://kroft-pied.vercel.app/assets/index-ab12.js:1:99)" }, { path: "/finance?x=1" });
eq("an error becomes a clean entry", [e.kind, e.message, e.source, e.path], ["error", "Cannot read properties of undefined (reading 'amount')", "/assets/index-ab12.js:1:99", "/finance"]);
eq("a script address with a version tag keeps its line", toEntry("error", { message: "x", filename: "https://kroft-pied.vercel.app/assets/a.js?v=3", lineno: 4, colno: 2 }).source, "/assets/a.js:4:2");
eq("noise is ignored", ["ResizeObserver loop completed with undelivered notifications.", "Script error.", "The user aborted a request."].map(m => toEntry("error", { message: m })), [null, null, null]);
eq("a crash keeps React's component trace", toEntry("crash", new Error("boom"), { stack: "Error: boom\n in InvoicesScreen" }).stack, "Error: boom\nin InvoicesScreen");

// Repeats counted, batches of 10, a limit on different errors per session.
const sent = [];
const log = createLog({ send: b => sent.push(b), maxDistinct: 12 });
for (let i = 0; i < 3; i++) log.add(toEntry("error", { message: "same thing" }));
for (let i = 0; i < 15; i++) log.add(toEntry("error", { message: `different ${i}` }));
eq("the same error is one entry with a count", log.flush().find(x => x.message === "same thing").count, 3);
eq("batches of at most 10", [sent[0].length, log.flush().length], [10, 2]);
eq("at most this many different errors per session", log.flush(), null);
log.add(toEntry("error", { message: "same thing" }));
eq("a repeat after sending is sent again, counted from then", log.flush().map(x => [x.message, x.count]), [["same thing", 1]]);

// The server's checks.
const rows = toRows({ client: "web;v=1", errors: [
  { kind: "error", message: "oops ada@example.com", source: "a.js:1:1", stack: "at f (https://x.y/a.js:1:1)", path: "/home?q=1", count: 4 },
  { kind: "hack", message: "not a kind we take" },
  { kind: "save", message: "" },
  ...Array.from({ length: 20 }, (_, i) => ({ kind: "promise", message: `p${i}` })),
] }, { userId: "u1", clientHeader: "android;shell=1.2.0" });
eq("server: only known kinds, at most 10 per request", rows.length, 8);
eq("server: cleaned again, header's client wins, count kept", [rows[0].message, rows[0].stack, rows[0].path, rows[0].client, rows[0].count, rows[0].user_id], ["oops [email]", "at f (/a.js:1:1)", "/home", "android;shell=1.2.0", 4, "u1"]);
eq("server: nonsense in, nothing stored", [toRows(null).length, toRows({ errors: "x" }).length, toRows({ errors: [{ kind: "error", count: 99999, message: "m" }] })[0].count], [0, 0, 1000]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);

// Unit tests for the calculation check. Run with: npm test
import { parseBlocks } from "./parse.js";
import { parseAmount, verifyBlocks, formatAmountLike } from "./verify.js";

let fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log("FAIL", name, "\n  got ", g, "\n  want", w); } else console.log("ok  ", name);
};
const issues = md => [...verifyBlocks(parseBlocks(md)).values()].map(i => ({ where: i.where, expected: Math.round(i.expected * 100) / 100, stated: i.stated }));

eq("amount: currency + unicode minus", parseAmount("−₦60,300.00"), { value: -60300, signed: true });
eq("amount: plus", parseAmount("+₦3,300.00"), { value: 3300, signed: true });
eq("amount: bold, unsigned", parseAmount("**₦297,862.50**"), { value: 297862.5, signed: false });
eq("amount: parentheses negative", parseAmount("(1,000)"), { value: -1000, signed: true });
eq("amount: code prefix", parseAmount("USD 1,200.50"), { value: 1200.5, signed: false });
eq("amount: hyphen minus", parseAmount("-$20"), { value: -20, signed: true });
eq("amount: percent is not money", parseAmount("18%"), null);
eq("amount: words", parseAmount("n/a"), null);
eq("amount: 1.5k skipped", parseAmount("₦1.5k"), null);

const GOOD = "```result\nFinal balance\n₦297,862.50\n```\n\n| Step | Amount |\n| --- | ---: |\n| Initial balance | ₦335,000.00 |\n| 18% expenditure | −₦60,300.00 |\n| Addition | +₦40,000.00 |\n| Withdrawal | −₦27,500.00 |\n| 12% refund | +₦3,300.00 |\n| Expenditure | −₦35,000.00 |\n| Addition | +₦50,000.00 |\n| 2.5% transaction fee | −₦7,637.50 |\n| **Final balance** | **₦297,862.50** |";
eq("correct calculation passes", issues(GOOD), []);
eq("wrong total row is caught", issues(GOOD.replace("| **₦297,862.50** |", "| **₦299,862.50** |")), [{ where: "total", expected: 297862.5, stated: 299862.5 }]);
eq("wrong step makes total disagree", issues(GOOD.replace("+₦40,000.00", "+₦45,000.00")), [{ where: "total", expected: 302862.5, stated: 297862.5 }]);
eq("headline differs from table", issues(GOOD.replace("```result\nFinal balance\n₦297,862.50", "```result\nFinal balance\n₦279,862.50")), [{ where: "result", expected: 297862.5, stated: 279862.5 }]);
eq("cent rounding tolerated", issues(GOOD.replace("−₦7,637.50", "−₦7,637.49")), []);

const RUNNING = "| Step | Change | Balance |\n|---|---:|---:|\n| Opening | | ₦1,000.00 |\n| Groceries | −₦250.00 | ₦750.00 |\n| Salary | +₦2,000.00 | ₦2,750.00 |\n| Closing balance | | ₦2,750.00 |";
eq("running balance passes", issues(RUNNING), []);
eq("running balance row mismatch", issues(RUNNING.replace("| ₦750.00 |", "| ₦700.00 |")), [{ where: "row", expected: 750, stated: 700 }]);

eq("breakdown total passes", issues("| Category | Spent |\n|---|---:|\n| Rent | ₦50,000 |\n| Food | ₦20,000 |\n| Transport | ₦7,500 |\n| **Total** | **₦77,500** |"), []);
eq("breakdown total wrong", issues("| Category | Spent |\n|---|---:|\n| Rent | ₦50,000 |\n| Food | ₦20,000 |\n| Total | ₦80,000 |"), [{ where: "total", expected: 70000, stated: 80000 }]);
eq("income/expenses/balance not summed", issues("| Item | Amount |\n|---|---|\n| Income | ₦100,000 |\n| Expenses | ₦60,000 |\n| Balance | ₦40,000 |"), []);
eq("net profit row not summed", issues("| Item | Amount |\n|---|---|\n| Revenue | $900 |\n| Costs | $400 |\n| Net profit | $500 |"), []);
eq("no total row: not checked", issues("| Item | Amount |\n|---|---|\n| A | ₦10 |\n| B | −₦2 |\n| C | +₦3 |"), []);
eq("percent column: not checked", issues("| Step | Rate |\n|---|---|\n| Start | 10% |\n| Add | +5% |\n| Total | 99% |"), []);
eq("two tables checked separately", issues(GOOD + "\n\nAnd separately:\n\n| Step | Amount |\n|---|---|\n| Start | $100 |\n| Fee | −$10 |\n| Total | $95 |"), [{ where: "total", expected: 90, stated: 95 }]);

eq("format like ₦ with decimals", formatAmountLike("₦297,862.50", 297862.5), "₦297,862.50");
eq("format negative dollars", formatAmountLike("$95", -12), "−$12");
eq("format with code", formatAmountLike("USD 1,200.50", 1200.5), "USD 1,200.50");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);

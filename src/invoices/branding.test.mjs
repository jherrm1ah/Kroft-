// Tests KROFT Pro branding on documents. Run with: npm test
import { brandingFor, logoSize, isLogo, LOGO_BOX, LOGO_MAX_CHARS } from "./branding.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

const LOGO = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
eq("a JPEG or PNG data URL is a logo", [isLogo(LOGO), isLogo("data:image/png;base64,iVBORw0KGgo=")], [true, true]);
eq("anything else isn't", [isLogo(""), isLogo(null), isLogo("https://example.com/logo.png"), isLogo("data:image/svg+xml;base64,PHN2Zz4="), isLogo("data:image/jpeg;base64,<script>")], [false, false, false, false, false]);
eq("a logo too big to sync isn't", isLogo(`data:image/jpeg;base64,${"A".repeat(LOGO_MAX_CHARS)}`), false);

eq("Pro: the logo, no KROFT line", brandingFor("pro", { logo: LOGO }), { logo: LOGO, footer: false });
eq("Pro without a logo: still no KROFT line", brandingFor("pro", {}), { logo: "", footer: false });
eq("Plus: no logo, KROFT line stays", brandingFor("plus", { logo: LOGO }), { logo: "", footer: true });
eq("Free: no logo, KROFT line stays", brandingFor("free", { logo: LOGO }), { logo: "", footer: true });
eq("no plan given: treated as Free", brandingFor(undefined, { logo: LOGO }), { logo: "", footer: true });
eq("Pro with a broken logo: no logo", brandingFor("pro", { logo: "not a picture" }), { logo: "", footer: false });

eq("a wide logo fits the box's width", logoSize(600, 200), { width: LOGO_BOX.width, height: 50 });
eq("a tall logo fits the box's height", logoSize(200, 400), { width: 28, height: LOGO_BOX.height });
eq("a small logo isn't enlarged", logoSize(40, 20), { width: 40, height: 20 });
eq("a picture with no size draws nothing", logoSize(0, 0), { width: 0, height: 0 });

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);

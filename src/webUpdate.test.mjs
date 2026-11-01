// Tests the "reload into the newer version" decision in webUpdate.js. Run with: npm test
globalThis.window = globalThis.window || { location: { origin: "https://kroft-pied.vercel.app" } };
const { shouldReload, latestBuild } = await import("./webUpdate.js");
let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

const base = { running: "abc123", latest: "def456", awayMs: 11 * 60 * 1000, typing: false, alreadyReloadedFor: null };
eq("newer version after a long absence reloads", shouldReload(base), true);
eq("same version stays", shouldReload({ ...base, latest: "abc123" }), false);
eq("short absence stays", shouldReload({ ...base, awayMs: 60 * 1000 }), false);
eq("someone typing keeps their page", shouldReload({ ...base, typing: true }), false);
eq("no reload loop for the same version", shouldReload({ ...base, alreadyReloadedFor: "def456" }), false);
eq("unknown latest stays", shouldReload({ ...base, latest: null }), false);
eq("local and dev builds never reload", [shouldReload({ ...base, running: "dev" }), shouldReload({ ...base, running: "local-xyz" })], [false, false]);

const fakeFetch = body => async () => ({ ok: true, json: async () => body });
eq("reads build from version.json", await latestBuild(fakeFetch({ build: "def456" })), "def456");
eq("ignores a malformed version.json", await latestBuild(fakeFetch({ nope: 1 })), null);
eq("ignores a failed request", await latestBuild(async () => ({ ok: false })), null);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);

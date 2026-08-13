// Checks that can only fail at load time, not at parse time.
//
// Content scripts listed in the manifest all evaluate in ONE shared global
// scope. `node --check` parses each file alone and so cannot see a top-level
// `const JR` colliding across two of them — that only shows up as a runtime
// SyntaxError in the browser, where every script after the first silently
// fails to load. This reproduces that shared scope.
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const files = manifest.content_scripts[0].js;

let pass = 0;
let fail = 0;
const check = (ok, label, extra) => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
};

// --- 1. every content script coexists in one global scope -------------------
const ctx = vm.createContext({ console });
vm.runInContext(
  `var window = this;
   var location = { origin: "https://x.atlassian.net", host: "x.atlassian.net" };
   var chrome = { runtime: { id: "test", onMessage: { addListener() {} }, getURL: (s) => s },
                  storage: { local: { get(k, cb) { cb({}); }, set() {} } } };
   var setTimeout = () => 0, clearTimeout = () => {}, ResizeObserver = null;
   var navigator = { clipboard: {} };
   var document = {
     createElement: () => ({ style: {}, setAttribute() {}, appendChild() {},
       attachShadow: () => ({ appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }) }),
     documentElement: { appendChild() {} }, getElementById: () => null,
     body: { appendChild() {} }, addEventListener() {} };`,
  ctx
);

for (const f of files) {
  try {
    new vm.Script(fs.readFileSync(path.join(root, f), "utf8"), { filename: f }).runInContext(ctx);
    check(true, `loads in shared scope: ${f}`);
  } catch (err) {
    check(false, `loads in shared scope: ${f}`, err.message);
  }
}

const namespaces = vm.runInContext("Object.keys(window.JR).sort().join(',')", ctx);
check(namespaces === "api,query,reports,util", "all namespaces registered", namespaces);

// --- 2. background.js injects exactly what the manifest declares ------------
// The toolbar button re-injects these when no live content script answers. If
// the two lists drift apart, self-healing injects a broken subset.
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
const match = bg.match(/const FILES = (\[[\s\S]*?\]);/);
check(!!match, "background.js declares a FILES list");
if (match) {
  const listed = JSON.parse(match[1].replace(/'/g, '"'));
  check(JSON.stringify(listed) === JSON.stringify(files), "background.js FILES matches manifest", JSON.stringify(listed));
}

// --- 3. background.js must not reference content-script-only globals --------
check(!/\bdocument\.[a-z]/i.test(bg.replace(/func: \([\s\S]*?\},/g, "")), "background.js keeps DOM access inside injected funcs");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

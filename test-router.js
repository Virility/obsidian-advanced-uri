// Router test: confirm chooseHandler dispatches insertatcursor correctly and
// that the new branch does not steal traffic from existing parameters.
const fs = require("fs");
const src = fs.readFileSync("main.js", "utf8");

const start = src.indexOf("async chooseHandler(e,t){");
const end = src.indexOf("async hookSuccess(");
if (start < 0 || end < 0 || end < start) throw new Error("could not locate router");
const routerSrc = src.slice(start, end);
console.log("extracted router: " + routerSrc.length + " chars");

const fnSrc = "async function" + routerSrc.slice("async chooseHandler".length);

// Every handler name the router can call, so unexpected routing is visible.
const names = [
  "handleReveal", "handlePluginManagement", "handleWorkspace", "handleCommand",
  "handleFrontmatterKey", "handleBookmarks", "handleRemovedEval", "handleDoesFileExist",
  "handleCanvas", "handleInsertAtCursor", "handleWrite", "handleOpen",
  "handleSearchAndReplace", "handleSearch", "handleOpenBlock", "handleOpenSettings",
  "handleUpdatePlugins",
];



const factory = new Function("return (" + fnSrc + ")");
const chooseHandler = factory();

function makeSelf(calls) {
  const handlers = {};
  for (const n of names) handlers[n] = async (p) => { calls.push(n); };
  return {
    handlers,
    app: {},
    // Ce(this.app) only runs for await-sync=true, which we do not exercise.
    plugin: {},
    // the router recurses into itself for heading/block positioning
    chooseHandler: (params, isNew) => chooseHandler.call(makeSelf(calls), params, isNew),
    success() {}, failure() {},
  };
}

let failures = 0;
function check(label, got, want) {
  if (got === want) console.log("  PASS  " + label + "  -> " + got);
  else { console.log("  FAIL  " + label + "  -> got " + got + ", want " + want); failures++; }
}

(async () => {
  const cases = [
    ["insertatcursor routes to handler", { insertatcursor: "hi" }, "handleInsertAtCursor"],
    ["insertatcursor wins over plain filepath", { insertatcursor: "hi", filepath: "a.md" }, "handleInsertAtCursor"],
    ["empty insertatcursor still routes", { insertatcursor: "" }, "handleInsertAtCursor"],
    ["insertatcursor wins over data", { insertatcursor: "hi", data: "x" }, "handleInsertAtCursor"],
    ["data alone still routes to write", { data: "x" }, "handleWrite"],
    ["filepath alone still opens", { filepath: "a.md" }, "handleOpen"],
    ["search still works", { search: "s" }, "handleSearch"],
    ["searchregex+replace still works", { searchregex: "/a/", replace: "b" }, "handleSearchAndReplace"],
    ["canvas still works", { canvasnodes: "x" }, "handleCanvas"],
    ["bookmark still works", { bookmark: "b" }, "handleBookmarks"],
    ["frontmatterkey still works", { frontmatterkey: "k" }, "handleFrontmatterKey"],
    ["exists still works", { filepath: "a.md", exists: "true" }, "handleDoesFileExist"],
  ];

  for (const [label, params, want] of cases) {
    const calls = [];
    await chooseHandler.call(makeSelf(calls), { ...params }, false);
    check(label, calls[0] || "(none)", want);
  }

  // heading/block + insertatcursor: router positions first, then recurses to insert
  const calls = [];
  await chooseHandler.call(makeSelf(calls), { insertatcursor: "hi", filepath: "a.md", heading: "H" }, false);
  check("heading + insertatcursor opens then inserts", calls.join(" -> "), "handleOpen -> handleInsertAtCursor");

  const calls2 = [];
  await chooseHandler.call(makeSelf(calls2), { insertatcursor: "hi", filepath: "a.md", block: "b1" }, false);
  check("block + insertatcursor opens then inserts", calls2.join(" -> "), "handleOpen -> handleInsertAtCursor");

  // heading + block + insertatcursor must fully unwind to one insertion
  const calls3 = [];
  await chooseHandler.call(makeSelf(calls3), { insertatcursor: "hi", filepath: "a.md", heading: "H", block: "b1" }, false);
  check("heading + block + insertatcursor unwinds to one insert", calls3.join(" -> "), "handleOpen -> handleOpen -> handleInsertAtCursor");

  // heading without insertatcursor must be unchanged (pre-existing behaviour)
  const calls4 = [];
  await chooseHandler.call(makeSelf(calls4), { filepath: "a.md", heading: "H" }, false);
  check("heading alone unchanged", calls4[0], "handleOpen");

  const calls5 = [];
  await chooseHandler.call(makeSelf(calls5), { filepath: "a.md", block: "b1" }, false);
  check("block alone unchanged", calls5[0], "handleOpen");

  console.log(failures === 0 ? "\nALL ROUTER TESTS PASSED" : `\n${failures} ROUTER TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();

// Functional tests for handleInsertAtCursor + focusInsertionTarget.
//
// The methods are extracted from the REAL built bundle (not re-implemented), so
// these tests exercise the shipped code. Minified module-scope helpers are
// resolved out of the bundle too.
const fs = require("fs");

const src = fs.readFileSync("main.js", "utf8");

// --- extract a class method's source by brace matching ---
// Preserves whether the method is actually async: the resolver is emitted
// synchronously, and forcing async here would make it return a Promise and
// produce a false failure.
function extractMethod(signature) {
  // the resolver is NOT async, so search for the bare name and then check
  // whether an `async ` modifier precedes it
  const nameStart = src.indexOf(signature);
  if (nameStart < 0) throw new Error("method not found in bundle: " + signature);
  const isAsync = src.slice(nameStart - 6, nameStart) === "async ";
  const start = isAsync ? nameStart - 6 : nameStart;
  const name = signature.replace(/\(.*$/, "");
  const params = signature.slice(signature.indexOf("("));
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) throw new Error("unbalanced braces for " + signature);
  const body = src.slice(open, end);
  // `[async] name(params){...}` -> `[async] function(params){...}`
  return {
    name,
    isAsync,
    src: (isAsync ? "async function " : "function ") + params + body,
  };
}

const handler = extractMethod("handleInsertAtCursor(n)");
const focusHelper = extractMethod("focusInsertionTarget(n)");
const resolveHelper = extractMethod("resolveInsertionTarget()");
const revealHelper = extractMethod("revealLeafCompat(n)");
console.log(
  `extracted: ${handler.name}(async=${handler.isAsync}), ` +
  `${focusHelper.name}(async=${focusHelper.isAsync}), ` +
  `${resolveHelper.name}(async=${resolveHelper.isAsync}), ` +
  `${revealHelper.name}(async=${revealHelper.isAsync})`
);
if (resolveHelper.isAsync) {
  throw new Error(
    "resolver is async in the bundle but the handler does not await it -- " +
    "this is the bug the suite is meant to catch, not a harness issue"
  );
}

// --- module-scope helpers that minification renamed ---
const tokenDef = src.match(/var (\w+)="\{\{clipboard\}\}"/);
if (!tokenDef) throw new Error("clipboard token constant not found in bundle");
const tokenSrc = `var ${tokenDef[1]} = "{{clipboard}}";`;
const sleepDef = src.match(/(\w+)=(\w+)=>new Promise\((\w+)=>window\.setTimeout\(\3,\2\)\)/);
if (!sleepDef) throw new Error("sleep helper not found in bundle");
const sleepSrc = `var ${sleepDef[1]} = ${sleepDef[2]} => new Promise(${sleepDef[3]} => window.setTimeout(${sleepDef[3]}, ${sleepDef[2]}));`;
console.log(`module helpers: token=${tokenDef[1]} sleep=${sleepDef[1]}`);

// fast timers, and record window.focus() (the handler raises the window)
global.window = { setTimeout: (fn) => Promise.resolve().then(fn), focusCount: 0 };
window.focus = () => { window.focusCount++; };

const notices = [];
class Notice { constructor(m) { notices.push(m); } }

// --- stubs -----------------------------------------------------------------
function makeEditor() {
  return {
    _cur: { line: 3, ch: 7 },
    focused: false,
    focusCalls: 0,
    setCursorCalls: 0,
    replaceSelectionCalls: 0,
    insertions: [],
    focus() { this.focused = true; this.focusCalls++; },
    setCursor(pos) { this.setCursorCalls++; this._cur = pos; },
    replaceSelection(text) { this.replaceSelectionCalls++; this.insertions.push(text); },
    getCursor() { return this._cur; },
    // The list-aware insert reads the caret's line and may move the caret before inserting.
    _line: '',
    getLine() { return this._line; },
    scrollIntoView() {},
  };
}

// log records the focus ordering so we can assert revealLeaf precedes focus()
function makeView(mode, log, path) {
  const view = new MarkdownView();
  view.editor = makeEditor();
  view.file = { path: path || "Note.md" };
  view._mode = mode || "source";
  view.leaf = {
    view,
    setViewState: async (state) => {
      log.push("setViewState:" + state.state.mode);
      view._mode = state.state.mode;
    },
    getViewState: () => ({ state: { mode: view._mode }, type: "markdown" }),
  };
  return view;
}

function makeThis(opts) {
  // opts: { markdownType, active, recent, leaves, log }
  const app = {
    workspace: {
      getActiveViewOfType: (type) =>
        opts.active instanceof type ? opts.active : null,
      getMostRecentLeaf: () => opts.recent || null,
      iterateAllLeaves: (cb) => (opts.leaves || []).forEach(cb),
      revealLeaf: async (leaf) => {
        opts.log.push("revealLeaf");
        // a revealed leaf is now the active one
        opts.active = leaf.view;
      },
    },
    vault: { getAbstractFileByPath: () => null },
  };
  return {
    app,
    plugin: {
      open: async () => {},
      success: () => { state.successCalled = true; },
      failure: () => { state.failureCalled = true; },
      settings: { openFileWithoutWriteInNewPane: false },
    },
  };
}

const state = { successCalled: false, failureCalled: false };

// The real code uses `instanceof MarkdownView` / `instanceof TFile`, so the
// stubs must be genuine instances of the classes the handler closes over.
class MarkdownView {}
class TFile {}

const x = { Notice, MarkdownView, TFile };

const clipboardStub = { value: "CLIPBOARD-CONTENT", fails: false };
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    clipboard: {
      readText: async () => {
        if (clipboardStub.fails) throw new Error("denied");
        return clipboardStub.value;
      },
    },
  },
});
if (typeof navigator.clipboard.readText !== "function") throw new Error("clipboard stub not installed");

// Build a runner that installs all three methods as real methods on `this`,
// exactly as the class does, so `this.resolveInsertionTarget()` and
// `this.focusInsertionTarget(view)` resolve.
const factory = new Function("x", `
  ${tokenSrc}
  ${sleepSrc}
  const methods = {};
  methods[${JSON.stringify(handler.name)}] = ${handler.src};
  methods[${JSON.stringify(focusHelper.name)}] = ${focusHelper.src};
  methods[${JSON.stringify(resolveHelper.name)}] = ${resolveHelper.src};
  methods[${JSON.stringify(revealHelper.name)}] = ${revealHelper.src};
  return methods;
`);
const methods = factory(x);

async function run(self, params) {
  // install the helpers the handler calls through `this`, exactly as the class
  // would have them on the prototype
  self[focusHelper.name] = methods[focusHelper.name];
  self[resolveHelper.name] = methods[resolveHelper.name];
  self[revealHelper.name] = methods[revealHelper.name];
  return methods[handler.name].call(self, params);
}

function reset() {
  notices.length = 0;
  state.successCalled = false;
  state.failureCalled = false;
  clipboardStub.fails = false;
  clipboardStub.value = "CLIPBOARD-CONTENT";
  window.focusCount = 0;
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log("  PASS  " + label);
  else { console.log("  FAIL  " + label + (extra !== undefined ? "  -> " + extra : "")); failures++; }
}

(async () => {
  // ---- 1. caret mid-note, active markdown view ----------------------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "Hello World" });
    check("inserts exactly the given text", v.editor.insertions[0] === "Hello World", JSON.stringify(v.editor.insertions[0]));
    check("exactly one insertion (nothing else written)", v.editor.replaceSelectionCalls === 1, v.editor.replaceSelectionCalls);
    check("editor focused", v.editor.focused);
    check("caret re-asserted via setCursor", v.editor.setCursorCalls === 1, v.editor.setCursorCalls);
    check("window raised", window.focusCount === 1, window.focusCount);
    check("success() fired", state.successCalled);
  }

  // ---- 2. focus ordering: revealLeaf BEFORE editor.focus() ----------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    const base = makeThis({ active: v, log });
    // record ordering by wrapping focus()
    const origFocus = v.editor.focus.bind(v.editor);
    v.editor.focus = () => { log.push("editorFocus"); origFocus(); };
    await run(base, { insertatcursor: "x" });
    const revealIdx = log.indexOf("revealLeaf");
    const focusIdx = log.indexOf("editorFocus");
    check("revealLeaf called", revealIdx >= 0, JSON.stringify(log));
    check("revealLeaf precedes editor.focus()", revealIdx >= 0 && focusIdx > revealIdx, JSON.stringify(log));
  }

  // ---- 3. selection replaced (replaceSelection semantics) -----------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    v.editor.replaceSelection = function (text) {
      // emulate CM: selection "SEL" replaced by text
      this.insertions.push("SEL->" + text);
    };
    await run(makeThis({ active: v, log }), { insertatcursor: "NEW" });
    check("existing selection replaced like typing over it", v.editor.insertions[0] === "SEL->NEW", JSON.stringify(v.editor.insertions[0]));
  }

  // ---- 4. active pane is NOT markdown -> recent leaf used -----------------
  reset();
  {
    const log = [];
    const note = makeView("source", log, "Note.md");
    const thisObj = makeThis({ active: null, recent: note.leaf, log });
    await run(thisObj, { insertatcursor: "to the note" });
    check("canvas/graph active -> inserts into most recent markdown leaf", note.editor.insertions[0] === "to the note", JSON.stringify(note.editor.insertions));
    check("recent leaf revealed before insert", log.includes("revealLeaf"), JSON.stringify(log));
    check("not reported as failure", !state.failureCalled);
  }

  // ---- 5. recent leaf is not markdown -> scans open leaves ----------------
  reset();
  {
    const log = [];
    const canvasLeaf = { view: { getViewType: () => "canvas" } };
    const note = makeView("source", log, "Other.md");
    const thisObj = makeThis({ active: null, recent: canvasLeaf, leaves: [canvasLeaf, note.leaf], log });
    await run(thisObj, { insertatcursor: "scanned" });
    check("falls back to scanning open leaves", note.editor.insertions[0] === "scanned", JSON.stringify(note.editor.insertions));
  }

  // ---- 6. nothing open at all -> documented error, no file touched --------
  reset();
  {
    const log = [];
    await run(makeThis({ active: null, recent: null, leaves: [], log }), { insertatcursor: "text" });
    check("no editor -> failure()/x-error", state.failureCalled);
    check("no editor -> exactly one notice", notices.length === 1, JSON.stringify(notices));
    check("no editor -> documented message", notices[0] === "No active editor to insert text into", JSON.stringify(notices));
    check("no editor -> success() NOT fired", !state.successCalled);
  }

  // ---- 7. reading mode, no viewmode -> source, stays source ---------------
  reset();
  {
    const log = [];
    const v = makeView("preview", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "X" });
    check("reading mode -> inserted", v.editor.insertions[0] === "X", JSON.stringify(v.editor.insertions));
    check("forced to source before focusing", log.includes("setViewState:source"), JSON.stringify(log));
    check("stays in source without viewmode=preview", v._mode === "source", v._mode);
  }

  // ---- 8. reading mode + viewmode=preview -> restored AFTER insert --------
  reset();
  {
    const log = [];
    const v = makeView("preview", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "X", viewmode: "preview" });
    const restoreIdx = log.indexOf("setViewState:preview");
    check("restored to reading mode", restoreIdx >= 0, JSON.stringify(log));
    check("inserted before restoring", v.editor.insertions[0] === "X");
    check("restore happens after insertion due to await order", restoreIdx > log.indexOf("setViewState:source"), JSON.stringify(log));
  }

  // ---- 9. no trimming / no auto-newlines / exact bytes -------------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    const text = "line1\n\n  indented\nline3\tTabbed";
    await run(makeThis({ active: v, log }), { insertatcursor: text });
    check("multi-line + tab preserved byte-exact", v.editor.insertions[0] === text, JSON.stringify(v.editor.insertions[0]));
  }

  // ---- 10. {{clipboard}} expansion ---------------------------------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "before {{clipboard}} after" });
    check("expands {{clipboard}} in place", v.editor.insertions[0] === "before CLIPBOARD-CONTENT after", JSON.stringify(v.editor.insertions[0]));
  }
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "{{clipboard}}|{{clipboard}}" });
    check("expands every occurrence", v.editor.insertions[0] === "CLIPBOARD-CONTENT|CLIPBOARD-CONTENT", JSON.stringify(v.editor.insertions[0]));
  }

  // ---- 11. clipboard blocked -> notice, and NOTHING inserted -------------
  reset();
  {
    const log = [];
    clipboardStub.fails = true;
    const v = makeView("source", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "prefix {{clipboard}} suffix" });
    check("clipboard denied -> zero insertions", v.editor.replaceSelectionCalls === 0, v.editor.replaceSelectionCalls);
    check("clipboard denied -> editor never focused", !v.editor.focused);
    check("clipboard denied -> no setCursor", v.editor.setCursorCalls === 0);
    check("clipboard denied -> failure()/x-error", state.failureCalled);
    check("clipboard denied -> notice shown", notices.length === 1, JSON.stringify(notices));
  }

  // ---- 12. long text via clipboard (the caller's fallback path) ----------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    const huge = "X".repeat(20000) + "\n# heading\n& ampersand % percent";
    clipboardStub.value = huge;
    await run(makeThis({ active: v, log }), { insertatcursor: "{{clipboard}}" });
    check("large clipboard text inserted in full (no URI involved)", v.editor.insertions[0] === huge, v.editor.insertions[0] && v.editor.insertions[0].length);
    check("long paste is a single replaceSelection", v.editor.replaceSelectionCalls === 1);
  }

  // ---- 13. empty value is still a valid no-op-ish insert -----------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    await run(makeThis({ active: v, log }), { insertatcursor: "" });
    check("empty value inserts empty string", v.editor.insertions[0] === "");
    check("empty value still succeeds", state.successCalled);
  }

  // ---- 14. filepath: open that note first, then insert into it -----------
  reset();
  {
    const log = [];
    const other = makeView("source", log, "Other.md");
    const initial = makeView("source", log, "Initial.md");
    const target = new TFile();
    target.path = "Other.md";
    const thisObj = makeThis({ active: initial, recent: null, leaves: [], log });
    thisObj.app.vault.getAbstractFileByPath = (p) =>
      p === "Other.md" ? target : null;
    thisObj.plugin.open = async () => {
      log.push("plugin.open");
      thisObj.app.workspace.getActiveViewOfType = () => other;
    };
    await run(thisObj, { filepath: "Other.md", insertatcursor: "into other" });
    check("filepath -> plugin.open called", log.includes("plugin.open"), JSON.stringify(log));
    check("filepath -> inserts into the opened note", other.editor.insertions[0] === "into other", JSON.stringify(other.editor.insertions));
    check("filepath -> initial note untouched", initial.editor.insertions.length === 0, JSON.stringify(initial.editor.insertions));
  }

  // ---- 15. encoding round-trip through the plugin's real decoder ---------
  // The caller sends encodeURIComponent(markdown); Obsidian parses the query
  // and passes decoded values to decodeParameterValues (source main.ts:54-64).
  reset();
  {
    // Obsidian's protocol layer splits the query on & and = but hands the
    // values over still percent-encoded; decodeParameterValues (source
    // main.ts:54-64) then applies decodeURIComponent EXACTLY ONCE. So `%25`
    // must survive to this point as the literal three characters "%25".
    const rawQueryParams = (uri) => {
      const out = {};
      for (const pair of uri.slice(uri.indexOf("?") + 1).split("&")) {
        const eq = pair.indexOf("=");
        if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return out;
    };
    // the plugin's own decoder, taken from the source
    const decodeParameterValues = (parameters) => {
      for (const p in parameters) {
        const value = parameters[p];
        if (typeof value === "string") {
          parameters[p] = decodeURIComponent(value);
        }
      }
      return parameters;
    };
    const markdown = "hash # amp & pct % newline\ntab\tend  spaced";
    const uri = "obsidian://advanced-uri?insertatcursor=" + encodeURIComponent(markdown);
    check("caller encodes space as %20 (never +)", uri.includes("%20") && !uri.includes("+"), uri);
    check("caller encodes # so it cannot truncate", uri.includes("%23") && uri.indexOf("#") === -1, uri);
    check("caller encodes & so it cannot split params", uri.includes("%26"), uri);
    check("caller encodes % as %25", uri.includes("%25"), uri);
    const raw = rawQueryParams(uri);
    check("raw value still percent-encoded before the plugin decoder", raw.insertatcursor === encodeURIComponent(markdown), raw.insertatcursor);
    check("exactly one parameter arrived", Object.keys(raw).length === 1, JSON.stringify(Object.keys(raw)));
    const decoded = decodeParameterValues(raw);
    check("round-trips # & % newline tab space exactly", decoded.insertatcursor === markdown, JSON.stringify(decoded.insertatcursor));

    // and the decoded text actually reaches the editor byte-for-byte
    const log = [];
    const v = makeView("source", log);
    await run(makeThis({ active: v, log }), { insertatcursor: decoded.insertatcursor });
    check("special characters survive into the note", v.editor.insertions[0] === markdown, JSON.stringify(v.editor.insertions[0]));
  }

  // ---- 16. revealLeafCompat: modern path (revealLeaf available) ----------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    const thisObj = makeThis({ active: v, recent: null, leaves: [], log });
    // makeThis already provides an async revealLeaf; record its order vs focus
    const origFocus = v.editor.focus.bind(v.editor);
    v.editor.focus = () => { log.push("editorFocus"); origFocus(); };
    await run(thisObj, { insertatcursor: "modern" });
    check("revealLeafCompat calls workspace.revealLeaf", log.includes("revealLeaf"), JSON.stringify(log));
    check("revealLeafCompat does not fall back to setActiveLeaf", !log.includes("setActiveLeaf"), JSON.stringify(log));
    const rIdx = log.indexOf("revealLeaf");
    const fIdx = log.indexOf("editorFocus");
    check("revealLeaf is awaited before editor.focus()", rIdx >= 0 && fIdx > rIdx, JSON.stringify(log));
    check("modern path still inserts", v.editor.insertions[0] === "modern", JSON.stringify(v.editor.insertions));
  }

  // ---- 17. revealLeafCompat: legacy path (no revealLeaf) -----------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    const thisObj = makeThis({ active: v, recent: null, leaves: [], log });
    delete thisObj.app.workspace.revealLeaf;          // simulate Obsidian < 1.7.2
    const ws = thisObj.app.workspace;
    const leafObj = v.leaf;
    ws.setActiveLeaf = (leaf, opts) => {
      log.push("setActiveLeaf:" + (leaf === leafObj ? "correctLeaf" : "WRONG") +
               ":" + (opts && opts.focus === true ? "focus:true" : "focus:" + JSON.stringify(opts)));
    };
    const origFocus = v.editor.focus.bind(v.editor);
    v.editor.focus = () => { log.push("editorFocus"); origFocus(); };

    let threw = null;
    try {
      await run(thisObj, { insertatcursor: "legacy" });
    } catch (err) { threw = err; }
    check("legacy path does not throw", threw === null, threw && threw.message);
    check("legacy path calls setActiveLeaf with the leaf and {focus:true}",
      log.includes("setActiveLeaf:correctLeaf:focus:true"), JSON.stringify(log));
    check("legacy path still focuses the editor", log.includes("editorFocus"), JSON.stringify(log));
    check("legacy path still inserts", v.editor.insertions[0] === "legacy", JSON.stringify(v.editor.insertions));
    check("legacy path still succeeds", state.successCalled && !state.failureCalled);
  }

  // ---- 18. revealLeafCompat: neither API available ----------------------
  reset();
  {
    const log = [];
    const v = makeView("source", log);
    const thisObj = makeThis({ active: v, recent: null, leaves: [], log });
    delete thisObj.app.workspace.revealLeaf;
    delete thisObj.app.workspace.setActiveLeaf;        // both absent
    const origFocus = v.editor.focus.bind(v.editor);
    v.editor.focus = () => { log.push("editorFocus"); origFocus(); };

    let threw = null;
    try {
      await run(thisObj, { insertatcursor: "neither" });
    } catch (err) { threw = err; }
    check("neither API -> does not throw", threw === null, threw && threw.message);
    check("neither API -> still focuses the editor", log.includes("editorFocus"), JSON.stringify(log));
    check("neither API -> still inserts", v.editor.insertions[0] === "neither", JSON.stringify(v.editor.insertions));
    check("neither API -> reports success (insert did happen)", state.successCalled && !state.failureCalled);
  }

  // ---- 19. neither API + no editor -> documented Notice, no throw -------
  reset();
  {
    const log = [];
    const thisObj = makeThis({ active: null, recent: null, leaves: [], log });
    delete thisObj.app.workspace.revealLeaf;
    delete thisObj.app.workspace.setActiveLeaf;

    let threw = null;
    try {
      await run(thisObj, { insertatcursor: "nowhere" });
    } catch (err) { threw = err; }
    check("no editor + no reveal API -> does not throw", threw === null, threw && threw.message);
    check("no editor + no reveal API -> documented Notice",
      notices.length === 1 && notices[0] === "No active editor to insert text into", JSON.stringify(notices));
    check("no editor + no reveal API -> failure()/x-error", state.failureCalled);
    check("no editor + no reveal API -> success() NOT fired", !state.successCalled);
  }

  console.log(failures === 0 ? "\nALL HANDLER TESTS PASSED" : `\n${failures} HANDLER TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
  // ---- the list-aware insert, asserted against the shipped bundle -------
  const twoLinks = "- [One](u1)\n- [Two](u2)";
  const runInsert = async (line, params) => {
    const v = makeView("source", [], "Note.md");
    v.editor._line = line;
    v.editor._cur = { line: 3, ch: 7 };
    setViews([v]);
    await methods.handleInsertAtCursor(Object.assign({ insertatcursor: twoLinks }, params || {}));
    return v.editor.insertions[v.editor.insertions.length - 1];
  };
  const onItem = await runInsert("- existing item");
  check("a list item with text gets a sibling item", onItem === "\n- [One](u1)\n\t- [Two](u2)", JSON.stringify(onItem));
  const onEmpty = await runInsert("- ");
  check("an empty item is filled rather than nested", onEmpty === "[One](u1)\n- [Two](u2)", JSON.stringify(onEmpty));
  const indented = await runInsert("\t- parent");
  check("the sibling keeps the line indentation", indented === "\n\t- [One](u1)\n\t\t- [Two](u2)", JSON.stringify(indented));
  const under = await runInsert("- existing item", { insertline: "under" });
  check("insertline=under nests the payload", under === "\n\t- [One](u1)\n\t\t- [Two](u2)", JSON.stringify(under));

})();

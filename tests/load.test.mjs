// Load test: runs Listen's scripts the way Safari does at startup (the content scripts in manifest.json order,
// background.js and the settings page), against a stand-in browser and page. It fails on:
//   - anything that throws while loading, such as a name used before it's declared, including in callbacks
//     that run between one content script and the next;
//   - any warning or error logged, and any promise rejected without a handler;
//   - a name a script uses that nothing declares (a ReferenceError waiting to happen when that code runs);
//   - a shared name (L.something / S.something) that no content script defines.
// It also opens and closes the chat the way the toolbar button does.
//
// Run: node tests/load.test.mjs  (node tests/run.mjs runs every test). Plain Node, no packages.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { blank, undeclared } from "./lib/js-scan.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// LISTEN_RESOURCES points the test at another copy of the extension's files (to check the test itself).
const RESOURCES = process.env.LISTEN_RESOURCES || path.join(ROOT, "Listen Extension", "Resources");

// Globals a page, an extension page or the background may use.
const GLOBALS = new Set(
    (
        "AbortController Array Boolean CSS CSSStyleSheet Date Error Highlight Image Infinity Intl JSON Map Math " +
        "Node NodeFilter Number Object OffscreenCanvas Option Promise SpeechSynthesisUtterance Set String " +
        "TextDecoder URL Uint8Array WeakMap XMLSerializer DOMParser browser btoa cancelAnimationFrame clearTimeout " +
        "console createImageBitmap crypto document encodeURIComponent fetch getComputedStyle globalThis location " +
        "navigator parseFloat requestAnimationFrame setTimeout speechSynthesis undefined window"
    ).split(" ")
);

const failures = [];
const fail = (message) => failures.push(message);

// A stand-in for any page object: every property and call gives back another stand-in, so code can build its
// interface without a real page. It counts as 0 or "0" when used as a number or text, and as an empty list.
function anything() {
    const props = new Map();
    return new Proxy(function () {}, {
        get(target, prop) {
            if (prop === Symbol.toPrimitive) return () => 0;
            if (prop === Symbol.iterator) return function* () {};
            if (prop === "then") return undefined; // not a promise
            if (prop === "length") return 0;
            if (!props.has(prop)) props.set(prop, anything());
            return props.get(prop);
        },
        set(target, prop, value) {
            props.set(prop, value);
            return true;
        },
        apply: () => anything(),
        construct: () => anything(),
    });
}

// The parts of Safari's browser.* API that Listen uses, in memory.
function fakeBrowser() {
    const listeners = { message: [], storage: [], clicked: [], removed: [] };
    const store = {};
    const pick = (keys) => {
        const out = {};
        for (const key of keys == null ? Object.keys(store) : [].concat(keys)) if (key in store) out[key] = store[key];
        return out;
    };
    const area = (data) => ({
        get: async (keys) => pick(keys),
        set: async (values) => {
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                changes[key] = { oldValue: data[key], newValue: value };
                data[key] = value;
            }
            listeners.storage.forEach((f) => f(changes, "local"));
        },
        remove: async (key) => delete data[key],
    });
    return {
        listeners,
        runtime: {
            onMessage: { addListener: (f) => listeners.message.push(f) },
            sendMessage: async () => null,
            getURL: (p) => `safari-web-extension://test/${p}`,
        },
        storage: { local: area(store), session: area({}), onChanged: { addListener: (f) => listeners.storage.push(f) } },
        i18n: { detectLanguage: async () => ({ languages: [], isReliable: false }) },
        action: { onClicked: { addListener: (f) => listeners.clicked.push(f) } },
        tabs: { onRemoved: { addListener: (f) => listeners.removed.push(f) }, sendMessage: async () => true, create: async () => ({}) },
    };
}

function makeContext(label) {
    const browser = fakeBrowser();
    const report = (kind) => (...parts) => fail(`${label}: console.${kind}: ${parts.map(String).join(" ")}`);
    const context = {
        browser,
        console: { log() {}, info() {}, debug() {}, warn: report("warn"), error: report("error") },
        document: anything(),
        location: anything(),
        navigator: { language: "en-GB" },
        speechSynthesis: anything(),
        getComputedStyle: anything(),
        CSS: anything(),
        CSSStyleSheet: anything(),
        Highlight: anything(),
        Image: anything(),
        Option: anything(),
        SpeechSynthesisUtterance: anything(),
        XMLSerializer: anything(),
        DOMParser: anything(),
        OffscreenCanvas: anything(),
        createImageBitmap: anything(),
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
        requestAnimationFrame: (f) => setTimeout(f, 0),
        cancelAnimationFrame: clearTimeout,
        setTimeout,
        clearTimeout,
        fetch: async () => {
            throw new Error("no network in the load test");
        },
        crypto: globalThis.crypto,
        btoa: globalThis.btoa,
        TextDecoder,
        AbortController,
        URL,
        // The window's own methods and sizes (the global object is the window).
        addEventListener: anything(),
        removeEventListener: anything(),
        getSelection: anything(),
        innerWidth: 1280,
        innerHeight: 800,
        scrollX: 0,
        scrollY: 0,
    };
    context.window = context;
    vm.createContext(context);
    return context;
}

function run(context, file, { strict = false } = {}) {
    const code = readFileSync(path.join(RESOURCES, file), "utf8");
    try {
        vm.runInContext(strict ? `"use strict";\n${code}` : code, context, { filename: file });
    } catch (error) {
        fail(`${file}: throws while loading: ${error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error}`);
    }
    return code;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

process.on("unhandledRejection", (error) => fail(`unhandled promise rejection: ${error && error.message}`));

const manifest = JSON.parse(readFileSync(path.join(RESOURCES, "manifest.json"), "utf8"));
const contentFiles = manifest.content_scripts.flatMap((entry) => entry.js);

// ----- Content scripts: loaded in order into one shared world, like Safari's isolated world for a page -----

const page = makeContext("content scripts");
const sources = {};
for (const file of contentFiles) {
    sources[file] = run(page, file);
    // Safari runs pending callbacks (such as storage answers) between one content script and the next, so code
    // reached that way mustn't need a file that hasn't loaded yet.
    await new Promise((resolve) => setImmediate(resolve));
}
await settle();

// Every name each file uses is declared in it or is a global.
for (const [file, code] of Object.entries({ ...sources, "background.js": readFileSync(path.join(RESOURCES, "background.js"), "utf8"), "popup.js": readFileSync(path.join(RESOURCES, "popup.js"), "utf8") })) {
    const missing = undeclared(code, GLOBALS);
    for (const [name, line] of Object.entries(missing)) fail(`${file}:${line}: "${name}" is used but never declared`);
}

// Every shared name used through L. or S. is defined once all the content scripts have loaded.
const L = vm.runInContext("globalThis.listen", page);
for (const [file, code] of Object.entries(sources)) {
    const scanned = blank(code);
    for (const [, kind, name] of scanned.matchAll(/(?<![\w$.])([LS])\.([A-Za-z_$][\w$]*)/g)) {
        const holder = kind === "L" ? L : L && L.state;
        if (!holder || !(name in holder)) fail(`${file}: ${kind}.${name} is used but no content script defines it`);
    }
}

// The toolbar button opens the chat, and a second click closes it.
const toolbar = page.browser.listeners.message;
if (!toolbar.length) fail("content scripts: nothing listens for the toolbar button");
for (const step of ["open", "close"]) {
    try {
        const answers = await Promise.all(toolbar.map((f) => f({ type: "listen:open-chat" })));
        if (!answers.includes(true)) fail(`toolbar ${step}: the content scripts didn't take the toolbar click`);
    } catch (error) {
        fail(`toolbar ${step}: throws: ${error && error.stack ? error.stack.split("\n").slice(0, 3).join(" | ") : error}`);
    }
    await settle();
}

// ----- background.js and the settings page (both run as modules, so strict) -----

const background = makeContext("background.js");
run(background, "background.js", { strict: true });
if (!background.browser.listeners.message.length) fail("background.js: no message listener");
if (!background.browser.listeners.clicked.length) fail("background.js: no toolbar button listener");

const settingsPage = makeContext("popup.js");
run(settingsPage, "popup.js", { strict: true });
await settle();

if (failures.length) {
    console.log(`load test: ${failures.length} problem${failures.length === 1 ? "" : "s"}`);
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
} else {
    console.log(`load test: ok (${contentFiles.length} content script${contentFiles.length === 1 ? "" : "s"}, background.js, popup.js)`);
}

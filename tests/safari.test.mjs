// Safari test: loads Listen's content scripts into a test page in real Safari (through safaridriver) and walks
// through the main things people do: highlight and listen, stop, change speed, ask about maths in the chat (seeing
// the one-time privacy notice), get a chart and a table, copy a table, open the settings, use the toolbar button,
// hover an image, start a new chat.
// Answers come from a stand-in background page (tests/safari/shim.js), so it needs no network and uses none of
// the daily questions. It complements the manual checklist in tests/SAFARI_SMOKE_TEST.md.
//
// Needs Safari's remote automation: Safari ▸ Settings ▸ Advanced ▸ "Show features for web developers", then
// Develop ▸ "Allow Remote Automation" (Safari turns it off again now and then).
// Run: node tests/safari.test.mjs   (about 30 seconds; a Safari window opens and closes)
//
// The scripts are served with test-only changes so they can be inspected and don't collide with an installed
// Listen on the same page: their elements get test names, their Shadow DOM is open, and the bar sits further
// from the selection.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RESOURCES = path.join(ROOT, "Listen Extension", "Resources");
const HERE = path.join(ROOT, "tests", "safari");
const DRIVER_PORT = 4471;

const TEST_CHANGES = [
    ['"listen-extension-root"', '"listen-test-bar"'],
    ['"listen-chat-root"', '"listen-test-chat"'],
    ['"listen-highlight-root"', '"listen-test-highlight"'],
    ['attachShadow({ mode: "closed" })', 'attachShadow({ mode: "open" })'],
    ["const OFFSET = 6;", "const OFFSET = 120;"],
];

const manifest = JSON.parse(readFileSync(path.join(RESOURCES, "manifest.json"), "utf8"));
const contentFiles = manifest.content_scripts.flatMap((entry) => entry.js);

// ----- The test page -----

function serve() {
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, "http://localhost");
        try {
            if (url.pathname === "/") {
                const scripts = contentFiles.map((f) => `<script src="/ext/${f}"></script>`).join("\n");
                const html = readFileSync(path.join(HERE, "page.html"), "utf8").replace("<!-- CONTENT SCRIPTS -->", scripts);
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
            } else if (url.pathname === "/shim.js") {
                response.writeHead(200, { "Content-Type": "text/javascript" }).end(readFileSync(path.join(HERE, "shim.js")));
            } else if (url.pathname.startsWith("/ext/images/")) {
                const file = path.join(RESOURCES, "images", path.basename(url.pathname));
                response.writeHead(200, { "Content-Type": "image/png" }).end(readFileSync(file));
            } else if (url.pathname.startsWith("/ext/") && url.pathname.endsWith(".js")) {
                let code = readFileSync(path.join(RESOURCES, path.basename(url.pathname)), "utf8");
                for (const [from, to] of TEST_CHANGES) code = code.split(from).join(to);
                response.writeHead(200, { "Content-Type": "text/javascript" }).end(code);
            } else {
                response.writeHead(404).end();
            }
        } catch (error) {
            response.writeHead(500).end(String(error));
        }
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ----- WebDriver -----

let session = null;

async function wd(method, route, body) {
    const response = await fetch(`http://127.0.0.1:${DRIVER_PORT}${route}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(data.value).slice(0, 300)}`);
    return data.value;
}

const js = (script, ...args) => wd("POST", `/session/${session}/execute/sync`, { script, args });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pointer(x, y, click = true) {
    const actions = [{ type: "pointerMove", duration: 60, origin: "viewport", x: Math.round(x), y: Math.round(y) }];
    if (click) actions.push({ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 });
    await wd("POST", `/session/${session}/actions`, {
        actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }],
    });
}

const BAR = 'document.querySelector("listen-test-bar").shadowRoot';
const CHAT = 'document.querySelector("listen-test-chat").shadowRoot';

// The centre of the first (or with last: true, the last) element matching `selector` in `root`, optionally
// with exactly `text`, or null if there's none on screen.
async function centre(root, selector, { text = null, last = false } = {}) {
    return js(
        `const all = [...${root}.querySelectorAll(arguments[0])].filter((e) => arguments[1] == null || e.textContent === arguments[1]);
         const e = arguments[2] ? all[all.length - 1] : all[0]; if (!e) return null; const r = e.getBoundingClientRect();
         return r.width ? [r.left + r.width / 2, r.top + r.height / 2] : null;`,
        selector,
        text,
        last
    );
}

async function click(root, selector, options) {
    const spot = await centre(root, selector, options);
    if (!spot) throw new Error(`nothing to click: ${selector}${options && options.text ? ` "${options.text}"` : ""}`);
    await pointer(...spot);
}

async function select(id) {
    await pointer(1100, 860); // click empty space first, so the next selection is fresh
    await sleep(150);
    await js(
        `const r = document.createRange(); r.selectNodeContents(document.getElementById(arguments[0]));
         getSelection().removeAllRanges(); getSelection().addRange(r);
         document.dispatchEvent(new KeyboardEvent("keyup", { shiftKey: true }));`,
        id
    );
    await sleep(300);
}

async function send(text) {
    await js(`${CHAT}.querySelector("input").value = arguments[0];`, text);
    await click(CHAT, "button.send");
    await sleep(500);
}

const chatState = () =>
    js(`const s = ${CHAT}; const shown = (q) => { const e = s.querySelector(q); return e && !e.closest("[hidden]") ? e.textContent : null; };
        return { open: !s.querySelector(".panel").hidden, kind: shown(".attachment-kind"),
                 chips: [...s.querySelectorAll(".chip")].map((c) => c.textContent),
                 answers: s.querySelectorAll(".msg.model").length };`);

// ----- Checks -----

const results = [];
async function check(name, test) {
    try {
        const problem = await test();
        results.push([problem ? "FAIL" : "PASS", name, problem || ""]);
    } catch (error) {
        results.push(["FAIL", name, error.message]);
    }
    const [status, , detail] = results[results.length - 1];
    console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
}
const expect = (ok, problem) => (ok ? null : problem);

async function main() {
    await check("loads without errors and shows the chat bubble", async () => {
        const state = await js(`return { errors: window.__errors, bubble: !!document.querySelector("listen-test-chat") && !${CHAT}.querySelector("button.bubble").hidden };`);
        return expect(state.errors.length === 0 && state.bubble, JSON.stringify(state));
    });

    await check("highlighting text shows the bar: speaker, speed, chat", async () => {
        await select("plain");
        const buttons = await js(`const h = document.querySelector("listen-test-bar"); if (!h || h.style.display === "none") return null;
            return [...${BAR}.querySelectorAll(".bar > button")].map((b) => b.querySelector("svg") ? "icon" : b.textContent);`);
        return expect(JSON.stringify(buttons) === '["icon","1x","icon"]', `bar: ${JSON.stringify(buttons)}`);
    });

    await check("the speaker reads the highlighted text with word highlighting", async () => {
        await click(BAR, ".bar > button");
        await sleep(700);
        const state = await js(`return { spoken: window.__spoken.slice(-1)[0] || "", stop: ${BAR}.querySelector(".bar > button").textContent,
            pill: !!document.querySelector("listen-test-highlight") };`);
        return expect(state.spoken.startsWith("Photosynthesis is how plants") && state.stop === "■" && state.pill, JSON.stringify(state));
    });

    await check("■ stops reading", async () => {
        await click(BAR, ".bar > button");
        await sleep(500);
        const state = await js(`return { speaking: speechSynthesis.speaking, icon: !!${BAR}.querySelector(".bar > button svg") };`);
        return expect(!state.speaking && state.icon, JSON.stringify(state));
    });

    await check("the speed button cycles and is saved", async () => {
        await select("plain");
        await click(BAR, "button.speed");
        await sleep(200);
        const state = await js(`return { label: ${BAR}.querySelector("button.speed").textContent, saved: window.__store.speed };`);
        for (let i = 0; i < 4; i++) await click(BAR, "button.speed"); // back round to 1x
        await sleep(200);
        const back = await js(`return ${BAR}.querySelector("button.speed").textContent;`);
        return expect(state.label === "1.25x" && state.saved === 1.25 && back === "1x", JSON.stringify({ ...state, back }));
    });

    await check("the chat button attaches maths with the maths chips", async () => {
        await select("maths");
        await click(BAR, "button.ask");
        await sleep(500);
        const state = await chatState();
        return expect(state.open && state.kind === "Maths" && state.chips.join() === "Hint,Solve,Explain", JSON.stringify(state));
    });

    await check("the first chat shows the privacy notice once; Got it remembers it", async () => {
        const shown = await js(`const n = ${CHAT}.querySelector(".notice"); const a = n && n.querySelector("a");
            return { visible: !!n && !n.hidden, link: a ? a.href : null, text: n ? n.textContent : "" };`);
        await click(CHAT, ".notice button", { text: "Got it" });
        await sleep(300);
        const after = await js(`return { hidden: ${CHAT}.querySelector(".notice").hidden, saved: window.__store.chatNoticeSeen };`);
        const ok = shown.visible && shown.link === "https://listen-proxy.vercel.app/privacy" && /Google Gemini/.test(shown.text) &&
            after.hidden && after.saved === true;
        return expect(ok, JSON.stringify({ shown, after }));
    });

    await check("Solve shows the final answer first, then the steps", async () => {
        await click(CHAT, ".chip", { text: "Solve" });
        await sleep(600);
        const state = await js(`const a = [...${CHAT}.querySelectorAll(".msg.model")].pop();
            return { final: a.querySelector(".final") && a.querySelector(".final").textContent, steps: a.querySelectorAll(".step").length,
                     sent: window.__sent.slice(-1)[0].action, kind: window.__sent.slice(-1)[0].math ? "math" : "?" };`);
        return expect(state.final === "x = 2" && state.steps === 3 && state.sent === "solve" && state.kind === "math", JSON.stringify(state));
    });

    await check("a follow-up carries the conversation and draws a bar chart", async () => {
        await send("make a bar chart of the planets");
        const state = await js(`const v = [...${CHAT}.querySelectorAll(".visual")].pop();
            return { bars: v ? v.querySelectorAll("rect").length : 0, history: window.__sent.slice(-1)[0].history.length,
                     action: window.__sent.slice(-1)[0].action };`);
        return expect(state.bars === 8 && state.history === 2 && state.action === "chat", JSON.stringify(state));
    });

    await check("a table is drawn and Copy gives tab-separated rows", async () => {
        await send("table of the first elements");
        const rows = await js(`const t = [...${CHAT}.querySelectorAll(".visual table")].pop(); return t ? t.tBodies[0].rows.length : 0;`);
        execFileSync("pbcopy", { input: "before" });
        await click(CHAT, ".msg.model button.copy", { last: true });
        await sleep(300);
        const copied = execFileSync("pbpaste").toString();
        return expect(rows === 3 && copied.startsWith("Z\tName\tSymbol\n1\tHydrogen\tH"), JSON.stringify({ rows, copied: copied.slice(0, 40) }));
    });

    await check("the gear shows the settings, and a switch is saved", async () => {
        await click(CHAT, "button.gear");
        await sleep(300);
        const shown = await js(`return !${CHAT}.querySelector(".settings").hidden && ${CHAT}.querySelector(".chat-body").hidden;`);
        await click(CHAT, ".toggle input");
        await sleep(200);
        const saved = await js("return window.__store.showImageButtons;");
        await click(CHAT, "button.gear");
        await sleep(200);
        const back = await js(`return !${CHAT}.querySelector(".chat-body").hidden;`);
        return expect(shown && saved === true && back, JSON.stringify({ shown, saved, back }));
    });

    await check("the toolbar button closes the open chat, then opens it again", async () => {
        await pointer(1100, 860); // nothing highlighted
        await js("getSelection().removeAllRanges();");
        await js("return window.__toolbar();");
        await sleep(300);
        const closed = !(await chatState()).open;
        await js("return window.__toolbar();");
        await sleep(400);
        const open = (await chatState()).open;
        return expect(closed && open, JSON.stringify({ closed, open }));
    });

    await check("hovering an image shows the bar (with image buttons switched on)", async () => {
        const spot = await js(`const r = document.getElementById("img").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];`);
        await pointer(spot[0], spot[1], false);
        await sleep(900);
        const shown = await js(`const h = document.querySelector("listen-test-bar"); return !!h && h.style.display !== "none";`);
        await pointer(1100, 860, false);
        return expect(shown, "no bar on the image");
    });

    await check("an email gets Reply, Shorter, More polite, Explain", async () => {
        await select("mail");
        await click(BAR, "button.ask");
        await sleep(500);
        const state = await chatState();
        return expect(state.kind === "Message" && state.chips.join() === "Reply,Shorter,More polite,Explain", JSON.stringify(state));
    });

    await check("New chat clears the conversation", async () => {
        await click(CHAT, "button.head-button", { text: "New chat" });
        await sleep(300);
        const state = await chatState();
        return expect(state.answers === 0 && state.kind === null, JSON.stringify(state));
    });

    await check("no page errors along the way", async () => {
        const errors = await js("return window.__errors;");
        return expect(errors.length === 0, JSON.stringify(errors));
    });
}

// ----- Run -----

const server = await serve();
const driver = spawn("safaridriver", ["-p", String(DRIVER_PORT)], { stdio: "ignore" });
try {
    for (let i = 0; i < 50; i++) {
        try {
            await wd("GET", "/status");
            break;
        } catch {
            await sleep(100);
        }
    }
    try {
        session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } })).sessionId;
    } catch (error) {
        console.log("Couldn't start Safari. Turn on Develop ▸ Allow Remote Automation in Safari and try again.");
        console.log(error.message);
        process.exitCode = 2;
    }
    if (session) {
        await wd("POST", `/session/${session}/window/rect`, { width: 1200, height: 900 });
        await wd("POST", `/session/${session}/url`, { url: `http://127.0.0.1:${server.address().port}/` });
        await sleep(1200);
        await main();
        const failed = results.filter(([status]) => status === "FAIL").length;
        console.log(`\nsafari test: ${results.length - failed} passed, ${failed} failed`);
        if (failed) process.exitCode = 1;
    }
} finally {
    if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
    driver.kill();
    server.close();
}

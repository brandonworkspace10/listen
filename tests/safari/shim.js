// A stand-in for Safari's extension APIs on the Safari test page: storage in memory, and a background page that
// answers from a script instead of asking Gemini. It also records what the content scripts send and speak, and any
// page errors, for the test to check.

(() => {
    "use strict";

    window.__errors = [];
    window.addEventListener("error", (event) => window.__errors.push(String(event.message)));
    window.addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason)));

    // Speech is silent but otherwise real, so the start, word and end events still arrive.
    window.__spoken = [];
    const speak = SpeechSynthesis.prototype.speak;
    SpeechSynthesis.prototype.speak = function (utterance) {
        window.__spoken.push(utterance.text);
        utterance.volume = 0;
        return speak.call(this, utterance);
    };

    // The chat bubble and panel start away from the installed extension's own bubble in the corner.
    const store = { chatPanelPos: { x: 470, y: 16 }, chatBubblePos: { x: 380, y: 600 } };
    window.__store = store;
    const storageListeners = [];
    const messageListeners = [];
    window.__messageListeners = messageListeners;
    window.__sent = [];

    const CHART = {
        kind: "chart", type: "bar", title: "Planets by radius", xLabel: "Planet", yLabel: "Radius (km)",
        labels: ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"],
        series: [{ name: "Radius", values: [2440, 6052, 6371, 3390, 69911, 58232, 25362, 24622] }],
    };
    const TABLE = {
        kind: "table", title: "First elements", headers: ["Z", "Name", "Symbol"],
        rows: [["1", "Hydrogen", "H"], ["2", "Helium", "He"], ["3", "Lithium", "Li"]],
    };

    function answer(message) {
        const question = message.question || "";
        if (message.action === "solve") return { ok: true, answer: "x = 2\n2x = 7 − 3\n2x = 4\nx = 4 ÷ 2" };
        if (/chart/.test(question)) return { ok: true, answer: "Approximate radii of the planets.", visual: CHART };
        if (/table/.test(question)) return { ok: true, answer: "The first three elements.", visual: TABLE };
        return { ok: true, answer: `A test answer to ${message.action}.` };
    }

    let chat = null; // what background.js would keep for this tab

    window.browser = {
        runtime: {
            onMessage: { addListener: (f) => messageListeners.push(f) },
            getURL: (p) => `/ext/${p}`,
            sendMessage: async (message) => {
                if (message.type === "listen:chat-load") return chat;
                if (message.type === "listen:chat-save") {
                    chat = message.chat;
                    return true;
                }
                window.__sent.push(message);
                await new Promise((resolve) => setTimeout(resolve, 100));
                return answer(message);
            },
        },
        i18n: { detectLanguage: async () => ({ languages: [{ language: "en" }], isReliable: true }) },
        storage: {
            onChanged: { addListener: (f) => storageListeners.push(f) },
            local: {
                get: async (keys) => {
                    const out = {};
                    for (const key of keys == null ? Object.keys(store) : [].concat(keys)) if (key in store) out[key] = store[key];
                    return out;
                },
                set: async (values) => {
                    const changes = {};
                    for (const [key, value] of Object.entries(values)) {
                        changes[key] = { oldValue: store[key], newValue: value };
                        store[key] = value;
                    }
                    storageListeners.forEach((f) => f(changes, "local"));
                },
            },
        },
    };

    // What background.js does when Listen's toolbar button is clicked.
    window.__toolbar = () => Promise.all(messageListeners.map((f) => f({ type: "listen:open-chat" })));
})();

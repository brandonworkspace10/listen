// Listen — content scripts, 7 of 10: the chat — panel, bubble, quick actions, the conversation, the gear's
// settings and the toolbar button (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;
    const S = L.state;

    // ---------- Chat (the chat button on the bar, and the chat bubble in the page's corner) ----------
    // One conversation per tab. The bar's chat button attaches the highlighted text (or the hovered image,
    // chart, link, code or maths) to it as a quoted chip; quick-action chips and typed messages ask Gemini
    // about it through background.js, with the last few turns as context. background.js keeps the
    // conversation for the tab until "New chat". The panel and the bubble can be dragged anywhere on
    // screen; their last positions are kept in browser.storage.local.

    const ASK_TIMEOUT_MS = 45000;
    const CHAT_PANEL_WIDTH = 360;
    const BUBBLE_SIZE = 44;
    const EDGE = 8; // px kept between the chat and the window's edges
    const DRAG_THRESHOLD = 4; // px a press must move to count as a drag rather than a click
    const HISTORY_TURNS = 6; // earlier turns sent along as context: the last three questions and answers
    const HISTORY_TURN_CHARS = 2000;
    const MAX_TURNS_KEPT = 40;

    // Quick actions: [action sent to background.js, label, tooltip], per kind of attachment.
    const CHIPS = [
        ["summarize", "Summarize", "Short summary of the highlighted text"],
        ["translate", "Translate", "Translate the highlighted text"],
        ["explain", "Explain", "Explain the highlighted text simply"],
    ];
    const MATH_CHIPS = [
        ["explain", "Explain", "Explain the maths simply"],
        ["solve", "Solve step by step", "Work through it step by step"],
        ["readit", "Read it", "Read the maths aloud"],
    ];
    const MATH_PROBLEM_CHIPS = [
        ["hint", "Hint", "One nudge toward the next step, without the answer"],
        ["solve", "Solve", "The answer, then the working step by step"],
        ["explain", "Explain", "Explain the problem simply"],
    ];
    const MATH_ANSWER_CHIPS = [
        ["check", "Check my answer", "Check whether the answer shown is right"],
        ["hint", "Hint", "One nudge toward the next step, without the answer"],
        ["solve", "Solve", "The answer, then the working step by step"],
        ["explain", "Explain", "Explain the problem simply"],
    ];
    const IMAGE_CHIPS = [
        ["describe", "Describe", "Describe the image"],
        ["readtext", "Read text in image", "Read out any text in the image"],
        ["explain", "Explain", "Explain the image simply"],
    ];
    const EMAIL_CHIPS = [
        ["reply", "Reply", "Draft a reply to this message"],
        ["shorter", "Shorter", "Make the text shorter"],
        ["polite", "More polite", "Make the text more polite"],
        ["explain", "Explain", "Explain the message simply"],
    ];

    // ----- Emails and messages -----
    // Text selected on a webmail site, or that reads like a message (a greeting, a sign-off, "From:" or
    // "Subject:"), gets the email chips.

    const MAIL_HOSTS = /^(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com)$/;
    const GREETING = /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^\n.?]{0,40}[,!]/i;
    const SIGN_OFF =
        /(^|\n|[.!?]\s+)(best( regards| wishes)?|kind regards|warm regards|regards|many thanks|thanks( again)?|thank you|cheers|sincerely|yours (truly|sincerely)|all the best|talk soon|take care)\s*(,|!|\n)[\p{L} .'’-]{0,40}$/iu;
    const MAIL_HEADER = /(^|\n)\s*(from|subject):\s*\S/i;

    function isMailSite() {
        const host = location.hostname;
        return MAIL_HOSTS.test(host) || (/(^|\.)icloud\.com$/.test(host) && /\/mail/.test(location.pathname));
    }

    function looksLikeMessage(text) {
        return isMailSite() || GREETING.test(text) || SIGN_OFF.test(text.trim()) || MAIL_HEADER.test(text);
    }

    // ----- The attachment: what the conversation is currently about -----

    let askKind = null; // "text", "email", "code", "math", "image", "chart", "link", or null for nothing attached
    let askContext = ""; // the attached text
    let askRange = null; // where that text is on the page, if known
    let askImage = null; // the attached image, chart, link or hovered equation, instead of text
    let askCode = null; // the code block, when askKind is "code"
    let askLanguage = ""; // its programming language
    let askMathMode = "formula"; // for maths: "problem", "answered" or "formula"
    let askRequest = 0; // id of the conversation; "New chat" makes answers still on their way stale

    // While the box is open the text it's about stays softly marked, since focusing the question
    // field clears the page selection. Uses the CSS Custom Highlight API; nothing in the page changes.
    const ASKED_CSS = "::highlight(listen-asked) { background-color: rgba(10, 132, 255, 0.22); }";
    let askedSheet = null;

    function markAsked(range) {
        unmarkAsked();
        if (!range || typeof Highlight !== "function" || typeof CSS === "undefined" || !CSS.highlights) return;
        try {
            askedSheet = new CSSStyleSheet();
            askedSheet.replaceSync(ASKED_CSS);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, askedSheet];
            CSS.highlights.set("listen-asked", new Highlight(range));
        } catch (e) {
            console.warn("[Listen] Couldn't mark the highlighted text:", e);
        }
    }

    function unmarkAsked() {
        if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.delete("listen-asked");
        if (askedSheet) {
            const sheet = askedSheet;
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
            askedSheet = null;
        }
    }

    // ----- Translation target -----
    // The browser's language, or the last language the user typed ("translate to Spanish"), saved in
    // browser.storage.local. If the text is already in that language, English is used instead.

    const KNOWN_LANGUAGES = (
        "en es fr de it pt nl sv no da fi pl cs sk hu ro bg el ru uk tr ar he fa hi bn ur th vi id ms tl zh ja ko sw ca"
    ).split(" ");
    let translateTarget = null; // { name, code } typed by the user, if any

    function languageName(code) {
        try {
            return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
        } catch (e) {
            return code;
        }
    }

    function codeForName(name) {
        const wanted = name.trim().toLowerCase();
        return KNOWN_LANGUAGES.find((code) => languageName(code).toLowerCase() === wanted) || null;
    }

    // "translate this to Spanish" / "Translate into french?" → { name: "Spanish", code: "es" }
    function parseTranslateTarget(question) {
        const match = question.match(/\btranslate\b.*?\b(?:to|into)\s+(\p{L}[\p{L} ]*?)\s*[?.!]*$/iu);
        const code = match && codeForName(match[1]);
        return code ? { name: languageName(code), code } : null;
    }

    function rememberTranslateTarget(target) {
        translateTarget = target;
        try {
            browser.storage.local.set({ translateTarget: target }).catch(() => {});
        } catch (e) {
            // not saved; still used for this page
        }
    }

    function translationTarget() {
        const browserCode = navigator.language.split("-")[0].toLowerCase();
        let target = translateTarget || { name: languageName(browserCode), code: browserCode };
        const textCode = L.language.detect(askRange, askContext).split(/[-_]/)[0].toLowerCase();
        if (textCode === target.code && target.code !== "en") target = { name: "English", code: "en" };
        return target;
    }

    try {
        browser.storage.local.get("translateTarget").then((items) => {
            const saved = items.translateTarget;
            if (saved && typeof saved.name === "string" && typeof saved.code === "string") translateTarget = saved;
        }, () => {});
    } catch (e) {
        // storage unavailable; the browser language is used
    }

    // ----- Conversation -----

    let turns = []; // [{ role: "user" | "model", text, lang? }]
    let chatLoaded = null; // promise of loading this tab's conversation from background.js

    const KIND_LABELS = {
        text: "Text", email: "Message", code: "Code", image: "Image", chart: "Chart", link: "Link",
        problem: "Maths", answered: "Maths and your answer", formula: "Maths",
    };

    function snippet(text, max) {
        const flat = text.replace(/\s+/g, " ").trim();
        return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    }

    // Only text-like attachments are kept with the conversation: images, charts and links need the page.
    function savableAttachment() {
        if (!["text", "email", "code", "math"].includes(askKind) || askImage) return null;
        const context = askKind === "math" && askRange ? L.mathContext(askRange) : askContext;
        return { kind: askKind, context: context.slice(0, 20000), language: askLanguage, mathMode: askMathMode };
    }

    function saveChat() {
        const chat = turns.length || askKind ? { turns: turns.slice(-MAX_TURNS_KEPT), attachment: savableAttachment() } : null;
        try {
            browser.runtime.sendMessage({ type: "listen:chat-save", chat }).catch(() => {});
        } catch (e) {
            // not kept; the conversation still lasts as long as the page
        }
    }

    function loadChat() {
        chatLoaded ||= (async () => {
            let kept = null;
            try {
                kept = await browser.runtime.sendMessage({ type: "listen:chat-load" });
            } catch (e) {
                // nothing kept for this tab
            }
            if (!kept || !Array.isArray(kept.turns)) return;
            turns = kept.turns
                .filter((t) => (t.role === "user" || t.role === "model") && typeof t.text === "string")
                .map((t) => (t.visual ? { ...t, visual: L.cleanVisual(t.visual) || undefined } : t));
            const saved = kept.attachment;
            if (saved && typeof saved.context === "string" && ["text", "email", "code", "math"].includes(saved.kind)) {
                setAttachment({ kind: saved.kind, context: saved.context, language: saved.language || "", mathMode: saved.mathMode });
            }
            renderTurns();
        })();
        return chatLoaded;
    }

    // The last few turns, shortened, as context for the next request.
    // A chart or table goes along as its data, so "make that a line chart" works.
    function historyForRequest() {
        return turns.slice(-HISTORY_TURNS).map((t) => ({
            role: t.role,
            text: (t.visual ? `${t.text}\n${L.visualText(t.visual)}` : t.text).slice(0, HISTORY_TURN_CHARS),
        }));
    }

    // ----- Building the chat (its own Shadow DOM host, separate from the bar) -----

    const CHAT_CSS = `
        /* Colours for light and dark mode. */
        :host {
            --chat-bg: #ffffff;
            --chat-text: #1c1c1e;
            --chat-muted: #6e6e73;
            --chat-soft: #f2f2f7;
            --chat-soft-hover: #e5e5ea;
            --chat-card: #f7f7f9;
            --chat-border: #e5e5ea;
            --chat-field: #ffffff;
            --chat-field-border: #d1d1d6;
            --chat-strong: #1c1c1e;
            --chat-on-strong: #ffffff;
            --chat-accent: #0a84ff;
            --chat-accent-text: #0a64c8;
            --chat-error: #c62828;
            --chat-zebra: rgba(0, 0, 0, 0.03);
        }
        @media (prefers-color-scheme: dark) {
            :host {
                --chat-bg: #1c1c1e;
                --chat-text: #f2f2f7;
                --chat-muted: #98989d;
                --chat-soft: #2c2c2e;
                --chat-soft-hover: #3a3a3c;
                --chat-card: #2a2a2c;
                --chat-border: #38383a;
                --chat-field: #2c2c2e;
                --chat-field-border: #48484a;
                --chat-strong: #f2f2f7;
                --chat-on-strong: #1c1c1e;
                --chat-accent-text: #64b0ff;
                --chat-error: #ff6b6b;
                --chat-zebra: rgba(255, 255, 255, 0.04);
            }
        }
        button.bubble {
            position: fixed;
            width: ${BUBBLE_SIZE}px;
            height: ${BUBBLE_SIZE}px;
            touch-action: none;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
        }
        button.bubble.dragging { transform: scale(1.08); cursor: grabbing; transition: none; }
        .panel {
            position: fixed;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            width: ${CHAT_PANEL_WIDTH}px;
            max-height: calc(100vh - ${EDGE * 2}px);
            border-radius: 14px;
            background: var(--chat-bg);
            color: var(--chat-text);
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.28);
            font: 400 14px/1.45 -apple-system, "Helvetica Neue", sans-serif;
            text-align: left;
            overflow: hidden;
        }
        .panel.dragging { box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35); }
        .panel[hidden], .panel [hidden], button.bubble[hidden] { display: none; }
        .chat-head {
            flex: none;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 8px 8px 12px;
            border-bottom: 1px solid var(--chat-border);
            cursor: grab;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
        }
        .panel.dragging .chat-head { cursor: grabbing; }
        .chat-title { flex: 1; font-weight: 600; font-size: 13px; }
        .panel button { box-shadow: none; }
        .panel button:hover { transform: none; }
        button.head-button {
            width: auto;
            height: 24px;
            padding: 0 10px;
            border-radius: 12px;
            background: var(--chat-soft);
            color: var(--chat-text);
            font: 500 12px/1 -apple-system, "Helvetica Neue", sans-serif;
        }
        button.head-button.close { width: 24px; padding: 0; font-size: 16px; }
        button.head-button:hover { background: var(--chat-soft-hover); }
        .chat-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 10px; gap: 8px; }
        .attachment {
            flex: none;
            display: flex;
            align-items: flex-start;
            gap: 6px;
            padding: 6px 8px;
            border-left: 3px solid var(--chat-accent);
            border-radius: 8px;
            background: rgba(10, 132, 255, 0.1);
            font-size: 13px;
            line-height: 1.35;
        }
        .attachment-text {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
        }
        .attachment-kind { display: block; color: var(--chat-accent-text); font-size: 11px; font-weight: 600; }
        button.detach {
            width: 18px;
            height: 18px;
            background: transparent;
            color: var(--chat-muted);
            font-size: 14px;
        }
        button.detach:hover { color: var(--chat-text); }
        .messages {
            flex: 1 1 auto;
            min-height: 0;
            max-height: 440px;
            overflow: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .messages:empty { display: none; }
        .msg { overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
        .msg.user {
            align-self: flex-end;
            max-width: 85%;
            padding: 6px 10px;
            border-radius: 12px 12px 4px 12px;
            background: var(--chat-strong);
            color: var(--chat-on-strong);
            white-space: pre-wrap;
        }
        /* Answers: a full-width card with a small row of buttons under it. */
        .msg.model { display: flex; flex-direction: column; gap: 4px; }
        .answer {
            padding: 10px 12px;
            border: 1px solid var(--chat-border);
            border-radius: 12px;
            background: var(--chat-card);
            white-space: pre-wrap;
        }
        .answer .final {
            display: block;
            font-size: 22px;
            font-weight: 700;
            line-height: 1.25;
            font-variant-numeric: tabular-nums;
        }
        .answer .steps {
            display: block;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--chat-border);
            font-variant-numeric: tabular-nums;
        }
        .answer .step { display: block; }
        .answer-tools { display: flex; align-items: center; gap: 2px; padding-left: 4px; }
        .panel button.speak, .panel button.copy {
            width: 26px;
            height: 26px;
            border-radius: 6px;
            background: transparent;
            color: var(--chat-muted);
            font-size: 11px;
        }
        .panel button.speak:hover, .panel button.copy:hover { background: var(--chat-soft); color: var(--chat-text); }
        .copied { margin-left: 4px; color: var(--chat-muted); font-size: 12px; }
        .empty { margin: 0; color: var(--chat-muted); font-size: 13px; }
        .status { margin-top: 0; color: var(--chat-muted); }
        .status.error { color: var(--chat-error); }
        .status.loading::before { border-color: var(--chat-border); border-top-color: var(--chat-muted); }
        /* Quick actions: one row that scrolls sideways when it doesn't fit. */
        .chips {
            flex: none;
            flex-wrap: nowrap;
            margin: 0 -10px;
            padding: 0 10px;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .chips::-webkit-scrollbar { display: none; }
        .chips:empty { display: none; }
        .panel button.chip { flex: none; background: var(--chat-soft); color: var(--chat-text); }
        .panel button.chip:hover { background: var(--chat-soft-hover); }
        .panel input { background: var(--chat-field); color: var(--chat-text); border-color: var(--chat-field-border); }
        .panel input:focus { border-color: var(--chat-accent); }
        .panel button.send { background: var(--chat-strong); color: var(--chat-on-strong); }
        /* Settings (behind the gear). */
        button.head-button.gear { width: 24px; padding: 0; }
        button.head-button.gear[aria-pressed="true"] { background: var(--chat-strong); color: var(--chat-on-strong); }
        .settings {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 12px;
            font-size: 13px;
        }
        .settings-heading { margin-bottom: -4px; color: var(--chat-muted); font-size: 12px; font-weight: 600; }
        .settings-row { display: flex; gap: 6px; align-items: center; }
        .settings select {
            flex: 1;
            min-width: 0;
            height: 28px;
            padding: 0 6px;
            border: 1px solid var(--chat-field-border);
            border-radius: 8px;
            background: var(--chat-field);
            color: var(--chat-text);
            font: 400 13px -apple-system, "Helvetica Neue", sans-serif;
        }
        .speeds { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--chat-soft); }
        .panel .speeds button {
            flex: 1;
            width: auto;
            height: 26px;
            border-radius: 7px;
            background: transparent;
            color: var(--chat-text);
            font: 500 12px/1 -apple-system, "Helvetica Neue", sans-serif;
        }
        .panel .speeds button[aria-checked="true"] { background: var(--chat-bg); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
        .toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; }
        .toggle input {
            all: initial;
            -webkit-appearance: none;
            appearance: none;
            position: relative;
            flex: none;
            width: 34px;
            height: 20px;
            border-radius: 10px;
            background: var(--chat-field-border);
            cursor: pointer;
            transition: background 0.15s;
        }
        .toggle input::before {
            content: "";
            position: absolute;
            top: 2px;
            left: 2px;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #ffffff;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            transition: transform 0.15s;
        }
        .toggle input:checked { background: var(--chat-accent); }
        .toggle input:checked::before { transform: translateX(14px); }
        .toggle input:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; }
        .settings-note { margin: 0; color: var(--chat-muted); font-size: 12px; }
        /* Charts and tables in answers. */
        .visual { position: relative; margin-top: 10px; white-space: normal; }
        .visual-title { margin-bottom: 6px; font-size: 13px; font-weight: 600; }
        .visual svg { display: block; width: 100%; height: auto; overflow: visible; }
        .visual .grid { stroke: var(--chat-border); stroke-width: 1; }
        .visual .axis { stroke: var(--chat-muted); stroke-width: 1; }
        .visual .tick { fill: var(--chat-muted); font: 400 10px -apple-system, "Helvetica Neue", sans-serif; }
        .visual .axis-title { fill: var(--chat-muted); font: 600 10px -apple-system, "Helvetica Neue", sans-serif; }
        .visual .hit:hover { opacity: 0.8; }
        .visual .slice { stroke: var(--chat-card); stroke-width: 1.5; }
        .chart-tip {
            position: absolute;
            z-index: 1;
            padding: 4px 8px;
            border-radius: 6px;
            background: var(--chat-strong);
            color: var(--chat-on-strong);
            font-size: 12px;
            white-space: nowrap;
            pointer-events: none;
        }
        .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 12px; }
        .legend-item { display: inline-flex; align-items: center; gap: 5px; }
        .swatch { flex: none; width: 10px; height: 10px; border-radius: 3px; }
        .table-wrap { overflow-x: auto; border: 1px solid var(--chat-border); border-radius: 8px; }
        .visual table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
        .visual th, .visual td {
            padding: 5px 8px;
            border-bottom: 1px solid var(--chat-border);
            text-align: left;
            white-space: nowrap;
        }
        .visual th { background: var(--chat-soft); font-weight: 600; }
        .visual tbody tr:nth-child(even) td { background: var(--chat-zebra); }
        .visual tbody tr:last-child td { border-bottom: 0; }
        .visual .num { text-align: right; }
    `;

    let chatHost = null;
    let chatShadow = null;
    let chat = null; // { panel, head, bubble, attachment, attachmentKind, attachmentText, messages, empty, status, chipRow, chips, input, send }
    let panelPosition = null; // { x, y } last chosen by dragging, from browser.storage.local
    let bubblePosition = null;

    function chatButton(className, label, content) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = className;
        b.title = label;
        b.setAttribute("aria-label", label);
        b.append(content);
        return b;
    }

    function createChat() {
        chatHost = document.createElement("listen-chat-root");
        chatHost.style.cssText = "all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;";
        chatShadow = chatHost.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = L.BAR_CSS + CHAT_CSS;

        const bubble = chatButton("bubble", "Open Listen chat", L.svgIcon("chat", 20));

        const panel = document.createElement("div");
        panel.className = "panel";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Listen chat");

        const head = document.createElement("div");
        head.className = "chat-head";
        const title = document.createElement("span");
        title.className = "chat-title";
        title.textContent = "Listen";
        const gear = chatButton("head-button gear", "Settings", L.svgIcon("gear", 15));
        gear.setAttribute("aria-pressed", "false");
        const newChat = chatButton("head-button", "New chat", "New chat");
        const close = chatButton("head-button close", "Close", "×");
        head.append(title, gear, newChat, close);

        const body = document.createElement("div");
        body.className = "chat-body";
        const attachment = document.createElement("div");
        attachment.className = "attachment";
        attachment.hidden = true;
        const attachmentText = document.createElement("div");
        attachmentText.className = "attachment-text";
        const detach = chatButton("detach", "Remove from the chat", "×");
        attachment.append(attachmentText, detach);

        const messages = document.createElement("div");
        messages.className = "messages";
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "Ask anything. To ask about part of the page, highlight it and press the chat button.";
        const status = document.createElement("div");
        status.className = "status";
        status.hidden = true;
        const chips = document.createElement("div");
        chips.className = "chips";
        const row = document.createElement("div");
        row.className = "ask-row";
        const input = document.createElement("input");
        input.type = "text";
        input.setAttribute("aria-label", "Message");
        const send = chatButton("send", "Send", "↑");
        row.append(input, send);
        body.append(attachment, messages, empty, status, chips, row);
        const settingsView = buildSettings();
        panel.append(head, body, settingsView.view);

        chatShadow.append(style, bubble, panel);
        document.documentElement.appendChild(chatHost);
        chat = {
            panel, head, bubble, body, gear, settings: settingsView, attachment, attachmentText, messages, empty, status,
            chipRow: chips, chips: [], input, send,
        };

        // Keep typing out of the page (site shortcuts) and out of our own page-level key handlers.
        for (const type of ["keydown", "keyup", "keypress"]) {
            panel.addEventListener(type, (event) => event.stopPropagation());
        }
        panel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeAsk();
            } else if (event.key === "Enter" && event.target === input && !event.isComposing) {
                event.preventDefault();
                sendQuestion();
            }
        });
        send.addEventListener("click", () => sendQuestion());
        newChat.addEventListener("click", () => startNewChat());
        close.addEventListener("click", () => closeAsk());
        gear.addEventListener("click", () => showSettings(chat.body.hidden === false));
        detach.addEventListener("click", () => {
            clearAttachment();
            saveChat();
            input.focus();
        });
        bubble.addEventListener("click", () => {
            if (bubble.dataset.dragged) {
                delete bubble.dataset.dragged;
                return;
            }
            if (isAskOpen()) closeAsk();
            else openChat("bubble");
        });
        messages.addEventListener("scroll", () => L.highlighter.relayout(), { passive: true });
        makeDraggable(panel, head, "chatPanelPos", (pos) => (panelPosition = pos));
        makeDraggable(bubble, bubble, "chatBubblePos", (pos) => (bubblePosition = pos));
        placeBubble();
        updateBubble();
    }

    function isChatEvent(event) {
        return chatHost !== null && event.composedPath().includes(chatHost);
    }

    // ----- Dragging (smooth, kept fully on screen, last position remembered) -----

    function clampPosition(element, x, y) {
        const viewWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewHeight = window.innerHeight;
        return {
            x: Math.round(Math.max(EDGE, Math.min(x, viewWidth - element.offsetWidth - EDGE))),
            y: Math.round(Math.max(EDGE, Math.min(y, viewHeight - element.offsetHeight - EDGE))),
        };
    }

    function place(element, x, y) {
        const pos = clampPosition(element, x, y);
        element.style.left = `${pos.x}px`;
        element.style.top = `${pos.y}px`;
        return pos;
    }

    function keepOnScreen(element) {
        if (element.hidden) return;
        place(element, parseFloat(element.style.left) || 0, parseFloat(element.style.top) || 0);
    }

    // After the window is resized: the bubble back in its place and the panel fully on screen.
    function keepChatOnScreen() {
        if (!chat) return;
        if (!chat.bubble.hidden) placeBubble();
        keepOnScreen(chat.panel);
    }

    // Lets `element` (position: fixed) be dragged by `handle`; a press on another button inside the handle
    // is left alone. Moves follow the pointer once per frame. The final position is saved under `key`.
    function makeDraggable(element, handle, key, remember) {
        handle.addEventListener("pointerdown", (event) => {
            const pressed = event.target.closest && event.target.closest("button");
            if (event.button !== 0 || (pressed && pressed !== handle)) return;
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
            let moved = false;
            let frame = 0;
            let target = null;
            handle.setPointerCapture(event.pointerId);
            const move = (e) => {
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
                if (!moved) {
                    moved = true;
                    element.classList.add("dragging");
                }
                target = { x: start.left + dx, y: start.top + dy };
                frame ||= requestAnimationFrame(() => {
                    frame = 0;
                    place(element, target.x, target.y);
                });
            };
            const end = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
                if (!moved) return;
                cancelAnimationFrame(frame);
                frame = 0;
                const pos = place(element, target.x, target.y);
                element.classList.remove("dragging");
                element.dataset.dragged = "1"; // the click that follows a drag is ignored
                setTimeout(() => delete element.dataset.dragged, 0);
                remember(pos);
                try {
                    browser.storage.local.set({ [key]: pos }).catch(() => {});
                } catch (e) {
                    // not remembered; it stays where it is on this page
                }
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        });
    }

    function placeBubble() {
        const { bubble } = chat;
        if (bubblePosition) place(bubble, bubblePosition.x, bubblePosition.y);
        else place(bubble, Infinity, Infinity); // bottom-right corner
    }

    // The bubble shows on every page unless it's switched off in the popup or AI features are off.
    function updateBubble() {
        if (!chat) return;
        chat.bubble.hidden = !L.settings.showChatBubble || !L.settings.aiFeatures;
        if (!chat.bubble.hidden) placeBubble();
    }

    // Where the panel opens: where it was last dragged to, else next to the bar or above the bubble.
    function placePanel(from) {
        const { panel, bubble } = chat;
        if (panelPosition) {
            place(panel, panelPosition.x, panelPosition.y);
        } else if (from === "bar" && S.barHost && S.barHost.style.display !== "none") {
            const bar = S.barHost.getBoundingClientRect();
            place(panel, bar.left, bar.bottom + 8);
        } else if (!bubble.hidden) {
            const b = bubble.getBoundingClientRect();
            place(panel, b.right - panel.offsetWidth, b.top - panel.offsetHeight - 8);
        } else {
            place(panel, Infinity, Infinity); // bottom-right corner
        }
    }

    try {
        browser.storage.local.get(["chatPanelPos", "chatBubblePos"]).then((items) => {
            const valid = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
            if (valid(items.chatPanelPos)) panelPosition = items.chatPanelPos;
            if (valid(items.chatBubblePos)) {
                bubblePosition = items.chatBubblePos;
                if (chat) placeBubble();
            }
        }, () => {});
    } catch (e) {
        // default positions
    }

    // ----- Opening and closing -----

    function isAskOpen() {
        return chat !== null && !chat.panel.hidden;
    }

    async function openChat(from) {
        if (!L.settings.aiFeatures) return;
        if (!chat) createChat();
        await loadChat();
        const wasOpen = isAskOpen();
        chat.panel.hidden = false;
        if (chat.body.hidden) showSettings(false);
        renderAttachment();
        renderTurns();
        if (!wasOpen) placePanel(from);
        keepOnScreen(chat.panel);
        chat.input.focus();
    }

    function closeAsk() {
        if (!isAskOpen()) return;
        if (S.readingAnswer) L.speech.stop();
        chat.panel.hidden = true;
        unmarkAsked();
    }

    function startNewChat() {
        askRequest++; // answers still on their way belong to the old chat
        if (S.readingAnswer) L.speech.stop();
        turns = [];
        clearAttachment();
        setAskBusy(false);
        chat.status.hidden = true;
        renderTurns();
        saveChat();
        chat.input.focus();
    }

    // The bar's chat button (or the toolbar button, `from` "toolbar"): attaches the selection (or the hovered
    // image, chart, link or equation) and opens the chat. With nothing to attach it opens or closes the chat.
    async function openAsk(from = "bar") {
        const context = S.selectedText || S.lastReadText;
        if (!S.imageTarget && !context) {
            if (isAskOpen()) closeAsk();
            else openChat(from);
            return;
        }
        const image = S.imageTarget;
        const code = !image && S.selectedText ? S.selectedCodeBlock : null;
        const range = image ? null : S.selectedText ? S.selectedRange : S.lastReadRange;
        let kind = image ? S.imageKind : code ? "code" : "text";
        let mathMode = "formula";
        if (kind === "text") {
            const problem = L.mathsProblem(context);
            if (problem || L.rangeHasMath(range, context)) {
                kind = "math";
                mathMode = problem || "formula";
            } else if (looksLikeMessage(context)) {
                kind = "email";
            }
        }
        await openChat(from);
        setAttachment({
            kind, context: image ? "" : context, range, image, code,
            language: code ? L.codeLanguage(code) : "", mathMode,
        });
        saveChat();
        // The bar's job is done; it would otherwise sit on top of the panel.
        window.getSelection().removeAllRanges();
        L.hideBar();
        chat.input.focus();
    }

    function setAttachment({ kind, context, range = null, image = null, code = null, language: programmingLanguage = "", mathMode = "formula" }) {
        askKind = kind;
        askContext = context;
        askRange = range;
        askImage = image;
        askCode = code;
        askLanguage = programmingLanguage;
        askMathMode = kind === "math" && !image ? mathMode || "formula" : "formula";
        if (isAskOpen()) markAsked(askRange);
        if (chat) renderAttachment();
    }

    function clearAttachment() {
        setAttachment({ kind: null, context: "" });
        unmarkAsked();
    }

    function attachmentLabel() {
        if (askKind === "image") return (askImage && L.imageInfo(askImage).alt) || "An image on the page";
        if (askKind === "chart") return L.captionOf(askImage) || "A chart on the page";
        if (askKind === "link") {
            const url = L.linkUrl(askImage);
            return url ? `${url.hostname}${url.pathname === "/" ? "" : url.pathname}` : "A link";
        }
        if (askKind === "math" && askImage) return L.mathSpeech(askImage);
        return askContext;
    }

    function renderAttachment() {
        const { attachment, attachmentText, input } = chat;
        attachment.hidden = !askKind;
        const chipLists = {
            text: CHIPS, email: EMAIL_CHIPS, code: L.CODE_CHIPS, image: IMAGE_CHIPS, chart: L.CHART_CHIPS, link: L.LINK_CHIPS,
            math: { problem: MATH_PROBLEM_CHIPS, answered: MATH_ANSWER_CHIPS, formula: MATH_CHIPS }[askMathMode],
        };
        renderChips(askKind ? chipLists[askKind] : []);
        // Text can be asked about or worked on ("write a reply", "make this shorter").
        const placeholders = {
            text: "Ask anything, or say what you need…", email: "Ask, or say what to write…",
            code: "Ask about the code…", math: "Ask about the maths…", image: "Ask about the image…",
            chart: "Ask about the chart…", link: "Ask about the linked page…",
        };
        input.placeholder = askKind ? placeholders[askKind] : "Ask anything…";
        chat.empty.hidden = turns.length > 0 || Boolean(askKind);
        if (!askKind) return;
        const kind = document.createElement("span");
        kind.className = "attachment-kind";
        kind.textContent = askKind === "math" ? KIND_LABELS[askMathMode] : KIND_LABELS[askKind];
        const isQuote = !["image", "chart", "link"].includes(askKind);
        const label = snippet(attachmentLabel(), 140);
        attachmentText.replaceChildren(kind, isQuote ? `“${label}”` : label);
        attachmentText.title = snippet(attachmentLabel(), 600);
        if (isAskOpen()) markAsked(askRange);
    }

    function renderChips(list) {
        chat.chips = list.map(([action, label, title]) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip";
            chip.textContent = label;
            chip.title = title;
            chip.addEventListener("click", () => sendChip(action, label));
            return chip;
        });
        chat.chipRow.replaceChildren(...chat.chips);
        setAskBusy(askBusy);
    }

    // ----- Messages -----

    function renderTurns() {
        if (!chat) return;
        chat.messages.replaceChildren(...turns.map(turnElement));
        chat.empty.hidden = turns.length > 0 || Boolean(askKind);
        chat.messages.scrollTop = chat.messages.scrollHeight;
        updateSpeakButtons();
        keepOnScreen(chat.panel);
    }

    function turnElement(turn) {
        const msg = document.createElement("div");
        msg.className = `msg ${turn.role}`;
        if (turn.role === "user") {
            msg.textContent = turn.text;
            return msg;
        }
        const answer = document.createElement("div");
        answer.className = "answer";
        const answerText = document.createElement("div");
        answerText.className = "answer-text";
        fillAnswer(answerText, turn.text);
        if (turn.lang) answerText.lang = turn.lang;
        answer.append(answerText);
        if (turn.visual) answer.append(L.visualElement(turn.visual));
        const tools = document.createElement("div");
        tools.className = "answer-tools";
        const speak = chatButton("speak", "Read answer aloud", "");
        const copyLabel = !turn.visual ? "Copy answer"
            : turn.visual.kind === "table" ? "Copy table (pastes into Sheets or Excel)" : "Copy the chart's data";
        const copy = chatButton("copy", copyLabel, L.svgIcon("copy", 14));
        const copied = document.createElement("div");
        copied.className = "copied";
        copied.setAttribute("role", "status");
        copied.hidden = true;
        tools.append(speak, copy, copied);
        msg.append(answer, tools);
        speak.addEventListener("click", () => {
            if (S.readingAnswer === answerText) L.speech.stop();
            else readAnswer(answerText);
        });
        copy.addEventListener("click", () => copyAnswer(turn.visual ? L.visualText(turn.visual) : turn.text, tools));
        return msg;
    }

    // A maths answer starts with its final answer on its own line ("= 26", "x = 2") followed by the
    // working, one equation per line: the answer is shown large and bold, the steps underneath.
    const FINAL_ANSWER = /^\s*(=|≈|[a-zA-Zα-ω]\s*[=≈])\s*\S/;

    function fillAnswer(answer, text) {
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        if (!lines.length || !FINAL_ANSWER.test(lines[0]) || lines[0].length > 40) {
            answer.textContent = text;
            return;
        }
        const final = document.createElement("span");
        final.className = "final";
        final.textContent = lines[0];
        answer.append(final);
        if (lines.length < 2) return;
        const steps = document.createElement("span");
        steps.className = "steps";
        for (const line of lines.slice(1)) {
            const step = document.createElement("span");
            step.className = "step";
            step.textContent = line;
            steps.append(step);
        }
        answer.append(steps);
    }

    function addTurn(turn) {
        turns.push(turn);
        if (turns.length > MAX_TURNS_KEPT) turns = turns.slice(-MAX_TURNS_KEPT);
        renderTurns();
        saveChat();
    }

    function showAskStatus(kind, message) {
        const { status } = chat;
        status.hidden = false;
        status.className = `status ${kind}`;
        status.textContent = message;
        chat.empty.hidden = true;
        keepOnScreen(chat.panel);
    }

    let askBusy = false;

    function setAskBusy(busy) {
        askBusy = busy;
        if (!chat) return;
        chat.send.disabled = busy;
        for (const chip of chat.chips) chip.disabled = busy;
    }

    function sendQuestion() {
        const question = chat.input.value.trim();
        if (!question || askBusy) return;
        chat.input.value = "";
        const target = parseTranslateTarget(question);
        if (target) rememberTranslateTarget(target);
        // Images, charts and linked pages go with the question; everything else goes to the tutor chat,
        // with any attached text.
        const action = ["image", "chart", "link"].includes(askKind) ? "ask" : "chat";
        askGemini({ action, question }, target ? target.code : "", question);
    }

    function sendChip(action, label) {
        if (action === "readit") {
            // Read the maths aloud with Listen's own spoken form (no Gemini needed).
            if (askImage && askKind === "math") L.onListenMath(askImage);
            else if (askRange) L.read(askRange, askContext, null);
            return;
        }
        if (action !== "translate" || askImage) {
            askGemini({ action }, "", label);
            return;
        }
        const target = translationTarget();
        askGemini({ action, target: target.name }, target.code, `${label} to ${target.name}`);
    }

    // Sends a request to background.js; always resolves to { ok, answer } or { ok: false, error }.
    async function askBackground(request) {
        if (!L.settings.aiFeatures) {
            // imageUnavailable lets an image fall back to its alt text.
            return { ok: false, error: "AI features are off. You can turn them on from Listen's toolbar button.", imageUnavailable: true };
        }
        try {
            const timeout = new Promise((resolve) =>
                setTimeout(() => resolve({ ok: false, error: "No answer came back in time. Try again." }), ASK_TIMEOUT_MS)
            );
            const response = await Promise.race([browser.runtime.sendMessage({ type: "listen:ask", ...request }), timeout]);
            return response || { ok: false, error: "No answer came back. Try again." };
        } catch (e) {
            return { ok: false, error: "Couldn't reach Listen's background page. Reload the page and try again." };
        }
    }

    // An error message, plus the image's alt text when the image itself couldn't be fetched.
    function withAltText(response) {
        const alt = askImage && askImage.tagName === "IMG" ? L.imageInfo(askImage).alt : "";
        return response.imageUnavailable && alt ? `${response.error} Its alt text says: “${alt}”` : response.error;
    }

    // What's attached, in the form background.js expects.
    async function aboutAttachment() {
        if (askKind === "link") return { link: { url: L.linkUrl(askImage).href } };
        if (askKind === "code") return { code: { text: askContext, language: askLanguage } };
        if (askKind === "math") {
            const text = askImage ? L.texOf(askImage) || L.mathSpeech(askImage) : askRange ? L.mathContext(askRange) : askContext;
            return { math: { text } };
        }
        if (askKind === "chart") return { chart: await L.chartInfo(askImage) };
        if (askKind === "image") return { image: L.imageInfo(askImage) };
        return askKind ? { text: askContext } : {};
    }

    // Sends `request` ({ action, question?, target? }) with the attachment and the last few turns, shows
    // `userText` as the student's message and the answer below it.
    async function askGemini(request, answerLang, userText) {
        if (askBusy) return;
        if (S.readingAnswer) L.speech.stop();
        const id = askRequest;
        const history = historyForRequest();
        addTurn({ role: "user", text: userText });
        setAskBusy(true);
        showAskStatus("loading", "Thinking…");
        let about;
        try {
            about = await aboutAttachment();
        } catch (error) {
            setAskBusy(false);
            if (id === askRequest) showAskStatus("error", error instanceof L.CaptureError ? error.message : "This chart couldn't be captured.");
            return;
        }
        const response = await askBackground({ ...request, ...about, history });
        if (id !== askRequest) return; // "New chat" was pressed meanwhile
        setAskBusy(false);
        if (response.ok) {
            chat.status.hidden = true;
            const visual = L.cleanVisual(response.visual);
            addTurn({ role: "model", text: response.answer, lang: answerLang || undefined, ...(visual ? { visual } : {}) });
            L.language.prepare(response.answer);
        } else {
            showAskStatus("error", withAltText(response));
        }
    }

    // ----- Settings (the gear in the chat's header) -----
    // The same settings as the settings page, saved in browser.storage.local; every open tab applies them
    // through storage.onChanged (see Settings).

    const SETTING_SWITCHES = [
        ["showImageButtons", "Buttons on images and charts"],
        ["showLinkButtons", "Buttons on links"],
        ["showChatBubble", "Chat bubble on pages"],
        ["aiFeatures", "AI features (chat)"],
    ];
    const SETTINGS_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
    const TEST_SENTENCE = "This is how Listen sounds when it reads to you.";
    const DAILY_QUESTIONS = 30; // the proxy's limit, shown until the first answer reports the real one

    function storeSetting(values) {
        try {
            browser.storage.local.set(values).catch((e) => console.warn("[Listen] Couldn't save settings:", e));
        } catch (e) {
            console.warn("[Listen] Couldn't save settings:", e);
        }
    }

    function settingsHeading(text) {
        const heading = document.createElement("div");
        heading.className = "settings-heading";
        heading.textContent = text;
        return heading;
    }

    function buildSettings() {
        const view = document.createElement("div");
        view.className = "settings";
        view.hidden = true;

        const voiceRow = document.createElement("div");
        voiceRow.className = "settings-row";
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Voice");
        const test = chatButton("head-button", "Test the voice", "Test");
        voiceRow.append(select, test);

        const speeds = document.createElement("div");
        speeds.className = "speeds";
        speeds.setAttribute("role", "radiogroup");
        speeds.setAttribute("aria-label", "Default speed");

        const switches = {};
        const toggles = SETTING_SWITCHES.map(([key, label]) => {
            const row = document.createElement("label");
            row.className = "toggle";
            const text = document.createElement("span");
            text.textContent = label;
            const box = document.createElement("input");
            box.type = "checkbox";
            box.setAttribute("role", "switch");
            box.addEventListener("change", () => storeSetting({ [key]: box.checked }));
            switches[key] = box;
            row.append(text, box);
            return row;
        });

        const usage = document.createElement("p");
        usage.className = "settings-note";
        const privacy = document.createElement("p");
        privacy.className = "settings-note";
        privacy.textContent = "Questions are sent to Google Gemini to answer. Reading stays on your Mac.";

        view.append(settingsHeading("Voice"), voiceRow, settingsHeading("Default speed"), speeds, ...toggles, usage, privacy);

        select.addEventListener("change", () => {
            L.speech.setVoice(select.value);
            storeSetting({ voice: select.value });
        });
        test.addEventListener("click", () => {
            if (test.textContent === "Stop") {
                L.speech.stop();
                return;
            }
            const done = () => (test.textContent = "Test");
            test.textContent = "Stop";
            L.speech.speak(TEST_SENTENCE, { onWord() {}, onWordTimingUnavailable() {}, onEnd: done }, navigator.language || "en");
        });
        return { view, select, test, speeds, switches, usage };
    }

    function fillVoices() {
        const { select } = chat.settings;
        const voices = L.speech.voiceChoices();
        select.replaceChildren(new Option("Automatic (best available)", ""));
        for (const voice of voices) select.add(new Option(voice.label, voice.uri));
        // A saved voice that's no longer installed shows as Automatic.
        select.value = voices.some((v) => v.uri === L.settings.voice) ? L.settings.voice : "";
        return voices.length > 0;
    }

    function showSpeeds() {
        const { speeds } = chat.settings;
        speeds.replaceChildren(
            ...SETTINGS_SPEEDS.map((value) => {
                const b = document.createElement("button");
                b.type = "button";
                b.setAttribute("role", "radio");
                b.setAttribute("aria-checked", String(value === S.speed));
                b.textContent = `${value}x`;
                b.addEventListener("click", () => {
                    L.setSpeed(value, true);
                    showSpeeds();
                });
                return b;
            })
        );
    }

    function showUsage(usage) {
        const el = chat.settings.usage;
        const today = new Date().toISOString().slice(0, 10); // the proxy counts by UTC day
        if (usage && usage.day === today && Number.isInteger(usage.remaining)) {
            el.textContent = `${usage.remaining} of ${usage.limit} question${usage.limit === 1 ? "" : "s"} left today`;
        } else {
            el.textContent = `${(usage && usage.limit) || DAILY_QUESTIONS} questions a day — none used yet today`;
        }
    }

    // Shows the settings in place of the conversation, or the conversation again.
    function showSettings(open) {
        chat.body.hidden = open;
        chat.settings.view.hidden = !open;
        chat.gear.setAttribute("aria-pressed", String(open));
        chat.gear.title = open ? "Back to the chat" : "Settings";
        if (!open) {
            if (chat.settings.test.textContent === "Stop") L.speech.stop();
            chat.input.focus();
            keepOnScreen(chat.panel);
            return;
        }
        if (!fillVoices()) speechSynthesis.addEventListener("voiceschanged", fillVoices, { once: true });
        showSpeeds();
        for (const [key, box] of Object.entries(chat.settings.switches)) box.checked = L.settings[key];
        showUsage(null);
        try {
            browser.storage.local.get("usage").then((items) => showUsage(items.usage), () => {});
        } catch (e) {
            // the default line stays
        }
        keepOnScreen(chat.panel);
    }

    // Keeps the open settings in step with changes made elsewhere (the settings page, another tab).
    function refreshSettingsView() {
        if (!chat || chat.settings.view.hidden) return;
        for (const [key, box] of Object.entries(chat.settings.switches)) box.checked = L.settings[key];
        showSpeeds();
    }

    // ----- Toolbar button -----
    // background.js sends "listen:open-chat" when Listen's toolbar button is clicked: the chat opens with any
    // highlighted text attached, or closes if it's open and nothing new is highlighted. With AI features off
    // the answer is false, and background.js opens the settings page instead.

    function openFromToolbar() {
        if (!L.settings.aiFeatures) return false;
        const result = L.readSelection();
        if (result) {
            S.selectedText = result.text;
            S.selectedRange = result.range;
            S.selectedCodeBlock = result.codeBlock;
            S.imageTarget = null;
            openAsk("toolbar");
        } else if (isAskOpen()) {
            closeAsk();
        } else {
            openChat("toolbar");
        }
        return true;
    }

    try {
        browser.runtime.onMessage.addListener((message) => {
            if (message && message.type === "listen:open-chat") return Promise.resolve(openFromToolbar());
        });
    } catch (e) {
        console.warn("[Listen] Toolbar messages unavailable:", e);
    }

    // ----- Read aloud and Copy -----

    function updateSpeakButtons() {
        if (!chat) return;
        for (const msg of chat.messages.querySelectorAll(".msg.model")) {
            const playing = S.readingAnswer === msg.querySelector(".answer-text");
            const speak = msg.querySelector("button.speak");
            speak.replaceChildren(playing ? "■" : L.svgIcon("speaker", 14));
            speak.classList.toggle("stop", playing);
            speak.title = playing ? "Stop" : "Read answer aloud";
            speak.setAttribute("aria-label", speak.title);
        }
    }

    function readAnswer(answer) {
        if (!answer.textContent) return;
        const range = document.createRange();
        range.selectNodeContents(answer);
        L.read(range, answer.textContent, answer);
    }

    const COPIED_MS = 1500;
    let copiedTimer = null;
    let copiedTools = null;

    // `ok`: true shows "Copied", false "Couldn't copy", null resets the button.
    function showCopied(tools, ok) {
        if (copiedTools && copiedTools !== tools) showCopied(copiedTools, null);
        clearTimeout(copiedTimer);
        copiedTools = ok === null ? null : tools;
        tools.querySelector("button.copy").replaceChildren(L.svgIcon(ok ? "check" : "copy", 14));
        const copied = tools.querySelector(".copied");
        copied.hidden = ok === null;
        copied.textContent = ok ? "Copied" : "Couldn't copy";
        if (ok !== null) copiedTimer = setTimeout(() => showCopied(tools, null), COPIED_MS);
    }

    // The older copy command is the fallback where the clipboard API isn't allowed.
    function copyWithCommand(text) {
        const field = document.createElement("textarea");
        field.value = text;
        field.style.cssText = "position: fixed; opacity: 0;";
        chatShadow.append(field);
        field.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch (e) {
            // not copied
        }
        field.remove();
        return ok;
    }

    async function copyAnswer(text, tools) {
        if (!text) return;
        let ok;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (e) {
            ok = copyWithCommand(text);
        }
        showCopied(tools, ok);
    }

    // For the other content scripts.
    Object.assign(L, {
        createChat, isChatEvent, keepChatOnScreen, updateBubble, isAskOpen, closeAsk, openAsk, askBackground,
        refreshSettingsView, updateSpeakButtons,
    });
})();

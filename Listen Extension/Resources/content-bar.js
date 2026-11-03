// Listen — content scripts, 6 of 10: reading aloud, the floating bar (speaker, speed and chat buttons), speed and
// settings (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;
    const S = L.state;

    // ---------- Reading ----------

    // Reads `range` aloud with word highlighting; `text` is the fallback if it can't be mapped.
    async function read(range, text, isAnswer) {
        L.speech.stop(); // end any current reading (and its highlights) before preparing the new one
        const hard = range ? L.mathNeedingHelp(range) : [];
        if (hard.length) {
            const id = ++S.imageRequest;
            S.imageBusy = true;
            setButtonIcon("loading");
            if (S.barShadow) L.showNote("Working out how to say the maths…", "info");
            await L.prepareMath(hard);
            if (id !== S.imageRequest) return; // cancelled
            S.imageBusy = false;
            if (S.note) S.note.hidden = true;
        }
        const lang = L.language.detect(range, text);
        const spoken = (range && L.highlighter.prepare(range)) || text;
        L.speech.speak(
            spoken,
            { onWord: L.highlighter.showWord, onWordTimingUnavailable: L.highlighter.clear, onEnd: onReadingEnded },
            lang
        );
        S.readingAnswer = isAnswer || null;
        L.updateSpeakButtons();
        setButtonIcon("stop");
    }

    // Called when the user clicks the speaker button.
    function onListen() {
        const range = S.selectedRange;
        const codeBlock = S.selectedCodeBlock;
        if (codeBlock && settings.aiFeatures) {
            L.onListenCode(S.selectedText, codeBlock); // see Code
            return;
        }
        S.lastReadText = S.selectedText;
        S.lastReadRange = range;
        read(range, S.selectedText, false);
        // Clear the blue selection so it doesn't cover the word highlights.
        if (range) window.getSelection().removeAllRanges();
    }

    // Reads `text` about `element` (an image) aloud, framing the element instead of highlighting words.
    function readAbout(element, text) {
        L.speech.stop();
        const lang = L.language.detect(null, text);
        L.highlighter.outline(element);
        L.speech.speak(text, { onWord() {}, onWordTimingUnavailable() {}, onEnd: onReadingEnded }, lang);
        S.readingAnswer = null;
        L.updateSpeakButtons();
        setButtonIcon("stop");
    }

    function onReadingEnded() {
        L.highlighter.clear();
        S.readingAnswer = null;
        L.updateSpeakButtons();
        setButtonIcon("listen");
        // If nothing is selected or hovered by the time reading ends, the bar has nothing left to do.
        if (!L.readSelection() && !(S.imageTarget && S.imageTarget.matches(":hover"))) hideBar();
    }

    // ---------- Floating bar (isolated in a Shadow DOM so host page CSS can't touch it) ----------
    // A row of buttons: speaker (listen / stop), speed and chat (attaches the selection to the chat; see Chat).

    const BUTTON_SIZE = 30;
    const OFFSET = 6;
    const ASK_PANEL_WIDTH = 320; // the note under the bar

    const ICONS = {
        listen: { svg: "speaker", label: "Read selected text aloud", title: "Listen" },
        stop: { text: "■", label: "Stop reading", title: "Stop" },
        loading: { text: "", label: "Describing the image. Click to cancel.", title: "Describing image…" },
    };

    const BAR_CSS = `
        :host { all: initial; }
        .bar {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        button {
            all: initial;
            box-sizing: border-box;
            width: ${BUTTON_SIZE}px;
            height: ${BUTTON_SIZE}px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: #1c1c1e;
            color: #ffffff;
            font: 400 14px/1 -apple-system, "Helvetica Neue", sans-serif;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            user-select: none;
            -webkit-user-select: none;
            transition: transform 0.1s ease;
        }
        button svg { display: block; flex: none; }
        /* Fixed width (fits "1.25x") so the button doesn't move under the pointer as the label changes. */
        button.speed {
            width: 54px;
            padding: 0;
            border-radius: ${BUTTON_SIZE / 2}px;
            font: 600 13px/1 -apple-system, "Helvetica Neue", sans-serif;
            font-variant-numeric: tabular-nums;
        }
        button:hover { transform: scale(1.08); }
        button:active { transform: scale(0.95); }
        button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
        button:disabled { opacity: 0.4; cursor: default; transform: none; }
        button[hidden] { display: none; }

        .ask-row { display: flex; gap: 6px; align-items: center; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        button.chip {
            flex: 1 0 auto;
            width: auto;
            height: 24px;
            padding: 0 9px;
            white-space: nowrap;
            border-radius: 12px;
            background: #f2f2f7;
            color: #1c1c1e;
            font: 500 12px/1 -apple-system, "Helvetica Neue", sans-serif;
            box-shadow: none;
        }
        button.chip:hover { background: #e5e5ea; transform: none; }
        button.loading::after {
            content: "";
            box-sizing: border-box;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: #ffffff;
            border-radius: 50%;
            animation: listen-spin 0.8s linear infinite;
        }
        .note {
            position: absolute;
            top: ${BUTTON_SIZE + 8}px;
            right: 0;
            box-sizing: border-box;
            width: ${ASK_PANEL_WIDTH}px;
            padding: 10px;
            border-radius: 12px;
            background: #ffffff;
            color: #c62828;
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
            font: 400 13px/1.4 -apple-system, "Helvetica Neue", sans-serif;
        }
        .note[hidden] { display: none; }
        .note.info { color: #1c1c1e; }
        input {
            all: initial;
            flex: 1;
            min-width: 0;
            box-sizing: border-box;
            height: ${BUTTON_SIZE}px;
            padding: 0 10px;
            border: 1px solid #d1d1d6;
            border-radius: 8px;
            background: #ffffff;
            color: #1c1c1e;
            font: 400 14px -apple-system, "Helvetica Neue", sans-serif;
        }
        input:focus { border-color: #0a84ff; }
        button.send { font: 700 16px/1 -apple-system, "Helvetica Neue", sans-serif; }
        .status { margin-top: 8px; color: #6e6e73; }
        .status.loading::before {
            content: "";
            display: inline-block;
            width: 10px;
            height: 10px;
            margin-right: 8px;
            border: 2px solid #d1d1d6;
            border-top-color: #6e6e73;
            border-radius: 50%;
            vertical-align: -1px;
            animation: listen-spin 0.8s linear infinite;
        }
        @keyframes listen-spin { to { transform: rotate(360deg); } }
        .status.error { color: #c62828; }
    `;

    let button = null; // speaker / ■
    let speedButton = null;
    let askButton = null; // hidden while AI features are off (see Settings)
    let buttonIcon = "listen";

    function createBar() {
        S.barHost = document.createElement("listen-extension-root");
        S.barHost.style.cssText =
            "all: initial; position: absolute; z-index: 2147483647; display: none;";

        const shadow = S.barHost.attachShadow({ mode: "closed" });
        S.barShadow = shadow;
        const style = document.createElement("style");
        style.textContent = BAR_CSS;

        const bar = document.createElement("div");
        bar.className = "bar";
        // Keep the page selection intact when any button is pressed.
        bar.addEventListener("mousedown", (event) => event.preventDefault());

        button = document.createElement("button");
        button.type = "button";
        applyIcon();
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (buttonIcon === "stop") L.speech.stop();
            else if (buttonIcon === "loading") L.cancelImageRequest();
            else if (S.imageTarget) L.onListenImage();
            else if (S.selectedText) onListen();
        });

        speedButton = document.createElement("button");
        speedButton.type = "button";
        speedButton.className = "speed";
        applySpeed();
        speedButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSpeed(nextSpeed(), true);
        });

        askButton = document.createElement("button");
        askButton.type = "button";
        askButton.className = "ask";
        askButton.append(L.svgIcon("chat", 16));
        askButton.title = "Ask or get help with the highlighted text or image";
        askButton.setAttribute("aria-label", askButton.title);
        askButton.hidden = !settings.aiFeatures;
        askButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            L.openAsk();
        });

        bar.append(button, speedButton, askButton);
        shadow.append(style, bar);
        document.documentElement.appendChild(S.barHost);
    }

    function applyIcon() {
        const icon = ICONS[buttonIcon];
        button.replaceChildren(icon.svg ? L.svgIcon(icon.svg, 16) : icon.text);
        button.title = icon.title;
        button.setAttribute("aria-label", icon.label);
        button.classList.toggle("stop", buttonIcon === "stop");
        button.classList.toggle("loading", buttonIcon === "loading");
    }

    function setButtonIcon(name) {
        buttonIcon = name;
        if (button) applyIcon();
    }

    // Shows the bar just below-right of `rect` (the selection's last line), or with corner: true inside
    // its top-right corner (an image), kept inside the viewport.
    function showBar(rect, corner) {
        if (!S.barHost || !S.barHost.isConnected) createBar();
        S.barHost.style.display = "block";
        const width = S.barHost.offsetWidth || BUTTON_SIZE;
        const height = S.barHost.offsetHeight || BUTTON_SIZE;
        const maxX = document.documentElement.clientWidth - width - OFFSET;
        const maxY = document.documentElement.clientHeight - height - OFFSET;
        let x = Math.min(rect.right + OFFSET, maxX);
        let y = rect.bottom + OFFSET;
        if (corner) {
            x = Math.min(rect.right - width - OFFSET, maxX);
            y = Math.min(Math.max(rect.top + OFFSET, OFFSET), maxY);
        } else if (y > maxY) {
            y = rect.top - height - OFFSET;
        }
        S.barHost.style.left = `${Math.max(OFFSET, x) + window.scrollX}px`;
        S.barHost.style.top = `${Math.max(OFFSET, y) + window.scrollY}px`;
    }

    function hideBar() {
        S.selectedText = "";
        S.selectedRange = null;
        S.selectedCodeBlock = null;
        // While reading or describing an image, keep the bar on screen.
        if (S.imageBusy) return;
        if (L.speech.isSpeaking()) {
            setButtonIcon("stop");
            return;
        }
        S.imageTarget = null;
        if (S.note) S.note.hidden = true;
        if (S.barHost) S.barHost.style.display = "none";
    }

    function isBarEvent(event) {
        return S.barHost !== null && event.composedPath().includes(S.barHost);
    }

    // ---------- Speed (remembered across sites in browser.storage.local) ----------

    const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

    function nextSpeed() {
        return SPEEDS[(SPEEDS.indexOf(S.speed) + 1) % SPEEDS.length];
    }

    function applySpeed() {
        speedButton.textContent = `${S.speed}x`;
        speedButton.title = "Reading speed";
        speedButton.setAttribute("aria-label", `Reading speed ${S.speed}x. Click to change.`);
    }

    // Applies a speed (restarting a reading in progress from the current word) and optionally saves it.
    function setSpeed(value, save) {
        S.speed = value;
        L.speech.setRate(value);
        if (speedButton) applySpeed();
        if (!save) return;
        try {
            browser.storage.local.set({ speed: value }).catch((e) => console.warn("[Listen] Couldn't save speed:", e));
        } catch (e) {
            console.warn("[Listen] Couldn't save speed:", e);
        }
    }

    try {
        browser.storage.local.get("speed").then(
            (items) => {
                if (SPEEDS.includes(items.speed)) setSpeed(items.speed, false);
            },
            (e) => console.warn("[Listen] Couldn't load speed:", e)
        );
        // Keep other open tabs in step when the speed changes in one of them.
        browser.storage.onChanged.addListener((changes, area) => {
            const change = changes.speed;
            if (area !== "local" || !change || !SPEEDS.includes(change.newValue)) return;
            if (change.newValue !== S.speed) setSpeed(change.newValue, false);
        });
    } catch (e) {
        console.warn("[Listen] Speed storage unavailable:", e);
    }

    // ---------- Settings (chosen in the toolbar popup, kept in browser.storage.local) ----------
    // voice: a voiceURI, or "" for the best available. showImageButtons / showLinkButtons: hover bars on
    // images and charts / links. aiFeatures: off hides the chat button and bubble, and nothing is ever sent to
    // Gemini. showChatBubble: the chat bubble in the page's corner.

    const settings = { voice: "", showImageButtons: false, showLinkButtons: false, aiFeatures: true, showChatBubble: true };

    function applySettings(values) {
        if (typeof values.voice === "string") {
            settings.voice = values.voice;
            L.speech.setVoice(values.voice);
        }
        for (const key of ["showImageButtons", "showLinkButtons", "aiFeatures", "showChatBubble"]) {
            if (typeof values[key] === "boolean") settings[key] = values[key];
        }
        if (askButton) askButton.hidden = !settings.aiFeatures;
        if (!settings.aiFeatures && L.isAskOpen()) L.closeAsk();
        L.updateBubble();
        L.refreshSettingsView();
    }

    // Loads the saved settings and follows changes to them. content-main.js calls this once every content script
    // has loaded, because applying settings reaches into the chat (content-chat.js).
    function loadSettings() {
        try {
            browser.storage.local.get(Object.keys(settings)).then(applySettings, (e) =>
                console.warn("[Listen] Couldn't load settings:", e)
            );
            // Changes made in the popup apply straight away, in every open tab.
            browser.storage.onChanged.addListener((changes, area) => {
                if (area !== "local") return;
                const values = {};
                for (const key of Object.keys(settings)) if (changes[key]) values[key] = changes[key].newValue;
                if (Object.keys(values).length) applySettings(values);
            });
        } catch (e) {
            console.warn("[Listen] Settings storage unavailable:", e);
        }
    }

    // For the other content scripts.
    Object.assign(L, {
        read, readAbout, BAR_CSS, setButtonIcon, showBar, hideBar, isBarEvent, setSpeed, settings, loadSettings,
    });
})();

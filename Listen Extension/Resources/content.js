// Listen — content script
// The “ ” button reads the selected text aloud with the best installed built-in voice,
// highlighting each word on the page as it's spoken.

(() => {
    "use strict";

    // ---------- Speech (swap this section out for a better voice later) ----------
    // Interface: speech.speak(text, { onWord, onWordTimingUnavailable, onEnd }), speech.stop(),
    // speech.isSpeaking(), speech.setRate(rate). onWord(charIndex, charLength) gives the position in
    // `text` of the word being spoken (charLength may be 0); onEnd fires once when reading finishes
    // or is stopped.

    const speech = (() => {
        // Novelty voices macOS ships alongside the real ones; never pick these.
        const NOVELTY_VOICES = new Set([
            "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News",
            "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
        ]);

        // Older robotic-sounding voices; only used if nothing better is installed.
        const LOW_QUALITY_VOICES = new Set([
            "Eddy", "Flo", "Fred", "Grandma", "Grandpa", "Junior", "Kathy", "Ralph", "Reed",
            "Rocko", "Sandy", "Shelley",
        ]);

        let bestVoice = null;
        let current = null; // { utterance, onEnd }

        // "Eddy (English (US))" → "Eddy"
        function baseName(voice) {
            return voice.name.replace(/\s*\(.*\)$/, "");
        }

        // Higher is better: Premium > Enhanced > Siri > system default > other English > low quality.
        function rank(voice) {
            const id = `${voice.name} ${voice.voiceURI}`.toLowerCase();
            let score = 0;
            if (id.includes("premium")) score = 4;
            else if (id.includes("enhanced")) score = 3;
            else if (id.includes("siri")) score = 2;
            else if (voice.default) score = 1;
            else if (LOW_QUALITY_VOICES.has(baseName(voice))) score = -1;
            // Within a tier, prefer the user's own English variant (e.g. en-GB), then en-US.
            const lang = voice.lang.replace("_", "-").toLowerCase();
            if (lang === navigator.language.toLowerCase()) score += 0.2;
            else if (lang === "en-us") score += 0.1;
            return score;
        }

        function pickBestVoice() {
            const english = window.speechSynthesis
                .getVoices()
                .filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"))
                .filter((v) => !NOVELTY_VOICES.has(baseName(v)));
            if (english.length === 0) return null;
            const best = english.reduce((a, b) => (rank(b) > rank(a) ? b : a));
            if (best !== bestVoice) {
                console.info(`[Listen] Using voice: ${best.name} (${best.lang}, ${best.voiceURI})`);
            }
            return best;
        }

        // Safari can load the voice list after the page starts.
        window.speechSynthesis.addEventListener("voiceschanged", () => {
            bestVoice = pickBestVoice();
        });

        // How long after speech starts to wait for the first word position before giving up on it.
        const WORD_TIMING_GRACE_MS = 2000;

        let rate = 1;

        function finish(entry) {
            // Ignore events from an utterance that was already replaced or stopped.
            if (current !== entry) return;
            current = null;
            clearTimeout(entry.wordTimingCheck);
            entry.callbacks.onEnd();
        }

        // Speaks entry.text from character `from` at the current rate. Word positions are reported
        // relative to the whole text, so a restart mid-text keeps the highlight in sync.
        function startUtterance(entry, from) {
            const utterance = new SpeechSynthesisUtterance(entry.text.slice(from));
            if (bestVoice) utterance.voice = bestVoice;
            utterance.lang = bestVoice ? bestVoice.lang : "en-US";
            utterance.rate = rate;

            // Events from an utterance replaced by a speed change are ignored.
            const isLive = () => current === entry && entry.utterance === utterance;
            utterance.onend = () => isLive() && finish(entry);
            utterance.onerror = () => isLive() && finish(entry);

            // Word positions come from "boundary" events; some voices never send them.
            utterance.onboundary = (event) => {
                if (!isLive() || (event.name && event.name !== "word")) return;
                entry.sawWord = true;
                entry.wordStart = from + event.charIndex;
                entry.callbacks.onWord(entry.wordStart, event.charLength || 0);
            };
            utterance.onstart = () => {
                if (entry.sawWord || entry.wordTimingCheck) return;
                entry.wordTimingCheck = setTimeout(() => {
                    if (current !== entry || entry.sawWord) return;
                    const name = bestVoice ? bestVoice.name : "This voice";
                    console.info(`[Listen] ${name} doesn't report word positions, so words won't be highlighted.`);
                    entry.callbacks.onWordTimingUnavailable();
                }, WORD_TIMING_GRACE_MS);
            };

            entry.utterance = utterance;
            window.speechSynthesis.speak(utterance);
        }

        function speak(text, callbacks) {
            stop();
            bestVoice = pickBestVoice() || bestVoice;
            const entry = { text, callbacks, utterance: null, wordStart: 0, sawWord: false, wordTimingCheck: null };
            current = entry;
            startUtterance(entry, 0);
        }

        // Changes the speaking rate (1 = normal). speechSynthesis can't change the rate of an
        // utterance in progress, so a reading in progress restarts from the word being spoken.
        function setRate(newRate) {
            rate = newRate;
            const entry = current;
            if (!entry) return;
            entry.utterance = null; // silences the old utterance's events
            window.speechSynthesis.cancel();
            startUtterance(entry, entry.wordStart);
        }

        function stop() {
            const entry = current;
            window.speechSynthesis.cancel();
            // Safari doesn't always fire onend after cancel(), so finish here.
            if (entry) finish(entry);
        }

        function isSpeaking() {
            return current !== null;
        }

        return { speak, stop, isSpeaking, setRate };
    })();

    // ---------- Word highlighting ----------
    // Interface: highlighter.prepare(range) → text to speak; highlighter.showWord(charIndex, charLength);
    // highlighter.clear(). Draws one rounded "pill" over the current and next word: yellow fading into
    // orange. It lives in its own Shadow DOM overlay, so the page's DOM and layout are never touched.

    const highlighter = (() => {
        const COLORS = { current: "#ffe033", next: "#ffad33", nextClear: "rgba(255, 173, 51, 0)" };
        const PAD_X = 4; // px of pill around the words
        const PAD_Y = 1;
        const BLEND_PX = 8; // how far the yellow→orange blend reaches into each word
        const GLIDE_MS = 160;
        const FADE_IN_MS = 150;
        const FADE_OUT_MS = 500;
        const DARK_OPACITY = "0.6"; // dark pages: a softer glow so white text stays readable
        const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "SELECT"]);

        // Layer 1: solid orange under the next word. Layer 2: transparent→orange blend. Base: yellow.
        // Only positions and sizes change per word, so every part of the move can be transitioned.
        const PILL_CSS = `
            .pill {
                position: absolute;
                left: 0;
                top: 0;
                width: 0;
                height: 0;
                opacity: 0;
                border-radius: 9999px;
                background-color: ${COLORS.current};
                background-image:
                    linear-gradient(${COLORS.next}, ${COLORS.next}),
                    linear-gradient(to right, ${COLORS.nextClear}, ${COLORS.next});
                background-repeat: no-repeat;
                will-change: transform, width;
                transition-property: transform, width, height, background-position, background-size, opacity;
                transition-duration: ${GLIDE_MS}ms, ${GLIDE_MS}ms, ${GLIDE_MS}ms, ${GLIDE_MS}ms, ${GLIDE_MS}ms, ${FADE_IN_MS}ms;
                transition-timing-function: ease-out;
            }
            /* Dark pages: a soft neon glow around the pill. */
            .pill.dark {
                box-shadow: 0 0 10px 3px rgba(255, 190, 60, 0.6);
            }
        `;

        let text = ""; // the text being spoken
        let map = []; // map[i] = { node, offset } in the page for text[i]; null for added line breaks
        let overlay = null; // { host, pill } for the current reading
        let words = null; // { current: Range, next: Range | null } being shown
        let lastTop = null; // viewport top of the pill's line, to detect line changes
        let darkMode = false; // whether the text being read sits on a dark background
        let layoutQueued = false;

        // ----- Building the spoken text from the page -----

        function isBlock(el) {
            const display = getComputedStyle(el).display;
            return !display.startsWith("inline") && display !== "contents";
        }

        function blockOf(node) {
            let el = node.parentElement;
            while (el && el !== document.body && !isBlock(el)) el = el.parentElement;
            return el;
        }

        function isHidden(el) {
            if (SKIPPED_TAGS.has(el.tagName)) return true;
            const style = getComputedStyle(el);
            return style.display === "none" || style.visibility === "hidden";
        }

        // Walks the text inside `range` and records where each character of the spoken text came from.
        // Whitespace is collapsed the way the page displays it; headings, paragraphs and <br> become "\n".
        function buildTextMap(range) {
            text = "";
            map = [];
            const lineBreak = () => {
                if (!text) return;
                if (/\s$/.test(text)) {
                    text = text.slice(0, -1);
                    map.pop();
                }
                text += "\n";
                map.push(null);
            };

            const root = range.commonAncestorContainer;
            const walker = document.createTreeWalker(
                root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
                {
                    acceptNode(node) {
                        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
                        if (isHidden(node)) return NodeFilter.FILTER_REJECT;
                        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                    },
                }
            );

            let lastBlock = null;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    lineBreak(); // <br>
                    continue;
                }
                const block = blockOf(node);
                if (lastBlock && block !== lastBlock) lineBreak();
                lastBlock = block;

                const data = node.data;
                const start = node === range.startContainer ? range.startOffset : 0;
                const end = node === range.endContainer ? range.endOffset : data.length;
                for (let i = start; i < end; i++) {
                    if (/\s/.test(data[i])) {
                        if (!text || /\s$/.test(text)) continue;
                        text += " ";
                    } else {
                        text += data[i];
                    }
                    map.push({ node, offset: i });
                }
            }
            while (/\s$/.test(text)) {
                text = text.slice(0, -1);
                map.pop();
            }
        }

        // ----- Turning text positions into page ranges -----

        function wordEnd(start, length) {
            if (length > 0) return Math.min(start + length, text.length);
            let end = start;
            while (end < text.length && !/\s/.test(text[end])) end++;
            return end;
        }

        // Start of the next word after `from` that has a letter or digit (skips lone dashes etc.).
        function nextWordStart(from) {
            let i = from;
            while (i < text.length) {
                while (i < text.length && /\s/.test(text[i])) i++;
                const end = wordEnd(i, 0);
                if (/[\p{L}\p{N}]/u.test(text.slice(i, end))) return i;
                i = end;
            }
            return -1;
        }

        function rangeFor(start, end) {
            let first = start;
            let last = end - 1;
            while (first <= last && !map[first]) first++;
            while (last >= first && !map[last]) last--;
            if (first > last) return null;
            try {
                const range = document.createRange();
                range.setStart(map[first].node, map[first].offset);
                range.setEnd(map[last].node, map[last].offset + 1);
                return range;
            } catch (e) {
                return null; // the page changed underneath us
            }
        }

        // ----- Page background -----

        // "rgb(r, g, b)" / "rgba(r, g, b, a)" → { r, g, b, a }; null for anything else.
        function parseColor(value) {
            const match = value.match(/rgba?\(([^)]+)\)/);
            if (!match) return null;
            const [r, g, b, a = 1] = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
            return { r, g, b, a };
        }

        // Perceived brightness, 0 (black) to 1 (white).
        function brightness({ r, g, b }) {
            return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        }

        // Uses the first non-transparent background colour going up from the selection. If no element has
        // one, the page canvas shows through, so fall back to the text colour (light text → dark page).
        function isDarkBackground(range) {
            let el = range.commonAncestorContainer;
            if (el.nodeType !== Node.ELEMENT_NODE) el = el.parentElement;
            const textColor = el ? parseColor(getComputedStyle(el).color) : null;
            for (; el; el = el.parentElement) {
                const background = parseColor(getComputedStyle(el).backgroundColor);
                if (background && background.a >= 0.5) return brightness(background) < 0.5;
            }
            return textColor ? brightness(textColor) > 0.6 : false;
        }

        // ----- Drawing the pill -----

        function createOverlay() {
            const host = document.createElement("listen-highlight-root");
            // The pill is drawn over the text but looks like it's behind it: on light pages multiply
            // keeps dark text dark; on dark pages screen keeps white text white and makes the pill glow.
            host.style.cssText =
                "all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; " +
                `pointer-events: none; z-index: 2147483646; mix-blend-mode: ${darkMode ? "screen" : "multiply"};`;
            const shadow = host.attachShadow({ mode: "closed" });
            const style = document.createElement("style");
            style.textContent = PILL_CSS;
            const pill = document.createElement("div");
            pill.className = darkMode ? "pill dark" : "pill";
            shadow.append(style, pill);
            document.documentElement.appendChild(host);
            return { host, pill };
        }

        // The box of a word's first line (a word split across inline elements has several rects).
        function lineBox(range) {
            const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
            if (rects.length === 0) return null;
            const first = rects[0];
            const box = { left: first.left, right: first.right, top: first.top, bottom: first.bottom };
            for (const r of rects) {
                if (Math.abs(r.top - first.top) > first.height / 2) continue;
                box.left = Math.min(box.left, r.left);
                box.right = Math.max(box.right, r.right);
                box.top = Math.min(box.top, r.top);
                box.bottom = Math.max(box.bottom, r.bottom);
            }
            return box;
        }

        // Positions the pill over `words`. instant: move without gliding (scroll, resize, line change).
        function layout(instant) {
            if (!overlay || !words) return;
            const cur = lineBox(words.current);
            if (!cur) return;
            let next = words.next ? lineBox(words.next) : null;
            // If the next word starts a new line, the pill covers the current word only.
            const height = cur.bottom - cur.top;
            if (next && (Math.abs(next.top - cur.top) > height / 2 || next.left < cur.right)) next = null;

            const left = cur.left - PAD_X;
            const right = (next ? next.right : cur.right) + PAD_X;
            const top = Math.min(cur.top, next ? next.top : cur.top) - PAD_Y;
            const bottom = Math.max(cur.bottom, next ? next.bottom : cur.bottom) + PAD_Y;
            const width = right - left;

            // Blend from just before the end of the current word to just into the next word.
            let blendFrom = width;
            let blendTo = width;
            if (next) {
                blendFrom = cur.right - left - Math.min(BLEND_PX, (cur.right - cur.left) * 0.3);
                blendTo = next.left - left + Math.min(BLEND_PX, (next.right - next.left) * 0.3);
            }

            const { pill } = overlay;
            const firstShow = lastTop === null;
            const lineChanged = !firstShow && Math.abs(top - lastTop) > height / 2;
            const jump = instant || firstShow || lineChanged;
            if (jump) pill.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;

            pill.style.transform = `translate(${left + window.scrollX}px, ${top + window.scrollY}px)`;
            pill.style.width = `${width}px`;
            pill.style.height = `${bottom - top}px`;
            pill.style.backgroundPosition = `${blendTo}px 0, ${blendFrom}px 0`;
            pill.style.backgroundSize = `${width - blendTo}px 100%, ${blendTo - blendFrom}px 100%`;
            pill.style.opacity = darkMode ? DARK_OPACITY : "1";

            if (jump) {
                void pill.offsetWidth; // apply the jump before glides are re-enabled
                pill.style.transition = "";
            }
            lastTop = top;
        }

        // Keeps the pill on its words when the page or an inner panel scrolls, or the window resizes.
        function onViewportChange() {
            if (layoutQueued) return;
            layoutQueued = true;
            requestAnimationFrame(() => {
                layoutQueued = false;
                layout(true);
            });
        }

        function watchViewport(on) {
            const method = on ? "addEventListener" : "removeEventListener";
            window[method]("scroll", onViewportChange, { capture: true, passive: true });
            window[method]("resize", onViewportChange);
        }

        // ----- Interface -----

        function prepare(range) {
            clear();
            buildTextMap(range);
            darkMode = isDarkBackground(range);
            console.info(`[Listen] Highlight mode: ${darkMode ? "dark" : "light"}`);
            return text;
        }

        function showWord(charIndex, charLength) {
            if (!text || charIndex >= text.length) return;
            const end = wordEnd(charIndex, charLength);
            const current = rangeFor(charIndex, end);
            if (!current) return;
            const next = nextWordStart(end);
            words = { current, next: next >= 0 ? rangeFor(next, wordEnd(next, 0)) : null };
            if (!overlay) {
                overlay = createOverlay();
                watchViewport(true);
            }
            layout(false);
        }

        // Fades the pill out, then removes it. A new reading gets a fresh pill.
        function clear() {
            if (overlay) {
                watchViewport(false);
                const { host, pill } = overlay;
                pill.style.transition = `opacity ${FADE_OUT_MS}ms ease-out`;
                pill.style.opacity = "0";
                setTimeout(() => host.remove(), FADE_OUT_MS + 50);
            }
            overlay = null;
            words = null;
            lastTop = null;
            text = "";
            map = [];
        }

        return { prepare, showWord, clear };
    })();

    // ---------- Reading ----------

    // Called when the user clicks the button.
    function onListen() {
        const range = selectedRange;
        const text = selectedText;
        speech.stop(); // end any current reading (and its highlights) before preparing the new one
        const spoken = (range && highlighter.prepare(range)) || text;
        // Clear the blue selection so it doesn't cover the word highlights.
        if (range) window.getSelection().removeAllRanges();
        speech.speak(spoken, {
            onWord: highlighter.showWord,
            onWordTimingUnavailable: highlighter.clear,
            onEnd: onReadingEnded,
        });
        setButtonIcon("stop");
    }

    function onReadingEnded() {
        highlighter.clear();
        setButtonIcon("listen");
        // If the selection is gone by the time reading ends, the button has nothing left to do.
        if (!readSelection()) hideBar();
    }

    // ---------- Floating bar (isolated in a Shadow DOM so host page CSS can't touch it) ----------
    // A row of buttons: “ ” (listen / stop) and the speed button. More buttons can be added to the row.

    const BUTTON_SIZE = 30;
    const OFFSET = 6;

    const ICONS = {
        listen: { text: "“”", label: "Read selected text aloud", title: "Listen" },
        stop: { text: "■", label: "Stop reading", title: "Stop" },
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
            font: 700 18px/1 Georgia, "Times New Roman", serif;
            padding-top: 6px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            user-select: none;
            -webkit-user-select: none;
            transition: transform 0.1s ease;
        }
        button.stop {
            font: 400 14px/1 -apple-system, "Helvetica Neue", sans-serif;
            padding-top: 0;
        }
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
    `;

    let host = null;
    let button = null; // “ ” / ■
    let speedButton = null;
    let buttonIcon = "listen";
    let selectedText = "";
    let selectedRange = null;

    function createBar() {
        host = document.createElement("listen-extension-root");
        host.style.cssText =
            "all: initial; position: absolute; z-index: 2147483647; display: none;";

        const shadow = host.attachShadow({ mode: "closed" });
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
            if (buttonIcon === "stop") {
                speech.stop();
            } else if (selectedText) {
                onListen();
            }
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

        bar.append(button, speedButton);
        shadow.append(style, bar);
        document.documentElement.appendChild(host);
    }

    function applyIcon() {
        const icon = ICONS[buttonIcon];
        button.textContent = icon.text;
        button.title = icon.title;
        button.setAttribute("aria-label", icon.label);
        button.classList.toggle("stop", buttonIcon === "stop");
    }

    function setButtonIcon(name) {
        buttonIcon = name;
        if (button) applyIcon();
    }

    // Shows the bar just below-right of `rect` (the selection's last line), kept inside the viewport.
    function showBar(rect) {
        if (!host || !host.isConnected) createBar();
        host.style.display = "block";
        const width = host.offsetWidth || BUTTON_SIZE;
        const height = host.offsetHeight || BUTTON_SIZE;
        const maxX = document.documentElement.clientWidth - width - OFFSET;
        const maxY = document.documentElement.clientHeight - height - OFFSET;
        const x = Math.min(rect.right + OFFSET, maxX);
        let y = rect.bottom + OFFSET;
        if (y > maxY) y = rect.top - height - OFFSET;
        host.style.left = `${Math.max(OFFSET, x) + window.scrollX}px`;
        host.style.top = `${Math.max(OFFSET, y) + window.scrollY}px`;
    }

    function hideBar() {
        selectedText = "";
        selectedRange = null;
        // While reading, keep the bar on screen so it can stop the reading or change its speed.
        if (speech.isSpeaking()) {
            setButtonIcon("stop");
            return;
        }
        if (host) host.style.display = "none";
    }

    function isBarEvent(event) {
        return host !== null && event.composedPath().includes(host);
    }

    // ---------- Speed (remembered across sites in browser.storage.local) ----------

    const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
    let speed = 1;

    function nextSpeed() {
        return SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    }

    function applySpeed() {
        speedButton.textContent = `${speed}x`;
        speedButton.title = "Reading speed";
        speedButton.setAttribute("aria-label", `Reading speed ${speed}x. Click to change.`);
    }

    // Applies a speed (restarting a reading in progress from the current word) and optionally saves it.
    function setSpeed(value, save) {
        speed = value;
        speech.setRate(value);
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
            if (change.newValue !== speed) setSpeed(change.newValue, false);
        });
    } catch (e) {
        console.warn("[Listen] Speed storage unavailable:", e);
    }

    // ---------- Selection ----------

    function isEditable(node) {
        const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        if (!el) return false;
        if (el.closest("input, textarea, select")) return true;
        return el.isContentEditable;
    }

    // Returns { text, range, rect } for a usable selection, or null.
    function readSelection() {
        // Text selected inside <input>/<textarea> is reported through activeElement.
        if (isEditable(document.activeElement) && document.activeElement !== document.body) {
            return null;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        const text = selection.toString().trim();
        if (!text) return null;
        if (isEditable(selection.anchorNode) || isEditable(selection.focusNode)) return null;

        const range = selection.getRangeAt(0);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) return null;

        return { text, range: range.cloneRange(), rect };
    }

    function updateBar() {
        const result = readSelection();
        if (!result) {
            hideBar();
            return;
        }

        // A new selection gets a fresh “ ” button; clicking it replaces any current reading.
        if (result.text !== selectedText) setButtonIcon("listen");
        selectedText = result.text;
        selectedRange = result.range;
        showBar(result.rect);
    }

    // ---------- Events ----------

    document.addEventListener("mouseup", (event) => {
        if (isBarEvent(event)) return;
        // Wait a tick so the browser finishes updating the selection.
        setTimeout(updateBar, 0);
    });

    document.addEventListener("mousedown", (event) => {
        if (!isBarEvent(event)) hideBar();
    });

    // Keyboard selection (Shift + arrows, Cmd+A).
    document.addEventListener("keyup", (event) => {
        if (event.shiftKey || event.metaKey || event.key === "Shift") updateBar();
    });

    // Escape stops any reading and hides the button.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        speech.stop();
        hideBar();
    });

    // Hide as soon as the selection is cleared.
    document.addEventListener("selectionchange", () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) hideBar();
    });

    window.addEventListener("resize", hideBar);

    // Don't keep talking after the user leaves the page.
    window.addEventListener("pagehide", () => speech.stop());
})();

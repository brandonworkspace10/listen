// Listen — content script
// The “ ” button reads the selected text aloud with the best installed built-in voice,
// highlighting each word on the page as it's spoken.

(() => {
    "use strict";

    // ---------- Speech (swap this section out for a better voice later) ----------
    // Interface: speech.speak(text, { onWord, onWordTimingUnavailable, onEnd }), speech.stop(),
    // speech.isSpeaking(). onWord(charIndex, charLength) gives the position in `text` of the word
    // being spoken (charLength may be 0); onEnd fires once when reading finishes or is stopped.

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

        function finish(entry) {
            // Ignore events from an utterance that was already replaced or stopped.
            if (current !== entry) return;
            current = null;
            clearTimeout(entry.wordTimingCheck);
            entry.callbacks.onEnd();
        }

        function speak(text, callbacks) {
            stop();

            bestVoice = pickBestVoice() || bestVoice;
            const utterance = new SpeechSynthesisUtterance(text);
            if (bestVoice) utterance.voice = bestVoice;
            utterance.lang = bestVoice ? bestVoice.lang : "en-US";

            const entry = { utterance, callbacks, sawWord: false, wordTimingCheck: null };
            utterance.onend = () => finish(entry);
            utterance.onerror = () => finish(entry);

            // Word positions come from "boundary" events; some voices never send them.
            utterance.onboundary = (event) => {
                if (current !== entry || (event.name && event.name !== "word")) return;
                entry.sawWord = true;
                callbacks.onWord(event.charIndex, event.charLength || 0);
            };
            utterance.onstart = () => {
                entry.wordTimingCheck = setTimeout(() => {
                    if (current !== entry || entry.sawWord) return;
                    const name = bestVoice ? bestVoice.name : "This voice";
                    console.info(`[Listen] ${name} doesn't report word positions, so words won't be highlighted.`);
                    callbacks.onWordTimingUnavailable();
                }, WORD_TIMING_GRACE_MS);
            };

            current = entry;
            window.speechSynthesis.speak(utterance);
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

        return { speak, stop, isSpeaking };
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
        `;

        let text = ""; // the text being spoken
        let map = []; // map[i] = { node, offset } in the page for text[i]; null for added line breaks
        let overlay = null; // { host, pill } for the current reading
        let words = null; // { current: Range, next: Range | null } being shown
        let lastTop = null; // viewport top of the pill's line, to detect line changes
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

        // ----- Drawing the pill -----

        function createOverlay() {
            const host = document.createElement("listen-highlight-root");
            // Multiply blending lets the page's text show through, so the pill looks like it's behind it.
            host.style.cssText =
                "all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; " +
                "pointer-events: none; z-index: 2147483646; mix-blend-mode: multiply;";
            const shadow = host.attachShadow({ mode: "closed" });
            const style = document.createElement("style");
            style.textContent = PILL_CSS;
            const pill = document.createElement("div");
            pill.className = "pill";
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
            pill.style.opacity = "1";

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
        if (!readSelection()) hideButton();
    }

    // ---------- Button (isolated in a Shadow DOM so host page CSS can't touch it) ----------

    const BUTTON_SIZE = 30;
    const OFFSET = 6;

    const ICONS = {
        listen: { text: "“”", label: "Read selected text aloud", title: "Listen" },
        stop: { text: "■", label: "Stop reading", title: "Stop" },
    };

    const BUTTON_CSS = `
        :host { all: initial; }
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
        button:hover { transform: scale(1.08); }
        button:active { transform: scale(0.95); }
        button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
    `;

    let host = null;
    let button = null;
    let buttonIcon = "listen";
    let selectedText = "";
    let selectedRange = null;

    function createButton() {
        host = document.createElement("listen-extension-root");
        host.style.cssText =
            "all: initial; position: absolute; z-index: 2147483647; display: none;";

        const shadow = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = BUTTON_CSS;

        button = document.createElement("button");
        button.type = "button";
        applyIcon();

        // Keep the page selection intact when the button is pressed.
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (buttonIcon === "stop") {
                speech.stop();
            } else if (selectedText) {
                onListen();
            }
        });

        shadow.append(style, button);
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

    function showButton(x, y) {
        if (!host || !host.isConnected) createButton();
        host.style.left = `${x}px`;
        host.style.top = `${y}px`;
        host.style.display = "block";
    }

    function hideButton() {
        selectedText = "";
        selectedRange = null;
        // While reading, keep the button on screen as a stop button.
        if (speech.isSpeaking()) {
            setButtonIcon("stop");
            return;
        }
        if (host) host.style.display = "none";
    }

    function isButtonEvent(event) {
        return host !== null && event.composedPath().includes(host);
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

    function updateButton() {
        const result = readSelection();
        if (!result) {
            hideButton();
            return;
        }

        // A new selection gets a fresh “ ” button; clicking it replaces any current reading.
        if (result.text !== selectedText) setButtonIcon("listen");
        selectedText = result.text;
        selectedRange = result.range;
        const { rect } = result;

        // Place just below-right of the selection's last line, kept inside the viewport.
        const maxX = document.documentElement.clientWidth - BUTTON_SIZE - OFFSET;
        const maxY = document.documentElement.clientHeight - BUTTON_SIZE - OFFSET;
        let x = Math.min(rect.right + OFFSET, maxX);
        let y = rect.bottom + OFFSET;
        if (y > maxY) y = rect.top - BUTTON_SIZE - OFFSET;

        showButton(Math.max(OFFSET, x) + window.scrollX, Math.max(OFFSET, y) + window.scrollY);
    }

    // ---------- Events ----------

    document.addEventListener("mouseup", (event) => {
        if (isButtonEvent(event)) return;
        // Wait a tick so the browser finishes updating the selection.
        setTimeout(updateButton, 0);
    });

    document.addEventListener("mousedown", (event) => {
        if (!isButtonEvent(event)) hideButton();
    });

    // Keyboard selection (Shift + arrows, Cmd+A).
    document.addEventListener("keyup", (event) => {
        if (event.shiftKey || event.metaKey || event.key === "Shift") updateButton();
    });

    // Escape stops any reading and hides the button.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        speech.stop();
        hideButton();
    });

    // Hide as soon as the selection is cleared.
    document.addEventListener("selectionchange", () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) hideButton();
    });

    window.addEventListener("resize", hideButton);

    // Don't keep talking after the user leaves the page.
    window.addEventListener("pagehide", () => speech.stop());
})();

// Listen — content script
// Phase 2: the “ ” button reads the selected text aloud with the built-in voice.

(() => {
    "use strict";

    // ---------- Speech (swap this section out for Kokoro in Phase 3) ----------
    // Interface: speech.speak(text, onEnd), speech.stop(), speech.isSpeaking()

    const speech = (() => {
        let current = null; // { utterance, onEnd }

        function pickEnglishVoice() {
            const voices = window.speechSynthesis.getVoices();
            const english = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
            return english.find((v) => v.default) || english[0] || null;
        }

        function finish(entry) {
            // Ignore events from an utterance that was already replaced or stopped.
            if (current !== entry) return;
            current = null;
            entry.onEnd();
        }

        function speak(text, onEnd) {
            stop();

            const utterance = new SpeechSynthesisUtterance(text);
            const voice = pickEnglishVoice();
            if (voice) utterance.voice = voice;
            utterance.lang = voice ? voice.lang : "en-US";

            const entry = { utterance, onEnd };
            utterance.onend = () => finish(entry);
            utterance.onerror = () => finish(entry);

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

    // Called when the user clicks the button.
    function onListen(text) {
        speech.speak(text, onReadingEnded);
        setButtonIcon("stop");
    }

    function onReadingEnded() {
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
                onListen(selectedText);
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

    // Returns { text, rect } for a usable selection, or null.
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

        const rects = selection.getRangeAt(0).getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) return null;

        return { text, rect };
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

// Listen — content script
// Phase 1: show a floating “ ” button next to selected text; clicking it logs the text.

(() => {
    "use strict";

    // Called when the user clicks the button. Later phases replace this with playback.
    function onListen(text) {
        console.log("[Listen] Selected text:", text);
    }

    // ---------- Button (isolated in a Shadow DOM so host page CSS can't touch it) ----------

    const BUTTON_SIZE = 30;
    const OFFSET = 6;

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
        button:hover { transform: scale(1.08); }
        button:active { transform: scale(0.95); }
        button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
    `;

    let host = null;
    let selectedText = "";

    function createButton() {
        host = document.createElement("listen-extension-root");
        host.style.cssText =
            "all: initial; position: absolute; z-index: 2147483647; display: none;";

        const shadow = host.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = BUTTON_CSS;

        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "“”";
        button.title = "Listen";
        button.setAttribute("aria-label", "Read selected text aloud");

        // Keep the page selection intact when the button is pressed.
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (selectedText) onListen(selectedText);
        });

        shadow.append(style, button);
        document.documentElement.appendChild(host);
    }

    function showButton(x, y) {
        if (!host || !host.isConnected) createButton();
        host.style.left = `${x}px`;
        host.style.top = `${y}px`;
        host.style.display = "block";
    }

    function hideButton() {
        if (host) host.style.display = "none";
        selectedText = "";
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

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideButton();
    });

    // Hide as soon as the selection is cleared.
    document.addEventListener("selectionchange", () => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) hideButton();
    });

    window.addEventListener("resize", hideButton);
})();

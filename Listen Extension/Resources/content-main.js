// Listen — content scripts, 10 of 10: the selection, page events, and starting up (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;
    const S = L.state;

    // ---------- Selection ----------

    function isEditable(node) {
        const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        if (!el) return false;
        if (el.closest("input, textarea, select")) return true;
        return el.isContentEditable;
    }

    // Returns { text, range, rect, codeBlock } for a usable selection, or null. `range` is null for text
    // selected in a read-only code viewer's text field (see Code).
    function readSelection() {
        const codeField = L.readOnlyCodeSelection();
        if (codeField) return codeField;
        // Text selected inside <input>/<textarea> is reported through activeElement.
        if (isEditable(document.activeElement) && document.activeElement !== document.body) {
            return null;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        let text = selection.toString().trim();
        // Equations drawn as MathML or images select as empty text; use their spoken form (see Maths).
        const maths = text ? [] : L.mathContainersIn(range);
        if (!text && maths.length) text = maths.map(L.mathSpeech).join(" ");
        if (!text) return null;
        if (isEditable(selection.anchorNode) || isEditable(selection.focusNode)) return null;

        const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
        let rect = rects[rects.length - 1];
        if (!rect && maths.length) rect = L.mathOutlineTarget(maths[maths.length - 1]).getBoundingClientRect();
        if (!rect) return null;

        return { text, range: range.cloneRange(), rect, codeBlock: L.codeBlockFor(range, text) };
    }

    function updateBar() {
        const result = readSelection();
        if (!result) {
            L.hideBar();
            return;
        }

        // A new selection gets a fresh speaker button; clicking it replaces any current reading.
        if (result.text !== S.selectedText) L.setButtonIcon("listen");
        S.selectedText = result.text;
        S.selectedRange = result.range;
        S.selectedCodeBlock = result.codeBlock;
        S.imageTarget = null; // a text selection takes the bar over from an image
        L.language.prepare(result.text);
        L.showBar(result.rect);
    }

    // ---------- Events ----------

    document.addEventListener("mouseup", (event) => {
        if (L.isBarEvent(event) || L.isChatEvent(event)) return;
        S.lastPointer = { x: event.clientX, y: event.clientY };
        // Wait a tick so the browser finishes updating the selection.
        setTimeout(() => {
            updateBar();
            // A click (no selection) on a rendered equation shows its bar, like hovering it.
            if (S.selectedText || L.speech.isSpeaking()) return;
            const found = L.visualTargetFor(event.target);
            if (found && found.kind === "math") L.showImageBar(found.el, "math");
        }, 0);
    });

    // Hides the bar. The chat stays open until it's closed.
    function dismiss() {
        L.hideBar();
    }

    document.addEventListener("mousedown", (event) => {
        if (!L.isBarEvent(event) && !L.isChatEvent(event)) dismiss();
    });

    // Keyboard selection (Shift + arrows, Cmd+A).
    document.addEventListener("keyup", (event) => {
        if (event.shiftKey || event.metaKey || event.key === "Shift") updateBar();
    });

    // Escape closes the ask panel if it's open; otherwise it stops any reading and hides the bar.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (L.isAskOpen()) {
            L.closeAsk();
            return;
        }
        L.speech.stop();
        L.hideBar();
    });

    // Hide as soon as the selection is cleared.
    document.addEventListener("selectionchange", () => {
        if (L.readOnlyCodeSelection()) return; // a code viewer's own text field holds the selection
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) L.hideBar();
    });

    window.addEventListener("resize", () => {
        dismiss();
        L.keepChatOnScreen();
    });

    // Don't keep talking after the user leaves the page.
    window.addEventListener("pagehide", () => L.speech.stop());

    // For the other content scripts.
    Object.assign(L, { isEditable, readSelection });

    L.createChat(); // the chat bubble
    L.loadSettings();
})();

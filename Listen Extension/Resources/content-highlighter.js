// Listen — content scripts, 5 of 10: the moving highlight over the words being spoken, tables read row by row,
// and outlines around images and equations (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;

    // ---------- Word highlighting ----------
    // Interface: highlighter.prepare(range) → text to speak; highlighter.showWord(charIndex, charLength);
    // highlighter.clear(); highlighter.relayout() after something scrolls; highlighter.outline(element)
    // to frame an element (an image being read about) instead. Draws one rounded "pill" over the current
    // and next word: yellow fading into orange. It lives in its own Shadow DOM overlay, so the page's
    // DOM and layout are never touched.

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
            /* An element being read about (an image): a soft glowing frame around it. */
            .pill.outline {
                border-radius: 12px;
                background: transparent;
                box-shadow: 0 0 0 3px rgba(255, 190, 60, 0.9), 0 0 18px 6px rgba(255, 170, 40, 0.5);
            }
        `;
        const OUTLINE_PAD = 4;

        let text = ""; // the text being spoken
        let map = []; // map[i] = { node, offset } in the page for text[i]; null for added line breaks
        let overlay = null; // { host, pill } for the current reading
        let words = null; // { current: Range, next: Range | null } being shown
        let lastTop = null; // viewport top of the pill's line, to detect line changes
        let darkMode = false; // whether the text being read sits on a dark background
        let outlined = null; // element framed by outline(), instead of the word pill
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

        // ----- Writing the spoken text (each character remembers where it came from) -----

        // Adds characters [start, end) of a text node, collapsing whitespace the way the page shows it.
        // Maths symbols are spoken as words ("x²" → "x squared"); the words still point at the symbol.
        function appendNodeText(node, start, end) {
            const data = node.data;
            for (let i = start; i < end; i++) {
                const words = L.SPOKEN_SYMBOLS[data[i]] || (L.SUPERSCRIPT_DIGITS[data[i]] && `to the power of ${L.SUPERSCRIPT_DIGITS[data[i]]}`);
                if (words) {
                    for (const ch of `${text && !/\s$/.test(text) ? " " : ""}${words} `) {
                        text += ch;
                        map.push({ node, offset: i });
                    }
                    continue;
                }
                if (/\s/.test(data[i])) {
                    if (!text || /\s$/.test(text)) continue;
                    text += " ";
                } else {
                    text += data[i];
                }
                map.push({ node, offset: i });
            }
        }

        // Adds words that aren't on the page (table announcements, "Header:" punctuation).
        function appendSpoken(words) {
            for (const ch of words) {
                text += ch;
                map.push(null);
            }
        }

        function trimEnd() {
            while (/\s$/.test(text)) {
                text = text.slice(0, -1);
                map.pop();
            }
        }

        // Ends the current line, so a heading, paragraph or table row is spoken as its own sentence.
        function lineBreak() {
            if (!text) return;
            trimEnd();
            text += "\n";
            map.push(null);
        }

        // Footnote markers such as "[14]" or "[note 1]" in superscript.
        function isFootnoteMarker(el) {
            return el.tagName === "SUP" && /^\[[^\]]{1,10}\]$/.test(el.textContent.trim());
        }

        // Adds all visible text inside an element (a table cell or caption), without footnote markers.
        function appendElementText(el) {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
                    if (isHidden(node) || isFootnoteMarker(node)) return NodeFilter.FILTER_REJECT;
                    if (node.matches(L.MATH_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
                    return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                },
            });
            let doneMath = null;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (doneMath && doneMath.contains(node)) continue;
                if (node.nodeType === Node.ELEMENT_NODE && node.matches(L.MATH_SELECTOR)) {
                    appendMath(node);
                    doneMath = node;
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (text && !/\s$/.test(text)) appendSpoken(" "); // <br> inside a cell
                } else {
                    appendNodeText(node, 0, node.data.length);
                }
            }
        }

        // Adds an equation as its spoken words (see Maths). Each character points at the equation element,
        // so while it's spoken the pill becomes an outline around it.
        function appendMath(container) {
            const block = isBlock(container);
            if (block) lineBreak();
            else if (text && !/\s$/.test(text)) appendSpoken(" ");
            const box = L.mathOutlineTarget(container);
            for (const ch of L.mathSpeech(container)) {
                text += ch;
                map.push({ math: box });
            }
            if (block) lineBreak();
            else appendSpoken(" ");
        }

        // ----- Tables -----
        // A selection covering more than one cell of a table is read row by row as "Header: value, ...",
        // after announcing its size. Only the rows and columns between the cells where the selection
        // starts and ends are read (a selection running past the table covers it to that edge);
        // empty cells and footnote markers are skipped.

        // The table's cells as a grid, with colspan/rowspan cells repeated in every slot they cover.
        function tableGrid(table) {
            const grid = [];
            Array.from(table.rows).forEach((row, r) => {
                grid[r] = grid[r] || [];
                let c = 0;
                for (const cell of row.cells) {
                    while (grid[r][c]) c++;
                    const rowSpan = cell.rowSpan > 0 ? cell.rowSpan : table.rows.length - r;
                    for (let i = 0; i < rowSpan && r + i < table.rows.length; i++) {
                        grid[r + i] = grid[r + i] || [];
                        for (let j = 0; j < Math.max(1, cell.colSpan); j++) grid[r + i][c + j] = cell;
                    }
                    c += Math.max(1, cell.colSpan);
                }
            });
            return grid;
        }

        // Leading rows made only of <th> cells (or in <thead>); if there are none, the first row.
        function headerRowCount(table, grid) {
            let count = 0;
            while (count < grid.length - 1) {
                const row = table.rows[count];
                const cells = grid[count].filter(Boolean);
                const isHeader = row.parentElement.tagName === "THEAD" || cells.every((cell) => cell.tagName === "TH");
                if (!isHeader) break;
                count++;
            }
            return grid.length > 1 ? Math.max(count, 1) : 0;
        }

        function cellsIn(table, range) {
            return Array.from(table.querySelectorAll("td, th")).filter(
                (cell) => cell.closest("table") === table && range.intersectsNode(cell)
            );
        }

        // Whether `table` should be read as a table: the selection must cover more than one of its cells.
        function readsAsTable(table, range) {
            return cellsIn(table, range).length > 1;
        }

        function cellIsEmpty(cell) {
            return !cell || !cell.textContent.trim();
        }

        // Grid slots [first, last] of a cell, as { r, c } pairs.
        function slotsOf(grid, cell) {
            let first = null;
            let last = null;
            grid.forEach((row, r) =>
                row.forEach((slot, c) => {
                    if (slot !== cell) return;
                    if (!first) first = { r, c };
                    last = { r, c };
                })
            );
            return first && { first, last };
        }

        // The cell (or, failing that, the row) of `table` that a selection boundary is in, else null.
        function boundaryIn(table, node) {
            const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            const cell = el && el.closest("td, th");
            if (cell && cell.closest("table") === table) return { cell };
            const row = el && el.closest("tr");
            if (row && row.closest("table") === table) return { row };
            return null;
        }

        function appendTable(table, range) {
            const grid = tableGrid(table);
            const width = Math.max(...grid.map((row) => row.length));
            const headerRows = headerRowCount(table, grid);

            // The selected rectangle: from where the selection starts to where it ends.
            const start = boundaryIn(table, range.startContainer);
            const end = boundaryIn(table, range.endContainer);
            const startSlots = start && start.cell && slotsOf(grid, start.cell);
            const endSlots = end && end.cell && slotsOf(grid, end.cell);
            const rowIndex = (b, slots, fallback) =>
                slots ? (b === start ? slots.first.r : slots.last.r) : b && b.row ? b.row.rowIndex : fallback;
            const r0 = rowIndex(start, startSlots, 0);
            const r1 = rowIndex(end, endSlots, grid.length - 1);
            let c0 = 0;
            let c1 = width - 1;
            if (startSlots && endSlots) {
                c0 = Math.min(startSlots.first.c, endSlots.first.c);
                c1 = Math.max(startSlots.last.c, endSlots.last.c);
            }
            const columns = [];
            for (let c = c0; c <= c1; c++) columns.push(c);
            let rows = [];
            for (let r = Math.max(r0, headerRows); r <= r1; r++) rows.push(r);
            const headerOnly = rows.length === 0;
            if (headerOnly) rows = [0]; // only header cells selected: read them as a plain row

            lineBreak();
            if (table.caption && range.intersectsNode(table.caption) && !cellIsEmpty(table.caption)) {
                appendElementText(table.caption);
                lineBreak();
            }
            const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
            appendSpoken(`Table with ${plural(columns.length, "column")} and ${plural(rows.length, "row")}.`);
            lineBreak();

            for (const r of rows) {
                const seen = new Set(); // a colspan cell is read once per row
                let first = true;
                for (const c of columns) {
                    const cell = grid[r][c];
                    if (cellIsEmpty(cell) || seen.has(cell)) continue;
                    seen.add(cell);
                    if (!first) appendSpoken(", ");
                    first = false;
                    // Header text for this column (several header rows are joined), unless it's the cell itself.
                    const headers = headerOnly ? [] : [...new Set(grid.slice(0, headerRows).map((row) => row[c]))]
                        .filter((h) => h && h !== cell && !cellIsEmpty(h));
                    for (const header of headers) {
                        appendElementText(header);
                        trimEnd();
                        appendSpoken(" ");
                    }
                    if (headers.length) {
                        trimEnd();
                        appendSpoken(": ");
                    }
                    appendElementText(cell);
                    trimEnd();
                }
                if (!first && !/[.!?]$/.test(text)) appendSpoken(".");
                lineBreak();
            }
        }

        // ----- Building the spoken text from a selection -----

        // Walks the text inside `range` and records where each character of the spoken text came from.
        // Whitespace is collapsed the way the page displays it; headings, paragraphs and <br> become "\n";
        // tables are read row by row (see Tables).
        function buildTextMap(range) {
            text = "";
            map = [];

            const root = range.commonAncestorContainer;
            const rootEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
            // A selection entirely inside one table never meets the <table> element while walking.
            const enclosingMath = L.mathContainerOf(rootEl);
            if (enclosingMath) {
                appendMath(enclosingMath);
                trimEnd();
                return;
            }
            const enclosingTable = rootEl && rootEl.closest("table");
            if (enclosingTable && readsAsTable(enclosingTable, range)) {
                appendTable(enclosingTable, range);
                trimEnd();
                return;
            }

            const walker = document.createTreeWalker(
                root.nodeType === Node.TEXT_NODE ? root.parentNode : root,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
                {
                    acceptNode(node) {
                        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
                        if (isHidden(node)) return NodeFilter.FILTER_REJECT;
                        if (node.tagName === "TABLE" && readsAsTable(node, range)) return NodeFilter.FILTER_ACCEPT;
                        if (node.matches(L.MATH_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
                        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                    },
                }
            );

            let lastBlock = null;
            let done = null; // a table or equation already read; its contents are skipped
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (done && done.contains(node)) continue;
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.matches(L.MATH_SELECTOR)) {
                        appendMath(node);
                        done = node;
                    } else if (node.tagName === "TABLE") {
                        appendTable(node, range);
                        done = node;
                        lastBlock = node;
                    } else {
                        lineBreak(); // <br>
                    }
                    continue;
                }
                const block = blockOf(node);
                if (lastBlock && block !== lastBlock) lineBreak();
                lastBlock = block;

                const start = node === range.startContainer ? range.startOffset : 0;
                const end = node === range.endContainer ? range.endOffset : node.data.length;
                appendNodeText(node, start, end);
            }
            trimEnd();
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
            // An outline frames its element, so it isn't blended.
            const blend = outlined ? "normal" : darkMode ? "screen" : "multiply";
            host.style.cssText =
                "all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; " +
                `pointer-events: none; z-index: 2147483647; mix-blend-mode: ${blend};`;
            const shadow = host.attachShadow({ mode: "closed" });
            const style = document.createElement("style");
            style.textContent = PILL_CSS;
            const pill = document.createElement("div");
            pill.className = outlined ? "pill outline" : darkMode ? "pill dark" : "pill";
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
            if (overlay && outlined) {
                layoutOutline(outlined);
                return;
            }
            if (!overlay || !words) return;
            if (words.math) {
                layoutOutline(words.math);
                return;
            }
            overlay.pill.classList.remove("outline");
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

        // Frames `element` (an image, or an equation being spoken) with the outline style.
        function layoutOutline(element) {
            const rect = element.getBoundingClientRect();
            const { pill } = overlay;
            pill.classList.add("outline");
            pill.style.transform =
                `translate(${rect.left - OUTLINE_PAD + window.scrollX}px, ${rect.top - OUTLINE_PAD + window.scrollY}px)`;
            pill.style.width = `${rect.width + 2 * OUTLINE_PAD}px`;
            pill.style.height = `${rect.height + 2 * OUTLINE_PAD}px`;
            pill.style.opacity = "1";
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
            const spot = map[charIndex];
            if (spot && spot.math) {
                words = { math: spot.math };
                if (!overlay) {
                    overlay = createOverlay();
                    watchViewport(true);
                }
                layout(false);
                lastTop = null; // the next word starts fresh instead of gliding out of the outline
                return;
            }
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

        // Frames `element` (instead of the word pill) until clear().
        function outline(element) {
            clear();
            outlined = element;
            overlay = createOverlay();
            overlay.pill.style.transition = `opacity ${FADE_IN_MS}ms ease-out`;
            watchViewport(true);
            layout(true);
        }

        // Fades the pill (or outline) out, then removes it. A new reading gets a fresh one.
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
            outlined = null;
            lastTop = null;
            text = "";
            map = [];
        }

        return { prepare, showWord, clear, outline, relayout: onViewportChange };
    })();

    // For the other content scripts.
    Object.assign(L, { highlighter });
})();

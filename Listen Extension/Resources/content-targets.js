// Listen — content scripts, 9 of 10: images, charts, code and links the bar can be used on (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;
    const S = L.state;

    // ---------- Images ----------
    // Hovering a content image shows the bar in its top-right corner. The speaker reads its alt text, or asks
    // Gemini (through background.js) to describe it; the chat button asks about it.

    const IMAGE_MIN_SIZE = 80;
    const IMAGE_HOVER_DELAY_MS = 400;
    const IMAGE_LEAVE_DELAY_MS = 250;
    const NOTE_MS = 6000;

    let hoverTimer = null;
    let leaveTimer = null;
    let noteTimer = null;

    // Big enough, visible, not decorative, and not a logo inside a link.
    function isReadableImage(img) {
        const rect = img.getBoundingClientRect();
        if (rect.width < IMAGE_MIN_SIZE || rect.height < IMAGE_MIN_SIZE) return false;
        if (img.getAttribute("role") === "presentation" || img.closest("[aria-hidden='true']")) return false;
        if (L.isEditable(img)) return false;
        const link = img.closest("a");
        if (link) {
            const hints = [img.alt, img.currentSrc || img.src, img.className, img.id, link.className, link.id].join(" ");
            if (/logo/i.test(hints)) return false;
        }
        return true;
    }

    // Alt text worth reading: not empty, not a file name, not a placeholder like "image" or "IMG_1234".
    function isMeaningfulAlt(alt) {
        const text = alt.trim();
        if (!text) return false;
        if (/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic)$/i.test(text)) return false;
        if (/^(image|img|photo|picture|graphic|icon|thumbnail|untitled)\s*\d*$/i.test(text)) return false;
        if (!/\s/.test(text) && /^(img|dsc|pxl|screenshot)[_\-]?\d/i.test(text)) return false;
        return true;
    }

    function imageInfo(img) {
        return { src: img.currentSrc || img.src, alt: (img.getAttribute("alt") || "").trim() };
    }

    // kind "error" (red, hides itself after a while) or "info" (stays until hidden, e.g. "Explaining code…").
    function showNote(message, kind = "error") {
        if (!S.note) {
            S.note = document.createElement("div");
            S.note.className = "note";
            S.barShadow.append(S.note);
        }
        S.note.textContent = message;
        S.note.classList.toggle("info", kind === "info");
        S.note.hidden = false;
        clearTimeout(noteTimer);
        if (kind !== "info") noteTimer = setTimeout(() => (S.note.hidden = true), NOTE_MS);
    }

    function showImageBar(img, kind = "image") {
        S.selectedText = "";
        S.selectedRange = null;
        S.imageTarget = img;
        S.imageKind = kind;
        L.setButtonIcon("listen");
        if (kind === "math") L.showBar(L.mathOutlineTarget(img).getBoundingClientRect(), false);
        else if (kind === "link") {
            const rects = img.getClientRects(); // a link can wrap over several lines; use its last one
            L.showBar(rects[rects.length - 1] || img.getBoundingClientRect(), false);
        } else L.showBar(img.getBoundingClientRect(), true);
    }

    function hideImageBar() {
        if (!S.imageTarget || S.imageBusy || L.speech.isSpeaking()) return;
        L.hideBar();
    }

    async function onListenImage() {
        if (S.imageKind === "chart") {
            onListenChart(S.imageTarget);
            return;
        }
        if (S.imageKind === "math") {
            L.onListenMath(S.imageTarget);
            return;
        }
        if (S.imageKind === "link") {
            onListenLink(S.imageTarget);
            return;
        }
        const img = S.imageTarget;
        const { alt } = imageInfo(img);
        if (isMeaningfulAlt(alt)) {
            L.readAbout(img, alt);
            return;
        }
        const id = ++S.imageRequest;
        S.imageBusy = true;
        L.setButtonIcon("loading");
        const response = await L.askBackground({ action: "describe", image: imageInfo(img) });
        if (id !== S.imageRequest) return; // cancelled
        S.imageBusy = false;
        if (response.ok) {
            L.readAbout(img, response.answer);
            return;
        }
        L.setButtonIcon("listen");
        const fallBack = response.imageUnavailable && alt;
        showNote(fallBack ? `${response.error} Reading its alt text instead.` : response.error);
        if (fallBack) L.readAbout(img, alt);
    }

    // Cancels a pending image, chart or code request (the spinner was clicked).
    function cancelImageRequest() {
        S.imageRequest++;
        S.imageBusy = false;
        if (S.note) S.note.hidden = true;
        L.setButtonIcon("listen");
    }

    // What a hover bar can be shown for under the pointer, following the popup's settings. Equations
    // always get one: they're read on the Mac, without AI.
    function hoverTargetFor(node) {
        const allowed = (found) => {
            if (!found) return null;
            if (found.kind === "math") return found;
            if (found.kind === "link") return L.settings.showLinkButtons && L.settings.aiFeatures ? found : null;
            if (found.kind === "chart") return L.settings.showImageButtons && L.settings.aiFeatures ? found : null;
            return L.settings.showImageButtons ? found : null; // images with alt text are read without AI
        };
        return allowed(visualTargetFor(node)) || allowed(linkTargetFor(node));
    }

    // Show the bar after the pointer rests on an image or chart (see Charts); hide it once the pointer
    // leaves both it and the bar.
    document.addEventListener(
        "mouseover",
        (event) => {
            if (L.isBarEvent(event)) {
                clearTimeout(leaveTimer);
                return;
            }
            const found = hoverTargetFor(event.target);
            if (found && found.el === S.imageTarget) {
                clearTimeout(leaveTimer);
                return;
            }
            if (!found) return;
            if (S.selectedText || L.speech.isSpeaking() || S.imageBusy) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                if (found.el.matches(":hover") && !S.selectedText && !L.speech.isSpeaking()) {
                    showImageBar(found.el, found.kind);
                }
            }, found.kind === "link" ? LINK_HOVER_DELAY_MS : IMAGE_HOVER_DELAY_MS);
        },
        true
    );

    document.addEventListener(
        "mouseout",
        (event) => {
            clearTimeout(hoverTimer);
            if (!S.imageTarget) return;
            const to = event.relatedTarget;
            if (to && (to === S.imageTarget || to === S.barHost || S.imageTarget.contains(to))) return;
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(hideImageBar, IMAGE_LEAVE_DELAY_MS);
        },
        true
    );

    // ---------- Charts ----------
    // Charts and graphs get the same hover bar as images: chart-like images, and large <canvas> or <svg>
    // elements. The speaker asks Gemini to describe what the chart shows; the chat button offers Describe / Key numbers /
    // Explain. Canvas and svg charts exist only on the page, so they're captured here as a PNG (svg also
    // sends its text labels); background.js sends everything to Gemini.

    const CHART_MIN_WIDTH = 150;
    const CHART_MIN_HEIGHT = 100;
    const MAX_CAPTURE_SIDE = 1024;
    const MAX_LABEL_CHARS = 4000;
    const CHART_HINTS = /\b(chart|graph|plot|diagram|histogram|pie|trend|timeline|statistics?|infographic)\b/i;
    // Computed styles copied into a captured svg, since the page's stylesheets don't come along.
    const SVG_STYLE_PROPS = [
        "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "opacity",
        "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "visibility", "display",
    ];
    const CHART_CHIPS = [
        ["describe", "Describe", "Describe what the chart shows"],
        ["keynumbers", "Key numbers", "The chart's most important numbers"],
        ["explain", "Explain", "Explain the chart simply"],
    ];

    // A chart that can't be captured; `message` is shown to the user.
    class CaptureError extends Error {}

    function bigEnoughForChart(el) {
        const rect = el.getBoundingClientRect();
        return rect.width >= CHART_MIN_WIDTH && rect.height >= CHART_MIN_HEIGHT;
    }

    function captionOf(el) {
        const figure = el.closest("figure");
        const caption = figure && figure.querySelector("figcaption");
        return caption ? caption.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    }

    // An image whose alt text, file name or caption mentions a chart, or a large vector diagram
    // (Wikipedia serves those as ".svg.png").
    function looksLikeChartImage(img) {
        const src = img.currentSrc || img.src || "";
        const hints = [img.alt, img.title, src, img.className, captionOf(img)].join(" ").replace(/[_-]/g, " ");
        if (CHART_HINTS.test(hints)) return true;
        return /\.svg(\.png)?([?#]|$)/i.test(src) && bigEnoughForChart(img);
    }

    function outermostSvg(node) {
        let svg = node.closest && node.closest("svg");
        while (svg && svg.parentElement && svg.parentElement.closest("svg")) svg = svg.parentElement.closest("svg");
        return svg;
    }

    // Large, not a decorative icon or a link's logo, and actually drawing something.
    function isChartSvg(svg) {
        if (!bigEnoughForChart(svg) || svg.closest("a") || svg.closest("[aria-hidden='true']")) return false;
        return svg.querySelectorAll("path, rect, line, circle, polyline, polygon").length >= 3;
    }

    // The image, chart image, canvas chart or svg chart under the pointer, as { el, kind }, or null.
    function visualTargetFor(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
        const math = L.mathContainerOf(node);
        if (math) return L.isHoverableMath(math) ? { el: math, kind: "math" } : null;
        if (node.tagName === "IMG") {
            if (!isReadableImage(node)) return null;
            return { el: node, kind: looksLikeChartImage(node) ? "chart" : "image" };
        }
        if (node.tagName === "CANVAS") {
            return bigEnoughForChart(node) && !node.closest("[aria-hidden='true']") ? { el: node, kind: "chart" } : null;
        }
        const svg = outermostSvg(node);
        return svg && isChartSvg(svg) ? { el: svg, kind: "chart" } : null;
    }

    function isBlank(pixels) {
        for (let i = 0; i < pixels.length; i += 16) {
            if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) return false;
        }
        return true;
    }

    // Draws `source` (a canvas or image) on white, at most MAX_CAPTURE_SIDE wide or tall, as a PNG part.
    function imagePartFrom(source, width, height) {
        const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        let pixels;
        try {
            pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        } catch (e) {
            throw new CaptureError(
                "This chart can't be captured: it uses pictures from another website, so Safari blocks copying it."
            );
        }
        if (isBlank(pixels)) throw new CaptureError("This chart couldn't be captured: the copy came out blank.");
        return { data: canvas.toDataURL("image/png").split(",")[1], mime_type: "image/png" };
    }

    function loadPicture(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new CaptureError("This chart couldn't be captured: the page didn't allow copying it."));
            img.src = url;
        });
    }

    // Renders an svg chart to a PNG part, with the page's computed styles copied in.
    async function svgImagePart(svg) {
        const rect = svg.getBoundingClientRect();
        const clone = svg.cloneNode(true);
        const sources = [svg, ...svg.querySelectorAll("*")];
        const copies = [clone, ...clone.querySelectorAll("*")];
        sources.forEach((source, i) => {
            const style = getComputedStyle(source);
            copies[i].setAttribute("style", SVG_STYLE_PROPS.map((p) => `${p}:${style.getPropertyValue(p)}`).join(";"));
        });
        clone.setAttribute("width", String(rect.width));
        clone.setAttribute("height", String(rect.height));
        const markup = new XMLSerializer().serializeToString(clone);
        const picture = await loadPicture(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`);
        return imagePartFrom(picture, rect.width * 2, rect.height * 2); // 2x keeps small labels sharp
    }

    function svgLabels(svg) {
        const texts = [...svg.querySelectorAll("title, desc, text")]
            .map((el) => el.textContent.replace(/\s+/g, " ").trim())
            .filter(Boolean);
        const label = svg.getAttribute("aria-label");
        if (label) texts.unshift(label);
        return [...new Set(texts)].join(" | ").slice(0, MAX_LABEL_CHARS);
    }

    // What background.js needs to see a chart: { src } for an image, or a captured { data, mime_type },
    // plus any text labels and caption. Throws CaptureError when a canvas or svg can't be copied.
    async function chartInfo(el) {
        const caption = captionOf(el);
        if (el.tagName === "IMG") return { ...imageInfo(el), caption };
        if (el.tagName === "CANVAS") {
            const labels = [el.getAttribute("aria-label"), el.title, el.textContent.trim()].filter(Boolean).join(" | ");
            return { ...imagePartFrom(el, el.width, el.height), labels: labels.slice(0, MAX_LABEL_CHARS), caption };
        }
        return { ...(await svgImagePart(el)), labels: svgLabels(el), caption };
    }

    async function onListenChart(el) {
        const id = ++S.imageRequest;
        S.imageBusy = true;
        L.setButtonIcon("loading");
        let response;
        try {
            response = await L.askBackground({ action: "describe", chart: await chartInfo(el) });
        } catch (error) {
            response = { ok: false, error: error instanceof CaptureError ? error.message : "This chart couldn't be captured." };
        }
        if (id !== S.imageRequest) return; // cancelled
        S.imageBusy = false;
        if (response.ok) {
            L.readAbout(el, response.answer);
            return;
        }
        L.setButtonIcon("listen");
        const alt = el.tagName === "IMG" ? imageInfo(el).alt : "";
        const fallBack = response.imageUnavailable && alt;
        showNote(fallBack ? `${response.error} Reading its alt text instead.` : response.error);
        if (fallBack) L.readAbout(el, alt);
    }

    // ---------- Code ----------
    // A selection inside a code block isn't read symbol by symbol: the speaker asks Gemini (through background.js)
    // for a short plain-English explanation and reads that, outlining the block; the chat button offers Explain /
    // Line by line / Find bugs. A single word or name in code is just read normally.

    // Elements that hold code (GitHub, Pygments, highlight.js, CodeMirror, plain <pre>/<code>) ...
    const CODE_SELECTOR =
        "pre, code, div.highlight, figure.highlight, .blob-code, .react-code-lines, .react-code-file-contents, " +
        ".hljs, .cm-content";
    // ... and the block around them that gets outlined.
    const CODE_BLOCK_SELECTOR = "pre, div.highlight, figure.highlight, .react-code-file-contents, .blob-wrapper, .cm-editor";
    const CODE_CHIPS = [
        ["explain", "Explain", "Explain what the code does"],
        ["linebyline", "Line by line", "Go through the code line by line"],
        ["bugs", "Find bugs", "Look for mistakes in the code"],
    ];

    // The code block `range` is inside, or null if it isn't code or is just one word or name.
    function codeBlockFor(range, text) {
        if (!range || !/\s/.test(text.trim())) return null;
        const node = range.commonAncestorContainer;
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        const code = el && el.closest(CODE_SELECTOR);
        return code ? code.closest(CODE_BLOCK_SELECTOR) || code : null;
    }

    // The code's language from classes like "language-js", "lang-py" or "highlight-source-python".
    function codeLanguage(block) {
        const pattern = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/i;
        const candidates = [block, ...block.querySelectorAll("[class*='language-'], [class*='lang-']")];
        for (let el = block.parentElement; el && el !== document.body; el = el.parentElement) candidates.push(el);
        for (const el of candidates) {
            const match = typeof el.className === "string" && el.className.match(pattern);
            if (match) return match[1];
        }
        return "";
    }

    // Some code viewers (GitHub's file view) keep the selection in a read-only text field laid over the
    // code, so it never shows up as a page selection.

    function isReadOnlyCodeField(el) {
        const readOnly = el && (el.readOnly || el.getAttribute("aria-readonly") === "true");
        return Boolean(readOnly && el.tagName === "TEXTAREA" && /code|blob/i.test(`${el.id} ${el.className}`));
    }

    // The selection in a read-only code field, shaped like readSelection()'s result, or null.
    function readOnlyCodeSelection() {
        const field = document.activeElement;
        if (!isReadOnlyCodeField(field)) return null;
        const text = field.value.slice(field.selectionStart, field.selectionEnd).trim();
        if (!text) return null;
        const box = field.getBoundingClientRect();
        const x = S.lastPointer ? S.lastPointer.x : box.left + 40;
        const y = S.lastPointer ? S.lastPointer.y : Math.max(box.top, 0) + 40;
        const block = field.closest(".react-code-file-contents") || field.parentElement;
        return { text, range: null, rect: { left: x, right: x, top: y - 16, bottom: y + 4 }, codeBlock: /\s/.test(text) ? block : null };
    }

    async function onListenCode(code, block) {
        const id = ++S.imageRequest;
        S.imageBusy = true;
        L.setButtonIcon("loading");
        showNote("Explaining code…", "info");
        const response = await L.askBackground({ action: "explain", code: { text: code, language: codeLanguage(block) } });
        if (id !== S.imageRequest) return; // cancelled
        S.imageBusy = false;
        if (S.note) S.note.hidden = true;
        if (response.ok) {
            L.readAbout(block, response.answer);
            return;
        }
        L.setButtonIcon("listen");
        showNote(response.error);
    }

    // ---------- Links ----------
    // Resting on a link shows the bar near it. The speaker reads a short summary of the linked page; chat asks
    // about it. background.js fetches the page (no cookies, public addresses only) and asks Gemini.

    const LINK_HOVER_DELAY_MS = 600;
    // Links to files rather than pages.
    const DOWNLOAD_EXTENSIONS =
        /\.(pdf|zip|rar|7z|gz|tgz|tar|dmg|pkg|exe|msi|apk|iso|img|bin|docx?|xlsx?|pptx?|csv|odt|ods|epub|mobi|mp3|wav|flac|m4a|mp4|mov|avi|mkv|webm|jpe?g|png|gif|webp|svg|heic|ics|vcf|json|xml|txt|torrent)$/i;
    const LINK_CHIPS = [
        ["summarize", "Summarize", "Summarize the linked page"],
        ["keypoints", "Key points", "The linked page's key points"],
        ["worth", "Is it worth reading?", "Whether the linked page seems worth reading"],
    ];
    const linkSummaries = new Map(); // address → summary, so a second listen is instant

    function linkUrl(a) {
        try {
            const url = new URL(a.href, location.href);
            url.hash = "";
            return url;
        } catch (e) {
            return null;
        }
    }

    // IP addresses, localhost and local network names.
    function isPrivateHost(host) {
        const name = host.toLowerCase();
        return !name.includes(".") || /^\[|:/.test(name) || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ||
            /(^|\.)(localhost|local|internal|lan|home|intranet|corp)$/.test(name);
    }

    // The link under the pointer, as { el, kind: "link" }, if it leads to another web page.
    function linkTargetFor(node) {
        const a = node && node.closest && node.closest("a[href]");
        if (!a || a.hasAttribute("download") || L.isEditable(a)) return null;
        const raw = a.getAttribute("href").trim();
        if (!raw || raw.startsWith("#") || /^(mailto|javascript|tel|sms|data|blob|file):/i.test(raw)) return null;
        const url = linkUrl(a);
        if (!url || !/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return null;
        const here = new URL(location.href);
        here.hash = "";
        if (url.href === here.href) return null; // a section of this same page
        if (DOWNLOAD_EXTENSIONS.test(url.pathname)) return null;
        const rect = a.getBoundingClientRect();
        const tinyIcon = !a.textContent.trim() && rect.width * rect.height < 1600;
        if (rect.width < 16 || rect.height < 10 || tinyIcon) return null;
        return { el: a, kind: "link" };
    }

    async function onListenLink(a) {
        const url = linkUrl(a).href;
        if (linkSummaries.has(url)) {
            L.readAbout(a, linkSummaries.get(url));
            return;
        }
        const id = ++S.imageRequest;
        S.imageBusy = true;
        L.setButtonIcon("loading");
        showNote("Reading the linked page…", "info");
        const response = await L.askBackground({ action: "summarize", link: { url } });
        if (id !== S.imageRequest) return; // cancelled
        S.imageBusy = false;
        if (S.note) S.note.hidden = true;
        if (response.ok) {
            linkSummaries.set(url, response.answer);
            L.readAbout(a, response.answer);
            return;
        }
        L.setButtonIcon("listen");
        showNote(response.error);
    }

    // For the other content scripts.
    Object.assign(L, {
        imageInfo, showNote, showImageBar, onListenImage, cancelImageRequest, CHART_CHIPS, CaptureError, captionOf,
        visualTargetFor, chartInfo, CODE_CHIPS, codeBlockFor, codeLanguage, readOnlyCodeSelection, onListenCode,
        LINK_CHIPS, linkUrl,
    });
})();

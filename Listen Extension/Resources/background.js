// Listen — background page
// Answers questions about highlighted text, code, maths, images, charts and linked pages. Requests go to Listen's
// proxy server (proxy/ in this repo), which holds the Gemini API key and the instructions for each kind of question,
// so the key never ships in the extension. Images and linked pages are loaded here and sent along as data.

// For local testing with `vercel dev` (run in proxy/), use "http://localhost:3000/api/ask".
const PROXY_URL = "https://listen-proxy.vercel.app/api/ask";
const REQUEST_TIMEOUT_MS = 35000; // the proxy gives Gemini 30 s
const MAX_CONTEXT_CHARS = 20000;
const MAX_IMAGE_SIDE = 1024; // px; larger images are scaled down before sending
const MAX_CAPTURED_IMAGE_CHARS = 12 * 1024 * 1024; // base64 of a chart the page captured, before it's scaled down
const MAX_CHART_TEXT_CHARS = 4000;

// Thrown for failures the user should see; `message` is shown as is. `imageUnavailable` marks an image
// that couldn't be fetched or decoded, so the page can fall back to its alt text.
class AskError extends Error {
    constructor(message, imageUnavailable = false) {
        super(message);
        this.imageUnavailable = imageUnavailable;
    }
}

// ----- Images -----

function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

async function toJpeg(bitmap, width, height) {
    let canvas;
    let encode;
    if (typeof OffscreenCanvas === "function") {
        canvas = new OffscreenCanvas(width, height);
        encode = () => canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    } else {
        canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        encode = () => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    }
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff"; // transparent images get a white background
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    return encode();
}

// Fetches an image, scales it to at most MAX_IMAGE_SIDE on its longest side and returns it as a
// Gemini inline image part (JPEG, base64).
async function loadImage(src) {
    if (!/^(https?|data):/i.test(src)) {
        throw new AskError("This image can't be read: it isn't a normal web image.", true);
    }
    let response;
    try {
        response = await fetch(src, { credentials: "omit" });
    } catch (e) {
        throw new AskError("This image can't be loaded: its website doesn't allow it to be fetched.", true);
    }
    if (!response.ok) throw new AskError(`This image couldn't be downloaded (error ${response.status}).`, true);
    let bitmap;
    try {
        bitmap = await createImageBitmap(await response.blob());
    } catch (e) {
        throw new AskError("This image's format can't be read.", true);
    }
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const jpeg = await toJpeg(bitmap, width, height);
    if (bitmap.close) bitmap.close();
    return { type: "image", data: toBase64(await jpeg.arrayBuffer()), mime_type: "image/jpeg" };
}

// A random ID made once per install, so the proxy can count each install's questions per day. It says nothing
// about the user.
let installIdPromise = null;
function installId() {
    installIdPromise ||= browser.storage.local.get("installId").then(async ({ installId: id }) => {
        if (typeof id === "string" && id) return id;
        const fresh = crypto.randomUUID();
        await browser.storage.local.set({ installId: fresh });
        return fresh;
    });
    return installIdPromise.catch(() => {
        installIdPromise = null;
        throw new AskError("Listen couldn't read its settings. Try again.");
    });
}

// Turns an error from the proxy into a clear message.
function errorFor(body) {
    switch (body?.error) {
        case "daily_limit": {
            const hours = body.resetHours > 1 ? `about ${body.resetHours} hours` : "about an hour";
            return new AskError(`You've used today's ${body.limit} questions. They reset in ${hours}.`);
        }
        case "busy":
            return new AskError("Listen is getting too many questions right now. Try again in a little while.");
        case "timeout":
            return new AskError("Gemini took too long to answer. Try again.");
        case "image_error":
            return new AskError("Gemini couldn't process this image.", true);
        case "no_answer":
            return new AskError("Gemini didn't return an answer. Try rephrasing the question.");
        case "too_large":
            return new AskError("That's too much to send at once. Try a smaller selection.");
        case "bad_request":
            return new AskError("Listen's server didn't accept this request.");
        default:
            return new AskError("Listen's server is unavailable. Try again shortly.");
    }
}

// A chart as an image part: captured by the page ({ data, mime_type }) or fetched ({ src }). Either way it's
// scaled down like any image, so it fits the proxy's size limit.
async function chartImagePart(chart) {
    if (typeof chart.data === "string" && chart.data) {
        if (!["image/png", "image/jpeg"].includes(chart.mime_type) || chart.data.length > MAX_CAPTURED_IMAGE_CHARS) {
            throw new AskError("This chart's picture is too large or in an unexpected format.");
        }
        try {
            return await loadImage(`data:${chart.mime_type};base64,${chart.data}`);
        } catch (e) {
            throw new AskError("This chart's picture couldn't be prepared.");
        }
    }
    if (typeof chart.src === "string" && chart.src) return loadImage(chart.src);
    throw new AskError("No chart picture was sent.");
}


// About text: action "ask" (with question), "summarize", "explain" or "translate" (with target language).
// About an image (image.src): "ask", "describe", "readtext" or "explain".
// About a chart (chart: { src } or { data, mime_type }, plus labels and caption): "ask", "describe",
// "keynumbers" or "explain".
// About code (code: { text, language }): "ask", "explain", "linebyline" or "bugs".
// About maths (math: { text }, with TeX or MathML for each equation): "ask", "explain", "solve" or "speak".
// About a linked page (link: { url }): "ask", "summarize", "keypoints" or "worth".
async function ask({ action, question, text, target, image, chart, code, math, link }) {
    const kind = link ? "link" : math ? "math" : code ? "code" : chart ? "chart" : image ? "image" : "text";
    if (action === "ask" && !question) throw new AskError("Type a question first.");
    let input;
    if (link) {
        const page = await loadPage(link.url);
        const quoted =
            `Page title: ${page.title}\nWebsite: ${page.host}\n<<<PAGE TEXT START>>>\n${page.text}\n<<<PAGE TEXT END>>>`;
        input = action === "ask" ? `${quoted}\n\nThe user's question: ${question}` : quoted;
    } else if (math) {
        const quoted = `Maths:\n"""\n${String(math.text || "").slice(0, MAX_CONTEXT_CHARS)}\n"""`;
        input = action === "ask" ? `${quoted}\n\nQuestion: ${question}` : quoted;
    } else if (code) {
        const source = String(code.text || "").slice(0, MAX_CONTEXT_CHARS);
        const language = String(code.language || "").replace(/[^\w+#. -]/g, "").slice(0, 30);
        const quoted = `Code${language ? ` (${language})` : ""}:\n"""\n${source}\n"""`;
        input = action === "ask" ? `${quoted}\n\nQuestion: ${question}` : quoted;
    } else if (chart) {
        // The docs recommend the text prompt before a single image. Labels found in an svg chart and
        // the chart's caption help with small or overlapping text.
        let prompt = action === "ask" ? `Question: ${question}` : "Here is the chart.";
        const labels = String(chart.labels || "").slice(0, MAX_CHART_TEXT_CHARS);
        const caption = String(chart.caption || "").slice(0, MAX_CHART_TEXT_CHARS);
        if (labels) prompt += `\n\nText labels found in the chart: ${labels}`;
        if (caption) prompt += `\n\nThe chart's caption: ${caption}`;
        input = [{ type: "text", text: prompt }, await chartImagePart(chart)];
    } else if (image) {
        // The docs recommend the text prompt before a single image.
        const prompt = action === "ask" ? `Question: ${question}` : "Here is the image.";
        input = [{ type: "text", text: prompt }, await loadImage(image.src)];
    } else {
        const passage = text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
        const quoted = `Highlighted text:\n"""\n${passage}\n"""`;
        input = action === "ask" ? `${quoted}\n\nQuestion: ${question}` : quoted;
    }
    const id = await installId();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(PROXY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ installId: id, kind, action, input, target }),
            signal: controller.signal,
        });
    } catch (e) {
        if (e.name === "AbortError") throw new AskError("Listen's server took too long to answer. Try again.");
        throw new AskError("Listen's server is unavailable. Check your internet connection and try again.");
    } finally {
        clearTimeout(timer);
    }

    let body = null;
    try {
        body = await response.json();
    } catch (e) {
        // handled below
    }
    if (!response.ok) throw errorFor(body);
    const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
    if (!answer) throw new AskError("Gemini didn't return an answer. Try rephrasing the question.");
    // Spoken answers drop markdown backticks; link answers never carry web addresses.
    if (link) return answer.replace(/(https?:\/\/|www\.)\S+/gi, "").replace(/\s{2,}/g, " ").trim();
    return code || math ? answer.replace(/`+/g, "") : answer;
}

// ----- Linked pages -----

const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 10000;
const PAGE_MAX_CHARS = 30000;
const CACHE_LIMIT = 100;
// Parts of a page that aren't its main text.
const PAGE_CLUTTER =
    "script, style, noscript, template, iframe, svg, canvas, form, button, input, select, textarea, nav, header, " +
    "footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary'], " +
    "[role='search'], [aria-hidden='true'], [hidden], [class*='advert'], [class*='cookie'], [id*='cookie'], " +
    "[class*='newsletter'], [class*='share'], .ad, .ads, .sidebar, .menu";

const pageCache = new Map(); // url → { title, host, text }
const answerCache = new Map(); // "action url" → answer, for this browser session

function remember(cache, key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

// http(s) addresses on public hosts only: no IP addresses, localhost or local network names.
function isPublicWebAddress(url) {
    if (!/^https?:$/.test(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (!host.includes(".") || /^\[|:/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    return !/(^|\.)(localhost|local|internal|lan|home|intranet|corp)$/.test(host);
}

// Reads a response body, stopping with an error once it passes PAGE_MAX_BYTES.
async function readLimited(response) {
    const length = Number(response.headers.get("content-length") || 0);
    if (length > PAGE_MAX_BYTES) throw new AskError("This page is too big to preview.");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > PAGE_MAX_BYTES) {
            reader.cancel();
            throw new AskError("This page is too big to preview.");
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    const charset = (/charset=([\w-]+)/i.exec(response.headers.get("content-type") || "") || [])[1] || "utf-8";
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch (e) {
        return new TextDecoder("utf-8").decode(bytes);
    }
}

// The page's title and main text. DOMParser builds an inert document: its scripts never run and it is
// never shown anywhere.
function extractPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ogTitle = doc.querySelector("meta[property='og:title']");
    const title = ((ogTitle && ogTitle.getAttribute("content")) || doc.title || "").trim().slice(0, 300);
    const root = doc.querySelector("article, main, [role='main']") || doc.body;
    if (!root) return { title, text: "" };
    root.querySelectorAll(PAGE_CLUTTER).forEach((el) => el.remove());
    const blocks = [...root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, pre, figcaption, td, dd")]
        .map((el) => el.textContent.replace(/\s+/g, " ").trim())
        .filter((line) => line.length > 1);
    const text = (blocks.length ? [...new Set(blocks)].join("\n") : root.textContent.replace(/\s+/g, " ")).trim();
    return { title, text: text.slice(0, PAGE_MAX_CHARS) };
}

// Fetches and extracts a linked page: no cookies, public http(s) only, at most 2 MB, 10 s.
async function loadPage(address) {
    let url;
    try {
        url = new URL(address);
    } catch (e) {
        throw new AskError("That link isn't a web page address.");
    }
    url.hash = "";
    if (!isPublicWebAddress(url)) throw new AskError("Listen only previews public web pages.");
    if (pageCache.has(url.href)) return pageCache.get(url.href);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
        let response;
        try {
            response = await fetch(url.href, { credentials: "omit", redirect: "follow", signal: controller.signal });
        } catch (e) {
            if (e.name === "AbortError") throw new AskError("The linked page took too long to load.");
            throw new AskError("The linked page can't be loaded: its website doesn't allow it, or you're offline.");
        }
        if (response.url && !isPublicWebAddress(new URL(response.url))) {
            throw new AskError("Listen only previews public web pages.");
        }
        if (response.status === 401 || response.status === 403) {
            throw new AskError("The linked page needs a login or doesn't allow previews.");
        }
        if (response.status === 404 || response.status === 410) throw new AskError("The linked page doesn't exist.");
        if (!response.ok) throw new AskError(`The linked page couldn't be loaded (error ${response.status}).`);
        const type = response.headers.get("content-type") || "";
        if (type && !/text\/html|application\/xhtml/i.test(type)) {
            throw new AskError("This link isn't a web page, so there's nothing to preview.");
        }
        const page = { ...extractPage(await readLimited(response)), host: url.hostname };
        if (page.text.length < 80) {
            throw new AskError("The linked page has almost no readable text. It may need a login or JavaScript.");
        }
        remember(pageCache, url.href, page);
        return page;
    } catch (error) {
        if (error.name === "AbortError") throw new AskError("The linked page took too long to load.");
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

browser.runtime.onMessage.addListener((request) => {
    if (!request || request.type !== "listen:ask") return;
    // Only plain language names (e.g. "Spanish") are passed into the prompt.
    const target = String(request.target || "English").replace(/[^\p{L} -]/gu, "").slice(0, 40) || "English";
    const image = request.image && typeof request.image.src === "string" ? { src: request.image.src } : null;
    const chart = request.chart && typeof request.chart === "object" ? request.chart : null;
    const code = request.code && typeof request.code.text === "string" ? request.code : null;
    const math = request.math && typeof request.math.text === "string" ? request.math : null;
    const link = request.link && typeof request.link.url === "string" ? { url: request.link.url } : null;
    // Linked-page answers (except typed questions) are cached for the session.
    const cacheKey = link && request.action !== "ask" ? `${request.action} ${link.url.split("#")[0]}` : null;
    if (cacheKey && answerCache.has(cacheKey)) return Promise.resolve({ ok: true, answer: answerCache.get(cacheKey) });
    return ask({
        action: String(request.action || "ask"),
        question: String(request.question || "").trim(),
        text: String(request.text || ""),
        target,
        image,
        chart,
        code,
        math,
        link,
    }).then(
        (answer) => {
            if (cacheKey) remember(answerCache, cacheKey, answer);
            return { ok: true, answer };
        },
        (error) => {
            if (!(error instanceof AskError)) console.error("[Listen] Ask failed:", error);
            const message = error instanceof AskError ? error.message : "Something went wrong asking Gemini.";
            return { ok: false, error: message, imageUnavailable: Boolean(error.imageUnavailable) };
        }
    );
});

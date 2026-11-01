// Listen — background page
// Answers questions about highlighted text, images and charts with Gemini. The API key lives in secrets.js (git-ignored)
// and is only ever used here, never sent to content scripts or logged.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.5-flash-lite"; // free tier; see ai.google.dev/gemini-api/docs/models
const REQUEST_TIMEOUT_MS = 30000;
const MAX_CONTEXT_CHARS = 20000;

// What Gemini is asked to do for each action the content script can send.
const INSTRUCTIONS = {
    ask: () =>
        "You answer questions about a passage the user highlighted on a web page. " +
        "Use only the highlighted text, not outside knowledge. " +
        "Answer briefly and clearly in plain sentences, without markdown. " +
        "If the highlighted text doesn't contain the answer, say that it doesn't.",
    summarize: () =>
        "Summarize the passage the user highlighted on a web page in two or three short sentences. " +
        "Use only that text. Plain sentences, without markdown.",
    explain: () =>
        "Explain the passage the user highlighted on a web page simply, as if to a beginner. " +
        "Use short, plain sentences and everyday words, without markdown. Base the explanation on that text.",
    translate: (target) =>
        `Translate the passage the user highlighted on a web page into ${target}. ` +
        "Reply with only the translation: no notes, quotes or explanations. " +
        `If the passage is already entirely in ${target}, reply with one short sentence saying so.`,
};
const MAX_OUTPUT_TOKENS = { ask: 400, summarize: 400, explain: 600, translate: 2048 };

// The same, for questions about an image (sent along as inline image data).
const IMAGE_INSTRUCTIONS = {
    describe: () =>
        "Describe the image in one or two plain sentences, as you would to someone who can't see it. No markdown.",
    readtext: () =>
        "Transcribe all readable text in the image, in reading order. Reply with only that text. " +
        "If there is no readable text, say so in one short sentence.",
    explain: () =>
        "Explain simply, as if to a beginner, what the image shows and what it means. " +
        "Use short, plain sentences, without markdown.",
    ask: () =>
        "Answer the user's question about the image briefly and clearly in plain sentences, without markdown. " +
        "Use only what the image shows. If the image doesn't show the answer, say so.",
};
const IMAGE_MAX_OUTPUT_TOKENS = { describe: 300, readtext: 2048, explain: 600, ask: 400 };
const MAX_IMAGE_SIDE = 1024; // px; larger images are scaled down before sending

// The same, for charts and graphs: a chart image to fetch, or a canvas/svg chart the page captured.
const CHART_INSTRUCTIONS = {
    describe: () =>
        "This image is a chart or graph. In two to four plain sentences, say what it shows: its title, what the " +
        "axes or categories measure, the main trend, and the highest and lowest values with their labels. " +
        "Use only what is visible and the labels provided. No markdown. " +
        "If it isn't actually a chart, describe what it shows in one or two sentences instead.",
    keynumbers: () =>
        "This image is a chart or graph. List its key numbers: the highest and lowest values, any totals or " +
        "averages shown, and other notable figures, each with what it refers to. Use short plain sentences, " +
        "without markdown, and only what the chart shows.",
    explain: () =>
        "This image is a chart or graph. Explain simply, as if to a beginner, what it shows and what it means. " +
        "Use short, plain sentences, without markdown.",
    ask: () =>
        "This image is a chart or graph. Answer the user's question about it briefly and clearly in plain " +
        "sentences, without markdown. Use only what the chart shows. If it doesn't show the answer, say so.",
};
const CHART_MAX_OUTPUT_TOKENS = { describe: 400, keynumbers: 600, explain: 600, ask: 400 };
const MAX_CAPTURED_IMAGE_CHARS = 12 * 1024 * 1024; // base64 of a captured chart (well under Gemini's 20 MB)
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

async function loadApiKey() {
    let key = "";
    try {
        ({ GEMINI_API_KEY: key } = await import("./secrets.js"));
    } catch (e) {
        throw new AskError("No Gemini API key found. Add secrets.js with your key, then rebuild.");
    }
    if (!key || key.includes("YOUR_GEMINI_API_KEY")) {
        throw new AskError("No Gemini API key set. Put your key in secrets.js, then rebuild.");
    }
    return key;
}

// Turns an HTTP error from Gemini into a clear message. The body may be an object or a one-item array.
function errorFor(status, body) {
    const error = (Array.isArray(body) ? body[0] : body)?.error || {};
    const reasons = (error.details || []).map((d) => d.reason);
    if (reasons.includes("API_KEY_INVALID") || status === 401 || status === 403) {
        return new AskError("Gemini rejected the API key. Check the key in secrets.js.");
    }
    if (status === 429) {
        return new AskError("Gemini's free-tier limit was reached. Wait a minute and try again.");
    }
    if (status >= 500) {
        return new AskError("Gemini is having trouble right now. Try again shortly.");
    }
    if (/image/i.test(error.message || "")) {
        return new AskError("Gemini couldn't process this image.", true);
    }
    return new AskError(`Gemini returned an error (${status}${error.message ? `: ${error.message}` : ""}).`);
}

// A chart as a Gemini image part: captured by the page ({ data, mime_type }) or fetched ({ src }).
async function chartImagePart(chart) {
    if (typeof chart.data === "string" && chart.data) {
        if (!["image/png", "image/jpeg"].includes(chart.mime_type) || chart.data.length > MAX_CAPTURED_IMAGE_CHARS) {
            throw new AskError("This chart's picture is too large or in an unexpected format.");
        }
        return { type: "image", data: chart.data, mime_type: chart.mime_type };
    }
    if (typeof chart.src === "string" && chart.src) return loadImage(chart.src);
    throw new AskError("No chart picture was sent.");
}

// About text: action "ask" (with question), "summarize", "explain" or "translate" (with target language).
// About an image (image.src): "ask", "describe", "readtext" or "explain".
// About a chart (chart: { src } or { data, mime_type }, plus labels and caption): "ask", "describe",
// "keynumbers" or "explain".
async function ask({ action, question, text, target, image, chart }) {
    const instructions = chart ? CHART_INSTRUCTIONS : image ? IMAGE_INSTRUCTIONS : INSTRUCTIONS;
    if (!instructions[action]) throw new AskError("Unknown request.");
    if (action === "ask" && !question) throw new AskError("Type a question first.");
    const key = await loadApiKey();
    let input;
    if (chart) {
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(GEMINI_URL, {
            method: "POST",
            headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: GEMINI_MODEL,
                system_instruction: instructions[action](target),
                input,
                generation_config: {
                    max_output_tokens: (chart ? CHART_MAX_OUTPUT_TOKENS : image ? IMAGE_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS)[action],
                    thinking_level: "low",
                },
            }),
            signal: controller.signal,
        });
    } catch (e) {
        if (e.name === "AbortError") throw new AskError("Gemini took too long to answer. Try again.");
        throw new AskError("Couldn't reach Gemini. Check your internet connection.");
    } finally {
        clearTimeout(timer);
    }

    let body = null;
    try {
        body = await response.json();
    } catch (e) {
        // handled below
    }
    if (!response.ok) throw errorFor(response.status, body);

    // The answer is the text of the "model_output" steps ("thought" steps are skipped).
    const answer = (body?.steps || [])
        .filter((step) => step.type === "model_output")
        .flatMap((step) => step.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
    if (!answer) throw new AskError("Gemini didn't return an answer. Try rephrasing the question.");
    return answer;
}

browser.runtime.onMessage.addListener((request) => {
    if (!request || request.type !== "listen:ask") return;
    // Only plain language names (e.g. "Spanish") are passed into the prompt.
    const target = String(request.target || "English").replace(/[^\p{L} -]/gu, "").slice(0, 40) || "English";
    const image = request.image && typeof request.image.src === "string" ? { src: request.image.src } : null;
    const chart = request.chart && typeof request.chart === "object" ? request.chart : null;
    return ask({
        action: String(request.action || "ask"),
        question: String(request.question || "").trim(),
        text: String(request.text || ""),
        target,
        image,
        chart,
    }).then(
        (answer) => ({ ok: true, answer }),
        (error) => {
            if (!(error instanceof AskError)) console.error("[Listen] Ask failed:", error);
            const message = error instanceof AskError ? error.message : "Something went wrong asking Gemini.";
            return { ok: false, error: message, imageUnavailable: Boolean(error.imageUnavailable) };
        }
    );
});

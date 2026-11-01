// Listen — background page
// Answers questions about highlighted text with Gemini. The API key lives in secrets.js (git-ignored)
// and is only ever used here, never sent to content scripts or logged.

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.5-flash-lite"; // free tier; see ai.google.dev/gemini-api/docs/models
const REQUEST_TIMEOUT_MS = 30000;
const MAX_CONTEXT_CHARS = 20000;

const SYSTEM_INSTRUCTION =
    "You answer questions about a passage the user highlighted on a web page. " +
    "Use only the highlighted text, not outside knowledge. " +
    "Answer briefly and clearly in plain sentences, without markdown. " +
    "If the highlighted text doesn't contain the answer, say that it doesn't.";

// Thrown for failures the user should see; `message` is shown as is.
class AskError extends Error {}

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
    return new AskError(`Gemini returned an error (${status}${error.message ? `: ${error.message}` : ""}).`);
}

async function ask(question, text) {
    const key = await loadApiKey();
    const passage = text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(GEMINI_URL, {
            method: "POST",
            headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: GEMINI_MODEL,
                system_instruction: SYSTEM_INSTRUCTION,
                input: `Highlighted text:\n"""\n${passage}\n"""\n\nQuestion: ${question}`,
                generation_config: { max_output_tokens: 400, thinking_level: "low" },
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
    return ask(String(request.question || ""), String(request.text || "")).then(
        (answer) => ({ ok: true, answer }),
        (error) => {
            if (!(error instanceof AskError)) console.error("[Listen] Ask failed:", error);
            const message = error instanceof AskError ? error.message : "Something went wrong asking Gemini.";
            return { ok: false, error: message };
        }
    );
});

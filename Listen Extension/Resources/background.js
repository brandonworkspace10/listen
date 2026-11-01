// Listen — background page
// Runs the Kokoro voice engine. Content scripts ask it to split text and turn sentences into audio.

import { KokoroTTS, TextSplitterStream, env } from "./kokoro.web.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";

// Load the ONNX Runtime engine files from the extension bundle instead of a CDN.
env.wasmPaths = new URL("./", import.meta.url).href;

// ---------- Voice engine ----------

let ttsPromise = null;
let generateQueue = Promise.resolve();

// Downloads the model on first use; later loads come from the browser cache.
function loadVoice() {
    if (!ttsPromise) {
        console.info("[Listen] Loading voice; multi-threaded:", self.crossOriginIsolated === true);
        ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "wasm" }).catch((error) => {
            ttsPromise = null; // allow a retry next time
            throw error;
        });
    }
    return ttsPromise;
}

// Splits each block (heading or paragraph) into sentences with Kokoro's own splitter.
function splitSentences(blocks) {
    return blocks.map((block) => {
        const splitter = new TextSplitterStream();
        splitter.push(block);
        splitter.close();
        return splitter.sentences;
    });
}

// Generations run one at a time so the model is never called concurrently.
function generate(text) {
    const job = generateQueue.then(async () => {
        const tts = await loadVoice();
        const audio = await tts.generate(text, { voice: VOICE });
        return { audio: encodePcm16(audio.audio), sampleRate: audio.sampling_rate };
    });
    generateQueue = job.catch(() => {});
    return job;
}

// Float32 samples → 16-bit PCM → base64, so audio passes safely through extension messaging.
function encodePcm16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

// ---------- Messaging ----------

async function handle(request) {
    switch (request.type) {
        case "listen:load":
            await loadVoice();
            return {};
        case "listen:split":
            return { sentences: splitSentences(request.blocks) };
        case "listen:generate":
            return await generate(request.text);
    }
    return null;
}

browser.runtime.onMessage.addListener((request) => {
    if (!request || typeof request.type !== "string" || !request.type.startsWith("listen:")) return;
    return handle(request).then(
        (result) => ({ ok: true, ...result }),
        (error) => {
            console.error("[Listen] Voice engine error:", error);
            return { ok: false, error: String(error && error.message ? error.message : error) };
        }
    );
});

// A content script holds this port open while reading, which keeps this page awake
// during the first model download.
browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "listen-keepalive") port.disconnect();
});

// Listen — background page
// Runs the Kokoro voice engine. Content scripts connect with a port named "listen-engine"
// and send requests ({ id, type, ... }); every request gets exactly one reply ({ id, ok, ... }).

import "./polyfills.js"; // must come before kokoro.web.js
import { KokoroTTS, TextSplitterStream, env } from "./kokoro.web.js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";

// Load the ONNX Runtime engine files from the extension bundle instead of a CDN.
env.wasmPaths = new URL("./", import.meta.url).href;

const ports = new Set();

function post(port, message) {
    try {
        port.postMessage(message);
    } catch (e) {
        ports.delete(port); // the page went away
    }
}

function broadcast(message) {
    for (const port of ports) post(port, message);
}

// ---------- Voice engine ----------

let ttsPromise = null;
let generateQueue = Promise.resolve();
const loggedProgress = new Map(); // file → last logged 10% step

function onProgress(info) {
    if (info.status !== "progress" || !info.total) return;
    const percent = Math.floor(info.progress);
    const step = Math.floor(percent / 10);
    if (loggedProgress.get(info.file) === step) return;
    loggedProgress.set(info.file, step);
    console.info(`[Listen] Downloading ${info.file}: ${percent}%`);
    broadcast({ type: "listen:progress", file: info.file, percent });
}

// Downloads the model on first use; later loads come from the browser cache.
function loadVoice() {
    if (!ttsPromise) {
        const started = performance.now();
        console.info("[Listen] Loading Kokoro voice; multi-threaded:", self.crossOriginIsolated === true);
        ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: "q8",
            device: "wasm",
            progress_callback: onProgress,
        }).then(
            async (tts) => {
                console.info(`[Listen] Kokoro model loaded in ${Math.round(performance.now() - started)} ms; warming up`);
                // The first generation is much slower in Safari; do it here so the first real sentence isn't.
                await tts.generate("Ready.", { voice: VOICE });
                console.info(`[Listen] Kokoro voice ready in ${Math.round(performance.now() - started)} ms`);
                return tts;
            },
            (error) => {
                ttsPromise = null; // allow a retry next time
                throw error;
            }
        );
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
        const started = performance.now();
        const audio = await tts.generate(text, { voice: VOICE });
        const seconds = audio.audio.length / audio.sampling_rate;
        console.info(
            `[Listen] Kokoro generated ${seconds.toFixed(1)} s of audio in ${Math.round(performance.now() - started)} ms`
        );
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
    throw new Error(`Unknown request: ${request.type}`);
}

browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "listen-engine") return;
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));

    port.onMessage.addListener((request) => {
        // Pings only exist to keep this page awake while the content script waits.
        if (!request || request.type === "listen:ping" || request.id === undefined) return;
        handle(request).then(
            (result) => post(port, { id: request.id, ok: true, ...result }),
            (error) => {
                console.error("[Listen] Voice engine error:", error);
                post(port, { id: request.id, ok: false, error: String((error && error.message) || error) });
            }
        );
    });
});

console.info("[Listen] Background page started");

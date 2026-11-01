// Listen — content script
// Phase 3: the “ ” button reads the selected text aloud with the Kokoro voice,
// falling back to the built-in voice if Kokoro can't load.

(() => {
    "use strict";

    // ---------- Speech ----------
    // Interface: speech.speak(text, { onPlaying, onEnd }), speech.stop(), speech.isSpeaking()
    // onPlaying fires when audio actually starts; onEnd fires once when reading finishes or is stopped.

    // Kokoro truncates long input, so sentences longer than this are split at , ; :
    const MAX_CHUNK_LENGTH = 300;

    // Built-in Safari voice (fallback).
    const builtinVoice = (() => {
        let current = null; // { utterance, callbacks }

        function pickEnglishVoice() {
            const voices = window.speechSynthesis.getVoices();
            const english = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
            return english.find((v) => v.default) || english[0] || null;
        }

        function finish(entry) {
            // Ignore events from an utterance that was already replaced or stopped.
            if (current !== entry) return;
            current = null;
            entry.callbacks.onEnd();
        }

        function speak(text, callbacks) {
            stop();

            const utterance = new SpeechSynthesisUtterance(text);
            const voice = pickEnglishVoice();
            if (voice) utterance.voice = voice;
            utterance.lang = voice ? voice.lang : "en-US";

            const entry = { utterance, callbacks };
            utterance.onend = () => finish(entry);
            utterance.onerror = () => finish(entry);

            current = entry;
            window.speechSynthesis.speak(utterance);
            callbacks.onPlaying();
        }

        function stop() {
            const entry = current;
            window.speechSynthesis.cancel();
            // Safari doesn't always fire onend after cancel(), so finish here.
            if (entry) finish(entry);
        }

        return { speak, stop, isSpeaking: () => current !== null };
    })();

    // Connection to the voice engine in the background page. Uses one long-lived port so the
    // background stays awake, and guarantees every request settles: a reply, a disconnect, or a timeout.
    const engine = (() => {
        const DISCONNECTED = "Voice engine disconnected";
        const LOAD_TIMEOUT = 10 * 60 * 1000; // first download can be slow
        const REQUEST_TIMEOUT = 3 * 60 * 1000; // Safari can take tens of seconds per sentence
        const PING_INTERVAL = 10 * 1000;

        let port = null;
        let pingTimer = null;
        let nextId = 1;
        const pending = new Map(); // id → { resolve, reject, timer }

        function rejectAll(message) {
            for (const entry of pending.values()) {
                clearTimeout(entry.timer);
                entry.reject(new Error(message));
            }
            pending.clear();
        }

        function closePort() {
            clearInterval(pingTimer);
            pingTimer = null;
            port = null;
        }

        function onMessage(message) {
            if (message.type === "listen:progress") {
                console.info(`[Listen] Downloading voice (${message.file}): ${message.percent}%`);
                return;
            }
            const entry = pending.get(message.id);
            if (!entry) return;
            pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.ok) entry.resolve(message);
            else entry.reject(new Error(message.error || "Voice engine error"));
        }

        function connect() {
            port = browser.runtime.connect({ name: "listen-engine" });
            port.onMessage.addListener(onMessage);
            port.onDisconnect.addListener(() => {
                closePort();
                rejectAll(DISCONNECTED);
            });
            pingTimer = setInterval(() => {
                try { port.postMessage({ type: "listen:ping" }); } catch (e) {}
            }, PING_INTERVAL);
        }

        function request(message) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                const timeout = message.type === "listen:load" ? LOAD_TIMEOUT : REQUEST_TIMEOUT;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Voice engine timed out (${message.type})`));
                }, timeout);
                pending.set(id, { resolve, reject, timer });
                try {
                    if (!port) connect();
                    port.postMessage({ ...message, id });
                } catch (error) {
                    pending.delete(id);
                    clearTimeout(timer);
                    reject(error);
                }
            });
        }

        // Called when a reading ends, so the background page can go idle.
        function release() {
            const old = port;
            closePort();
            rejectAll("Released");
            try { if (old) old.disconnect(); } catch (e) {}
        }

        return { request, release, DISCONNECTED };
    })();

    // Kokoro voice. The model runs in the background page; audio plays here with Web Audio.
    const kokoroVoice = (() => {
        let current = null; // see speak()

        const send = (message) => engine.request(message);

        // Loads the model, retrying once if Safari unloaded the background page mid-load.
        async function load(isCurrent) {
            try {
                await send({ type: "listen:load" });
            } catch (error) {
                if (!isCurrent() || error.message !== engine.DISCONNECTED) throw error;
                console.warn("[Listen] Voice engine restarted while loading; retrying once.");
                await send({ type: "listen:load" });
            }
        }

        // Splits text into [{ text }] using line breaks for headings/paragraphs and
        // Kokoro's sentence splitter for sentences.
        async function splitIntoSegments(text) {
            const blocks = text.split(/\n+/).map((b) => b.trim()).filter(Boolean);
            const { sentences } = await send({ type: "listen:split", blocks });
            const segments = [];
            for (const blockSentences of sentences) {
                for (const sentence of blockSentences) {
                    for (const chunk of splitLongSentence(sentence)) segments.push({ text: chunk });
                }
            }
            return segments;
        }

        function splitLongSentence(sentence) {
            if (sentence.length <= MAX_CHUNK_LENGTH) return [sentence];
            const parts = sentence.split(/(?<=[,;:])\s+/);
            const chunks = [];
            let chunk = "";
            for (const part of parts) {
                if (chunk && chunk.length + part.length + 1 > MAX_CHUNK_LENGTH) {
                    chunks.push(chunk);
                    chunk = part;
                } else {
                    chunk = chunk ? `${chunk} ${part}` : part;
                }
            }
            if (chunk) chunks.push(chunk);
            return chunks;
        }

        function decodePcm16(base64) {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const pcm = new Int16Array(bytes.buffer);
            const samples = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
            return samples;
        }

        // One AudioContext for the page, unlocked inside the user's click (Safari only plays
        // Web Audio from a context started by a gesture) and kept alive between readings.
        let audioContext = null;

        function unlockAudio() {
            if (!audioContext || audioContext.state === "closed") {
                audioContext = new AudioContext();
                const context = audioContext;
                context.onstatechange = () => console.info("[Listen] AudioContext state changed:", context.state);
            }
            const context = audioContext;
            context.resume().then(
                () => console.info("[Listen] AudioContext resumed:", context.state),
                (error) => console.warn("[Listen] AudioContext resume failed:", error)
            );
            // Playing a tiny silent sound during the click fully unlocks audio in Safari.
            const silence = context.createBufferSource();
            silence.buffer = context.createBuffer(1, 1, context.sampleRate);
            silence.connect(context.destination);
            silence.start();
            console.info(
                `[Listen] AudioContext unlocked in click: state=${context.state}, sampleRate=${context.sampleRate}`
            );
            return context;
        }

        async function ensureRunning(context) {
            if (context.state === "running") return;
            console.warn(`[Listen] AudioContext is "${context.state}"; trying to resume`);
            await Promise.race([context.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
            if (context.state !== "running") {
                throw new Error(`AudioContext is "${context.state}" (Safari blocked audio)`);
            }
        }

        function playSamples(entry, samples, sampleRate) {
            const context = entry.context;
            return new Promise((resolve, reject) => {
                const buffer = context.createBuffer(1, samples.length, sampleRate);
                buffer.copyToChannel(samples, 0);
                const source = context.createBufferSource();
                source.buffer = buffer;
                source.connect(context.destination);
                const startedAt = context.currentTime;

                // Measure the level actually reaching the output, half a second in.
                const analyser = context.createAnalyser();
                analyser.fftSize = 2048;
                source.connect(analyser);
                setTimeout(() => {
                    const data = new Float32Array(analyser.fftSize);
                    analyser.getFloatTimeDomainData(data);
                    let sum = 0;
                    for (const v of data) sum += v * v;
                    console.info(
                        `[Listen] Output level 0.5 s in: RMS ${Math.sqrt(sum / data.length).toFixed(4)} ` +
                        `(clock advanced ${(context.currentTime - startedAt).toFixed(2)} s)`
                    );
                }, Math.min(500, buffer.duration * 500));

                // If the sound never finishes, fail with the reason instead of hanging.
                entry.watchdog = setTimeout(() => {
                    source.onended = null;
                    try { source.stop(); } catch (e) {}
                    entry.source = null;
                    const advanced = (context.currentTime - startedAt).toFixed(2);
                    reject(new Error(
                        `audio did not finish (AudioContext "${context.state}", clock advanced ` +
                        `${advanced} s of ${buffer.duration.toFixed(2)} s)`
                    ));
                }, buffer.duration * 1000 + 3000);

                source.onended = () => {
                    clearTimeout(entry.watchdog);
                    entry.source = null;
                    resolve();
                };
                entry.source = source;
                source.start();
            });
        }

        function finish(entry) {
            if (current !== entry) return;
            current = null;
            clearTimeout(entry.watchdog);
            if (entry.source) {
                entry.source.onended = null;
                try { entry.source.stop(); } catch (e) {}
            }
            // The AudioContext stays open so later readings keep their unlocked audio.
            engine.release();
            entry.callbacks.onEnd();
        }

        // Must be called synchronously from the click handler so the audio unlock counts as a gesture.
        // callbacks.onFail(remainingText) is called instead of onEnd if Kokoro can't continue.
        async function speak(text, callbacks) {
            stop();
            const context = unlockAudio();

            const entry = { context, callbacks, source: null, watchdog: null };
            current = entry;
            const isCurrent = () => current === entry;

            let segments = [{ text }];
            let index = 0;
            let step = "loading the voice";
            try {
                await load(isCurrent);
                if (!isCurrent()) return;

                step = "checking audio";
                await ensureRunning(context);
                if (!isCurrent()) return;

                step = "splitting the text";
                segments = await splitIntoSegments(text);
                if (!isCurrent()) return;
                console.info(`[Listen] Reading with the Kokoro voice: ${segments.length} piece(s)`);

                const request = (i) =>
                    i < segments.length ? send({ type: "listen:generate", text: segments[i].text }) : null;

                let next = request(0);
                for (index = 0; index < segments.length; index++) {
                    const piece = `piece ${index + 1}/${segments.length}`;
                    step = `generating ${piece}`;
                    const { audio, sampleRate } = await next;
                    if (!isCurrent()) return;
                    next = request(index + 1); // prepare the next piece while this one plays
                    if (next) next.catch(() => {}); // handled when awaited

                    step = `playing ${piece}`;
                    await ensureRunning(context);
                    const samples = decodePcm16(audio);
                    let peak = 0;
                    for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
                    console.info(
                        `[Listen] Playing ${piece}: ${(samples.length / sampleRate).toFixed(1)} s at ${sampleRate} Hz, ` +
                        `peak ${peak.toFixed(3)}, AudioContext ${context.state} at ${context.sampleRate} Hz, ` +
                        `clock ${context.currentTime.toFixed(2)} s`
                    );
                    if (index === 0) callbacks.onPlaying();
                    await playSamples(entry, samples, sampleRate);
                    if (!isCurrent()) return;
                }
                console.info("[Listen] Finished reading with the Kokoro voice");
                finish(entry);
            } catch (error) {
                if (!isCurrent()) return;
                const reason = (error && error.message) || String(error);
                console.warn(
                    `[Listen] Kokoro voice failed while ${step}: ${reason} ` +
                    `(AudioContext ${context.state}). Using the built-in voice.`
                );
                const remaining = segments.slice(index).map((s) => s.text).join(" ");
                // Hand over without calling onEnd, so the reading continues seamlessly.
                entry.callbacks = { onEnd() {} };
                finish(entry);
                callbacks.onFail(remaining);
            }
        }

        function stop() {
            if (current) finish(current);
        }

        return { speak, stop, isSpeaking: () => current !== null };
    })();

    const speech = (() => {
        function speak(text, callbacks) {
            stop();
            kokoroVoice.speak(text, {
                ...callbacks,
                onFail(remaining) {
                    if (remaining) builtinVoice.speak(remaining, callbacks);
                    else callbacks.onEnd();
                },
            });
        }

        function stop() {
            kokoroVoice.stop();
            builtinVoice.stop();
        }

        function isSpeaking() {
            return kokoroVoice.isSpeaking() || builtinVoice.isSpeaking();
        }

        return { speak, stop, isSpeaking };
    })();

    // ---------- Reading ----------

    let readingState = null; // null | "loading" | "playing"

    // Called when the user clicks the button.
    function onListen(text) {
        speech.speak(text, { onPlaying: onReadingPlaying, onEnd: onReadingEnded });
        readingState = "loading";
        setButtonIcon("loading");
    }

    function onReadingPlaying() {
        readingState = "playing";
        // Don't replace a fresh “ ” shown for a newer selection.
        if (buttonIcon !== "listen") setButtonIcon("stop");
    }

    function onReadingEnded() {
        readingState = null;
        setButtonIcon("listen");
        // If the selection is gone by the time reading ends, the button has nothing left to do.
        if (!readSelection()) hideButton();
    }

    function readingIcon() {
        return readingState === "loading" ? "loading" : "stop";
    }

    // ---------- Button (isolated in a Shadow DOM so host page CSS can't touch it) ----------

    const BUTTON_SIZE = 30;
    const OFFSET = 6;

    const ICONS = {
        listen: { text: "“”", label: "Read selected text aloud", title: "Listen" },
        loading: { text: "", label: "Loading voice — click to cancel", title: "Loading voice…" },
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
        button.loading { padding-top: 0; }
        button.loading::after {
            content: "";
            box-sizing: border-box;
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: #ffffff;
            border-radius: 50%;
            animation: listen-spin 0.8s linear infinite;
        }
        @keyframes listen-spin { to { transform: rotate(360deg); } }
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
            if (buttonIcon !== "listen") {
                speech.stop(); // stop or cancel loading
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
        button.classList.toggle("loading", buttonIcon === "loading");
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
            setButtonIcon(readingIcon());
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

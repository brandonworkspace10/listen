// Listen — content scripts, 2 of 10: speaking with the Mac's built-in voices (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;

    // ---------- Speech (swap this section out for a better voice later) ----------
    // Interface: speech.speak(text, { onWord, onWordTimingUnavailable, onEnd }, lang), speech.stop(),
    // speech.isSpeaking(), speech.setRate(rate), speech.setVoice(voiceURI). `lang` is a BCP 47 tag ("es",
    // "pt-BR"); the voice chosen with setVoice() is used if it speaks that language, otherwise the best
    // installed voice for it, or English if there is none. onWord(charIndex, charLength)
    // gives the position in `text` of the word being spoken (charLength may be 0); onEnd fires once
    // when reading finishes or is stopped.

    const speech = (() => {
        // Novelty voices macOS ships alongside the real ones; never pick these.
        const NOVELTY_VOICES = new Set([
            "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News",
            "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
        ]);

        // Older robotic-sounding voices; only used if nothing better is installed.
        const LOW_QUALITY_VOICES = new Set([
            "Eddy", "Flo", "Fred", "Grandma", "Grandpa", "Junior", "Kathy", "Ralph", "Reed",
            "Rocko", "Sandy", "Shelley",
        ]);

        let current = null; // the reading in progress; see speak()
        let preferredVoice = ""; // voiceURI chosen in the popup; "" = best available

        // "Eddy (English (US))" → "Eddy"
        function baseName(voice) {
            return voice.name.replace(/\s*\(.*\)$/, "");
        }

        // "pt_BR" / "PT-br" → "pt-br"
        function normalizeLang(lang) {
            return lang.replace("_", "-").toLowerCase();
        }

        // Higher is better: Premium > Enhanced > Siri > system default > other > low quality.
        // Within a tier, prefer the exact region asked for, then the user's own region.
        function rank(voice, lang) {
            const id = `${voice.name} ${voice.voiceURI}`.toLowerCase();
            let score = 0;
            if (id.includes("premium")) score = 4;
            else if (id.includes("enhanced")) score = 3;
            else if (id.includes("siri")) score = 2;
            else if (voice.default) score = 1;
            else if (LOW_QUALITY_VOICES.has(baseName(voice))) score = -1;
            const voiceLang = normalizeLang(voice.lang);
            if (voiceLang === normalizeLang(lang)) score += 0.2;
            else if (voiceLang === normalizeLang(navigator.language)) score += 0.15;
            else if (voiceLang === "en-us") score += 0.1;
            return score;
        }

        // The chosen voice if it speaks `lang`, else the best installed voice for `lang` ("es", "es-MX"),
        // or null if no voice speaks that language.
        function pickVoice(lang) {
            const primary = normalizeLang(lang).split("-")[0];
            const voices = window.speechSynthesis
                .getVoices()
                .filter((v) => v.lang && normalizeLang(v.lang).split("-")[0] === primary)
                .filter((v) => !NOVELTY_VOICES.has(baseName(v)));
            if (voices.length === 0) return null;
            const chosen = preferredVoice && voices.find((v) => v.voiceURI === preferredVoice);
            if (chosen) return chosen;
            return voices.reduce((a, b) => (rank(b, lang) > rank(a, lang) ? b : a));
        }

        // Safari loads the voice list lazily; ask for it early so it's ready by the first click.
        window.speechSynthesis.getVoices();

        // How long after speech starts to wait for the first word position before giving up on it.
        const WORD_TIMING_GRACE_MS = 2000;

        let rate = 1;

        function finish(entry) {
            // Ignore events from an utterance that was already replaced or stopped.
            if (current !== entry) return;
            current = null;
            clearTimeout(entry.wordTimingCheck);
            entry.callbacks.onEnd();
        }

        // Speaks entry.text from character `from` at the current rate. Word positions are reported
        // relative to the whole text, so a restart mid-text keeps the highlight in sync.
        function startUtterance(entry, from) {
            const utterance = new SpeechSynthesisUtterance(entry.text.slice(from));
            if (entry.voice) utterance.voice = entry.voice;
            utterance.lang = entry.voice ? entry.voice.lang : entry.lang;
            utterance.rate = rate;

            // Events from an utterance replaced by a speed change are ignored.
            const isLive = () => current === entry && entry.utterance === utterance;
            utterance.onend = () => isLive() && finish(entry);
            utterance.onerror = () => isLive() && finish(entry);

            // Word positions come from "boundary" events; some voices never send them.
            utterance.onboundary = (event) => {
                if (!isLive() || (event.name && event.name !== "word")) return;
                entry.sawWord = true;
                entry.wordStart = from + event.charIndex;
                entry.callbacks.onWord(entry.wordStart, event.charLength || 0);
            };
            utterance.onstart = () => {
                if (entry.sawWord || entry.wordTimingCheck) return;
                entry.wordTimingCheck = setTimeout(() => {
                    if (current !== entry || entry.sawWord) return;
                    const name = entry.voice ? entry.voice.name : "This voice";
                    L.debug(`${name} doesn't report word positions, so words won't be highlighted.`);
                    entry.callbacks.onWordTimingUnavailable();
                }, WORD_TIMING_GRACE_MS);
            };

            entry.utterance = utterance;
            window.speechSynthesis.speak(utterance);
        }

        function speak(text, callbacks, lang = "en") {
            stop();
            let voice = pickVoice(lang);
            if (!voice && normalizeLang(lang).split("-")[0] !== "en") {
                L.debug(`No installed voice for "${lang}"; falling back to English.`);
                lang = "en";
                voice = pickVoice(lang);
            }
            L.debug(`Detected language: ${lang}, voice: ${voice ? `${voice.name} (${voice.lang})` : "system default"}`);
            const entry = {
                text, callbacks, lang, voice, utterance: null, wordStart: 0, sawWord: false, wordTimingCheck: null,
            };
            current = entry;
            startUtterance(entry, 0);
        }

        // Changes the speaking rate (1 = normal). speechSynthesis can't change the rate of an
        // utterance in progress, so a reading in progress restarts from the word being spoken.
        function setRate(newRate) {
            rate = newRate;
            const entry = current;
            if (!entry) return;
            entry.utterance = null; // silences the old utterance's events
            window.speechSynthesis.cancel();
            startUtterance(entry, entry.wordStart);
        }

        function stop() {
            const entry = current;
            window.speechSynthesis.cancel();
            // Safari doesn't always fire onend after cancel(), so finish here.
            if (entry) finish(entry);
        }

        function isSpeaking() {
            return current !== null;
        }

        // Used from the next reading on.
        function setVoice(voiceURI) {
            preferredVoice = voiceURI || "";
        }

        // Installed voices for the Mac's language, best first, as { uri, label } such as "Ava (Premium, US)".
        function voiceChoices() {
            const mine = navigator.language || "en";
            return window.speechSynthesis
                .getVoices()
                .filter((v) => v.lang && normalizeLang(v.lang).split("-")[0] === normalizeLang(mine).split("-")[0])
                .filter((v) => !NOVELTY_VOICES.has(baseName(v)))
                .sort((a, b) => rank(b, mine) - rank(a, mine) || a.name.localeCompare(b.name))
                .map((v) => {
                    const id = `${v.name} ${v.voiceURI}`.toLowerCase();
                    const quality = id.includes("premium") ? "Premium" : id.includes("enhanced") ? "Enhanced" : "";
                    const region = normalizeLang(v.lang).split("-")[1];
                    const details = [quality, region && region.toUpperCase()].filter(Boolean).join(", ");
                    return { uri: v.voiceURI, label: details ? `${baseName(v)} (${details})` : baseName(v) };
                });
        }

        return { speak, stop, isSpeaking, setRate, setVoice, voiceChoices };
    })();

    // For the other content scripts.
    Object.assign(L, { speech });
})();

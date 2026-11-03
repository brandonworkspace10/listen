// Listen — content scripts, 3 of 10: which language the text is in (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;

    // ---------- Language ----------
    // Interface: language.prepare(text) starts the text check early (when text is selected), since
    // browser.i18n.detectLanguage is asynchronous and speech must start inside the click;
    // language.detect(range, text) → BCP 47 tag, decided synchronously when reading starts.

    const language = (() => {
        const canDetect =
            typeof browser !== "undefined" && browser.i18n && typeof browser.i18n.detectLanguage === "function";
        const results = new Map(); // text → { lang, reliable } from browser.i18n.detectLanguage, or null while pending
        const MAX_CACHED = 20;

        // Writing systems that identify a language on their own (checked in order).
        const SCRIPTS = [
            ["ko", /\p{Script=Hangul}/u],
            ["ja", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
            ["zh", /\p{Script=Han}/u],
            ["ru", /\p{Script=Cyrillic}/u],
            ["el", /\p{Script=Greek}/u],
            ["ar", /\p{Script=Arabic}/u],
            ["he", /\p{Script=Hebrew}/u],
            ["th", /\p{Script=Thai}/u],
            ["hi", /\p{Script=Devanagari}/u],
        ];

        // Common short words that tell Latin-script languages apart.
        const COMMON_WORDS = {
            en: "the and is of to in that it with for this was are on you have be not",
            es: "el la los las de que y en un una es por con para del se no su al lo como más",
            fr: "le la les des et est un une du que en pour dans pas qui sur au avec ce il",
            de: "der die das und ist nicht ein eine zu den mit sich des auf für im dem von auch",
            it: "il lo la gli di che e è un una per non con del della sono nel anche si",
            pt: "o a os as de que e é um uma do da em para não com por se mais dos",
            nl: "de het een en van is dat niet op te voor met zijn ook aan maar",
        };
        const WORD_SETS = Object.fromEntries(
            Object.entries(COMMON_WORDS).map(([lang, words]) => [lang, new Set(words.split(" "))])
        );

        // Lightweight check: a dominant non-Latin script, or clearly more common words of one language.
        function quickGuess(text) {
            const letters = [...text].filter((c) => /\p{L}/u.test(c));
            if (letters.length === 0) return null;
            for (const [lang, pattern] of SCRIPTS) {
                if (letters.filter((c) => pattern.test(c)).length / letters.length > 0.3) return lang;
            }
            const words = text.toLowerCase().match(/\p{L}+/gu) || [];
            const scores = Object.entries(WORD_SETS)
                .map(([lang, set]) => [lang, words.filter((w) => set.has(w)).length])
                .sort((a, b) => b[1] - a[1]);
            const [[best, bestScore], [, secondScore]] = scores;
            return bestScore >= 3 && bestScore >= secondScore * 1.5 ? best : null;
        }

        function prepare(text) {
            if (!canDetect || !text || results.has(text)) return;
            results.set(text, null);
            if (results.size > MAX_CACHED) results.delete(results.keys().next().value);
            browser.i18n.detectLanguage(text.slice(0, 2000)).then(
                (result) => {
                    const top = result && result.languages && result.languages[0];
                    results.set(text, top ? { lang: top.language, reliable: Boolean(result.isReliable) } : { lang: "und" });
                },
                () => results.set(text, { lang: "und" })
            );
        }

        // Nearest lang attribute around the text, else the page's.
        function fromAttribute(range) {
            const node = range && range.startContainer;
            const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
            const tagged = el && el.closest("[lang]");
            return ((tagged && tagged.getAttribute("lang")) || document.documentElement.lang || "").trim();
        }

        // The language the text itself is in, or null if unsure.
        function fromText(text) {
            const result = results.get(text);
            if (result && result.reliable && result.lang !== "und") {
                return { lang: result.lang, how: "browser.i18n.detectLanguage" };
            }
            const guess = quickGuess(text);
            return guess ? { lang: guess, how: "word check" } : null;
        }

        function detect(range, text) {
            const attribute = fromAttribute(range);
            const textual = fromText(text);
            const primary = (lang) => lang.toLowerCase().split(/[-_]/)[0];
            let lang;
            if (textual && (!attribute || primary(attribute) !== primary(textual.lang))) {
                lang = textual.lang; // the text wins when they disagree
            } else {
                lang = attribute || (textual && textual.lang) || "en";
            }
            L.debug(
                `Language check: lang attribute "${attribute || "none"}", ` +
                `text ${textual ? `"${textual.lang}" (${textual.how})` : "unsure"} → ${lang}`
            );
            return lang;
        }

        return { prepare, detect };
    })();

    // For the other content scripts.
    Object.assign(L, { language });
})();

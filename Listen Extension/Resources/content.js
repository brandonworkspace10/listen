// Listen — content script
// The speaker button reads the selected text aloud with the best installed built-in voice,
// highlighting each word on the page as it's spoken.

(() => {
    "use strict";

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
                    console.info(`[Listen] ${name} doesn't report word positions, so words won't be highlighted.`);
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
                console.info(`[Listen] No installed voice for "${lang}"; falling back to English.`);
                lang = "en";
                voice = pickVoice(lang);
            }
            console.info(`[Listen] Detected language: ${lang}, voice: ${voice ? `${voice.name} (${voice.lang})` : "system default"}`);
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
            console.info(
                `[Listen] Language check: lang attribute "${attribute || "none"}", ` +
                `text ${textual ? `"${textual.lang}" (${textual.how})` : "unsure"} → ${lang}`
            );
            return lang;
        }

        return { prepare, detect };
    })();

    // ---------- Maths ----------
    // Equations are read the way a person says them ("x squared plus 2 x equals 10"). The spoken form is
    // made here from the equation's MathML (MathML, MathJax, KaTeX and Wikipedia all include it); only
    // equations too complex for that (matrices, unknown markup) or with nothing but TeX are spoken by
    // Gemini, through background.js. Maths symbols in ordinary text (², √, ≤ …) are said in words too.

    // Outermost elements that hold one equation.
    const MATH_SELECTOR = ".mwe-math-element, mjx-container, .MathJax, .MathJax_Display, .katex-display, .katex, math";
    const MATH_HELP_TIMEOUT_MS = 30000;

    const MATH_OPERATORS = {
        "+": "plus", "-": "minus", "−": "minus", "=": "equals", "≠": "is not equal to",
        "<": "is less than", ">": "is greater than", "≤": "is less than or equal to",
        "≥": "is greater than or equal to", "≈": "is approximately equal to", "≡": "is equivalent to",
        "×": "times", "⋅": "times", "·": "times", "∗": "times", "÷": "divided by", "/": "over",
        "±": "plus or minus", "∓": "minus or plus", "→": "tends to", "⇒": "implies",
        "⇔": "if and only if", "∈": "is in", "∉": "is not in", "⊂": "is a subset of",
        "∪": "union", "∩": "intersection", "∞": "infinity", "!": "factorial", "′": "prime",
        "″": "double prime", "∝": "is proportional to", "∠": "angle", "°": "degrees", "%": "percent",
        "∑": "the sum of", "∏": "the product of", "∫": "the integral of", "∮": "the contour integral of",
        "∂": "partial", "∇": "del", "|": "", "(": "", ")": "", "[": "", "]": "", "{": "", "}": "",
        "⟨": "", "⟩": "", ",": ",", ";": ";", ":": "", ".": "",
        "⁡": "of", "⁢": "", "⁣": ",", "⁤": "plus",
    };
    const MATH_LETTERS = {
        "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ϵ": "epsilon",
        "ζ": "zeta", "η": "eta", "θ": "theta", "ι": "iota", "κ": "kappa", "λ": "lambda",
        "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ρ": "rho", "σ": "sigma", "τ": "tau",
        "υ": "upsilon", "φ": "phi", "ϕ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega",
        "Γ": "capital gamma", "Δ": "capital delta", "Θ": "capital theta", "Λ": "capital lambda",
        "Π": "capital pi", "Σ": "capital sigma", "Φ": "capital phi", "Ψ": "capital psi",
        "Ω": "capital omega", "ℝ": "the real numbers", "ℕ": "the natural numbers",
        "ℤ": "the integers", "ℚ": "the rational numbers", "ℂ": "the complex numbers",
    };
    const MATH_FUNCTIONS = {
        sin: "sine", cos: "cosine", tan: "tangent", sec: "secant", csc: "cosecant", cot: "cotangent",
        arcsin: "arc sine", arccos: "arc cosine", arctan: "arc tangent", sinh: "hyperbolic sine",
        cosh: "hyperbolic cosine", tanh: "hyperbolic tangent", log: "log", ln: "natural log", lim: "the limit",
        det: "determinant", exp: "exp", max: "max", min: "min", sup: "supremum", inf: "infimum",
    };
    const BIG_OPERATORS = { "∑": "the sum", "∏": "the product", "∫": "the integral", "∮": "the contour integral" };
    const ACCENTS = {
        "¯": "bar", "‾": "bar", "^": "hat", "ˆ": "hat", "~": "tilde", "˜": "tilde",
        "˙": "dot", "¨": "double dot", "→": "vector", "⃗": "vector",
    };
    // Maths symbols in ordinary text, said in words.
    const SPOKEN_SYMBOLS = {
        "²": "squared", "³": "cubed", "√": "the square root of", "∑": "the sum of",
        "∫": "the integral of", "π": "pi", "≤": "is less than or equal to",
        "≥": "is greater than or equal to", "≠": "is not equal to", "≈": "is approximately equal to",
        "±": "plus or minus", "×": "times", "÷": "divided by", "∞": "infinity", "−": "minus",
        "½": "one half", "¼": "one quarter", "¾": "three quarters", "⅓": "one third",
        "⅔": "two thirds", "∂": "partial", "→": "tends to", "∈": "is in",
    };
    const SUPERSCRIPT_DIGITS = { "⁰": "0", "¹": "1", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "ⁿ": "n" };
    const MATH_TEXT_HINT = /[²³√∑∫∏π≤≥≠≈±÷∞∂½¼¾⅓⅔]/;

    const mathCache = new WeakMap(); // equation element → { local: { text, complete }, helped?: string }

    function mathContainerOf(node) {
        let el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        let found = null;
        while (el && (el = el.closest(MATH_SELECTOR))) {
            found = el;
            el = el.parentElement;
        }
        return found;
    }

    // The words for one text-ish MathML token.
    function tokenWords(text, operator) {
        const t = text.trim();
        if (operator && t in MATH_OPERATORS) return MATH_OPERATORS[t];
        if (t in MATH_LETTERS) return MATH_LETTERS[t];
        if (t in MATH_FUNCTIONS) return MATH_FUNCTIONS[t];
        return [...t].map((ch) => MATH_LETTERS[ch] || MATH_OPERATORS[ch] || ch).join(t.length > 1 && /\W/.test(t) ? " " : "");
    }

    // Converts presentation MathML to words. `complete` is false when it met markup it can't say well.
    function mathmlToSpeech(math) {
        let complete = true;
        const isSimple = (words) => !/\s/.test(words.trim());
        const bigOperator = (el) => {
            const t = el && el.textContent.trim();
            if (t in BIG_OPERATORS) return BIG_OPERATORS[t];
            return t === "lim" ? "the limit" : null;
        };
        const OPENERS = { "(": ")", "[": "]", "{": "}" };
        const isOperand = (el) => el && el.localName !== "mo";
        // Says a row of siblings. A bracketed group with an operator inside is read as "the quantity …,"
        // (with "times" when it follows a term), like "n times the quantity n plus 1"; simple ones are silent.
        const sayRow = (kids) => {
            const parts = [];
            for (let i = 0; i < kids.length; i++) {
                const kid = kids[i];
                const close = kid.localName === "mo" && OPENERS[kid.textContent.trim()];
                if (close) {
                    let depth = 0;
                    let j = i;
                    for (; j < kids.length; j++) {
                        const t = kids[j].localName === "mo" ? kids[j].textContent.trim() : "";
                        if (t === kid.textContent.trim()) depth++;
                        else if (t === close && --depth === 0) break;
                    }
                    if (j < kids.length) {
                        const inner = sayRow(kids.slice(i + 1, j));
                        if (/\s/.test(inner)) {
                            parts.push(`${isOperand(kids[i - 1]) || (kids[i - 1] && kids[i - 1].textContent.trim() === ")") ? "times " : ""}the quantity ${inner},`);
                        } else {
                            parts.push(inner);
                        }
                        i = j;
                        continue;
                    }
                }
                parts.push(say(kid));
            }
            return parts.filter(Boolean).join(" ");
        };
        const say = (node) => {
            if (node.nodeType === Node.TEXT_NODE) return node.data.trim();
            if (node.nodeType !== Node.ELEMENT_NODE) return "";
            const kids = [...node.children];
            const all = () => sayRow(kids);
            switch (node.localName) {
                case "math": case "mrow": case "mstyle": case "mpadded": case "merror": case "mfenced":
                case "menclose": case "mtd": case "mlabeledtr":
                    return all();
                case "semantics":
                    return kids.length ? say(kids[0]) : "";
                case "annotation": case "annotation-xml": case "mspace": case "mphantom": case "none": case "mprescripts":
                    return "";
                case "mi": case "mtext": case "ms":
                    return tokenWords(node.textContent, false);
                case "mn":
                    return node.textContent.trim();
                case "mo":
                    return tokenWords(node.textContent, true);
                case "msup": {
                    const [base, exp] = kids.map(say);
                    const e = (exp || "").trim();
                    if (e === "2") return `${base} squared`;
                    if (e === "3") return `${base} cubed`;
                    if (e === "prime" || e === "double prime") return `${base} ${e}`;
                    return `${base} to the power of ${e}${isSimple(e) ? "" : ","}`;
                }
                case "msub":
                    return `${say(kids[0])} sub ${say(kids[1])}`;
                case "msubsup": case "munderover": {
                    const op = bigOperator(kids[0]);
                    if (op) return `${op} from ${say(kids[1])} to ${say(kids[2])} of`;
                    return `${say(kids[0])} sub ${say(kids[1])} to the power of ${say(kids[2])}`;
                }
                case "munder": {
                    const op = bigOperator(kids[0]);
                    if (op === "the limit") return `the limit as ${say(kids[1])} of`;
                    if (op) return `${op} over ${say(kids[1])} of`;
                    return `${say(kids[0])} under ${say(kids[1])}`;
                }
                case "mover": {
                    const accent = kids[1] && ACCENTS[kids[1].textContent.trim()];
                    if (accent === "vector") return `vector ${say(kids[0])}`;
                    if (accent) return `${say(kids[0])} ${accent}`;
                    return `${say(kids[0])} with ${say(kids[1])} above`;
                }
                case "mfrac": {
                    const [n, d] = kids.map(say);
                    return isSimple(n) && isSimple(d) ? `${n} over ${d}` : `the fraction ${n}, over ${d}, end fraction`;
                }
                case "msqrt":
                    return `the square root of ${all()}${kids.length > 1 ? ", end root" : ""}`;
                case "mroot": {
                    const index = say(kids[1]).trim();
                    const name = index === "3" ? "cube" : index === "2" ? "square" : `${index}th`;
                    return `the ${name} root of ${say(kids[0])}`;
                }
                default: // tables (matrices), multiscripts and anything unknown
                    complete = false;
                    return all();
            }
        };
        const text = say(math).replace(/\s+/g, " ").replace(/\s+([,;])/g, "$1").replace(/,+/g, ",").trim();
        return { text, complete: complete && Boolean(text) };
    }

    // The part of an equation that's actually drawn (rendered MathML, fallback image, KaTeX or MathJax
    // output), for outlining it. Wrappers can be taller than the equation, e.g. an inline span around a
    // displayed equation.
    function mathOutlineTarget(container) {
        let best = null;
        let bestArea = 0;
        for (const el of container.querySelectorAll("math, img, svg, mjx-math, .katex-html")) {
            const rect = el.getBoundingClientRect();
            if (rect.width * rect.height > bestArea) {
                best = el;
                bestArea = rect.width * rect.height;
            }
        }
        return best || container;
    }

    // The equation's TeX source, if the page includes it.
    function texOf(container) {
        const annotation = container.querySelector("annotation[encoding='application/x-tex']");
        const math = container.localName === "math" ? container : container.querySelector("math");
        const img = container.querySelector("img[alt]");
        const script = container.parentElement && container.parentElement.querySelector("script[type^='math/tex']");
        const tex = (annotation && annotation.textContent) || (math && math.getAttribute("alttext")) ||
            (img && img.getAttribute("alt")) || container.getAttribute("aria-label") || (script && script.textContent) || "";
        return tex.trim().replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1").trim();
    }

    function localMath(container) {
        let entry = mathCache.get(container);
        if (!entry) {
            const math = container.localName === "math" ? container : container.querySelector("math");
            entry = { local: math ? mathmlToSpeech(math) : { text: "", complete: false } };
            mathCache.set(container, entry);
        }
        return entry;
    }

    // Words for an equation: from its MathML, or from Gemini when prepareMath() asked for help.
    function mathSpeech(container) {
        const entry = localMath(container);
        return entry.helped || entry.local.text || texOf(container) || "an equation";
    }

    function mathContainersIn(range) {
        const root = range.commonAncestorContainer;
        const rootEl = root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement;
        const outer = mathContainerOf(rootEl);
        if (outer) return [outer];
        return [...rootEl.querySelectorAll(MATH_SELECTOR)].filter((el) => !mathContainerOf(el.parentElement) && range.intersectsNode(el));
    }

    // Equations in `range` that can't be said from their MathML and haven't been sent to Gemini yet.
    function mathNeedingHelp(range) {
        return mathContainersIn(range).filter((el) => {
            const entry = localMath(el);
            return !entry.local.complete && entry.helped === undefined;
        });
    }

    // Asks Gemini how to say the equations that mathNeedingHelp() found.
    async function prepareMath(containers) {
        await Promise.all(containers.slice(0, 8).map(async (el) => {
            const entry = localMath(el);
            const source = texOf(el) || (el.querySelector("math") || el).outerHTML.slice(0, 4000);
            const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false }), MATH_HELP_TIMEOUT_MS));
            const response = await Promise.race([askBackground({ action: "speak", math: { text: source } }), timeout]);
            entry.helped = response.ok ? response.answer : ""; // "" = asked, use the local words or TeX
        }));
    }

    // Rendered equations big enough to be worth a hover bar (not every inline "x").
    function isHoverableMath(container) {
        const rect = mathOutlineTarget(container).getBoundingClientRect();
        return rect.width >= 60 && rect.height >= 12;
    }

    // Reads one hovered or clicked equation, outlining it; asks Gemini first if its MathML isn't enough.
    async function onListenMath(container) {
        const entry = localMath(container);
        if (!entry.local.complete && entry.helped === undefined) {
            const id = ++imageRequest;
            imageBusy = true;
            setButtonIcon("loading");
            showNote("Working out how to say the maths…", "info");
            await prepareMath([container]);
            if (id !== imageRequest) return; // cancelled
            imageBusy = false;
            if (note) note.hidden = true;
        }
        readAbout(mathOutlineTarget(container), mathSpeech(container));
    }

    // The selection as text for Gemini, with each equation replaced by its TeX (or spoken form).
    function mathContext(range) {
        const fragment = range.cloneContents();
        const originals = mathContainersIn(range);
        [...fragment.querySelectorAll(MATH_SELECTOR)].filter((el) => !mathContainerOf(el.parentElement)).forEach((el, i) => {
            const source = texOf(el) || (originals[i] ? mathSpeech(originals[i]) : el.textContent);
            el.replaceWith(document.createTextNode(` ${source} `));
        });
        return fragment.textContent.replace(/\s+/g, " ").trim();
    }

    function rangeHasMath(range, text) {
        return Boolean(range && mathContainersIn(range).length) || MATH_TEXT_HINT.test(text);
    }

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
                const words = SPOKEN_SYMBOLS[data[i]] || (SUPERSCRIPT_DIGITS[data[i]] && `to the power of ${SUPERSCRIPT_DIGITS[data[i]]}`);
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
                    if (node.matches(MATH_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
                    return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                },
            });
            let doneMath = null;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (doneMath && doneMath.contains(node)) continue;
                if (node.nodeType === Node.ELEMENT_NODE && node.matches(MATH_SELECTOR)) {
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
            const box = mathOutlineTarget(container);
            for (const ch of mathSpeech(container)) {
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
            const enclosingMath = mathContainerOf(rootEl);
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
                        if (node.matches(MATH_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
                        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                    },
                }
            );

            let lastBlock = null;
            let done = null; // a table or equation already read; its contents are skipped
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (done && done.contains(node)) continue;
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.matches(MATH_SELECTOR)) {
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

    // ---------- Reading ----------

    let lastReadText = ""; // the page text being (or last) read, for the chat box while reading
    let lastReadRange = null;
    let readingAnswer = null; // the chat answer being read aloud, if any

    // Reads `range` aloud with word highlighting; `text` is the fallback if it can't be mapped.
    async function read(range, text, isAnswer) {
        speech.stop(); // end any current reading (and its highlights) before preparing the new one
        const hard = range ? mathNeedingHelp(range) : [];
        if (hard.length) {
            const id = ++imageRequest;
            imageBusy = true;
            setButtonIcon("loading");
            if (barShadow) showNote("Working out how to say the maths…", "info");
            await prepareMath(hard);
            if (id !== imageRequest) return; // cancelled
            imageBusy = false;
            if (note) note.hidden = true;
        }
        const lang = language.detect(range, text);
        const spoken = (range && highlighter.prepare(range)) || text;
        speech.speak(
            spoken,
            { onWord: highlighter.showWord, onWordTimingUnavailable: highlighter.clear, onEnd: onReadingEnded },
            lang
        );
        readingAnswer = isAnswer || null;
        updateSpeakButtons();
        setButtonIcon("stop");
    }

    // Called when the user clicks the speaker button.
    function onListen() {
        const range = selectedRange;
        const codeBlock = selectedCodeBlock;
        if (codeBlock && settings.aiFeatures) {
            onListenCode(selectedText, codeBlock); // see Code
            return;
        }
        lastReadText = selectedText;
        lastReadRange = range;
        read(range, selectedText, false);
        // Clear the blue selection so it doesn't cover the word highlights.
        if (range) window.getSelection().removeAllRanges();
    }

    // Reads `text` about `element` (an image) aloud, framing the element instead of highlighting words.
    function readAbout(element, text) {
        speech.stop();
        const lang = language.detect(null, text);
        highlighter.outline(element);
        speech.speak(text, { onWord() {}, onWordTimingUnavailable() {}, onEnd: onReadingEnded }, lang);
        readingAnswer = null;
        updateSpeakButtons();
        setButtonIcon("stop");
    }

    function onReadingEnded() {
        highlighter.clear();
        readingAnswer = null;
        updateSpeakButtons();
        setButtonIcon("listen");
        // If nothing is selected or hovered by the time reading ends, the bar has nothing left to do.
        if (!readSelection() && !(imageTarget && imageTarget.matches(":hover"))) hideBar();
    }

    // ---------- Floating bar (isolated in a Shadow DOM so host page CSS can't touch it) ----------
    // A row of buttons: speaker (listen / stop), speed and chat (attaches the selection to the chat; see Chat).

    const BUTTON_SIZE = 30;
    const OFFSET = 6;
    const ASK_PANEL_WIDTH = 320; // the note under the bar

    const ICONS = {
        listen: { svg: "speaker", label: "Read selected text aloud", title: "Listen" },
        stop: { text: "■", label: "Stop reading", title: "Stop" },
        loading: { text: "", label: "Describing the image. Click to cancel.", title: "Describing image…" },
    };

    // Line icons (24×24 grid), drawn in the button's text colour.
    const SVG_NS = "http://www.w3.org/2000/svg";
    const SVG_SHAPES = {
        speaker: [
            ["path", { d: "M11 5 6 9H3v6h3l5 4z", fill: "currentColor" }],
            ["path", { d: "M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9.2 9.2 0 0 1 0 13" }],
        ],
        chat: [["path", { d: "M20 11.5a7.5 7.5 0 0 1-11.2 6.5L4 19.5l1.5-4.3A7.5 7.5 0 1 1 20 11.5z" }]],
        copy: [
            ["rect", { x: "9", y: "9", width: "11", height: "11", rx: "2" }],
            ["path", { d: "M5 15V6a2 2 0 0 1 2-2h8" }],
        ],
        check: [["path", { d: "M5 12.5l4.5 4.5L19 7.5" }]],
        gear: [
            ["circle", { cx: "12", cy: "12", r: "3" }],
            ["path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" }],
        ],
    };

    // Built with DOM calls rather than innerHTML, which pages using Trusted Types (Gmail) refuse.
    function svgIcon(name, size) {
        const svg = document.createElementNS(SVG_NS, "svg");
        const attrs = {
            viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor",
            "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
        };
        for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, String(value));
        for (const [tag, shapeAttrs] of SVG_SHAPES[name]) {
            const shape = document.createElementNS(SVG_NS, tag);
            for (const [key, value] of Object.entries(shapeAttrs)) shape.setAttribute(key, value);
            svg.append(shape);
        }
        return svg;
    }

    const BAR_CSS = `
        :host { all: initial; }
        .bar {
            display: flex;
            align-items: center;
            gap: 6px;
        }
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
            font: 400 14px/1 -apple-system, "Helvetica Neue", sans-serif;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
            user-select: none;
            -webkit-user-select: none;
            transition: transform 0.1s ease;
        }
        button svg { display: block; flex: none; }
        /* Fixed width (fits "1.25x") so the button doesn't move under the pointer as the label changes. */
        button.speed {
            width: 54px;
            padding: 0;
            border-radius: ${BUTTON_SIZE / 2}px;
            font: 600 13px/1 -apple-system, "Helvetica Neue", sans-serif;
            font-variant-numeric: tabular-nums;
        }
        button:hover { transform: scale(1.08); }
        button:active { transform: scale(0.95); }
        button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
        button:disabled { opacity: 0.4; cursor: default; transform: none; }
        button[hidden] { display: none; }

        .ask-row { display: flex; gap: 6px; align-items: center; }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
        button.chip {
            flex: 1 0 auto;
            width: auto;
            height: 24px;
            padding: 0 9px;
            white-space: nowrap;
            border-radius: 12px;
            background: #f2f2f7;
            color: #1c1c1e;
            font: 500 12px/1 -apple-system, "Helvetica Neue", sans-serif;
            box-shadow: none;
        }
        button.chip:hover { background: #e5e5ea; transform: none; }
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
        .note {
            position: absolute;
            top: ${BUTTON_SIZE + 8}px;
            right: 0;
            box-sizing: border-box;
            width: ${ASK_PANEL_WIDTH}px;
            padding: 10px;
            border-radius: 12px;
            background: #ffffff;
            color: #c62828;
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
            font: 400 13px/1.4 -apple-system, "Helvetica Neue", sans-serif;
        }
        .note[hidden] { display: none; }
        .note.info { color: #1c1c1e; }
        input {
            all: initial;
            flex: 1;
            min-width: 0;
            box-sizing: border-box;
            height: ${BUTTON_SIZE}px;
            padding: 0 10px;
            border: 1px solid #d1d1d6;
            border-radius: 8px;
            background: #ffffff;
            color: #1c1c1e;
            font: 400 14px -apple-system, "Helvetica Neue", sans-serif;
        }
        input:focus { border-color: #0a84ff; }
        button.send { font: 700 16px/1 -apple-system, "Helvetica Neue", sans-serif; }
        .status { margin-top: 8px; color: #6e6e73; }
        .status.loading::before {
            content: "";
            display: inline-block;
            width: 10px;
            height: 10px;
            margin-right: 8px;
            border: 2px solid #d1d1d6;
            border-top-color: #6e6e73;
            border-radius: 50%;
            vertical-align: -1px;
            animation: listen-spin 0.8s linear infinite;
        }
        @keyframes listen-spin { to { transform: rotate(360deg); } }
        .status.error { color: #c62828; }
    `;

    let host = null;
    let barShadow = null;
    let button = null; // speaker / ■
    let speedButton = null;
    let askButton = null; // hidden while AI features are off (see Settings)
    let buttonIcon = "listen";
    let selectedText = "";
    let selectedRange = null;
    let selectedCodeBlock = null; // the code block the selection is in (see Code), or null

    function createBar() {
        host = document.createElement("listen-extension-root");
        host.style.cssText =
            "all: initial; position: absolute; z-index: 2147483647; display: none;";

        const shadow = host.attachShadow({ mode: "closed" });
        barShadow = shadow;
        const style = document.createElement("style");
        style.textContent = BAR_CSS;

        const bar = document.createElement("div");
        bar.className = "bar";
        // Keep the page selection intact when any button is pressed.
        bar.addEventListener("mousedown", (event) => event.preventDefault());

        button = document.createElement("button");
        button.type = "button";
        applyIcon();
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (buttonIcon === "stop") speech.stop();
            else if (buttonIcon === "loading") cancelImageRequest();
            else if (imageTarget) onListenImage();
            else if (selectedText) onListen();
        });

        speedButton = document.createElement("button");
        speedButton.type = "button";
        speedButton.className = "speed";
        applySpeed();
        speedButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            setSpeed(nextSpeed(), true);
        });

        askButton = document.createElement("button");
        askButton.type = "button";
        askButton.className = "ask";
        askButton.append(svgIcon("chat", 16));
        askButton.title = "Ask or get help with the highlighted text or image";
        askButton.setAttribute("aria-label", askButton.title);
        askButton.hidden = !settings.aiFeatures;
        askButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openAsk();
        });

        bar.append(button, speedButton, askButton);
        shadow.append(style, bar);
        document.documentElement.appendChild(host);
    }

    function applyIcon() {
        const icon = ICONS[buttonIcon];
        button.replaceChildren(icon.svg ? svgIcon(icon.svg, 16) : icon.text);
        button.title = icon.title;
        button.setAttribute("aria-label", icon.label);
        button.classList.toggle("stop", buttonIcon === "stop");
        button.classList.toggle("loading", buttonIcon === "loading");
    }

    function setButtonIcon(name) {
        buttonIcon = name;
        if (button) applyIcon();
    }

    // Shows the bar just below-right of `rect` (the selection's last line), or with corner: true inside
    // its top-right corner (an image), kept inside the viewport.
    function showBar(rect, corner) {
        if (!host || !host.isConnected) createBar();
        host.style.display = "block";
        const width = host.offsetWidth || BUTTON_SIZE;
        const height = host.offsetHeight || BUTTON_SIZE;
        const maxX = document.documentElement.clientWidth - width - OFFSET;
        const maxY = document.documentElement.clientHeight - height - OFFSET;
        let x = Math.min(rect.right + OFFSET, maxX);
        let y = rect.bottom + OFFSET;
        if (corner) {
            x = Math.min(rect.right - width - OFFSET, maxX);
            y = Math.min(Math.max(rect.top + OFFSET, OFFSET), maxY);
        } else if (y > maxY) {
            y = rect.top - height - OFFSET;
        }
        host.style.left = `${Math.max(OFFSET, x) + window.scrollX}px`;
        host.style.top = `${Math.max(OFFSET, y) + window.scrollY}px`;
    }

    function hideBar() {
        selectedText = "";
        selectedRange = null;
        selectedCodeBlock = null;
        // While reading or describing an image, keep the bar on screen.
        if (imageBusy) return;
        if (speech.isSpeaking()) {
            setButtonIcon("stop");
            return;
        }
        imageTarget = null;
        if (note) note.hidden = true;
        if (host) host.style.display = "none";
    }

    function isBarEvent(event) {
        return host !== null && event.composedPath().includes(host);
    }

    // ---------- Speed (remembered across sites in browser.storage.local) ----------

    const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
    let speed = 1;

    function nextSpeed() {
        return SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    }

    function applySpeed() {
        speedButton.textContent = `${speed}x`;
        speedButton.title = "Reading speed";
        speedButton.setAttribute("aria-label", `Reading speed ${speed}x. Click to change.`);
    }

    // Applies a speed (restarting a reading in progress from the current word) and optionally saves it.
    function setSpeed(value, save) {
        speed = value;
        speech.setRate(value);
        if (speedButton) applySpeed();
        if (!save) return;
        try {
            browser.storage.local.set({ speed: value }).catch((e) => console.warn("[Listen] Couldn't save speed:", e));
        } catch (e) {
            console.warn("[Listen] Couldn't save speed:", e);
        }
    }

    try {
        browser.storage.local.get("speed").then(
            (items) => {
                if (SPEEDS.includes(items.speed)) setSpeed(items.speed, false);
            },
            (e) => console.warn("[Listen] Couldn't load speed:", e)
        );
        // Keep other open tabs in step when the speed changes in one of them.
        browser.storage.onChanged.addListener((changes, area) => {
            const change = changes.speed;
            if (area !== "local" || !change || !SPEEDS.includes(change.newValue)) return;
            if (change.newValue !== speed) setSpeed(change.newValue, false);
        });
    } catch (e) {
        console.warn("[Listen] Speed storage unavailable:", e);
    }

    // ---------- Settings (chosen in the toolbar popup, kept in browser.storage.local) ----------
    // voice: a voiceURI, or "" for the best available. showImageButtons / showLinkButtons: hover bars on
    // images and charts / links. aiFeatures: off hides the chat button and bubble, and nothing is ever sent to
    // Gemini. showChatBubble: the chat bubble in the page's corner.

    const settings = { voice: "", showImageButtons: false, showLinkButtons: false, aiFeatures: true, showChatBubble: true };

    function applySettings(values) {
        if (typeof values.voice === "string") {
            settings.voice = values.voice;
            speech.setVoice(values.voice);
        }
        for (const key of ["showImageButtons", "showLinkButtons", "aiFeatures", "showChatBubble"]) {
            if (typeof values[key] === "boolean") settings[key] = values[key];
        }
        if (askButton) askButton.hidden = !settings.aiFeatures;
        if (!settings.aiFeatures && isAskOpen()) closeAsk();
        updateBubble();
        refreshSettingsView();
    }

    try {
        browser.storage.local.get(Object.keys(settings)).then(applySettings, (e) =>
            console.warn("[Listen] Couldn't load settings:", e)
        );
        // Changes made in the popup apply straight away, in every open tab.
        browser.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return;
            const values = {};
            for (const key of Object.keys(settings)) if (changes[key]) values[key] = changes[key].newValue;
            if (Object.keys(values).length) applySettings(values);
        });
    } catch (e) {
        console.warn("[Listen] Settings storage unavailable:", e);
    }

    // ---------- Chat (the chat button on the bar, and the chat bubble in the page's corner) ----------
    // One conversation per tab. The bar's chat button attaches the highlighted text (or the hovered image,
    // chart, link, code or maths) to it as a quoted chip; quick-action chips and typed messages ask Gemini
    // about it through background.js, with the last few turns as context. background.js keeps the
    // conversation for the tab until "New chat". The panel and the bubble can be dragged anywhere on
    // screen; their last positions are kept in browser.storage.local.

    const ASK_TIMEOUT_MS = 45000;
    const CHAT_PANEL_WIDTH = 360;
    const BUBBLE_SIZE = 44;
    const EDGE = 8; // px kept between the chat and the window's edges
    const DRAG_THRESHOLD = 4; // px a press must move to count as a drag rather than a click
    const HISTORY_TURNS = 6; // earlier turns sent along as context: the last three questions and answers
    const HISTORY_TURN_CHARS = 2000;
    const MAX_TURNS_KEPT = 40;

    // Quick actions: [action sent to background.js, label, tooltip], per kind of attachment.
    const CHIPS = [
        ["summarize", "Summarize", "Short summary of the highlighted text"],
        ["translate", "Translate", "Translate the highlighted text"],
        ["explain", "Explain", "Explain the highlighted text simply"],
    ];
    const MATH_CHIPS = [
        ["explain", "Explain", "Explain the maths simply"],
        ["solve", "Solve step by step", "Work through it step by step"],
        ["readit", "Read it", "Read the maths aloud"],
    ];
    const MATH_PROBLEM_CHIPS = [
        ["hint", "Hint", "One nudge toward the next step, without the answer"],
        ["solve", "Solve", "The answer, then the working step by step"],
        ["explain", "Explain", "Explain the problem simply"],
    ];
    const MATH_ANSWER_CHIPS = [
        ["check", "Check my answer", "Check whether the answer shown is right"],
        ["hint", "Hint", "One nudge toward the next step, without the answer"],
        ["solve", "Solve", "The answer, then the working step by step"],
        ["explain", "Explain", "Explain the problem simply"],
    ];
    const IMAGE_CHIPS = [
        ["describe", "Describe", "Describe the image"],
        ["readtext", "Read text in image", "Read out any text in the image"],
        ["explain", "Explain", "Explain the image simply"],
    ];
    const EMAIL_CHIPS = [
        ["reply", "Reply", "Draft a reply to this message"],
        ["shorter", "Shorter", "Make the text shorter"],
        ["polite", "More polite", "Make the text more polite"],
        ["explain", "Explain", "Explain the message simply"],
    ];

    // ----- Emails and messages -----
    // Text selected on a webmail site, or that reads like a message (a greeting, a sign-off, "From:" or
    // "Subject:"), gets the email chips.

    const MAIL_HOSTS = /^(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com)$/;
    const GREETING = /^\s*(hi|hello|hey|dear|good (morning|afternoon|evening))\b[^\n.?]{0,40}[,!]/i;
    const SIGN_OFF =
        /(^|\n|[.!?]\s+)(best( regards| wishes)?|kind regards|warm regards|regards|many thanks|thanks( again)?|thank you|cheers|sincerely|yours (truly|sincerely)|all the best|talk soon|take care)\s*(,|!|\n)[\p{L} .'’-]{0,40}$/iu;
    const MAIL_HEADER = /(^|\n)\s*(from|subject):\s*\S/i;

    function isMailSite() {
        const host = location.hostname;
        return MAIL_HOSTS.test(host) || (/(^|\.)icloud\.com$/.test(host) && /\/mail/.test(location.pathname));
    }

    function looksLikeMessage(text) {
        return isMailSite() || GREETING.test(text) || SIGN_OFF.test(text.trim()) || MAIL_HEADER.test(text);
    }

    // ----- Maths problems -----
    // A maths problem (a sum, an expression, an equation to solve, or a word problem with a question) gets
    // Hint / Solve / Explain; with an answer already written down, Check my answer / Hint / Solve / Explain.
    // Other maths (a formula in an article) keeps Explain / Solve step by step / Read it.

    // Numbers, letters or brackets joined by an operator: "5 + 7", "3/4 × 2", "2x − 1", "(a + b)^2".
    const EXPRESSION = /(\d|\b[a-z]\b|\))\s*[+\-−×÷*/^=]\s*(\d|\(|\b[a-z]\b)/i;
    const PERCENT_OF = /\d\s*%\s*of\s*\d/i;
    // Dates and year ranges look like sums but aren't: "12/03/2024", "2023-24", "1914–1918".
    const DATE_OR_RANGE = /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b(1[0-9]|20)\d{2}\s*[-–]\s*((1[0-9]|20)?\d{2})\b/g;
    // Words that can sit around a sum without making it prose.
    const MATHS_GLUE = /^(of|what|is|solve|find|simplify|calculate|work|out|evaluate|for|and|the|my|answer|ans|equals|then)$/i;

    // A short piece of text that is mostly a sum, expression or equation.
    function isExpression(text) {
        if (text.length > 300) return false;
        let cleaned = text.replace(DATE_OR_RANGE, " ");
        const words = (cleaned.match(/\p{L}{2,}/gu) || []).filter((w) => !MATHS_GLUE.test(w));
        if (words.length > 3) return false;
        // Among words, "4-7" or "555-1234" is a range or a number, not a subtraction.
        if (words.length) cleaned = cleaned.replace(/(\d)-(\d)/g, "$1 $2");
        return EXPRESSION.test(cleaned) || PERCENT_OF.test(cleaned);
    }

    // A letter next to a number or an operator, then "=": "2x + 3 = 11", "x² − 4 = 0".
    const EQUATION = /(\d\s*[a-z]\b|\b[a-z]\s*[\^²³]|\b[a-z]\s*[+\-−*×÷/]\s*\d|\d\s*[+\-−*×÷/]\s*[a-z]\b)[^=\n]{0,60}=/i;
    // A sum with its result written down: "12 × 7 = 84".
    const SUM_WITH_RESULT = /\d\s*[+\-−*×÷/]\s*\(?\d[\d\s+\-−*×÷/().]*=\s*[-−]?\d/;
    const QUESTION_CUE =
        /\?|\b(find|solve|calculate|work out|evaluate|simplify|factori[sz]e|expand|determine|how (many|much|long|far|fast)|what is)\b/i;
    const MATHS_WORDS =
        /%|\b(total|sum|difference|product|altogether|each|per|times|twice|half|percent|average|mean|area|perimeter|volume|speed|rate|costs?|price|fraction|ratio|remain(s|ing)?|left|more than|less than|equation)\b/i;
    // "Answer: 12", "my answer is 7", or a line ending "x = 4".
    const ANSWER_SHOWN = /\b(answer|ans|solution|result)\s*(is\b|:|=)|(^|[\s,;:])[a-z]\s*=\s*[-−]?\d+([.,/]\d+)?\s*[.!]?\s*$/im;

    // "problem", "answered", or null when the text isn't a maths problem.
    function mathsProblem(text) {
        if (text.length > 1500) return null;
        const numbers = (text.match(/\d+(\.\d+)?/g) || []).length;
        const question = QUESTION_CUE.test(text);
        const sum = SUM_WITH_RESULT.test(text);
        const isProblem =
            isExpression(text) ||
            EQUATION.test(text) ||
            sum ||
            (numbers >= 2 && question && MATHS_WORDS.test(text)) ||
            (numbers >= 1 && question && /[+\-−*×÷/^=²³√]/.test(text));
        if (!isProblem) return null;
        return sum || ANSWER_SHOWN.test(text) ? "answered" : "problem";
    }

    // ----- The attachment: what the conversation is currently about -----

    let askKind = null; // "text", "email", "code", "math", "image", "chart", "link", or null for nothing attached
    let askContext = ""; // the attached text
    let askRange = null; // where that text is on the page, if known
    let askImage = null; // the attached image, chart, link or hovered equation, instead of text
    let askCode = null; // the code block, when askKind is "code"
    let askLanguage = ""; // its programming language
    let askMathMode = "formula"; // for maths: "problem", "answered" or "formula"
    let askRequest = 0; // id of the conversation; "New chat" makes answers still on their way stale

    // While the box is open the text it's about stays softly marked, since focusing the question
    // field clears the page selection. Uses the CSS Custom Highlight API; nothing in the page changes.
    const ASKED_CSS = "::highlight(listen-asked) { background-color: rgba(10, 132, 255, 0.22); }";
    let askedSheet = null;

    function markAsked(range) {
        unmarkAsked();
        if (!range || typeof Highlight !== "function" || typeof CSS === "undefined" || !CSS.highlights) return;
        try {
            askedSheet = new CSSStyleSheet();
            askedSheet.replaceSync(ASKED_CSS);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, askedSheet];
            CSS.highlights.set("listen-asked", new Highlight(range));
        } catch (e) {
            console.warn("[Listen] Couldn't mark the highlighted text:", e);
        }
    }

    function unmarkAsked() {
        if (typeof CSS !== "undefined" && CSS.highlights) CSS.highlights.delete("listen-asked");
        if (askedSheet) {
            const sheet = askedSheet;
            document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
            askedSheet = null;
        }
    }

    // ----- Translation target -----
    // The browser's language, or the last language the user typed ("translate to Spanish"), saved in
    // browser.storage.local. If the text is already in that language, English is used instead.

    const KNOWN_LANGUAGES = (
        "en es fr de it pt nl sv no da fi pl cs sk hu ro bg el ru uk tr ar he fa hi bn ur th vi id ms tl zh ja ko sw ca"
    ).split(" ");
    let translateTarget = null; // { name, code } typed by the user, if any

    function languageName(code) {
        try {
            return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
        } catch (e) {
            return code;
        }
    }

    function codeForName(name) {
        const wanted = name.trim().toLowerCase();
        return KNOWN_LANGUAGES.find((code) => languageName(code).toLowerCase() === wanted) || null;
    }

    // "translate this to Spanish" / "Translate into french?" → { name: "Spanish", code: "es" }
    function parseTranslateTarget(question) {
        const match = question.match(/\btranslate\b.*?\b(?:to|into)\s+(\p{L}[\p{L} ]*?)\s*[?.!]*$/iu);
        const code = match && codeForName(match[1]);
        return code ? { name: languageName(code), code } : null;
    }

    function rememberTranslateTarget(target) {
        translateTarget = target;
        try {
            browser.storage.local.set({ translateTarget: target }).catch(() => {});
        } catch (e) {
            // not saved; still used for this page
        }
    }

    function translationTarget() {
        const browserCode = navigator.language.split("-")[0].toLowerCase();
        let target = translateTarget || { name: languageName(browserCode), code: browserCode };
        const textCode = language.detect(askRange, askContext).split(/[-_]/)[0].toLowerCase();
        if (textCode === target.code && target.code !== "en") target = { name: "English", code: "en" };
        return target;
    }

    try {
        browser.storage.local.get("translateTarget").then((items) => {
            const saved = items.translateTarget;
            if (saved && typeof saved.name === "string" && typeof saved.code === "string") translateTarget = saved;
        }, () => {});
    } catch (e) {
        // storage unavailable; the browser language is used
    }

    // ----- Conversation -----

    let turns = []; // [{ role: "user" | "model", text, lang? }]
    let chatLoaded = null; // promise of loading this tab's conversation from background.js

    const KIND_LABELS = {
        text: "Text", email: "Message", code: "Code", image: "Image", chart: "Chart", link: "Link",
        problem: "Maths", answered: "Maths and your answer", formula: "Maths",
    };

    function snippet(text, max) {
        const flat = text.replace(/\s+/g, " ").trim();
        return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
    }

    // Only text-like attachments are kept with the conversation: images, charts and links need the page.
    function savableAttachment() {
        if (!["text", "email", "code", "math"].includes(askKind) || askImage) return null;
        const context = askKind === "math" && askRange ? mathContext(askRange) : askContext;
        return { kind: askKind, context: context.slice(0, 20000), language: askLanguage, mathMode: askMathMode };
    }

    function saveChat() {
        const chat = turns.length || askKind ? { turns: turns.slice(-MAX_TURNS_KEPT), attachment: savableAttachment() } : null;
        try {
            browser.runtime.sendMessage({ type: "listen:chat-save", chat }).catch(() => {});
        } catch (e) {
            // not kept; the conversation still lasts as long as the page
        }
    }

    function loadChat() {
        chatLoaded ||= (async () => {
            let kept = null;
            try {
                kept = await browser.runtime.sendMessage({ type: "listen:chat-load" });
            } catch (e) {
                // nothing kept for this tab
            }
            if (!kept || !Array.isArray(kept.turns)) return;
            turns = kept.turns
                .filter((t) => (t.role === "user" || t.role === "model") && typeof t.text === "string")
                .map((t) => (t.visual ? { ...t, visual: cleanVisual(t.visual) || undefined } : t));
            const saved = kept.attachment;
            if (saved && typeof saved.context === "string" && ["text", "email", "code", "math"].includes(saved.kind)) {
                setAttachment({ kind: saved.kind, context: saved.context, language: saved.language || "", mathMode: saved.mathMode });
            }
            renderTurns();
        })();
        return chatLoaded;
    }

    // The last few turns, shortened, as context for the next request.
    // A chart or table goes along as its data, so "make that a line chart" works.
    function historyForRequest() {
        return turns.slice(-HISTORY_TURNS).map((t) => ({
            role: t.role,
            text: (t.visual ? `${t.text}\n${visualText(t.visual)}` : t.text).slice(0, HISTORY_TURN_CHARS),
        }));
    }

    // ----- Building the chat (its own Shadow DOM host, separate from the bar) -----

    const CHAT_CSS = `
        /* Colours for light and dark mode. */
        :host {
            --chat-bg: #ffffff;
            --chat-text: #1c1c1e;
            --chat-muted: #6e6e73;
            --chat-soft: #f2f2f7;
            --chat-soft-hover: #e5e5ea;
            --chat-card: #f7f7f9;
            --chat-border: #e5e5ea;
            --chat-field: #ffffff;
            --chat-field-border: #d1d1d6;
            --chat-strong: #1c1c1e;
            --chat-on-strong: #ffffff;
            --chat-accent: #0a84ff;
            --chat-accent-text: #0a64c8;
            --chat-error: #c62828;
            --chat-zebra: rgba(0, 0, 0, 0.03);
        }
        @media (prefers-color-scheme: dark) {
            :host {
                --chat-bg: #1c1c1e;
                --chat-text: #f2f2f7;
                --chat-muted: #98989d;
                --chat-soft: #2c2c2e;
                --chat-soft-hover: #3a3a3c;
                --chat-card: #2a2a2c;
                --chat-border: #38383a;
                --chat-field: #2c2c2e;
                --chat-field-border: #48484a;
                --chat-strong: #f2f2f7;
                --chat-on-strong: #1c1c1e;
                --chat-accent-text: #64b0ff;
                --chat-error: #ff6b6b;
                --chat-zebra: rgba(255, 255, 255, 0.04);
            }
        }
        button.bubble {
            position: fixed;
            width: ${BUBBLE_SIZE}px;
            height: ${BUBBLE_SIZE}px;
            touch-action: none;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
        }
        button.bubble.dragging { transform: scale(1.08); cursor: grabbing; transition: none; }
        .panel {
            position: fixed;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            width: ${CHAT_PANEL_WIDTH}px;
            max-height: calc(100vh - ${EDGE * 2}px);
            border-radius: 14px;
            background: var(--chat-bg);
            color: var(--chat-text);
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.28);
            font: 400 14px/1.45 -apple-system, "Helvetica Neue", sans-serif;
            text-align: left;
            overflow: hidden;
        }
        .panel.dragging { box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35); }
        .panel[hidden], .panel [hidden], button.bubble[hidden] { display: none; }
        .chat-head {
            flex: none;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 8px 8px 12px;
            border-bottom: 1px solid var(--chat-border);
            cursor: grab;
            touch-action: none;
            user-select: none;
            -webkit-user-select: none;
        }
        .panel.dragging .chat-head { cursor: grabbing; }
        .chat-title { flex: 1; font-weight: 600; font-size: 13px; }
        .panel button { box-shadow: none; }
        .panel button:hover { transform: none; }
        button.head-button {
            width: auto;
            height: 24px;
            padding: 0 10px;
            border-radius: 12px;
            background: var(--chat-soft);
            color: var(--chat-text);
            font: 500 12px/1 -apple-system, "Helvetica Neue", sans-serif;
        }
        button.head-button.close { width: 24px; padding: 0; font-size: 16px; }
        button.head-button:hover { background: var(--chat-soft-hover); }
        .chat-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 10px; gap: 8px; }
        .attachment {
            flex: none;
            display: flex;
            align-items: flex-start;
            gap: 6px;
            padding: 6px 8px;
            border-left: 3px solid var(--chat-accent);
            border-radius: 8px;
            background: rgba(10, 132, 255, 0.1);
            font-size: 13px;
            line-height: 1.35;
        }
        .attachment-text {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
        }
        .attachment-kind { display: block; color: var(--chat-accent-text); font-size: 11px; font-weight: 600; }
        button.detach {
            width: 18px;
            height: 18px;
            background: transparent;
            color: var(--chat-muted);
            font-size: 14px;
        }
        button.detach:hover { color: var(--chat-text); }
        .messages {
            flex: 1 1 auto;
            min-height: 0;
            max-height: 440px;
            overflow: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .messages:empty { display: none; }
        .msg { overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
        .msg.user {
            align-self: flex-end;
            max-width: 85%;
            padding: 6px 10px;
            border-radius: 12px 12px 4px 12px;
            background: var(--chat-strong);
            color: var(--chat-on-strong);
            white-space: pre-wrap;
        }
        /* Answers: a full-width card with a small row of buttons under it. */
        .msg.model { display: flex; flex-direction: column; gap: 4px; }
        .answer {
            padding: 10px 12px;
            border: 1px solid var(--chat-border);
            border-radius: 12px;
            background: var(--chat-card);
            white-space: pre-wrap;
        }
        .answer .final {
            display: block;
            font-size: 22px;
            font-weight: 700;
            line-height: 1.25;
            font-variant-numeric: tabular-nums;
        }
        .answer .steps {
            display: block;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--chat-border);
            font-variant-numeric: tabular-nums;
        }
        .answer .step { display: block; }
        .answer-tools { display: flex; align-items: center; gap: 2px; padding-left: 4px; }
        .panel button.speak, .panel button.copy {
            width: 26px;
            height: 26px;
            border-radius: 6px;
            background: transparent;
            color: var(--chat-muted);
            font-size: 11px;
        }
        .panel button.speak:hover, .panel button.copy:hover { background: var(--chat-soft); color: var(--chat-text); }
        .copied { margin-left: 4px; color: var(--chat-muted); font-size: 12px; }
        .empty { margin: 0; color: var(--chat-muted); font-size: 13px; }
        .status { margin-top: 0; color: var(--chat-muted); }
        .status.error { color: var(--chat-error); }
        .status.loading::before { border-color: var(--chat-border); border-top-color: var(--chat-muted); }
        /* Quick actions: one row that scrolls sideways when it doesn't fit. */
        .chips {
            flex: none;
            flex-wrap: nowrap;
            margin: 0 -10px;
            padding: 0 10px;
            overflow-x: auto;
            scrollbar-width: none;
        }
        .chips::-webkit-scrollbar { display: none; }
        .chips:empty { display: none; }
        .panel button.chip { flex: none; background: var(--chat-soft); color: var(--chat-text); }
        .panel button.chip:hover { background: var(--chat-soft-hover); }
        .panel input { background: var(--chat-field); color: var(--chat-text); border-color: var(--chat-field-border); }
        .panel input:focus { border-color: var(--chat-accent); }
        .panel button.send { background: var(--chat-strong); color: var(--chat-on-strong); }
        /* Settings (behind the gear). */
        button.head-button.gear { width: 24px; padding: 0; }
        button.head-button.gear[aria-pressed="true"] { background: var(--chat-strong); color: var(--chat-on-strong); }
        .settings {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 12px;
            font-size: 13px;
        }
        .settings-heading { margin-bottom: -4px; color: var(--chat-muted); font-size: 12px; font-weight: 600; }
        .settings-row { display: flex; gap: 6px; align-items: center; }
        .settings select {
            flex: 1;
            min-width: 0;
            height: 28px;
            padding: 0 6px;
            border: 1px solid var(--chat-field-border);
            border-radius: 8px;
            background: var(--chat-field);
            color: var(--chat-text);
            font: 400 13px -apple-system, "Helvetica Neue", sans-serif;
        }
        .speeds { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--chat-soft); }
        .panel .speeds button {
            flex: 1;
            width: auto;
            height: 26px;
            border-radius: 7px;
            background: transparent;
            color: var(--chat-text);
            font: 500 12px/1 -apple-system, "Helvetica Neue", sans-serif;
        }
        .panel .speeds button[aria-checked="true"] { background: var(--chat-bg); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
        .toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; }
        .toggle input {
            all: initial;
            -webkit-appearance: none;
            appearance: none;
            position: relative;
            flex: none;
            width: 34px;
            height: 20px;
            border-radius: 10px;
            background: var(--chat-field-border);
            cursor: pointer;
            transition: background 0.15s;
        }
        .toggle input::before {
            content: "";
            position: absolute;
            top: 2px;
            left: 2px;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #ffffff;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
            transition: transform 0.15s;
        }
        .toggle input:checked { background: var(--chat-accent); }
        .toggle input:checked::before { transform: translateX(14px); }
        .toggle input:focus-visible { outline: 2px solid var(--chat-accent); outline-offset: 2px; }
        .settings-note { margin: 0; color: var(--chat-muted); font-size: 12px; }
        /* Charts and tables in answers. */
        .visual { position: relative; margin-top: 10px; white-space: normal; }
        .visual-title { margin-bottom: 6px; font-size: 13px; font-weight: 600; }
        .visual svg { display: block; width: 100%; height: auto; overflow: visible; }
        .visual .grid { stroke: var(--chat-border); stroke-width: 1; }
        .visual .axis { stroke: var(--chat-muted); stroke-width: 1; }
        .visual .tick { fill: var(--chat-muted); font: 400 10px -apple-system, "Helvetica Neue", sans-serif; }
        .visual .axis-title { fill: var(--chat-muted); font: 600 10px -apple-system, "Helvetica Neue", sans-serif; }
        .visual .hit:hover { opacity: 0.8; }
        .visual .slice { stroke: var(--chat-card); stroke-width: 1.5; }
        .chart-tip {
            position: absolute;
            z-index: 1;
            padding: 4px 8px;
            border-radius: 6px;
            background: var(--chat-strong);
            color: var(--chat-on-strong);
            font-size: 12px;
            white-space: nowrap;
            pointer-events: none;
        }
        .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 12px; }
        .legend-item { display: inline-flex; align-items: center; gap: 5px; }
        .swatch { flex: none; width: 10px; height: 10px; border-radius: 3px; }
        .table-wrap { overflow-x: auto; border: 1px solid var(--chat-border); border-radius: 8px; }
        .visual table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
        .visual th, .visual td {
            padding: 5px 8px;
            border-bottom: 1px solid var(--chat-border);
            text-align: left;
            white-space: nowrap;
        }
        .visual th { background: var(--chat-soft); font-weight: 600; }
        .visual tbody tr:nth-child(even) td { background: var(--chat-zebra); }
        .visual tbody tr:last-child td { border-bottom: 0; }
        .visual .num { text-align: right; }
    `;

    let chatHost = null;
    let chatShadow = null;
    let chat = null; // { panel, head, bubble, attachment, attachmentKind, attachmentText, messages, empty, status, chipRow, chips, input, send }
    let panelPosition = null; // { x, y } last chosen by dragging, from browser.storage.local
    let bubblePosition = null;

    function chatButton(className, label, content) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = className;
        b.title = label;
        b.setAttribute("aria-label", label);
        b.append(content);
        return b;
    }

    function createChat() {
        chatHost = document.createElement("listen-chat-root");
        chatHost.style.cssText = "all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;";
        chatShadow = chatHost.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.textContent = BAR_CSS + CHAT_CSS;

        const bubble = chatButton("bubble", "Open Listen chat", svgIcon("chat", 20));

        const panel = document.createElement("div");
        panel.className = "panel";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "Listen chat");

        const head = document.createElement("div");
        head.className = "chat-head";
        const title = document.createElement("span");
        title.className = "chat-title";
        title.textContent = "Listen";
        const gear = chatButton("head-button gear", "Settings", svgIcon("gear", 15));
        gear.setAttribute("aria-pressed", "false");
        const newChat = chatButton("head-button", "New chat", "New chat");
        const close = chatButton("head-button close", "Close", "×");
        head.append(title, gear, newChat, close);

        const body = document.createElement("div");
        body.className = "chat-body";
        const attachment = document.createElement("div");
        attachment.className = "attachment";
        attachment.hidden = true;
        const attachmentText = document.createElement("div");
        attachmentText.className = "attachment-text";
        const detach = chatButton("detach", "Remove from the chat", "×");
        attachment.append(attachmentText, detach);

        const messages = document.createElement("div");
        messages.className = "messages";
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "Ask anything. To ask about part of the page, highlight it and press the chat button.";
        const status = document.createElement("div");
        status.className = "status";
        status.hidden = true;
        const chips = document.createElement("div");
        chips.className = "chips";
        const row = document.createElement("div");
        row.className = "ask-row";
        const input = document.createElement("input");
        input.type = "text";
        input.setAttribute("aria-label", "Message");
        const send = chatButton("send", "Send", "↑");
        row.append(input, send);
        body.append(attachment, messages, empty, status, chips, row);
        const settingsView = buildSettings();
        panel.append(head, body, settingsView.view);

        chatShadow.append(style, bubble, panel);
        document.documentElement.appendChild(chatHost);
        chat = {
            panel, head, bubble, body, gear, settings: settingsView, attachment, attachmentText, messages, empty, status,
            chipRow: chips, chips: [], input, send,
        };

        // Keep typing out of the page (site shortcuts) and out of our own page-level key handlers.
        for (const type of ["keydown", "keyup", "keypress"]) {
            panel.addEventListener(type, (event) => event.stopPropagation());
        }
        panel.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeAsk();
            } else if (event.key === "Enter" && event.target === input && !event.isComposing) {
                event.preventDefault();
                sendQuestion();
            }
        });
        send.addEventListener("click", () => sendQuestion());
        newChat.addEventListener("click", () => startNewChat());
        close.addEventListener("click", () => closeAsk());
        gear.addEventListener("click", () => showSettings(chat.body.hidden === false));
        detach.addEventListener("click", () => {
            clearAttachment();
            saveChat();
            input.focus();
        });
        bubble.addEventListener("click", () => {
            if (bubble.dataset.dragged) {
                delete bubble.dataset.dragged;
                return;
            }
            if (isAskOpen()) closeAsk();
            else openChat("bubble");
        });
        messages.addEventListener("scroll", () => highlighter.relayout(), { passive: true });
        makeDraggable(panel, head, "chatPanelPos", (pos) => (panelPosition = pos));
        makeDraggable(bubble, bubble, "chatBubblePos", (pos) => (bubblePosition = pos));
        placeBubble();
        updateBubble();
    }

    function isChatEvent(event) {
        return chatHost !== null && event.composedPath().includes(chatHost);
    }

    // ----- Dragging (smooth, kept fully on screen, last position remembered) -----

    function clampPosition(element, x, y) {
        const viewWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewHeight = window.innerHeight;
        return {
            x: Math.round(Math.max(EDGE, Math.min(x, viewWidth - element.offsetWidth - EDGE))),
            y: Math.round(Math.max(EDGE, Math.min(y, viewHeight - element.offsetHeight - EDGE))),
        };
    }

    function place(element, x, y) {
        const pos = clampPosition(element, x, y);
        element.style.left = `${pos.x}px`;
        element.style.top = `${pos.y}px`;
        return pos;
    }

    function keepOnScreen(element) {
        if (element.hidden) return;
        place(element, parseFloat(element.style.left) || 0, parseFloat(element.style.top) || 0);
    }

    // Lets `element` (position: fixed) be dragged by `handle`; a press on another button inside the handle
    // is left alone. Moves follow the pointer once per frame. The final position is saved under `key`.
    function makeDraggable(element, handle, key, remember) {
        handle.addEventListener("pointerdown", (event) => {
            const pressed = event.target.closest && event.target.closest("button");
            if (event.button !== 0 || (pressed && pressed !== handle)) return;
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            const start = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
            let moved = false;
            let frame = 0;
            let target = null;
            handle.setPointerCapture(event.pointerId);
            const move = (e) => {
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
                if (!moved) {
                    moved = true;
                    element.classList.add("dragging");
                }
                target = { x: start.left + dx, y: start.top + dy };
                frame ||= requestAnimationFrame(() => {
                    frame = 0;
                    place(element, target.x, target.y);
                });
            };
            const end = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
                if (!moved) return;
                cancelAnimationFrame(frame);
                frame = 0;
                const pos = place(element, target.x, target.y);
                element.classList.remove("dragging");
                element.dataset.dragged = "1"; // the click that follows a drag is ignored
                setTimeout(() => delete element.dataset.dragged, 0);
                remember(pos);
                try {
                    browser.storage.local.set({ [key]: pos }).catch(() => {});
                } catch (e) {
                    // not remembered; it stays where it is on this page
                }
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        });
    }

    function placeBubble() {
        const { bubble } = chat;
        if (bubblePosition) place(bubble, bubblePosition.x, bubblePosition.y);
        else place(bubble, Infinity, Infinity); // bottom-right corner
    }

    // The bubble shows on every page unless it's switched off in the popup or AI features are off.
    function updateBubble() {
        if (!chat) return;
        chat.bubble.hidden = !settings.showChatBubble || !settings.aiFeatures;
        if (!chat.bubble.hidden) placeBubble();
    }

    // Where the panel opens: where it was last dragged to, else next to the bar or above the bubble.
    function placePanel(from) {
        const { panel, bubble } = chat;
        if (panelPosition) {
            place(panel, panelPosition.x, panelPosition.y);
        } else if (from === "bar" && host && host.style.display !== "none") {
            const bar = host.getBoundingClientRect();
            place(panel, bar.left, bar.bottom + 8);
        } else if (!bubble.hidden) {
            const b = bubble.getBoundingClientRect();
            place(panel, b.right - panel.offsetWidth, b.top - panel.offsetHeight - 8);
        } else {
            place(panel, Infinity, Infinity); // bottom-right corner
        }
    }

    try {
        browser.storage.local.get(["chatPanelPos", "chatBubblePos"]).then((items) => {
            const valid = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
            if (valid(items.chatPanelPos)) panelPosition = items.chatPanelPos;
            if (valid(items.chatBubblePos)) {
                bubblePosition = items.chatBubblePos;
                if (chat) placeBubble();
            }
        }, () => {});
    } catch (e) {
        // default positions
    }

    // ----- Opening and closing -----

    function isAskOpen() {
        return chat !== null && !chat.panel.hidden;
    }

    async function openChat(from) {
        if (!settings.aiFeatures) return;
        if (!chat) createChat();
        await loadChat();
        const wasOpen = isAskOpen();
        chat.panel.hidden = false;
        if (chat.body.hidden) showSettings(false);
        renderAttachment();
        renderTurns();
        if (!wasOpen) placePanel(from);
        keepOnScreen(chat.panel);
        chat.input.focus();
    }

    function closeAsk() {
        if (!isAskOpen()) return;
        if (readingAnswer) speech.stop();
        chat.panel.hidden = true;
        unmarkAsked();
    }

    function startNewChat() {
        askRequest++; // answers still on their way belong to the old chat
        if (readingAnswer) speech.stop();
        turns = [];
        clearAttachment();
        setAskBusy(false);
        chat.status.hidden = true;
        renderTurns();
        saveChat();
        chat.input.focus();
    }

    // The bar's chat button (or the toolbar button, `from` "toolbar"): attaches the selection (or the hovered
    // image, chart, link or equation) and opens the chat. With nothing to attach it opens or closes the chat.
    async function openAsk(from = "bar") {
        const context = selectedText || lastReadText;
        if (!imageTarget && !context) {
            if (isAskOpen()) closeAsk();
            else openChat(from);
            return;
        }
        const image = imageTarget;
        const code = !image && selectedText ? selectedCodeBlock : null;
        const range = image ? null : selectedText ? selectedRange : lastReadRange;
        let kind = image ? imageKind : code ? "code" : "text";
        let mathMode = "formula";
        if (kind === "text") {
            const problem = mathsProblem(context);
            if (problem || rangeHasMath(range, context)) {
                kind = "math";
                mathMode = problem || "formula";
            } else if (looksLikeMessage(context)) {
                kind = "email";
            }
        }
        await openChat(from);
        setAttachment({
            kind, context: image ? "" : context, range, image, code,
            language: code ? codeLanguage(code) : "", mathMode,
        });
        saveChat();
        // The bar's job is done; it would otherwise sit on top of the panel.
        window.getSelection().removeAllRanges();
        hideBar();
        chat.input.focus();
    }

    function setAttachment({ kind, context, range = null, image = null, code = null, language = "", mathMode = "formula" }) {
        askKind = kind;
        askContext = context;
        askRange = range;
        askImage = image;
        askCode = code;
        askLanguage = language;
        askMathMode = kind === "math" && !image ? mathMode || "formula" : "formula";
        if (isAskOpen()) markAsked(askRange);
        if (chat) renderAttachment();
    }

    function clearAttachment() {
        setAttachment({ kind: null, context: "" });
        unmarkAsked();
    }

    function attachmentLabel() {
        if (askKind === "image") return (askImage && imageInfo(askImage).alt) || "An image on the page";
        if (askKind === "chart") return captionOf(askImage) || "A chart on the page";
        if (askKind === "link") {
            const url = linkUrl(askImage);
            return url ? `${url.hostname}${url.pathname === "/" ? "" : url.pathname}` : "A link";
        }
        if (askKind === "math" && askImage) return mathSpeech(askImage);
        return askContext;
    }

    function renderAttachment() {
        const { attachment, attachmentText, input } = chat;
        attachment.hidden = !askKind;
        const chipLists = {
            text: CHIPS, email: EMAIL_CHIPS, code: CODE_CHIPS, image: IMAGE_CHIPS, chart: CHART_CHIPS, link: LINK_CHIPS,
            math: { problem: MATH_PROBLEM_CHIPS, answered: MATH_ANSWER_CHIPS, formula: MATH_CHIPS }[askMathMode],
        };
        renderChips(askKind ? chipLists[askKind] : []);
        // Text can be asked about or worked on ("write a reply", "make this shorter").
        const placeholders = {
            text: "Ask anything, or say what you need…", email: "Ask, or say what to write…",
            code: "Ask about the code…", math: "Ask about the maths…", image: "Ask about the image…",
            chart: "Ask about the chart…", link: "Ask about the linked page…",
        };
        input.placeholder = askKind ? placeholders[askKind] : "Ask anything…";
        chat.empty.hidden = turns.length > 0 || Boolean(askKind);
        if (!askKind) return;
        const kind = document.createElement("span");
        kind.className = "attachment-kind";
        kind.textContent = askKind === "math" ? KIND_LABELS[askMathMode] : KIND_LABELS[askKind];
        const isQuote = !["image", "chart", "link"].includes(askKind);
        const label = snippet(attachmentLabel(), 140);
        attachmentText.replaceChildren(kind, isQuote ? `“${label}”` : label);
        attachmentText.title = snippet(attachmentLabel(), 600);
        if (isAskOpen()) markAsked(askRange);
    }

    function renderChips(list) {
        chat.chips = list.map(([action, label, title]) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip";
            chip.textContent = label;
            chip.title = title;
            chip.addEventListener("click", () => sendChip(action, label));
            return chip;
        });
        chat.chipRow.replaceChildren(...chat.chips);
        setAskBusy(askBusy);
    }

    // ----- Messages -----

    function renderTurns() {
        if (!chat) return;
        chat.messages.replaceChildren(...turns.map(turnElement));
        chat.empty.hidden = turns.length > 0 || Boolean(askKind);
        chat.messages.scrollTop = chat.messages.scrollHeight;
        updateSpeakButtons();
        keepOnScreen(chat.panel);
    }

    function turnElement(turn) {
        const msg = document.createElement("div");
        msg.className = `msg ${turn.role}`;
        if (turn.role === "user") {
            msg.textContent = turn.text;
            return msg;
        }
        const answer = document.createElement("div");
        answer.className = "answer";
        const answerText = document.createElement("div");
        answerText.className = "answer-text";
        fillAnswer(answerText, turn.text);
        if (turn.lang) answerText.lang = turn.lang;
        answer.append(answerText);
        if (turn.visual) answer.append(visualElement(turn.visual));
        const tools = document.createElement("div");
        tools.className = "answer-tools";
        const speak = chatButton("speak", "Read answer aloud", "");
        const copyLabel = !turn.visual ? "Copy answer"
            : turn.visual.kind === "table" ? "Copy table (pastes into Sheets or Excel)" : "Copy the chart's data";
        const copy = chatButton("copy", copyLabel, svgIcon("copy", 14));
        const copied = document.createElement("div");
        copied.className = "copied";
        copied.setAttribute("role", "status");
        copied.hidden = true;
        tools.append(speak, copy, copied);
        msg.append(answer, tools);
        speak.addEventListener("click", () => {
            if (readingAnswer === answerText) speech.stop();
            else readAnswer(answerText);
        });
        copy.addEventListener("click", () => copyAnswer(turn.visual ? visualText(turn.visual) : turn.text, tools));
        return msg;
    }

    // A maths answer starts with its final answer on its own line ("= 26", "x = 2") followed by the
    // working, one equation per line: the answer is shown large and bold, the steps underneath.
    const FINAL_ANSWER = /^\s*(=|≈|[a-zA-Zα-ω]\s*[=≈])\s*\S/;

    function fillAnswer(answer, text) {
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        if (!lines.length || !FINAL_ANSWER.test(lines[0]) || lines[0].length > 40) {
            answer.textContent = text;
            return;
        }
        const final = document.createElement("span");
        final.className = "final";
        final.textContent = lines[0];
        answer.append(final);
        if (lines.length < 2) return;
        const steps = document.createElement("span");
        steps.className = "steps";
        for (const line of lines.slice(1)) {
            const step = document.createElement("span");
            step.className = "step";
            step.textContent = line;
            steps.append(step);
        }
        answer.append(steps);
    }

    function addTurn(turn) {
        turns.push(turn);
        if (turns.length > MAX_TURNS_KEPT) turns = turns.slice(-MAX_TURNS_KEPT);
        renderTurns();
        saveChat();
    }

    function showAskStatus(kind, message) {
        const { status } = chat;
        status.hidden = false;
        status.className = `status ${kind}`;
        status.textContent = message;
        chat.empty.hidden = true;
        keepOnScreen(chat.panel);
    }

    let askBusy = false;

    function setAskBusy(busy) {
        askBusy = busy;
        if (!chat) return;
        chat.send.disabled = busy;
        for (const chip of chat.chips) chip.disabled = busy;
    }

    function sendQuestion() {
        const question = chat.input.value.trim();
        if (!question || askBusy) return;
        chat.input.value = "";
        const target = parseTranslateTarget(question);
        if (target) rememberTranslateTarget(target);
        // Images, charts and linked pages go with the question; everything else goes to the tutor chat,
        // with any attached text.
        const action = ["image", "chart", "link"].includes(askKind) ? "ask" : "chat";
        askGemini({ action, question }, target ? target.code : "", question);
    }

    function sendChip(action, label) {
        if (action === "readit") {
            // Read the maths aloud with Listen's own spoken form (no Gemini needed).
            if (askImage && askKind === "math") onListenMath(askImage);
            else if (askRange) read(askRange, askContext, null);
            return;
        }
        if (action !== "translate" || askImage) {
            askGemini({ action }, "", label);
            return;
        }
        const target = translationTarget();
        askGemini({ action, target: target.name }, target.code, `${label} to ${target.name}`);
    }

    // Sends a request to background.js; always resolves to { ok, answer } or { ok: false, error }.
    async function askBackground(request) {
        if (!settings.aiFeatures) {
            // imageUnavailable lets an image fall back to its alt text.
            return { ok: false, error: "AI features are off. You can turn them on from Listen's toolbar button.", imageUnavailable: true };
        }
        try {
            const timeout = new Promise((resolve) =>
                setTimeout(() => resolve({ ok: false, error: "No answer came back in time. Try again." }), ASK_TIMEOUT_MS)
            );
            const response = await Promise.race([browser.runtime.sendMessage({ type: "listen:ask", ...request }), timeout]);
            return response || { ok: false, error: "No answer came back. Try again." };
        } catch (e) {
            return { ok: false, error: "Couldn't reach Listen's background page. Reload the page and try again." };
        }
    }

    // What's attached, in the form background.js expects.
    async function aboutAttachment() {
        if (askKind === "link") return { link: { url: linkUrl(askImage).href } };
        if (askKind === "code") return { code: { text: askContext, language: askLanguage } };
        if (askKind === "math") {
            const text = askImage ? texOf(askImage) || mathSpeech(askImage) : askRange ? mathContext(askRange) : askContext;
            return { math: { text } };
        }
        if (askKind === "chart") return { chart: await chartInfo(askImage) };
        if (askKind === "image") return { image: imageInfo(askImage) };
        return askKind ? { text: askContext } : {};
    }

    // Sends `request` ({ action, question?, target? }) with the attachment and the last few turns, shows
    // `userText` as the student's message and the answer below it.
    async function askGemini(request, answerLang, userText) {
        if (askBusy) return;
        if (readingAnswer) speech.stop();
        const id = askRequest;
        const history = historyForRequest();
        addTurn({ role: "user", text: userText });
        setAskBusy(true);
        showAskStatus("loading", "Thinking…");
        let about;
        try {
            about = await aboutAttachment();
        } catch (error) {
            setAskBusy(false);
            if (id === askRequest) showAskStatus("error", error instanceof CaptureError ? error.message : "This chart couldn't be captured.");
            return;
        }
        const response = await askBackground({ ...request, ...about, history });
        if (id !== askRequest) return; // "New chat" was pressed meanwhile
        setAskBusy(false);
        if (response.ok) {
            chat.status.hidden = true;
            const visual = cleanVisual(response.visual);
            addTurn({ role: "model", text: response.answer, lang: answerLang || undefined, ...(visual ? { visual } : {}) });
            language.prepare(response.answer);
        } else {
            showAskStatus("error", withAltText(response));
        }
    }

    // ----- Settings (the gear in the chat's header) -----
    // The same settings as the settings page, saved in browser.storage.local; every open tab applies them
    // through storage.onChanged (see Settings).

    const SETTING_SWITCHES = [
        ["showImageButtons", "Buttons on images and charts"],
        ["showLinkButtons", "Buttons on links"],
        ["showChatBubble", "Chat bubble on pages"],
        ["aiFeatures", "AI features (chat)"],
    ];
    const SETTINGS_SPEEDS = [0.75, 1, 1.25, 1.5, 2];
    const TEST_SENTENCE = "This is how Listen sounds when it reads to you.";
    const DAILY_QUESTIONS = 30; // the proxy's limit, shown until the first answer reports the real one

    function storeSetting(values) {
        try {
            browser.storage.local.set(values).catch((e) => console.warn("[Listen] Couldn't save settings:", e));
        } catch (e) {
            console.warn("[Listen] Couldn't save settings:", e);
        }
    }

    function settingsHeading(text) {
        const heading = document.createElement("div");
        heading.className = "settings-heading";
        heading.textContent = text;
        return heading;
    }

    function buildSettings() {
        const view = document.createElement("div");
        view.className = "settings";
        view.hidden = true;

        const voiceRow = document.createElement("div");
        voiceRow.className = "settings-row";
        const select = document.createElement("select");
        select.setAttribute("aria-label", "Voice");
        const test = chatButton("head-button", "Test the voice", "Test");
        voiceRow.append(select, test);

        const speeds = document.createElement("div");
        speeds.className = "speeds";
        speeds.setAttribute("role", "radiogroup");
        speeds.setAttribute("aria-label", "Default speed");

        const switches = {};
        const toggles = SETTING_SWITCHES.map(([key, label]) => {
            const row = document.createElement("label");
            row.className = "toggle";
            const text = document.createElement("span");
            text.textContent = label;
            const box = document.createElement("input");
            box.type = "checkbox";
            box.setAttribute("role", "switch");
            box.addEventListener("change", () => storeSetting({ [key]: box.checked }));
            switches[key] = box;
            row.append(text, box);
            return row;
        });

        const usage = document.createElement("p");
        usage.className = "settings-note";
        const privacy = document.createElement("p");
        privacy.className = "settings-note";
        privacy.textContent = "Questions are sent to Google Gemini to answer. Reading stays on your Mac.";

        view.append(settingsHeading("Voice"), voiceRow, settingsHeading("Default speed"), speeds, ...toggles, usage, privacy);

        select.addEventListener("change", () => {
            speech.setVoice(select.value);
            storeSetting({ voice: select.value });
        });
        test.addEventListener("click", () => {
            if (test.textContent === "Stop") {
                speech.stop();
                return;
            }
            const done = () => (test.textContent = "Test");
            test.textContent = "Stop";
            speech.speak(TEST_SENTENCE, { onWord() {}, onWordTimingUnavailable() {}, onEnd: done }, navigator.language || "en");
        });
        return { view, select, test, speeds, switches, usage };
    }

    function fillVoices() {
        const { select } = chat.settings;
        const voices = speech.voiceChoices();
        select.replaceChildren(new Option("Automatic (best available)", ""));
        for (const voice of voices) select.add(new Option(voice.label, voice.uri));
        // A saved voice that's no longer installed shows as Automatic.
        select.value = voices.some((v) => v.uri === settings.voice) ? settings.voice : "";
        return voices.length > 0;
    }

    function showSpeeds() {
        const { speeds } = chat.settings;
        speeds.replaceChildren(
            ...SETTINGS_SPEEDS.map((value) => {
                const b = document.createElement("button");
                b.type = "button";
                b.setAttribute("role", "radio");
                b.setAttribute("aria-checked", String(value === speed));
                b.textContent = `${value}x`;
                b.addEventListener("click", () => {
                    setSpeed(value, true);
                    showSpeeds();
                });
                return b;
            })
        );
    }

    function showUsage(usage) {
        const el = chat.settings.usage;
        const today = new Date().toISOString().slice(0, 10); // the proxy counts by UTC day
        if (usage && usage.day === today && Number.isInteger(usage.remaining)) {
            el.textContent = `${usage.remaining} of ${usage.limit} question${usage.limit === 1 ? "" : "s"} left today`;
        } else {
            el.textContent = `${(usage && usage.limit) || DAILY_QUESTIONS} questions a day — none used yet today`;
        }
    }

    // Shows the settings in place of the conversation, or the conversation again.
    function showSettings(open) {
        chat.body.hidden = open;
        chat.settings.view.hidden = !open;
        chat.gear.setAttribute("aria-pressed", String(open));
        chat.gear.title = open ? "Back to the chat" : "Settings";
        if (!open) {
            if (chat.settings.test.textContent === "Stop") speech.stop();
            chat.input.focus();
            keepOnScreen(chat.panel);
            return;
        }
        if (!fillVoices()) speechSynthesis.addEventListener("voiceschanged", fillVoices, { once: true });
        showSpeeds();
        for (const [key, box] of Object.entries(chat.settings.switches)) box.checked = settings[key];
        showUsage(null);
        try {
            browser.storage.local.get("usage").then((items) => showUsage(items.usage), () => {});
        } catch (e) {
            // the default line stays
        }
        keepOnScreen(chat.panel);
    }

    // Keeps the open settings in step with changes made elsewhere (the settings page, another tab).
    function refreshSettingsView() {
        if (!chat || chat.settings.view.hidden) return;
        for (const [key, box] of Object.entries(chat.settings.switches)) box.checked = settings[key];
        showSpeeds();
    }

    // ----- Toolbar button -----
    // background.js sends "listen:open-chat" when Listen's toolbar button is clicked: the chat opens with any
    // highlighted text attached, or closes if it's open and nothing new is highlighted. With AI features off
    // the answer is false, and background.js opens the settings page instead.

    function openFromToolbar() {
        if (!settings.aiFeatures) return false;
        const result = readSelection();
        if (result) {
            selectedText = result.text;
            selectedRange = result.range;
            selectedCodeBlock = result.codeBlock;
            imageTarget = null;
            openAsk("toolbar");
        } else if (isAskOpen()) {
            closeAsk();
        } else {
            openChat("toolbar");
        }
        return true;
    }

    try {
        browser.runtime.onMessage.addListener((message) => {
            if (message && message.type === "listen:open-chat") return Promise.resolve(openFromToolbar());
        });
    } catch (e) {
        console.warn("[Listen] Toolbar messages unavailable:", e);
    }

    // ----- Charts and tables -----
    // Gemini can answer with data for a chart or a table (checked by the proxy); it's checked again here and
    // drawn with DOM calls. Nothing the model writes is ever used as HTML, SVG or code: only these data
    // fields, as text and numbers.

    const VISUAL_LIMITS = { series: 12, labels: 200, values: 2400, slices: 12, columns: 10, rows: 50 };
    // Apple's system colours: clear on both light and dark backgrounds.
    const CHART_COLORS = [
        "#0a84ff", "#ff9f0a", "#30d158", "#ff375f", "#bf5af2", "#64d2ff",
        "#ffd60a", "#ac8e68", "#5e5ce6", "#ff6961", "#32ade6", "#8e8e93",
    ];
    const CHART_W = 320;
    const CHART_H = 210;
    const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
    const fullNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

    function plainText(value, max) {
        if (typeof value !== "string" && typeof value !== "number") return "";
        return String(value).replace(/\s+/g, " ").trim().slice(0, max);
    }

    // A checked copy of a chart or table from the proxy, or null.
    function cleanVisual(visual) {
        if (!visual || typeof visual !== "object") return null;
        if (visual.kind === "table") {
            if (!Array.isArray(visual.headers) || !Array.isArray(visual.rows)) return null;
            const headers = visual.headers.slice(0, VISUAL_LIMITS.columns).map((h) => plainText(h, 80));
            const rows = visual.rows
                .filter(Array.isArray)
                .slice(0, VISUAL_LIMITS.rows)
                .map((row) => headers.map((_, i) => plainText(row[i], 200)));
            return headers.length && rows.length ? { kind: "table", title: plainText(visual.title, 120), headers, rows } : null;
        }
        if (visual.kind !== "chart" || !["bar", "line", "pie"].includes(visual.type)) return null;
        if (!Array.isArray(visual.labels) || !Array.isArray(visual.series)) return null;
        const labels = visual.labels.map((l) => plainText(l, 60));
        if (!labels.length || labels.length > VISUAL_LIMITS.labels) return null;
        const series = visual.series.slice(0, visual.type === "pie" ? 1 : VISUAL_LIMITS.series).map((item) => ({
            name: plainText(item && item.name, 60),
            values: item && Array.isArray(item.values) ? item.values : [],
        }));
        const valid = (s) => s.values.length === labels.length && s.values.every((v) => typeof v === "number" && Number.isFinite(v));
        if (!series.length || !series.every(valid) || series.length * labels.length > VISUAL_LIMITS.values) return null;
        if (visual.type === "pie") {
            const values = series[0].values;
            if (labels.length > VISUAL_LIMITS.slices || values.some((v) => v < 0) || !values.some((v) => v > 0)) return null;
        }
        return {
            kind: "chart", type: visual.type, title: plainText(visual.title, 120), xLabel: plainText(visual.xLabel, 60),
            yLabel: plainText(visual.yLabel, 60), labels, series,
        };
    }

    // Tab-separated rows, which paste into Numbers, Sheets or Excel as a table.
    function visualText(visual) {
        const cell = (value) => String(value).replace(/[\t\r\n]+/g, " ");
        const rows =
            visual.kind === "table"
                ? [visual.headers, ...visual.rows]
                : [
                    [visual.xLabel || "Label", ...visual.series.map((s, i) => s.name || `Series ${i + 1}`)],
                    ...visual.labels.map((label, i) => [label, ...visual.series.map((s) => s.values[i])]),
                ];
        return rows.map((row) => row.map(cell).join("\t")).join("\n");
    }

    function svgEl(tag, attrs, parent) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
        if (parent) parent.append(el);
        return el;
    }

    function svgText(text, attrs, parent) {
        const el = svgEl("text", attrs, parent);
        el.textContent = text;
        return el;
    }

    const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

    // Round axis steps covering lo..hi, e.g. 0, 20 000, 40 000…
    function niceScale(lo, hi) {
        if (lo === hi) hi = lo + 1;
        const rough = (hi - lo) / 4;
        const magnitude = 10 ** Math.floor(Math.log10(rough));
        const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
        const min = Math.floor(lo / step) * step;
        const max = Math.ceil(hi / step) * step;
        const ticks = [];
        for (let v = min; v <= max + step / 1000; v += step) ticks.push(Math.round(v / step) * step);
        return { min, max, ticks };
    }

    // A small tooltip inside the chart's box, following the pointer over bars, points and slices.
    function addTooltip(box) {
        const tip = document.createElement("div");
        tip.className = "chart-tip";
        tip.hidden = true;
        box.append(tip);
        return (shape, text) => {
            shape.classList.add("hit");
            shape.addEventListener("pointermove", (event) => {
                const r = box.getBoundingClientRect();
                tip.textContent = text;
                tip.hidden = false;
                const x = Math.min(event.clientX - r.left + 12, r.width - tip.offsetWidth - 4);
                tip.style.left = `${Math.max(4, x)}px`;
                tip.style.top = `${Math.max(4, event.clientY - r.top - tip.offsetHeight - 8)}px`;
            });
            shape.addEventListener("pointerleave", () => (tip.hidden = true));
        };
    }

    // Bar and line charts: value axis with round steps, gridlines, slanted labels when they're long or many.
    function drawAxesChart(svg, chart, tooltip) {
        const { labels, series, type } = chart;
        const values = series.flatMap((s) => s.values);
        const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values));
        const tickWidth = Math.max(...scale.ticks.map((t) => compactNumber.format(t).length)) * 6;
        const longest = Math.max(...labels.map((l) => l.length));
        const left = tickWidth + 10 + (chart.yLabel ? 14 : 0);
        const right = 8;
        const band = (CHART_W - left - right) / labels.length;
        const slanted = longest * 5.6 > band - 4;
        const bottom = (slanted ? Math.min(60, 12 + Math.min(longest, 14) * 4.2) : 18) + (chart.xLabel ? 16 : 0);
        const top = 8;
        const x0 = left;
        const y0 = top;
        const y1 = CHART_H - bottom;
        const y = (v) => y1 - ((v - scale.min) / (scale.max - scale.min)) * (y1 - y0);

        for (const t of scale.ticks) {
            svgEl("line", { x1: x0, x2: CHART_W - right, y1: y(t), y2: y(t), class: t === 0 ? "axis" : "grid" }, svg);
            svgText(compactNumber.format(t), { x: x0 - 5, y: y(t) + 3.5, "text-anchor": "end", class: "tick" }, svg);
        }
        if (chart.yLabel) {
            svgText(shorten(chart.yLabel, 34), {
                x: 10, y: (y0 + y1) / 2, "text-anchor": "middle", class: "axis-title", transform: `rotate(-90 10 ${(y0 + y1) / 2})`,
            }, svg);
        }
        if (chart.xLabel) {
            svgText(shorten(chart.xLabel, 50), { x: (x0 + CHART_W - right) / 2, y: CHART_H - 3, "text-anchor": "middle", class: "axis-title" }, svg);
        }
        // Label every nth band so labels don't overlap.
        const every = Math.ceil(labels.length / (slanted ? 24 : Math.max(1, Math.floor((CHART_W - left) / 36))));
        labels.forEach((label, i) => {
            if (i % every) return;
            const cx = x0 + band * (i + 0.5);
            if (slanted) {
                svgText(shorten(label, 14), { x: cx, y: y1 + 10, "text-anchor": "end", class: "tick", transform: `rotate(-40 ${cx} ${y1 + 10})` }, svg);
            } else {
                svgText(shorten(label, Math.max(3, Math.floor(band / 5.6))), { x: cx, y: y1 + 13, "text-anchor": "middle", class: "tick" }, svg);
            }
        });

        const name = (s, i) => s.name || `Series ${i + 1}`;
        const several = series.length > 1;
        if (type === "bar") {
            const inner = band * 0.8;
            const width = inner / series.length;
            series.forEach((s, j) => {
                s.values.forEach((v, i) => {
                    const bar = svgEl("rect", {
                        x: x0 + band * i + band * 0.1 + width * j, y: y(Math.max(v, 0)), width: Math.max(1, width - (several ? 1 : 0)),
                        height: Math.max(1, Math.abs(y(v) - y(0))), rx: Math.min(3, width / 4),
                        fill: CHART_COLORS[(several ? j : i) % CHART_COLORS.length],
                    }, svg);
                    tooltip(bar, `${labels[i]}${several ? ` · ${name(s, j)}` : ""}: ${fullNumber.format(v)}`);
                });
            });
        } else {
            series.forEach((s, j) => {
                const color = CHART_COLORS[j % CHART_COLORS.length];
                const points = s.values.map((v, i) => [x0 + band * (i + 0.5), y(v)]);
                svgEl("polyline", { points: points.map((p) => p.join(",")).join(" "), fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }, svg);
                points.forEach(([px, py], i) => {
                    const dot = svgEl("circle", { cx: px, cy: py, r: labels.length > 40 ? 2 : 3.5, fill: color }, svg);
                    tooltip(dot, `${labels[i]}${several ? ` · ${name(s, j)}` : ""}: ${fullNumber.format(s.values[i])}`);
                });
            });
        }
    }

    function drawPie(svg, chart, tooltip) {
        const values = chart.series[0].values;
        const total = values.reduce((a, b) => a + b, 0);
        const cx = CHART_W / 2;
        const cy = CHART_H / 2;
        const r = CHART_H / 2 - 8;
        let angle = -Math.PI / 2;
        values.forEach((v, i) => {
            if (v <= 0) return;
            const share = v / total;
            const color = CHART_COLORS[i % CHART_COLORS.length];
            const text = `${chart.labels[i]}: ${fullNumber.format(v)} (${fullNumber.format(Math.round(share * 1000) / 10)}%)`;
            if (share >= 0.9999) {
                tooltip(svgEl("circle", { cx, cy, r, fill: color }, svg), text);
                return;
            }
            const end = angle + share * 2 * Math.PI;
            const d = `M ${cx} ${cy} L ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} ` +
                `A ${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} Z`;
            tooltip(svgEl("path", { d, fill: color, class: "slice" }, svg), text);
            angle = end;
        });
    }

    function legend(items) {
        const box = document.createElement("div");
        box.className = "legend";
        for (const [label, color] of items) {
            const item = document.createElement("span");
            item.className = "legend-item";
            const swatch = document.createElement("span");
            swatch.className = "swatch";
            swatch.style.background = color;
            item.append(swatch, label);
            box.append(item);
        }
        return box;
    }

    function tableElement(table) {
        const wrap = document.createElement("div");
        wrap.className = "table-wrap";
        const el = document.createElement("table");
        // Columns of numbers are right-aligned, header included.
        const isNumber = (value) => /^[-−+]?[\d.,\s]+%?$/.test(value) && /\d/.test(value);
        const numeric = table.headers.map((_, i) => table.rows.every((row) => !row[i] || isNumber(row[i])));
        const head = el.createTHead().insertRow();
        table.headers.forEach((header, i) => {
            const th = document.createElement("th");
            th.textContent = header;
            if (numeric[i]) th.className = "num";
            head.append(th);
        });
        const body = el.createTBody();
        for (const row of table.rows) {
            const tr = body.insertRow();
            row.forEach((value, i) => {
                const td = tr.insertCell();
                td.textContent = value;
                if (numeric[i]) td.className = "num";
            });
        }
        wrap.append(el);
        return wrap;
    }

    function visualElement(visual) {
        const box = document.createElement("div");
        box.className = `visual ${visual.kind}`;
        if (visual.title) {
            const title = document.createElement("div");
            title.className = "visual-title";
            title.textContent = visual.title;
            box.append(title);
        }
        if (visual.kind === "table") {
            box.append(tableElement(visual));
            return box;
        }
        const tooltip = addTooltip(box);
        const svg = svgEl("svg", { viewBox: `0 0 ${CHART_W} ${CHART_H}`, role: "img" });
        svg.setAttribute("aria-label", visual.title || "Chart");
        if (visual.type === "pie") drawPie(svg, visual, tooltip);
        else drawAxesChart(svg, visual, tooltip);
        box.append(svg);
        if (visual.type === "pie") {
            const total = visual.series[0].values.reduce((a, b) => a + b, 0);
            box.append(legend(visual.labels.map((label, i) => [
                `${label} ${fullNumber.format(Math.round((visual.series[0].values[i] / total) * 1000) / 10)}%`,
                CHART_COLORS[i % CHART_COLORS.length],
            ])));
        } else if (visual.series.length > 1) {
            box.append(legend(visual.series.map((s, j) => [s.name || `Series ${j + 1}`, CHART_COLORS[j % CHART_COLORS.length]])));
        }
        return box;
    }

    // ----- Read aloud and Copy -----

    function updateSpeakButtons() {
        if (!chat) return;
        for (const msg of chat.messages.querySelectorAll(".msg.model")) {
            const playing = readingAnswer === msg.querySelector(".answer-text");
            const speak = msg.querySelector("button.speak");
            speak.replaceChildren(playing ? "■" : svgIcon("speaker", 14));
            speak.classList.toggle("stop", playing);
            speak.title = playing ? "Stop" : "Read answer aloud";
            speak.setAttribute("aria-label", speak.title);
        }
    }

    function readAnswer(answer) {
        if (!answer.textContent) return;
        const range = document.createRange();
        range.selectNodeContents(answer);
        read(range, answer.textContent, answer);
    }

    const COPIED_MS = 1500;
    let copiedTimer = null;
    let copiedTools = null;

    // `ok`: true shows "Copied", false "Couldn't copy", null resets the button.
    function showCopied(tools, ok) {
        if (copiedTools && copiedTools !== tools) showCopied(copiedTools, null);
        clearTimeout(copiedTimer);
        copiedTools = ok === null ? null : tools;
        tools.querySelector("button.copy").replaceChildren(svgIcon(ok ? "check" : "copy", 14));
        const copied = tools.querySelector(".copied");
        copied.hidden = ok === null;
        copied.textContent = ok ? "Copied" : "Couldn't copy";
        if (ok !== null) copiedTimer = setTimeout(() => showCopied(tools, null), COPIED_MS);
    }

    // The older copy command is the fallback where the clipboard API isn't allowed.
    function copyWithCommand(text) {
        const field = document.createElement("textarea");
        field.value = text;
        field.style.cssText = "position: fixed; opacity: 0;";
        chatShadow.append(field);
        field.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch (e) {
            // not copied
        }
        field.remove();
        return ok;
    }

    async function copyAnswer(text, tools) {
        if (!text) return;
        let ok;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (e) {
            ok = copyWithCommand(text);
        }
        showCopied(tools, ok);
    }

    // ---------- Images ----------
    // Hovering a content image shows the bar in its top-right corner. The speaker reads its alt text, or asks
    // Gemini (through background.js) to describe it; the chat button asks about it.

    const IMAGE_MIN_SIZE = 80;
    const IMAGE_HOVER_DELAY_MS = 400;
    const IMAGE_LEAVE_DELAY_MS = 250;
    const NOTE_MS = 6000;

    let imageTarget = null; // the image or chart the bar is for, or null when it's for selected text
    let imageKind = "image"; // "image", "chart", "math" or "link"
    let imageBusy = false; // waiting for a description
    let imageRequest = 0; // id of the latest description request
    let hoverTimer = null;
    let leaveTimer = null;
    let note = null; // short message under the bar (e.g. an image that can't be fetched)
    let noteTimer = null;

    // Big enough, visible, not decorative, and not a logo inside a link.
    function isReadableImage(img) {
        const rect = img.getBoundingClientRect();
        if (rect.width < IMAGE_MIN_SIZE || rect.height < IMAGE_MIN_SIZE) return false;
        if (img.getAttribute("role") === "presentation" || img.closest("[aria-hidden='true']")) return false;
        if (isEditable(img)) return false;
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

    // An error message, plus the image's alt text when the image itself couldn't be fetched.
    function withAltText(response) {
        const alt = askImage && askImage.tagName === "IMG" ? imageInfo(askImage).alt : "";
        return response.imageUnavailable && alt ? `${response.error} Its alt text says: “${alt}”` : response.error;
    }

    // kind "error" (red, hides itself after a while) or "info" (stays until hidden, e.g. "Explaining code…").
    function showNote(message, kind = "error") {
        if (!note) {
            note = document.createElement("div");
            note.className = "note";
            barShadow.append(note);
        }
        note.textContent = message;
        note.classList.toggle("info", kind === "info");
        note.hidden = false;
        clearTimeout(noteTimer);
        if (kind !== "info") noteTimer = setTimeout(() => (note.hidden = true), NOTE_MS);
    }

    function showImageBar(img, kind = "image") {
        selectedText = "";
        selectedRange = null;
        imageTarget = img;
        imageKind = kind;
        setButtonIcon("listen");
        if (kind === "math") showBar(mathOutlineTarget(img).getBoundingClientRect(), false);
        else if (kind === "link") {
            const rects = img.getClientRects(); // a link can wrap over several lines; use its last one
            showBar(rects[rects.length - 1] || img.getBoundingClientRect(), false);
        } else showBar(img.getBoundingClientRect(), true);
    }

    function hideImageBar() {
        if (!imageTarget || imageBusy || speech.isSpeaking()) return;
        hideBar();
    }

    async function onListenImage() {
        if (imageKind === "chart") {
            onListenChart(imageTarget);
            return;
        }
        if (imageKind === "math") {
            onListenMath(imageTarget);
            return;
        }
        if (imageKind === "link") {
            onListenLink(imageTarget);
            return;
        }
        const img = imageTarget;
        const { alt } = imageInfo(img);
        if (isMeaningfulAlt(alt)) {
            readAbout(img, alt);
            return;
        }
        const id = ++imageRequest;
        imageBusy = true;
        setButtonIcon("loading");
        const response = await askBackground({ action: "describe", image: imageInfo(img) });
        if (id !== imageRequest) return; // cancelled
        imageBusy = false;
        if (response.ok) {
            readAbout(img, response.answer);
            return;
        }
        setButtonIcon("listen");
        const fallBack = response.imageUnavailable && alt;
        showNote(fallBack ? `${response.error} Reading its alt text instead.` : response.error);
        if (fallBack) readAbout(img, alt);
    }

    // Cancels a pending image, chart or code request (the spinner was clicked).
    function cancelImageRequest() {
        imageRequest++;
        imageBusy = false;
        if (note) note.hidden = true;
        setButtonIcon("listen");
    }

    // What a hover bar can be shown for under the pointer, following the popup's settings. Equations
    // always get one: they're read on the Mac, without AI.
    function hoverTargetFor(node) {
        const allowed = (found) => {
            if (!found) return null;
            if (found.kind === "math") return found;
            if (found.kind === "link") return settings.showLinkButtons && settings.aiFeatures ? found : null;
            if (found.kind === "chart") return settings.showImageButtons && settings.aiFeatures ? found : null;
            return settings.showImageButtons ? found : null; // images with alt text are read without AI
        };
        return allowed(visualTargetFor(node)) || allowed(linkTargetFor(node));
    }

    // Show the bar after the pointer rests on an image or chart (see Charts); hide it once the pointer
    // leaves both it and the bar.
    document.addEventListener(
        "mouseover",
        (event) => {
            if (isBarEvent(event)) {
                clearTimeout(leaveTimer);
                return;
            }
            const found = hoverTargetFor(event.target);
            if (found && found.el === imageTarget) {
                clearTimeout(leaveTimer);
                return;
            }
            if (!found) return;
            if (selectedText || speech.isSpeaking() || imageBusy) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                if (found.el.matches(":hover") && !selectedText && !speech.isSpeaking()) {
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
            if (!imageTarget) return;
            const to = event.relatedTarget;
            if (to && (to === imageTarget || to === host || imageTarget.contains(to))) return;
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
        const math = mathContainerOf(node);
        if (math) return isHoverableMath(math) ? { el: math, kind: "math" } : null;
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
        const id = ++imageRequest;
        imageBusy = true;
        setButtonIcon("loading");
        let response;
        try {
            response = await askBackground({ action: "describe", chart: await chartInfo(el) });
        } catch (error) {
            response = { ok: false, error: error instanceof CaptureError ? error.message : "This chart couldn't be captured." };
        }
        if (id !== imageRequest) return; // cancelled
        imageBusy = false;
        if (response.ok) {
            readAbout(el, response.answer);
            return;
        }
        setButtonIcon("listen");
        const alt = el.tagName === "IMG" ? imageInfo(el).alt : "";
        const fallBack = response.imageUnavailable && alt;
        showNote(fallBack ? `${response.error} Reading its alt text instead.` : response.error);
        if (fallBack) readAbout(el, alt);
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
    let lastPointer = null; // where the mouse was last released, to place the bar for such selections

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
        const x = lastPointer ? lastPointer.x : box.left + 40;
        const y = lastPointer ? lastPointer.y : Math.max(box.top, 0) + 40;
        const block = field.closest(".react-code-file-contents") || field.parentElement;
        return { text, range: null, rect: { left: x, right: x, top: y - 16, bottom: y + 4 }, codeBlock: /\s/.test(text) ? block : null };
    }

    async function onListenCode(code, block) {
        const id = ++imageRequest;
        imageBusy = true;
        setButtonIcon("loading");
        showNote("Explaining code…", "info");
        const response = await askBackground({ action: "explain", code: { text: code, language: codeLanguage(block) } });
        if (id !== imageRequest) return; // cancelled
        imageBusy = false;
        if (note) note.hidden = true;
        if (response.ok) {
            readAbout(block, response.answer);
            return;
        }
        setButtonIcon("listen");
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
        if (!a || a.hasAttribute("download") || isEditable(a)) return null;
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
            readAbout(a, linkSummaries.get(url));
            return;
        }
        const id = ++imageRequest;
        imageBusy = true;
        setButtonIcon("loading");
        showNote("Reading the linked page…", "info");
        const response = await askBackground({ action: "summarize", link: { url } });
        if (id !== imageRequest) return; // cancelled
        imageBusy = false;
        if (note) note.hidden = true;
        if (response.ok) {
            linkSummaries.set(url, response.answer);
            readAbout(a, response.answer);
            return;
        }
        setButtonIcon("listen");
        showNote(response.error);
    }

    // ---------- Selection ----------

    function isEditable(node) {
        const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
        if (!el) return false;
        if (el.closest("input, textarea, select")) return true;
        return el.isContentEditable;
    }

    // Returns { text, range, rect, codeBlock } for a usable selection, or null. `range` is null for text
    // selected in a read-only code viewer's text field (see Code).
    function readSelection() {
        const codeField = readOnlyCodeSelection();
        if (codeField) return codeField;
        // Text selected inside <input>/<textarea> is reported through activeElement.
        if (isEditable(document.activeElement) && document.activeElement !== document.body) {
            return null;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

        const range = selection.getRangeAt(0);
        let text = selection.toString().trim();
        // Equations drawn as MathML or images select as empty text; use their spoken form (see Maths).
        const maths = text ? [] : mathContainersIn(range);
        if (!text && maths.length) text = maths.map(mathSpeech).join(" ");
        if (!text) return null;
        if (isEditable(selection.anchorNode) || isEditable(selection.focusNode)) return null;

        const rects = [...range.getClientRects()].filter((r) => r.width || r.height);
        let rect = rects[rects.length - 1];
        if (!rect && maths.length) rect = mathOutlineTarget(maths[maths.length - 1]).getBoundingClientRect();
        if (!rect) return null;

        return { text, range: range.cloneRange(), rect, codeBlock: codeBlockFor(range, text) };
    }

    function updateBar() {
        const result = readSelection();
        if (!result) {
            hideBar();
            return;
        }

        // A new selection gets a fresh speaker button; clicking it replaces any current reading.
        if (result.text !== selectedText) setButtonIcon("listen");
        selectedText = result.text;
        selectedRange = result.range;
        selectedCodeBlock = result.codeBlock;
        imageTarget = null; // a text selection takes the bar over from an image
        language.prepare(result.text);
        showBar(result.rect);
    }

    // ---------- Events ----------

    document.addEventListener("mouseup", (event) => {
        if (isBarEvent(event) || isChatEvent(event)) return;
        lastPointer = { x: event.clientX, y: event.clientY };
        // Wait a tick so the browser finishes updating the selection.
        setTimeout(() => {
            updateBar();
            // A click (no selection) on a rendered equation shows its bar, like hovering it.
            if (selectedText || speech.isSpeaking()) return;
            const found = visualTargetFor(event.target);
            if (found && found.kind === "math") showImageBar(found.el, "math");
        }, 0);
    });

    // Hides the bar. The chat stays open until it's closed.
    function dismiss() {
        hideBar();
    }

    document.addEventListener("mousedown", (event) => {
        if (!isBarEvent(event) && !isChatEvent(event)) dismiss();
    });

    // Keyboard selection (Shift + arrows, Cmd+A).
    document.addEventListener("keyup", (event) => {
        if (event.shiftKey || event.metaKey || event.key === "Shift") updateBar();
    });

    // Escape closes the ask panel if it's open; otherwise it stops any reading and hides the bar.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (isAskOpen()) {
            closeAsk();
            return;
        }
        speech.stop();
        hideBar();
    });

    // Hide as soon as the selection is cleared.
    document.addEventListener("selectionchange", () => {
        if (readOnlyCodeSelection()) return; // a code viewer's own text field holds the selection
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) hideBar();
    });

    window.addEventListener("resize", () => {
        dismiss();
        if (!chat) return;
        if (!chat.bubble.hidden) placeBubble();
        keepOnScreen(chat.panel);
    });

    // Don't keep talking after the user leaves the page.
    window.addEventListener("pagehide", () => speech.stop());

    createChat(); // the chat bubble
})();

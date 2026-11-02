// Listen — content script
// The “ ” button reads the selected text aloud with the best installed built-in voice,
// highlighting each word on the page as it's spoken.

(() => {
    "use strict";

    // ---------- Speech (swap this section out for a better voice later) ----------
    // Interface: speech.speak(text, { onWord, onWordTimingUnavailable, onEnd }, lang), speech.stop(),
    // speech.isSpeaking(), speech.setRate(rate). `lang` is a BCP 47 tag ("es", "pt-BR"); the best
    // installed voice for it is used, or English if there is none. onWord(charIndex, charLength)
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

        // Best installed voice for `lang` ("es", "es-MX"), or null if no voice speaks that language.
        function pickVoice(lang) {
            const primary = normalizeLang(lang).split("-")[0];
            const voices = window.speechSynthesis
                .getVoices()
                .filter((v) => v.lang && normalizeLang(v.lang).split("-")[0] === primary)
                .filter((v) => !NOVELTY_VOICES.has(baseName(v)));
            if (voices.length === 0) return null;
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

        return { speak, stop, isSpeaking, setRate };
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

    let lastReadText = ""; // the page text being (or last) read, for "?" while reading
    let lastReadRange = null;
    let readingAnswer = false; // whether the current reading is the answer in the ask panel

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
        readingAnswer = Boolean(isAnswer);
        if (askPanel) setAnswerSpeakIcon(readingAnswer);
        setButtonIcon("stop");
    }

    // Called when the user clicks the “ ” button.
    function onListen() {
        const range = selectedRange;
        const codeBlock = selectedCodeBlock;
        if (codeBlock) {
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
        readingAnswer = false;
        if (askPanel) setAnswerSpeakIcon(false);
        setButtonIcon("stop");
    }

    function onReadingEnded() {
        highlighter.clear();
        readingAnswer = false;
        if (askPanel) setAnswerSpeakIcon(false);
        setButtonIcon("listen");
        // If nothing is selected or hovered by the time reading ends, the bar has nothing left to do.
        if (!readSelection() && !(imageTarget && imageTarget.matches(":hover"))) hideBar();
    }

    // ---------- Floating bar (isolated in a Shadow DOM so host page CSS can't touch it) ----------
    // A row of buttons: “ ” (listen / stop), speed and "?" (ask). The ask panel opens below the row.

    const BUTTON_SIZE = 30;
    const OFFSET = 6;
    const ASK_PANEL_WIDTH = 320;

    const ICONS = {
        listen: { text: "“”", label: "Read selected text aloud", title: "Listen" },
        stop: { text: "■", label: "Stop reading", title: "Stop" },
        loading: { text: "", label: "Describing the image. Click to cancel.", title: "Describing image…" },
    };

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
        /* Fixed width (fits "1.25x") so the button doesn't move under the pointer as the label changes. */
        button.speed {
            width: 54px;
            padding: 0;
            border-radius: ${BUTTON_SIZE / 2}px;
            font: 600 13px/1 -apple-system, "Helvetica Neue", sans-serif;
            font-variant-numeric: tabular-nums;
        }
        button.ask { padding-top: 0; font-size: 17px; }
        button:hover { transform: scale(1.08); }
        button:active { transform: scale(0.95); }
        button:focus-visible { outline: 2px solid #0a84ff; outline-offset: 2px; }
        button:disabled { opacity: 0.4; cursor: default; transform: none; }

        .panel {
            position: absolute;
            top: ${BUTTON_SIZE + 8}px;
            left: 0;
            box-sizing: border-box;
            width: ${ASK_PANEL_WIDTH}px;
            padding: 10px;
            border-radius: 12px;
            background: #ffffff;
            color: #1c1c1e;
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
            font: 400 14px/1.45 -apple-system, "Helvetica Neue", sans-serif;
            text-align: left;
        }
        .panel.above { top: auto; bottom: ${BUTTON_SIZE + 8}px; }
        .panel[hidden], .panel [hidden] { display: none; }
        .ask-row { display: flex; gap: 6px; align-items: center; }
        .chips { display: flex; gap: 6px; margin-bottom: 8px; }
        button.chip {
            width: auto;
            min-width: 76px;
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
        button.send { font: 700 16px/1 -apple-system, "Helvetica Neue", sans-serif; padding-top: 0; }
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
        .answer-row { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; }
        .answer {
            flex: 1;
            max-height: 240px;
            overflow: auto;
            white-space: pre-wrap;
            user-select: text;
            -webkit-user-select: text;
        }
        button.speak {
            flex: none;
            width: 24px;
            height: 24px;
            font-size: 14px;
            padding-top: 4px;
            box-shadow: none;
        }
        button.speak.stop { font: 400 11px/1 -apple-system, "Helvetica Neue", sans-serif; padding-top: 0; }
    `;

    let host = null;
    let barShadow = null;
    let button = null; // “ ” / ■
    let speedButton = null;
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

        const askButton = document.createElement("button");
        askButton.type = "button";
        askButton.className = "ask";
        askButton.textContent = "?";
        askButton.title = "Ask about the highlighted text or image";
        askButton.setAttribute("aria-label", askButton.title);
        askButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (isAskOpen()) closeAsk();
            else openAsk();
        });

        bar.append(button, speedButton, askButton);
        shadow.append(style, bar);
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
        // While reading, asking or describing an image, keep the bar on screen.
        if (isAskOpen() || imageBusy) return;
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

    // ---------- Ask panel ("?": questions about the highlighted text, answered by Gemini) ----------
    // The question is sent to background.js, which holds the API key and calls Gemini.

    const ASK_TIMEOUT_MS = 45000;

    // Quick actions: [action sent to background.js, label, tooltip], for text and for images.
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
    const IMAGE_CHIPS = [
        ["describe", "Describe", "Describe the image"],
        ["readtext", "Read text in image", "Read out any text in the image"],
        ["explain", "Explain", "Explain the image simply"],
    ];

    let askPanel = null; // { panel, input, send, chips, status, answerRow, answer, speak }
    let askContext = ""; // the highlighted text questions are about
    let askRange = null; // where that text is on the page, if known
    let askImage = null; // the image or chart questions are about, instead of text
    let askKind = "text"; // "text", "code", "math", "image" or "chart"
    let askCode = null; // the code block questions are about, when askKind is "code"
    let askRequest = 0; // id of the latest question; older answers are ignored

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

    function createAskPanel() {
        const panel = document.createElement("div");
        panel.className = "panel";
        panel.hidden = true;

        const chips = document.createElement("div");
        chips.className = "chips";

        const row = document.createElement("div");
        row.className = "ask-row";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Ask about the highlighted text…";
        input.setAttribute("aria-label", "Question about the highlighted text");
        const send = document.createElement("button");
        send.type = "button";
        send.className = "send";
        send.textContent = "↑";
        send.title = "Ask";
        send.setAttribute("aria-label", "Ask");
        row.append(input, send);

        const status = document.createElement("div");
        status.className = "status";
        status.hidden = true;

        const answerRow = document.createElement("div");
        answerRow.className = "answer-row";
        answerRow.hidden = true;
        const answer = document.createElement("div");
        answer.className = "answer";
        const speak = document.createElement("button");
        speak.type = "button";
        speak.className = "speak";
        answerRow.append(answer, speak);

        panel.append(chips, row, status, answerRow);
        askPanel = { panel, input, send, chipRow: chips, chips: [], status, answerRow, answer, speak };
        setAnswerSpeakIcon(false);

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
        speak.addEventListener("click", () => {
            if (readingAnswer) speech.stop();
            else readAnswer();
        });
        answer.addEventListener("scroll", () => highlighter.relayout(), { passive: true });
        return panel;
    }

    function renderChips(list) {
        askPanel.chips = list.map(([action, label, title]) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "chip";
            chip.textContent = label;
            chip.title = title;
            chip.addEventListener("click", () => sendChip(action));
            return chip;
        });
        askPanel.chipRow.replaceChildren(...askPanel.chips);
    }

    function isAskOpen() {
        return askPanel !== null && !askPanel.panel.hidden;
    }

    function openAsk() {
        const context = selectedText || lastReadText;
        if ((!imageTarget && !context) || !host) return;
        askImage = imageTarget;
        askCode = !askImage && selectedText ? selectedCodeBlock : null;
        const askMath = !askImage && !askCode && selectedText && rangeHasMath(selectedRange, selectedText);
        askKind = askImage ? imageKind : askCode ? "code" : askMath ? "math" : "text";
        askContext = askImage ? "" : context;
        askRange = askImage ? null : selectedText ? selectedRange : lastReadRange;
        markAsked(askRange);
        if (!askPanel) barShadow.append(createAskPanel());
        if (note) note.hidden = true;
        const chips = { text: CHIPS, code: CODE_CHIPS, math: MATH_CHIPS, image: IMAGE_CHIPS, chart: CHART_CHIPS };
        const placeholders = { text: "highlighted text", code: "code", math: "maths", image: "image", chart: "chart" };
        renderChips(chips[askKind]);
        askPanel.input.placeholder = `Ask about the ${placeholders[askKind]}…`;
        askRequest++;
        askPanel.input.value = "";
        askPanel.status.hidden = true;
        askPanel.answerRow.hidden = true;
        askPanel.panel.hidden = false;
        placeAskPanel();
        askPanel.input.focus();
    }

    function closeAsk() {
        if (!isAskOpen()) return;
        askRequest++; // ignore an answer still on its way
        if (readingAnswer) speech.stop();
        askPanel.panel.hidden = true;
        unmarkAsked();
    }

    // Opens below the bar, or above it if there's no room; shifted left to stay inside the window.
    function placeAskPanel() {
        const { panel } = askPanel;
        panel.style.left = "0px";
        panel.classList.remove("above");
        const barRect = host.getBoundingClientRect();
        const rect = panel.getBoundingClientRect();
        const viewWidth = document.documentElement.clientWidth;
        const viewHeight = document.documentElement.clientHeight;
        const overflowRight = rect.right - (viewWidth - OFFSET);
        if (overflowRight > 0) panel.style.left = `${-Math.min(overflowRight, barRect.left - OFFSET)}px`;
        if (rect.bottom > viewHeight - OFFSET && barRect.top - rect.height - OFFSET > 0) panel.classList.add("above");
    }

    function showAskStatus(kind, message) {
        const { status, answerRow } = askPanel;
        status.hidden = false;
        status.className = `status ${kind}`;
        status.textContent = message;
        answerRow.hidden = true;
        placeAskPanel();
    }

    // `lang`: the answer's language when known (translations), so read-aloud picks the right voice.
    function showAnswer(text, lang) {
        const { status, answerRow, answer } = askPanel;
        status.hidden = true;
        answer.textContent = text;
        if (lang) answer.lang = lang;
        else answer.removeAttribute("lang");
        answer.scrollTop = 0;
        language.prepare(text);
        answerRow.hidden = false;
        placeAskPanel();
    }

    function setAskBusy(busy) {
        askPanel.send.disabled = busy;
        for (const chip of askPanel.chips) chip.disabled = busy;
    }

    function sendQuestion() {
        const question = askPanel.input.value.trim();
        if (!question) return;
        const target = parseTranslateTarget(question);
        if (target) rememberTranslateTarget(target);
        askGemini({ action: "ask", question }, target ? target.code : "");
    }

    function sendChip(action) {
        if (action === "readit") {
            // Read the selected maths aloud with Listen's own spoken form (no Gemini needed).
            if (askRange) read(askRange, askContext, false);
            return;
        }
        if (action !== "translate" || askImage) {
            askGemini({ action }, "");
            return;
        }
        const target = translationTarget();
        askGemini({ action, target: target.name }, target.code);
    }

    // Sends a request to background.js; always resolves to { ok, answer } or { ok: false, error }.
    async function askBackground(request) {
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

    // Sends `request` ({ action, question?, target? }) about askContext or askImage and shows the reply.
    async function askGemini(request, answerLang) {
        if (askPanel.send.disabled) return;
        if (readingAnswer) speech.stop();

        const id = ++askRequest;
        setAskBusy(true);
        showAskStatus("loading", "Thinking…");
        let about;
        try {
            if (askKind === "code") about = { code: { text: askContext, language: codeLanguage(askCode) } };
            else if (askKind === "math") about = { math: { text: askRange ? mathContext(askRange) : askContext } };
            else if (!askImage) about = { text: askContext };
            else if (askKind === "chart") about = { chart: await chartInfo(askImage) };
            else about = { image: imageInfo(askImage) };
        } catch (error) {
            setAskBusy(false);
            if (id === askRequest) showAskStatus("error", error instanceof CaptureError ? error.message : "This chart couldn't be captured.");
            return;
        }
        const response = await askBackground({ ...request, ...about });
        setAskBusy(false);
        if (id !== askRequest) return; // closed or replaced by a newer question
        if (response.ok) showAnswer(response.answer, answerLang);
        else showAskStatus("error", withAltText(response));
    }

    function setAnswerSpeakIcon(playing) {
        const { speak } = askPanel;
        speak.textContent = playing ? "■" : "“”";
        speak.classList.toggle("stop", playing);
        speak.title = playing ? "Stop" : "Read answer aloud";
        speak.setAttribute("aria-label", speak.title);
    }

    function readAnswer() {
        const textNode = askPanel.answer.firstChild;
        if (!textNode) return;
        const range = document.createRange();
        range.selectNodeContents(textNode);
        read(range, textNode.data, true);
    }

    // ---------- Images ----------
    // Hovering a content image shows the bar in its top-right corner. “ ” reads its alt text, or asks
    // Gemini (through background.js) to describe it; "?" asks about it.

    const IMAGE_MIN_SIZE = 80;
    const IMAGE_HOVER_DELAY_MS = 400;
    const IMAGE_LEAVE_DELAY_MS = 250;
    const NOTE_MS = 6000;

    let imageTarget = null; // the image or chart the bar is for, or null when it's for selected text
    let imageKind = "image"; // "image" or "chart"
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
        showBar(img.getBoundingClientRect(), true);
    }

    function hideImageBar() {
        if (!imageTarget || imageBusy || speech.isSpeaking() || isAskOpen()) return;
        hideBar();
    }

    async function onListenImage() {
        if (imageKind === "chart") {
            onListenChart(imageTarget);
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

    // Show the bar after the pointer rests on an image or chart (see Charts); hide it once the pointer
    // leaves both it and the bar.
    document.addEventListener(
        "mouseover",
        (event) => {
            if (isBarEvent(event)) {
                clearTimeout(leaveTimer);
                return;
            }
            const found = visualTargetFor(event.target);
            if (found && found.el === imageTarget) {
                clearTimeout(leaveTimer);
                return;
            }
            if (!found) return;
            if (selectedText || speech.isSpeaking() || isAskOpen() || imageBusy) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                if (found.el.matches(":hover") && !selectedText && !speech.isSpeaking() && !isAskOpen()) {
                    showImageBar(found.el, found.kind);
                }
            }, IMAGE_HOVER_DELAY_MS);
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
    // elements. “ ” asks Gemini to describe what the chart shows; "?" offers Describe / Key numbers /
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
    // A selection inside a code block isn't read symbol by symbol: “ ” asks Gemini (through background.js)
    // for a short plain-English explanation and reads that, outlining the block; "?" offers Explain /
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

        const text = selection.toString().trim();
        if (!text) return null;
        if (isEditable(selection.anchorNode) || isEditable(selection.focusNode)) return null;

        const range = selection.getRangeAt(0);
        const rects = range.getClientRects();
        const rect = rects[rects.length - 1];
        if (!rect) return null;

        return { text, range: range.cloneRange(), rect, codeBlock: codeBlockFor(range, text) };
    }

    function updateBar() {
        if (isAskOpen()) return; // typing a question moves the selection; keep the bar where it is
        const result = readSelection();
        if (!result) {
            hideBar();
            return;
        }

        // A new selection gets a fresh “ ” button; clicking it replaces any current reading.
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
        if (isBarEvent(event)) return;
        lastPointer = { x: event.clientX, y: event.clientY };
        // Wait a tick so the browser finishes updating the selection.
        setTimeout(updateBar, 0);
    });

    // Hides the bar and closes the ask panel.
    function dismiss() {
        closeAsk();
        hideBar();
    }

    document.addEventListener("mousedown", (event) => {
        if (!isBarEvent(event)) dismiss();
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
        if (isAskOpen()) return; // focusing the question field clears the page selection
        if (readOnlyCodeSelection()) return; // a code viewer's own text field holds the selection
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) hideBar();
    });

    window.addEventListener("resize", dismiss);

    // Don't keep talking after the user leaves the page.
    window.addEventListener("pagehide", () => speech.stop());
})();

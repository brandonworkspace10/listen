// Listen — content scripts, 4 of 10: equations said in words, and spotting maths problems for the chat's quick
// actions (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;
    const S = L.state;

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
            const response = await Promise.race([L.askBackground({ action: "speak", math: { text: source } }), timeout]);
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
            const id = ++S.imageRequest;
            S.imageBusy = true;
            L.setButtonIcon("loading");
            L.showNote("Working out how to say the maths…", "info");
            await prepareMath([container]);
            if (id !== S.imageRequest) return; // cancelled
            S.imageBusy = false;
            if (S.note) S.note.hidden = true;
        }
        L.readAbout(mathOutlineTarget(container), mathSpeech(container));
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

    // For the other content scripts.
    Object.assign(L, {
        MATH_SELECTOR, SPOKEN_SYMBOLS, SUPERSCRIPT_DIGITS, mathContainerOf, mathOutlineTarget, texOf, mathSpeech,
        mathContainersIn, mathNeedingHelp, prepareMath, isHoverableMath, onListenMath, mathContext, rangeHasMath,
        mathsProblem,
    });
})();

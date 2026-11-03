// A small JavaScript scanner for the tests (plain JavaScript, no parser library). It's approximate but good
// enough for this codebase: it blanks out comments, strings and regular expressions, then finds the names a
// file declares and the names it uses, so the load test can spot a name that is used but never declared
// (a ReferenceError waiting to happen when that code runs).

const KEYWORDS = new Set(
    (
        "await break case catch class const continue debugger default delete do else export extends false " +
        "finally for function if import in instanceof let new null of return static super switch this throw " +
        "true try typeof var void while with yield async get set"
    ).split(" ")
);

// Same length as `code`, with comments, string contents, template text (not ${} code) and regex literals
// replaced by spaces, so positions still line up with the original.
export function blank(code) {
    let out = "";
    let i = 0;
    const n = code.length;
    const stack = []; // "tpl" inside template text, "expr" inside ${…}, "brace" for { … } within an expr
    let last = ""; // the last significant token (to tell a regex literal from a division)
    while (i < n) {
        const c = code[i];
        const d = code[i + 1];
        if (stack.length && stack[stack.length - 1] === "tpl") {
            if (c === "\\") {
                out += code[i + 1] === "\n" ? " \n" : "  ";
                i += 2;
            } else if (c === "`") {
                stack.pop();
                out += " ";
                i++;
                last = "x";
            } else if (c === "$" && d === "{") {
                stack.push("expr");
                out += "  ";
                i += 2;
                last = "(";
            } else {
                out += c === "\n" ? "\n" : " ";
                i++;
            }
            continue;
        }
        if (c === "/" && d === "/") {
            while (i < n && code[i] !== "\n") {
                out += " ";
                i++;
            }
            continue;
        }
        if (c === "/" && d === "*") {
            while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
                out += code[i] === "\n" ? "\n" : " ";
                i++;
            }
            out += "  ";
            i += 2;
            continue;
        }
        if (c === "'" || c === '"') {
            out += " ";
            i++;
            while (i < n && code[i] !== c) {
                if (code[i] === "\\") {
                    out += " ";
                    i++;
                }
                out += code[i] === "\n" ? "\n" : " ";
                i++;
            }
            out += " ";
            i++;
            last = "x";
            continue;
        }
        if (c === "`") {
            stack.push("tpl");
            out += " ";
            i++;
            continue;
        }
        if (c === "{") {
            if (stack.length) stack.push("brace");
            out += c;
            i++;
            last = c;
            continue;
        }
        if (c === "}") {
            if (stack.length && stack.pop() === "expr") {
                out += " ";
                i++;
                last = "x";
                continue;
            }
            out += c;
            i++;
            last = c;
            continue;
        }
        if (c === "/" && (/^[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || last === "" || last === "return" || last === "typeof")) {
            // A regular expression literal.
            out += " ";
            i++;
            let inClass = false;
            while (i < n && (inClass || code[i] !== "/")) {
                if (code[i] === "\\") {
                    out += " ";
                    i++;
                } else if (code[i] === "[") inClass = true;
                else if (code[i] === "]") inClass = false;
                out += " ";
                i++;
            }
            out += " ";
            i++;
            while (i < n && /[a-z]/.test(code[i])) {
                out += " ";
                i++;
            }
            last = "x";
            continue;
        }
        out += c;
        if (/[\w$]/.test(c)) last = /[\w$]$/.test(last) && /[\w$]/.test(code[i - 1] || "") ? last + c : c;
        else if (!/\s/.test(c)) last = c;
        i++;
    }
    return out;
}

const IDENT = /[A-Za-z_$][\w$]*/g;

// Identifiers bound by a parameter list or destructuring pattern: "a, { b, c: d = 1 }, ...e" → a, b, d, e.
function bindingNames(pattern) {
    const names = [];
    // Drop default values (up to the next comma or closing bracket at the same depth).
    let depth = 0;
    let skipping = false;
    let skipDepth = 0;
    let cleaned = "";
    for (const ch of pattern) {
        if ("([{".includes(ch)) depth++;
        if (")]}".includes(ch)) depth--;
        if (skipping) {
            if ((ch === "," && depth <= skipDepth) || depth < skipDepth) {
                skipping = false;
                cleaned += ch;
            }
            continue;
        }
        if (ch === "=") {
            skipping = true;
            skipDepth = depth;
            continue;
        }
        cleaned += ch;
    }
    for (const m of cleaned.matchAll(/([A-Za-z_$][\w$]*)\s*(:)?/g)) {
        if (m[2]) continue; // "key:" renames to the name after it
        if (!KEYWORDS.has(m[1])) names.push(m[1]);
    }
    return names;
}

// Every name the file declares anywhere (any scope): variables, functions, classes, parameters, catch and
// loop bindings. Over-collecting is fine: it only means fewer warnings.
export function declaredNames(code) {
    const b = blank(code);
    const names = new Set();
    for (const m of b.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // Destructuring: const { a, b: c } = …, const [[x, y], z] = …, for (const [k, v] of …).
    for (const m of b.matchAll(/\b(?:const|let|var)\s*(?=[{[])/g)) {
        let depth = 0;
        let end = m.index + m[0].length;
        for (; end < b.length; end++) {
            if ("[{".includes(b[end])) depth++;
            if ("]}".includes(b[end]) && --depth === 0) break;
        }
        bindingNames(b.slice(m.index + m[0].length + 1, end)).forEach((x) => names.add(x));
    }
    for (const m of b.matchAll(/\b(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of b.matchAll(/\bfunction\*?\s*[A-Za-z_$]?[\w$]*\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) bindingNames(m[1]).forEach((x) => names.add(x));
    for (const m of b.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*=>/g)) bindingNames(m[1]).forEach((x) => names.add(x));
    for (const m of b.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(m[1]);
    for (const m of b.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // Object-literal methods' parameters: "acceptNode(node) {", "onEnd() {".
    for (const m of b.matchAll(/(?:^|[{,]\s*)(?!(?:if|for|while|switch|catch|function|return)\b)[A-Za-z_$][\w$]*\s*\(([^()]*)\)\s*\{/gm)) {
        bindingNames(m[1]).forEach((x) => names.add(x));
    }
    return names;
}

// Names used as variables (not property names, object keys or method definitions), with line numbers.
export function usedNames(code) {
    const b = blank(code);
    const used = new Map(); // name → first line
    // The text just around a match, without whitespace (looking only nearby keeps this fast).
    const before = (i) => {
        let j = i - 1;
        while (j >= 0 && /\s/.test(b[j])) j--;
        return b.slice(Math.max(0, j - 2), j + 1);
    };
    const after = (i) => {
        let j = i;
        while (j < b.length && /\s/.test(b[j])) j++;
        return b.slice(j, j + 200);
    };
    let line = 1;
    let counted = 0;
    for (const m of b.matchAll(IDENT)) {
        const name = m[0];
        if (KEYWORDS.has(name) || /\d/.test(b[m.index - 1] || "")) continue; // also skips the "x8000" in 0x8000
        for (; counted < m.index; counted++) if (b[counted] === "\n") line++;
        const prev = before(m.index);
        const next = after(m.index + name.length);
        if (prev.endsWith(".") && !prev.endsWith("...")) continue; // a property: x.name, x?.name
        const last = prev.slice(-1);
        if ((last === "{" || last === ",") && next.startsWith(":")) continue; // { key: … }
        if ((last === "{" || last === ",") && /^\([^()]*\)\s*\{/.test(next)) continue; // { method() { … } }
        if (!used.has(name)) used.set(name, line);
    }
    return used;
}

// Names a file uses but never declares, minus the given globals: { name: line }.
export function undeclared(code, globals) {
    const declared = declaredNames(code);
    const result = {};
    for (const [name, line] of usedNames(code)) {
        if (!declared.has(name) && !globals.has(name)) result[name] = line;
    }
    return result;
}

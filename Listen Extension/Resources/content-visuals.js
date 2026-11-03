// Listen — content scripts, 8 of 10: charts and tables in chat answers (see content-core.js).

(() => {
    "use strict";

    const L = globalThis.listen;

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
        const el = document.createElementNS(L.SVG_NS, tag);
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

    // For the other content scripts.
    Object.assign(L, { cleanVisual, visualText, visualElement });
})();

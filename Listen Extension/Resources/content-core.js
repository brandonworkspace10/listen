// Listen — content scripts, 1 of 10: the shared namespace and state, the DEBUG flag, icons
// The speaker button reads highlighted text aloud with the best installed Mac voice, highlighting each word as
// it's spoken; the chat button and the chat bubble ask Gemini about it, through background.js and Listen's server.
//
// manifest.json loads these files in this order into each page, in Safari's isolated world for extensions (the
// page's own scripts can't see or change anything in them):
//   content-core.js         this file
//   content-speech.js       speaking with the Mac's voices
//   content-language.js     which language the text is in
//   content-maths.js        equations said in words; spotting maths problems for the chat
//   content-highlighter.js  the moving highlight, tables read row by row, outlines
//   content-bar.js          reading aloud, the floating bar, speed, settings
//   content-chat.js         the chat: panel, bubble, quick actions, conversation, gear, toolbar button
//   content-visuals.js      charts and tables in chat answers
//   content-targets.js      images, charts, code and links the bar can be used on
//   content-main.js         the selection, page events and starting up
//
// Each file is wrapped in its own function and shares things through one object, globalThis.listen, which every
// file calls L: modules and functions are L.speech, L.read() and so on, and the values more than one file changes
// are in L.state, which files call S. Anything from another file is looked up through L or S when it's used, so
// the files can call each other freely; only code that runs while loading depends on the order.

(() => {
    "use strict";

    const L = (globalThis.listen = {});

    // Development logging, such as which voice and language were picked. Keep it off in releases.
    L.DEBUG = false;
    L.debug = (...parts) => {
        if (L.DEBUG) console.info("[Listen]", ...parts);
    };

    // Values that more than one file reads or changes.
    L.state = {
        // The highlighted text the bar is for, where it is on the page, and the code block it's in (see Code in
        // content-targets.js), or null.
        selectedText: "",
        selectedRange: null,
        selectedCodeBlock: null,
        lastReadText: "", // the page text being (or last) read, for the chat box while reading
        lastReadRange: null,
        readingAnswer: null, // the chat answer being read aloud, if any
        speed: 1, // reading speed, 1 = normal (remembered in browser.storage.local)
        barHost: null, // the floating bar's element on the page, and its Shadow DOM
        barShadow: null,
        imageTarget: null, // the image or chart the bar is for, or null when it's for selected text
        imageKind: "image", // "image", "chart", "math" or "link"
        imageBusy: false, // waiting for a description
        imageRequest: 0, // id of the latest description request
        note: null, // short message under the bar (e.g. an image that can't be fetched)
        lastPointer: null, // where the mouse was last released, to place the bar for read-only code fields
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

    // For the other content scripts.
    Object.assign(L, { SVG_NS, svgIcon });
})();

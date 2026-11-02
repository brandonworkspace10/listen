// Listen — settings page: voice, default speed, hover buttons, the chat bubble and AI features. It opens in a
// tab when the toolbar button is clicked on a page where Listen can't run (on web pages the button opens the
// chat, whose gear shows the same settings).
// Everything is saved in browser.storage.local; content.js picks changes up straight away.

const SPEEDS = [0.75, 1, 1.25, 1.5, 2]; // the speed button's options, in order
const DEFAULTS = {
    voice: "", speed: 1, showImageButtons: false, showLinkButtons: false, showChatBubble: true, aiFeatures: true,
};
const DAILY_QUESTIONS = 30; // the proxy's limit, shown until the first answer reports the real one
const TEST_SENTENCE = "This is how Listen sounds when it reads to you.";

// Novelty voices macOS ships alongside the real ones (content.js never picks them either).
const NOVELTY_VOICES = new Set([
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News",
    "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox",
]);

const $ = (id) => document.getElementById(id);
const storage = browser.storage.local;
let settings = { ...DEFAULTS };

function save(values) {
    Object.assign(settings, values);
    storage.set(values).catch((e) => console.warn("[Listen] Couldn't save settings:", e));
}

// ----- Voices -----

const baseName = (voice) => voice.name.replace(/\s*\(.*\)$/, "");
const primaryLang = (lang) => lang.replace("_", "-").toLowerCase().split("-")[0];

// "Premium", "Enhanced" or "" from a voice's name or identifier.
function quality(voice) {
    const id = `${voice.name} ${voice.voiceURI}`.toLowerCase();
    if (id.includes("premium")) return "Premium";
    if (id.includes("enhanced")) return "Enhanced";
    return "";
}

// Older robotic-sounding voices; listed last (content.js only picks them if nothing better is installed).
const LOW_QUALITY_VOICES = new Set([
    "Eddy", "Flo", "Fred", "Grandma", "Grandpa", "Junior", "Kathy", "Ralph", "Reed",
    "Rocko", "Sandy", "Shelley",
]);

// Lower is better: Premium, Enhanced, standard, then the old robotic voices.
function order(voice) {
    if (LOW_QUALITY_VOICES.has(baseName(voice))) return 3;
    return { Premium: 0, Enhanced: 1, "": 2 }[quality(voice)];
}

// Installed voices for the Mac's language, best first.
function voicesForMyLanguage() {
    const mine = primaryLang(navigator.language || "en");
    return speechSynthesis
        .getVoices()
        .filter((v) => v.lang && primaryLang(v.lang) === mine && !NOVELTY_VOICES.has(baseName(v)))
        .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
}

// "Ava (Premium, US)"
function voiceLabel(voice) {
    const region = voice.lang.replace("_", "-").split("-")[1];
    const details = [quality(voice), region && region.toUpperCase()].filter(Boolean).join(", ");
    return details ? `${baseName(voice)} (${details})` : baseName(voice);
}

function fillVoices() {
    const select = $("voice");
    const voices = voicesForMyLanguage();
    if (!voices.length) return false;
    select.replaceChildren(new Option("Automatic (best available)", ""));
    for (const voice of voices) select.add(new Option(voiceLabel(voice), voice.voiceURI));
    // A saved voice that's no longer installed falls back to Automatic.
    select.value = voices.some((v) => v.voiceURI === settings.voice) ? settings.voice : "";
    return true;
}

// Safari loads the voice list lazily.
function loadVoices() {
    if (fillVoices()) return;
    speechSynthesis.addEventListener("voiceschanged", fillVoices, { once: true });
    setTimeout(fillVoices, 500);
}

function testVoice() {
    const button = $("test");
    if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
        return;
    }
    const voices = voicesForMyLanguage();
    const chosen = voices.find((v) => v.voiceURI === $("voice").value) || voices[0];
    const utterance = new SpeechSynthesisUtterance(TEST_SENTENCE);
    if (chosen) {
        utterance.voice = chosen;
        utterance.lang = chosen.lang;
    }
    utterance.rate = settings.speed;
    utterance.onend = utterance.onerror = () => (button.textContent = "Test");
    button.textContent = "Stop";
    speechSynthesis.speak(utterance);
}

// ----- Speed -----

function showSpeeds() {
    const group = $("speeds");
    group.replaceChildren(
        ...SPEEDS.map((value) => {
            const button = document.createElement("button");
            button.type = "button";
            button.setAttribute("role", "radio");
            button.setAttribute("aria-checked", String(value === settings.speed));
            button.textContent = `${value}x`;
            button.addEventListener("click", () => {
                save({ speed: value });
                showSpeeds();
            });
            return button;
        })
    );
}

// ----- Questions left today -----

function showUsage(usage) {
    const el = $("usage");
    if (!settings.aiFeatures) {
        el.textContent = "";
        return;
    }
    const today = new Date().toISOString().slice(0, 10); // the proxy counts by UTC day
    if (usage && usage.day === today && Number.isInteger(usage.remaining)) {
        const left = usage.remaining;
        el.textContent = `${left} of ${usage.limit} question${usage.limit === 1 ? "" : "s"} left today`;
    } else {
        const limit = (usage && usage.limit) || DAILY_QUESTIONS;
        el.textContent = `${limit} questions a day — none used yet today`;
    }
}

// ----- Start -----

async function start() {
    const stored = await storage.get([...Object.keys(DEFAULTS), "usage"]).catch(() => ({}));
    for (const key of Object.keys(DEFAULTS)) {
        if (typeof stored[key] === typeof DEFAULTS[key]) settings[key] = stored[key];
    }
    if (!SPEEDS.includes(settings.speed)) settings.speed = 1;

    loadVoices();
    $("voice").addEventListener("change", (event) => save({ voice: event.target.value }));
    $("test").addEventListener("click", testVoice);

    showSpeeds();

    for (const key of ["showImageButtons", "showLinkButtons", "showChatBubble", "aiFeatures"]) {
        const box = $(key);
        box.checked = settings[key];
        box.addEventListener("change", () => {
            save({ [key]: box.checked });
            if (key === "aiFeatures") showUsage(stored.usage);
        });
    }

    showUsage(stored.usage);
}

// Stop a voice test when the popup closes.
window.addEventListener("pagehide", () => speechSynthesis.cancel());

if (location.search.includes("page")) {
    document.body.classList.add("page");
    $("page-note").hidden = false;
}

start();

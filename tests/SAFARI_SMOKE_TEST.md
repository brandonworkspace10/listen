# Safari smoke test — before each release

About 20 minutes. Use the build you're about to submit, with the real Listen extension. Most steps use the test page https://listen-proxy.vercel.app/try, which has a paragraph, a table, maths, an email, code, an image, a chart and a link to try Listen on. Tick each box; if anything doesn't match "→", don't ship until it's fixed.

## 0. Automated tests (2 minutes)

From the repository folder in Terminal:

- [ ] `node tests/run.mjs` → ends with **All 2 test files passed.**
- [ ] `node tests/run.mjs --safari` → ends with **safari test: 16 passed, 0 failed**. It needs Safari ▸ Settings ▸ Advanced ▸ *Show features for web developers*, then Develop ▸ *Allow Remote Automation* (Safari switches this off now and then).

## 1. Install and turn on

- [ ] Run Listen from Xcode (Product ▸ Run, ⌘R), or open the archive you'll submit. → The Listen window shows the icon, the name, "Listen is on/off in Safari", three numbered steps, **Open Safari Settings** and **Privacy policy**.
- [ ] Click **Privacy policy**. → The policy opens in your web browser (not inside the Listen window).
- [ ] Click **Open Safari Settings**. → Safari's Extensions settings open and Listen quits. Tick **Listen** and allow it on every website.
- [ ] Open Listen again. → Green dot, "Listen is on in Safari".

## 2. Reading aloud

On a long article, for example https://en.wikipedia.org/wiki/Photosynthesis:

- [ ] Highlight a paragraph. → A small bar appears below it: speaker, **1x**, chat bubble.
- [ ] Click the speaker. → It reads in a natural voice; a yellow highlight follows the words; the speaker becomes ■.
- [ ] Click **1x** while it reads. → **1.25x**, and it carries on faster from the current word.
- [ ] Click ■. → It stops and the highlight fades.
- [ ] Highlight several cells of a table. → "Table with … columns and … rows", then each row as "Header: value".
- [ ] On https://listen-proxy.vercel.app/try, highlight the quadratic formula. → The maths is read in words ("x equals …").
- [ ] On https://es.wikipedia.org/wiki/Fotosíntesis, highlight a paragraph. → Read with a Spanish voice.

## 3. The bar on images, charts, code and links

On https://listen-proxy.vercel.app/try, first turn on **Buttons on images and charts** and **Buttons on links** (gear in the chat, see section 6).

- [ ] Rest the pointer on the picture of the sun. → A bar appears in its corner; the speaker reads its description.
- [ ] Rest on the rainfall chart. → A bar appears; the speaker describes what the chart shows.
- [ ] Rest on the Wikipedia link for a moment. → A bar appears; the speaker reads a short summary of the linked page.
- [ ] Highlight the code. → The speaker explains what the code does instead of reading symbols.
- [ ] Turn both switches off again. → Resting on the picture, chart and link shows nothing.

## 4. Chat: toolbar button and bubble

- [ ] With nothing highlighted, click Listen's toolbar icon. → The chat opens, ready to type, with nothing attached.
- [ ] The first time only: a note at the top says questions go to Google Gemini, with **Privacy policy** and **Got it**. Click **Got it**. → It goes away and doesn't come back, on this tab or others, even after reloading.
- [ ] Ask "What is photosynthesis?" → A short answer in a card, with speaker and copy buttons under it. Follow up with "explain that for a 10-year-old". → The answer builds on the previous one.
- [ ] Ask "make a bar chart of the planets' sizes". → A coloured bar chart with axis labels; hovering a bar shows its value. Click its copy button and paste into Numbers or Google Sheets. → A two-column table.
- [ ] Ask "table of the first 10 elements". → A table with a styled header and striped rows; copy and paste it into a spreadsheet. → Same rows and columns.
- [ ] Click the toolbar icon again. → The chat closes. Highlight a sentence and click the toolbar icon. → The chat opens with the sentence attached as a quoted chip.
- [ ] Drag the chat by its top bar, and drag the bubble. → Both move smoothly and stay fully on screen. Reload the page. → They're where you left them.
- [ ] Close the chat, reload, click the bubble. → The conversation is still there. Click **New chat**. → It's empty.

## 5. Quick actions for each kind of selection

On https://listen-proxy.vercel.app/try, highlight each one and click the bar's chat button.

- [ ] The paragraph under "Read aloud". → Tagged **Text**: Summarize, Translate, Explain.
- [ ] "5 + 7 + 8 + 6". → **Maths**: Hint, Solve, Explain. **Solve** → "= 26" large and bold, steps underneath. **Hint** → one nudge, no answer.
- [ ] "Solve 3x − 7 = 11. My answer: x = 5". → **Maths and your answer**: Check my answer first. Click it. → "Not quite." with a hint, and no answer given away.
- [ ] The email ("Hi Sam, …"). → **Message**: Reply, Shorter, More polite, Explain. **Reply** → a ready-to-send draft with [placeholders] for missing details. Try one real email in Gmail too.
- [ ] The code. → Explain, Line by line, Find bugs. The picture (from its hover bar). → Describe, Read text in image, Explain. The link (from its hover bar). → Summarize, Key points, Is it worth reading?

## 6. Settings (the gear in the chat)

- [ ] Click the gear. → Voice (Automatic first, plus Test), default speed, four switches, "N of 30 questions left today", and the privacy line with a **Privacy policy** link.
- [ ] Pick another voice and click **Test**. → That voice speaks; **Stop** stops it. Highlight text and listen. → The new voice reads.
- [ ] Turn off **Chat bubble on pages**. → The bubble disappears on every open tab; the toolbar icon still opens the chat. Turn it back on.
- [ ] Turn off **AI features (chat)**. → The chat closes, the bar's chat button and the bubble disappear, and the toolbar icon opens the settings page in a tab instead. Code selections are read as text. Turn it back on.

## 7. Where Listen can't run

- [ ] Open a new empty tab (Safari's start page) and click the toolbar icon. → Listen's settings open in a tab, with a note that it can't chat on this page.

## 8. When things go wrong

- [ ] Turn off Wi-Fi and ask a question in the chat. → A clear message ("Listen's server is unavailable…"), and everything else keeps working. Turn Wi-Fi back on.

## 9. Light and dark

- [ ] System Settings ▸ Appearance ▸ Dark. → The chat, the settings page and the Listen window are dark; text stays readable. Switch back to Light.

## Afterwards

- [ ] Put back anything you changed for the test: voice, speed and the switches.

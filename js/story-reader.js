/* ============================================================
   Story Reader — the user brings a real story (a diary page, an
   event, an action taken) and the AI interprets it through the
   22 Major Arcana as a MAP OF ACTION: archetypes of person/role,
   force, inner state, and threshold. No future-telling.

   Two calls through the proxy server (server.py → MiniMax M3):
     1. selection  — which 3-5 archetypes light up in the story
     2. reading    — the grounded interpretation, streamed
   The API key never leaves the server — visitors need no key.
   ============================================================ */

const MODEL = "MiniMax-M3";

/* ---------- element references ---------- */

const $ = (id) => document.getElementById(id);

const stepWrite    = $("step-write");
const cardsEl      = $("cards");
const readingEl    = $("reading");
const slotsEl      = $("slots");
const readingBody  = $("reading-body");
const btnReadStory = $("btn-read-story");
const btnFollowup  = $("btn-followup");
const followupIn   = $("followup");
const storyIn      = $("story");
const focusIn      = $("focus");
const storyCount   = $("story-count");
const readerStatus = $("reader-status");

/* ---------- state ---------- */

let chosen = [];        // card objects selected for the story
let messages = [];      // LLM conversation history (the reading call)
let busy = false;

/* ---------- status helper ---------- */

function setStatus(text, kind) {
  readerStatus.textContent = text;
  readerStatus.className = "reader-status" + (kind ? " " + kind : "");
}

/* ---------- word count ---------- */

storyIn.addEventListener("input", () => {
  storyCount.textContent = storyIn.value.length
    ? storyIn.value.length + " / 5000"
    : "";
});

/* ---------- streaming call through the proxy server ---------- */

// Where the AI is proxied:
//  - on GitHub Pages (thefool.im / *.github.io): the public NAS endpoint
//    (Tailscale Funnel), which holds the API key server-side;
//  - everywhere else (NAS, local dev): the same-origin relative path.
const HOSTED_API =
  /(^|\.)github\.io$/.test(location.hostname) ||
  location.hostname === "thefool.im";

function apiEndpoint() {
  return HOSTED_API
    ? "https://augmentor.tail1ce34f.ts.net:8443/tarot/api/read"
    : "api/read";
}

function stripThink(text) {
  return text.replace(/<think[^>]*>[\s\S]*?<\/think>/g, "");
}

async function streamChat(msgs, onDelta) {
  const res = await fetch(apiEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: msgs }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error("HTTP " + res.status + (detail ? " — " + detail : ""));
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* partial JSON line — skip */ }
    }
  }
}

// Collect an entire streamed reply (no live display) — used for the
// JSON selection call.
async function collectChat(msgs) {
  let full = "";
  await streamChat(msgs, (d) => { full += d; });
  return stripThink(full);
}

/* ---------- markdown-lite rendering (same as the card reader) ---------- */

function inlineMd(s) {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
}

function appendBody(container, lines) {
  const list = lines.filter((l) => /^\s*[-*]\s+/.test(l));
  if (list.length) {
    const ul = document.createElement("ul");
    list.forEach((l) => {
      const li = document.createElement("li");
      li.innerHTML = inlineMd(l.replace(/^\s*[-*]\s+/, ""));
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }
  const para = lines
    .filter((l) => l.trim() && !/^\s*[-*]\s+/.test(l))
    .join(" ")
    .trim();
  if (para) {
    const p = document.createElement("p");
    p.innerHTML = inlineMd(para);
    container.appendChild(p);
  }
}

function renderMarkdownLite(container, text) {
  container.innerHTML = "";
  stripThink(text).split(/\n{2,}/).forEach((block) => {
    const lines = block.trim().split("\n");
    if (!lines[0].trim()) return;
    if (/^##\s+/.test(lines[0])) {
      const h = document.createElement("h3");
      h.innerHTML = inlineMd(lines[0].replace(/^##\s+/, ""));
      container.appendChild(h);
      appendBody(container, lines.slice(1));
    } else {
      appendBody(container, lines);
    }
  });
}

function liveEl() {
  let live = readingBody.querySelector(".reading-live");
  if (!live) {
    live = document.createElement("p");
    live.className = "reading-live";
    readingBody.appendChild(live);
  }
  return live;
}

/* ---------- the prompts ---------- */

function cardCatalog(compact) {
  // compact: one line per card for the selection call
  return CARDS.map((c) =>
    compact
      ? c.n + ". " + c.name + " — " + c.meaning.split(". ")[0] + "."
      : c.n + ". " + c.name + " — " + c.meaning
  ).join("\n");
}

const SELECTION_SYSTEM = [
  "You choose tarot archetypes for a story interpretation.",
  "The 22 Major Arcana are a map of human action, not omens:",
  "- person / role in the story: Emperor, Empress, Hierophant, Hermit, Lovers…",
  "- force acting on the person, beyond their control: Wheel of Fortune, Tower, Death, Moon…",
  "- inner state: Sun, Star, Moon, Strength, Temperance…",
  "- threshold / moment of decision: Fool, Lovers, Judgement…",
  "",
  "Read the user's story and choose the 3 to 5 archetypes that best express what is actually happening in the action. Every choice must be supportable by concrete evidence in the story's details. A blocked, strained, or shadowed expression of an archetype is the same archetype — name it, not a substitute.",
  "",
  "For each chosen card give its axis: \"person\", \"force\", \"state\", or \"threshold\".",
  "Never choose cards as predictions of what will happen next.",
  "",
  "Reply with JSON only, exactly in this form:",
  '{"cards":[{"n":0,"name":"The Fool","axis":"person"},{"n":16,"name":"The Tower","axis":"force"}]}',
].join("\n");

const READING_SYSTEM = [
  "You are a tarot interpreter who works with the 22 Major Arcana as a MAP OF HUMAN ACTION, not as a way to read the future. The user has shared a real story — a diary page, an event, an action they took. Your task is to help them see their own action through the archetypes.",
  "",
  "Rules:",
  "1. Never predict the future. Never give prescriptive advice. You are a mirror for reflection, not a fortune-teller.",
  "2. Ground every claim in concrete details of the story — quote or paraphrase the user's own words as evidence.",
  "3. Each card is an archetype: a person or role, a force acting on the person, an inner state, or a threshold. Explain what that archetype was doing in this story — not what it means in general.",
  "4. One story can express several archetypes at once; each has its own evidence. A blocked, internalized, or shadowed expression is the same archetype — say so when it appears that way.",
  "5. The Fool's Journey is the arc of every story: departure and potential (Fool) → will and tools (Magician, Chariot) → structure and teaching (Emperor, Hierophant) → crisis and reversal (Wheel, Death, Tower) → integration (Star, Sun, World).",
  "6. Tone: warm, clear, reflective — a thoughtful person sitting with you after the event. No clinical jargon, no mysticism.",
  "",
  "Reply in exactly this structure, using markdown:",
  "## <Card Name> — <four to eight words: what it was doing in the story>",
  "2-4 sentences, grounded in specific details of the story (cite them).",
  "One section per card, in the order given, then:",
  "## The shape of your story",
  "3-5 sentences: where this story sits on the Fool's Journey arc, what was in play, and what the story reveals about how the person acted.",
  "## Questions to sit with",
  "Three short reflection questions — invitations, not advice.",
].join("\n");

function buildReadingUserMessage(story, focus) {
  const lines = ["Story:", '"' + story + '"'];
  if (focus) lines.push('What the reader wants to see: "' + focus + '"');
  lines.push("", "The archetypes that lit up in this story:");
  chosen.forEach((c, i) => {
    const card = CARDS[c.n];
    const els = card.elements
      .map((e) => (typeof e === "object" ? e.n + ": " + e.t : e))
      .join("; ");
    lines.push(
      (i + 1) + ". " + card.name + " (number " + card.n +
      (c.axis ? ", axis: " + c.axis : "") +
      ") — Core meaning: " + card.meaning +
      ". Key elements: " + els + "."
    );
  });
  return lines.join("\n");
}

/* ---------- step 1 — select the archetypes ---------- */

const AXIS_LABELS = {
  person: "Person / Role",
  force: "Force",
  state: "Inner State",
  threshold: "Threshold",
};

async function selectCards(story, focus) {
  const user =
    "Story: \"" + story + '"' +
    (focus ? '\nWhat the reader wants to see: "' + focus + '"' : "") +
    "\n\nThe 22 archetypes:\n" + cardCatalog(true);
  const raw = await collectChat([
    { role: "system", content: SELECTION_SYSTEM },
    { role: "user", content: user },
  ]);

  // Extract the first JSON object in the reply (the model may add
  // a code fence or a stray word — be forgiving, then strict).
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("the cards could not be read — please try again");
  let data;
  try { data = JSON.parse(m[0]); }
  catch { throw new Error("the cards could not be read — please try again"); }

  const list = Array.isArray(data.cards) ? data.cards : [];
  const cards = [];
  for (const item of list.slice(0, 5)) {
    const n = Number(item && item.n);
    if (!Number.isInteger(n) || n < 0 || n > 21) continue;
    const card = CARDS[n];
    cards.push({
      n: card.n,
      name: card.name,
      axis: AXIS_LABELS[item.axis] ? item.axis : "",
    });
  }
  if (cards.length < 3) throw new Error("too few archetypes came through — please try again");
  return cards;
}

/* ---------- render the chosen cards ---------- */

function renderChosen() {
  slotsEl.innerHTML = "";
  chosen.forEach((c, i) => {
    const card = CARDS[c.n];
    const slot = document.createElement("div");
    slot.className = "card-slot";
    slot.innerHTML =
      '<div class="card-inner">' +
        '<div class="card-face card-back" aria-hidden="true"><span>&#10022;</span></div>' +
        '<div class="card-face card-front">' +
          '<img src="images/' + card.file + '.png" alt="' + card.name + ' tarot card">' +
          '<span class="slot-card-name">' + card.name + "</span>" +
        "</div>" +
      "</div>" +
      '<span class="slot-label">' + (AXIS_LABELS[c.axis] || "Archetype") + "</span>";
    setTimeout(() => slot.classList.add("flipped"), 620 + i * 280);
    slotsEl.appendChild(slot);
  });
}

/* ---------- step 2 — the streamed interpretation ---------- */

async function readStory() {
  if (busy) return;
  const story = storyIn.value.trim();
  const focus = focusIn.value.trim();
  if (!story) {
    setStatus("Write or paste your story first — even a few sentences are enough.", "err");
    storyIn.focus();
    return;
  }

  busy = true;
  btnReadStory.disabled = true;
  btnFollowup.disabled = true;
  setStatus("");
  readingEl.hidden = true;
  readingBody.innerHTML = "";
  messages = [];

  try {
    setStatus("Holding your story up to the light…");
    chosen = await selectCards(story, focus);
    renderChosen();
    cardsEl.hidden = false;
    cardsEl.scrollIntoView({ behavior: "smooth", block: "center" });

    setStatus("");
    messages = [
      { role: "system", content: READING_SYSTEM },
      { role: "user", content: buildReadingUserMessage(story, focus) },
    ];
    let raw = "";
    await streamChat(messages, (d) => {
      raw += d;
      liveEl().textContent = stripThink(raw);
    });
    if (!raw.trim()) throw new Error("empty response");
    messages.push({ role: "assistant", content: raw });
    renderMarkdownLite(readingBody, raw);
    readingEl.hidden = false;
    readingEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus("Reading failed: " + err.message, "err");
  } finally {
    busy = false;
    btnReadStory.disabled = false;
    btnFollowup.disabled = false;
  }
}

btnReadStory.addEventListener("click", readStory);

/* ---------- follow-up: look closer ---------- */

async function sendFollowup() {
  const q = followupIn.value.trim();
  if (!q || busy || !messages.length) return;
  followupIn.value = "";
  busy = true;
  btnFollowup.disabled = true;
  setStatus("");

  const qEl = document.createElement("p");
  qEl.className = "followup-q";
  qEl.textContent = "You asked: " + q;
  readingBody.appendChild(qEl);

  messages.push({ role: "user", content: q });
  let raw = "";
  try {
    await streamChat(messages, (d) => {
      raw += d;
      liveEl().textContent = stripThink(raw);
    });
    if (!raw.trim()) throw new Error("empty response");
    messages.push({ role: "assistant", content: raw });
    const live = readingBody.querySelector(".reading-live");
    if (live) live.remove();
    const aEl = document.createElement("div");
    aEl.className = "followup-a";
    renderMarkdownLite(aEl, raw);
    readingBody.appendChild(aEl);
    aEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    setStatus("Follow-up failed: " + err.message, "err");
  } finally {
    busy = false;
    btnFollowup.disabled = false;
  }
}

btnFollowup.addEventListener("click", sendFollowup);
followupIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendFollowup();
});

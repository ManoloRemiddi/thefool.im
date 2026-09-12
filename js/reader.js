/* ============================================================
   AI Card Reader — draws random Major Arcana cards and streams
   a tarot reading from the site's local server (server.py),
   which proxies the request to MiniMax M3. The API key never
   leaves the server — visitors need no key and pay nothing.
   ============================================================ */

/* ---------- spread definitions ---------- */

const SPREADS = {
  "13": {
    title: "Card of the Day + Past · Present · Future",
    positions: [
      { label: "Card of the Day", big: true },
      { label: "Past" },
      { label: "Present" },
      { label: "Future" },
    ],
  },
  "cross5": {
    title: "The Five-Card Cross",
    positions: [
      { label: "Situation" },
      { label: "Challenge" },
      { label: "Influence" },
      { label: "Outcome" },
      { label: "Counsel" },
    ],
  },
};

const MODEL = "MiniMax-M3";

/* ---------- element references ---------- */

const $ = (id) => document.getElementById(id);

const stepChoose     = $("step-choose");
const stepDraw       = $("step-draw");
const spreadEl       = $("spread");
const stepRead       = $("step-read");
const readingEl      = $("reading");
const slotsEl        = $("slots");
const readingBody    = $("reading-body");
const btnDraw        = $("btn-draw");
const btnRead        = $("btn-read");
const btnDrawAgain   = $("btn-draw-again");
const btnFollowup    = $("btn-followup");
const followupIn     = $("followup");
const questionIn     = $("question");
const drawHint       = $("draw-hint");
const readerStatus   = $("reader-status");

/* ---------- state ---------- */

let spreadKey = null;
let drawn = [];        // card objects in slot order
let messages = [];     // LLM conversation history
let readingActive = false;

/* ---------- status helper ---------- */

function setStatus(text, kind) {
  readerStatus.textContent = text;
  readerStatus.className = "reader-status" + (kind ? " " + kind : "");
}

/* ---------- step flow ---------- */

function chooseSpread(key) {
  spreadKey = key;
  stepChoose.hidden = true;
  stepDraw.hidden = false;
  drawHint.textContent = "Spread: " + SPREADS[key].title;
  stepDraw.scrollIntoView({ behavior: "smooth", block: "center" });
}

document.querySelectorAll(".spread-option").forEach((b) =>
  b.addEventListener("click", () => chooseSpread(b.dataset.spread))
);

/* ---------- shuffle & draw ---------- */

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function renderSlots() {
  const sp = SPREADS[spreadKey];
  slotsEl.innerHTML = "";
  drawn.forEach((card, i) => {
    const slot = document.createElement("div");
    slot.className = "card-slot" + (sp.positions[i].big ? " big" : "");
    slot.innerHTML =
      '<div class="card-inner">' +
        '<div class="card-face card-back" aria-hidden="true"><span>&#10022;</span></div>' +
        '<div class="card-face card-front">' +
          '<img src="images/' + card.file + '.png" alt="' + card.name + ' tarot card">' +
          '<span class="slot-card-name">' + card.name + "</span>" +
        "</div>" +
      "</div>" +
      '<span class="slot-label">' + sp.positions[i].label + "</span>";
    // flip face-up after the fly-in animation, staggered per slot
    setTimeout(() => slot.classList.add("flipped"), 620 + i * 280);
    slotsEl.appendChild(slot);
  });
}

function draw() {
  const sp = SPREADS[spreadKey];
  drawn = shuffle(CARDS).slice(0, sp.positions.length);
  renderSlots();
  spreadEl.hidden = false;
  stepRead.hidden = false;
  readingEl.hidden = true;
  readingBody.innerHTML = "";
  messages = [];
  setStatus("");
  spreadEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

btnDraw.addEventListener("click", draw);
btnDrawAgain.addEventListener("click", draw);

/* ---------- prompt ---------- */

const SYSTEM_PROMPT = [
  "You are a tarot reader who works only with the 22 Major Arcana.",
  "",
  "How to read (apply in this order):",
  "1. Each card is an archetype: use its name, number, core meaning, and key image elements.",
  "2. The card's position in the spread gives it its role — read the card through that position.",
  "3. Weave the cards into one coherent story using the Fool's Journey: early cards (Fool to Chariot) urge action; middle cards (Justice to Tower) ask for reckoning; late cards (Star to World) speak of recovery and completion. The journey is a cycle — the World leads back to the Fool.",
  "4. Write in a warm, clear, insightful voice. Be specific to the querent's question where one is given.",
  "5. Offer guidance, not prediction: frame things as possibilities and inner work, never as fixed fate.",
  "",
  "Reply in exactly this structure, using markdown:",
  "## <Card Name> — <Position>",
  "2-4 sentences for each card (3-5 for a Card of the Day).",
  "One section per card, in spread order, then:",
  "## Overall message",
  "3-5 sentences weaving all the cards into one guidance for the querent.",
].join("\n");

function buildUserMessage(question) {
  const sp = SPREADS[spreadKey];
  const lines = [
    question ? 'Question: "' + question + '"' : "Question: none — a general reading.",
    "Spread: " + sp.title,
    "",
  ];
  drawn.forEach((card, i) => {
    const els = card.elements
      .map((e) => (typeof e === "object" ? e.n + ": " + e.t : e))
      .join("; ");
    lines.push(
      (i + 1) + ". " + sp.positions[i].label + ": " + card.name +
      " (number " + card.n + ") — Core meaning: " + card.meaning +
      ". Key elements: " + els + "."
    );
  });
  return lines.join("\n");
}

/* ---------- streaming call through the proxy server ---------- */

// Where the AI reading is proxied:
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

/* ---------- markdown-lite rendering ---------- */

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

/* ---------- the reading ---------- */

async function startReading() {
  if (readingActive) return;
  readingActive = true;
  btnRead.disabled = true;
  btnFollowup.disabled = true;
  readingEl.hidden = false;
  readingBody.innerHTML = "";
  setStatus("");

  messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(questionIn.value.trim()) },
  ];

  let raw = "";
  try {
    await streamChat(messages, (d) => {
      raw += d;
      liveEl().textContent = stripThink(raw);
    });
    if (!raw.trim()) throw new Error("empty response");
    messages.push({ role: "assistant", content: raw });
    renderMarkdownLite(readingBody, raw);
    readingEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    readingBody.innerHTML = "";
    setStatus("Reading failed: " + err.message, "err");
  } finally {
    readingActive = false;
    btnRead.disabled = false;
    btnFollowup.disabled = false;
  }
}

btnRead.addEventListener("click", startReading);

async function sendFollowup() {
  const q = followupIn.value.trim();
  if (!q || readingActive || !messages.length) return;
  followupIn.value = "";
  readingActive = true;
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
    readingActive = false;
    btnFollowup.disabled = false;
  }
}

btnFollowup.addEventListener("click", sendFollowup);
followupIn.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendFollowup();
});

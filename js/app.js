/* ============================================================
   Major Arcana — single-page gallery
   Data distilled from historyoftarot.com/major-arcana/
   ============================================================ */

// Card data (CARDS) is loaded from js/cards-data.js


/* ---------- helpers ---------- */

const ROMAN = ["0","I","II","III","IV","V","VI","VII","VIII","IX","X","XI","XII","XIII","XIV","XV","XVI","XVII","XVIII","XIX","XX","XXI"];

const strip     = document.getElementById("strip");
const detail    = document.getElementById("detail");
const cardImg   = document.getElementById("card-img");
const elNumber  = document.getElementById("card-number");
const elName    = document.getElementById("card-name");
const elMeaning = document.getElementById("card-meaning");
const elBullets = document.getElementById("card-elements");
const elIndex   = document.getElementById("card-index");
const btnPrev   = document.getElementById("prev-card");
const btnNext   = document.getElementById("next-card");

let current = -1;
let pendingTimer = null;
const loaded = new Map(); // file -> true once decoded

function preload(file) {
  if (loaded.has(file)) return;
  const img = new Image();
  img.onload = () => loaded.set(file, true);
  img.src = `images/${file}.png`;
}

/* ---------- navigator strip ---------- */

CARDS.forEach((card, i) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tile";
  btn.dataset.index = String(i);
  btn.setAttribute("aria-pressed", "false");

  const img = document.createElement("img");
  img.src = `images/thumb/${card.file}.png`;
  img.alt = card.name;
  img.loading = "lazy";

  const label = document.createElement("span");
  label.className = "tile-name";
  label.textContent = card.name;

  btn.append(img, label);
  btn.addEventListener("click", () => show(i));
  strip.appendChild(btn);
});

const tiles = Array.from(strip.children);

function updateActiveTile() {
  tiles.forEach((t, i) => {
    t.classList.toggle("active", i === current);
    t.setAttribute("aria-pressed", i === current ? "true" : "false");
  });
}

/* ---------- detail rendering ---------- */

function renderElements(card) {
  elBullets.textContent = "";
  card.elements.forEach((item) => {
    const li = document.createElement("li");
    if (item && typeof item === "object") {
      const b = document.createElement("b");
      b.textContent = item.n;
      li.append(b, ": " + item.t);
    } else {
      li.textContent = item;
    }
    elBullets.appendChild(li);
  });
}

function show(i, immediate = false) {
  if (i === current) return;
  current = i;
  const card = CARDS[i];
  updateActiveTile();
  document.title = `${card.name} — Major Arcana`;

  const apply = () => {
    elNumber.textContent  = ROMAN[card.n];
    elName.textContent    = card.name;
    elMeaning.textContent = card.meaning;
    renderElements(card);
    elIndex.textContent   = `${i + 1} / ${CARDS.length}`;
    cardImg.alt = `${card.name} tarot card`;
    cardImg.src = `images/${card.file}.png`;
    const reveal = () => {
      detail.classList.remove("fading");
      // On a user-initiated card change, bring the details into view
      // (skipped for the initial load, which uses immediate=true).
      if (!immediate) {
        detail.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    cardImg.complete && cardImg.naturalWidth > 0
      ? reveal()
      : cardImg.addEventListener("load", reveal, { once: true });
  };

  if (immediate) { apply(); return; }
  detail.classList.add("fading");
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(apply, 190);
  preload(card.file);
  preload(CARDS[(i + 1) % CARDS.length].file);
}

btnPrev.addEventListener("click", () => show((current - 1 + CARDS.length) % CARDS.length));
btnNext.addEventListener("click", () => show((current + 1) % CARDS.length));

document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") show((current + 1) % CARDS.length);
  else if (e.key === "ArrowLeft") show((current - 1 + CARDS.length) % CARDS.length);
});

/* ---------- initial state ---------- */
show(0, true);

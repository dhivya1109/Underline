// Underline web app — one app for phones and laptops.
// Shows a random quote from the shared sheet, and saves new ones to it.

const ENDPOINT = self.UNDERLINE_ENDPOINT;
const MAX_QUOTE_LENGTH = 85;         // two lines at full size
const REFRESH_EVERY_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const quoteEl = $("quote");
const byEl = $("by");

// ---------- Local storage (wrapped: it can be unavailable in private modes) ----------

const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem("underline:" + key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem("underline:" + key, JSON.stringify(value));
    } catch {}
  }
};

const settings = () => ({
  name: store.get("name", ""),
  linkedin: store.get("linkedin", ""),
  code: store.get("code", ""),
  theme: store.get("theme", "auto")
});
const isSetUp = () => Boolean(settings().name && settings().code);

// ---------- Talking to the sheet ----------

async function call(payload) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      // text/plain keeps this a "simple" request, so the browser skips the CORS preflight
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, secret: settings().code })
    });
  } catch {
    throw new Error("Couldn't reach Google — check your internet");
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("Unexpected reply from Google");
  if (!data.ok) {
    throw new Error(/secret/i.test(data.error || "") ? "That invite code isn't right" : data.error || "Something went wrong");
  }
  return data;
}

async function refresh(force) {
  if (!isSetUp()) return null;
  if (!force && Date.now() - store.get("lastRefresh", 0) < REFRESH_EVERY_MS) return null;
  try {
    const data = await call({ action: "list" });
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    store.set("quotes", quotes);
    store.set("lastRefresh", Date.now());
    return quotes;
  } catch {
    return null; // offline or Google is slow: keep using the saved quotes
  }
}

// ---------- Choosing a quote ----------

// Only quotes that fit in two lines at full size are shown
const fitting = (quotes) => quotes.filter((q) => q.quote && q.quote.length <= MAX_QUOTE_LENGTH);

// Work through a shuffled queue of quote texts so nothing repeats until all have been shown
function nextQuote() {
  const quotes = fitting(store.get("quotes", []));
  if (!quotes.length) return null;
  const byText = new Map(quotes.map((q) => [q.quote, q]));
  let queue = store.get("queue", []).filter((text) => byText.has(text));
  if (!queue.length) queue = shuffle([...byText.keys()]);
  const text = queue.shift();
  store.set("queue", queue);
  return byText.get(text);
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

// ---------- Rendering ----------

function render(q) {
  quoteEl.className = "";
  quoteEl.textContent = q.quote;
  byEl.replaceChildren();
  if (q.contributor_name) byEl.append("— ", link(q.contributor_name, q.social_link));
  fadeIn();
}

function renderEmpty(message) {
  quoteEl.className = "empty";
  quoteEl.textContent = message;
  byEl.replaceChildren();
  fadeIn();
}

function fadeIn() {
  for (const el of [quoteEl, byEl]) {
    el.classList.remove("visible");
    void el.offsetWidth; // restart the fade
    el.classList.add("visible");
  }
}

function link(text, href) {
  if (!/^https?:\/\//i.test(href || "")) return text;
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function showNext() {
  const q = nextQuote();
  if (q) render(q);
  else renderEmpty(isSetUp() ? "Nothing underlined yet. Tap Underline. to add the first quote." : "Welcome to Underline.");
}

// Tap the quote for the next one (but not when selecting text to copy)
quoteEl.addEventListener("click", () => {
  if (quoteEl.classList.contains("empty")) return;
  if (String(window.getSelection())) return;
  showNext();
});

// ---------- Menu ----------

const logo = $("logo");
const menu = $("menu");

function toggleMenu(open) {
  menu.hidden = !open;
  logo.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector("button").focus();
}

logo.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu(menu.hidden);
});
menu.addEventListener("click", (e) => {
  const action = e.target.dataset.action;
  toggleMenu(false);
  if (action === "add") openCard("");
  if (action === "settings") openSettings();
});
document.addEventListener("click", () => toggleMenu(false));

// ---------- The add card ----------

const cardLayer = $("card-layer");
const cardText = $("card-text");
const cardStatus = $("card-status");
let cardSource = { title: "", url: "" };
let saving = false;

const clean = (text) =>
  (text || "")
    .replace(/­/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();

function setCardStatus(text, kind = "") {
  cardStatus.textContent = text;
  cardStatus.className = "status " + kind;
}

function showCount() {
  const n = clean(cardText.value).length;
  if (n > MAX_QUOTE_LENGTH) setCardStatus(`${n} / ${MAX_QUOTE_LENGTH} — trim it to fit two lines`, "err");
  else setCardStatus(`${n} / ${MAX_QUOTE_LENGTH}`);
}

function openCard(text, source = { title: "", url: "" }) {
  if (!isSetUp()) return openSettings();
  cardSource = source;
  cardText.value = clean(text);
  $("card-mode").textContent = text ? "Review" : "Add a quote";
  $("card-source").textContent = source.title ? "From " + source.title : "";
  cardLayer.hidden = false;
  showCount();
  cardText.focus();
  cardText.setSelectionRange(cardText.value.length, cardText.value.length);
}

function closeCard() {
  cardLayer.hidden = true;
  saving = false;
}

$("card").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (saving) return;
  const quote = clean(cardText.value);
  if (!quote) return setCardStatus("Write something first", "err");
  if (quote.length > MAX_QUOTE_LENGTH) return showCount();

  const s = settings();
  const entry = {
    quote,
    contributor_name: s.name,
    social_link: s.linkedin,
    source_title: cardSource.title,
    source_url: cardSource.url,
    added_at: new Date().toISOString()
  };

  saving = true;
  setCardStatus("Saving…");
  try {
    const result = await call(entry);
    setCardStatus(result.duplicate ? "Already in the list" : "Underlined", "ok");
    if (!result.duplicate) {
      store.set("quotes", [...store.get("quotes", []), entry]);
      render(entry);
    }
    setTimeout(closeCard, 900);
  } catch (err) {
    saving = false;
    setCardStatus(err.message, "err");
  }
});

cardText.addEventListener("input", showCount);
cardText.addEventListener("keydown", (e) => {
  // Enter saves on a laptop; on phones the keyboard's "done" key does the same
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("card").requestSubmit();
  }
});

// Laptop: copy a line anywhere, open Underline, press Ctrl+V
document.addEventListener("paste", (e) => {
  if (!cardLayer.hidden || !$("settings-layer").hidden) return;
  const text = e.clipboardData && e.clipboardData.getData("text");
  if (!text) return;
  e.preventDefault();
  openCard(text);
});

// ---------- Settings ----------

const settingsLayer = $("settings-layer");
const settingsStatus = $("settings-status");

function openSettings() {
  const s = settings();
  $("s-name").value = s.name;
  $("s-linkedin").value = s.linkedin;
  $("s-code").value = s.code;
  document.querySelectorAll('input[name="theme"]').forEach((r) => (r.checked = r.value === s.theme));
  $("settings-intro").textContent = isSetUp()
    ? "Lines worth keeping, underlined by friends."
    : "Welcome! Add your name and the invite code a friend gave you.";
  settingsStatus.textContent = "";
  settingsLayer.hidden = false;
  $("s-name").focus();
}

function closeSettings() {
  if (!isSetUp()) return; // first run: setup must be finished
  settingsLayer.hidden = true;
}

function applyTheme(pref) {
  const light = pref === "light" || (pref === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

document.querySelectorAll('input[name="theme"]').forEach((radio) =>
  radio.addEventListener("change", () => {
    store.set("theme", radio.value);
    applyTheme(radio.value);
  })
);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme(settings().theme));

$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("s-name").value.trim();
  const code = $("s-code").value.trim();
  let linkedin = $("s-linkedin").value.trim();

  const fail = (text) => {
    settingsStatus.textContent = text;
    settingsStatus.className = "status err";
  };
  if (!name) return fail("Add your name first");
  if (!code) return fail("Add your invite code");
  // Accept "www.linkedin.com/in/..." and add the https:// for them
  if (linkedin && !/^https?:\/\//i.test(linkedin)) linkedin = "https://" + linkedin;
  if (linkedin && !/^https?:\/\/[^\s/]+\.\S+$/i.test(linkedin)) return fail("That doesn't look like a link");
  $("s-linkedin").value = linkedin;

  // Check the invite code before keeping it
  const oldCode = store.get("code", "");
  store.set("code", code);
  settingsStatus.className = "status";
  settingsStatus.textContent = "Checking…";
  try {
    await call({ ping: true });
  } catch (err) {
    store.set("code", oldCode);
    return fail(err.message);
  }

  store.set("name", name);
  store.set("linkedin", linkedin);
  settingsStatus.textContent = "Saved";
  settingsStatus.className = "status ok";

  const firstRun = !store.get("quotes", []).length;
  await refresh(true);
  if (firstRun) showNext();
  setTimeout(closeSettings, 600);
});

// ---------- Shared closing behaviour ----------

document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", () => (b.closest("#card-layer") ? closeCard() : closeSettings()))
);
for (const layer of [cardLayer, settingsLayer]) {
  layer.addEventListener("click", (e) => {
    if (e.target === layer) layer === cardLayer ? closeCard() : closeSettings();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!cardLayer.hidden) closeCard();
  else if (!settingsLayer.hidden) closeSettings();
  else toggleMenu(false);
});

// ---------- Start ----------

async function start() {
  applyTheme(settings().theme);
  showNext();

  if (!isSetUp()) {
    openSettings();
    return;
  }

  // Android "Share → Underline" opens the app with the shared text in the address
  const params = new URLSearchParams(location.search);
  if (params.has("text") || params.has("title") || params.has("url")) {
    let text = params.get("text") || "";
    let url = params.get("url") || "";
    // Some apps put the page link inside the text; pull it out
    const found = text.match(/https?:\/\/\S+/);
    if (found) {
      url = url || found[0];
      text = text.replace(found[0], "");
    }
    history.replaceState(null, "", location.pathname);
    openCard(text, { title: params.get("title") || "", url });
  }

  const fresh = await refresh(!store.get("quotes", []).length);
  if (fresh && quoteEl.classList.contains("empty")) showNext();
}

start();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

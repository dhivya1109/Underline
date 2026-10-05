// Ask the sheet for fresh quotes at most this often; new tabs in between use the cache.
const REFRESH_EVERY_MS = 10 * 60 * 1000;

const quoteEl = document.getElementById("quote");
const byEl = document.getElementById("by");

async function main() {
  const { quotes = [], queue = [], next = null } = await chrome.storage.local.get(["quotes", "queue", "next"]);

  if (next) {
    // Something was just underlined — show it first.
    render(next);
    await chrome.storage.local.remove("next");
  } else if (quotes.length) {
    const picked = pick(quotes, queue);
    render(picked.quote);
    await chrome.storage.local.set({ queue: picked.queue });
  } else {
    renderEmpty();
  }

  if (location.hash === "#add") compose();

  const fresh = await refresh(quotes.length === 0);
  if (!quotes.length && !next && fresh?.length) {
    // First run: the cache was empty, so show a quote as soon as they arrive.
    const picked = pick(fresh, []);
    render(picked.quote);
    await chrome.storage.local.set({ queue: picked.queue });
  }
}

// Work through a shuffled queue of quote texts so nothing repeats until all have been shown.
// Texts (not positions) are queued so edits to the sheet can't point at the wrong quote.
function pick(quotes, queue) {
  const byText = new Map(quotes.map((q) => [q.quote, q]));
  let remaining = queue.filter((text) => byText.has(text));
  if (remaining.length === 0) remaining = shuffle([...byText.keys()]);
  const text = remaining.shift();
  return { quote: byText.get(text), queue: remaining };
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
  quoteEl.textContent = q.quote;
  quoteEl.className = q.quote.length > 280 ? "long" : q.quote.length > 120 ? "medium" : "";

  // Who sent it — their name opens their LinkedIn (social_link) when there is one
  byEl.replaceChildren();
  if (q.contributor_name) byEl.append("— ", link(q.contributor_name, q.social_link));

  show();
}

function renderEmpty() {
  quoteEl.className = "empty";
  quoteEl.replaceChildren(
    "Nothing underlined yet. Select a line you love while reading and press ",
    Object.assign(document.createElement("kbd"), { textContent: "Alt+Shift+U" }),
    "."
  );
  byEl.replaceChildren();
  show();
}

function show() {
  for (const el of [quoteEl, byEl]) {
    el.classList.remove("visible");
    void el.offsetWidth; // apply the hidden state first so the fade-in replays
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

// ---------- Adding a quote by hand ----------

function compose() {
  openEditor("", "", window.underlineTheme.get());
}

// Alt+Shift+U pressed while this tab is open: the background can't inject into this page, so it asks us.
chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type !== "compose") return;
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id === msg.tabId) compose();
});

// A quote was just saved (here or in another tab) — show it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.next?.newValue && !document.hidden) {
    render(changes.next.newValue);
    chrome.storage.local.remove("next");
  }
});

// ---------- Fetching ----------

async function refresh(force) {
  const { endpoint, secret } = self.UNDERLINE_CONFIG || {};
  if (!endpoint || !secret) return;

  const { lastRefresh = 0 } = await chrome.storage.local.get("lastRefresh");
  if (!force && Date.now() - lastRefresh < REFRESH_EVERY_MS) return;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "list", secret })
    });
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.quotes)) return;
    await chrome.storage.local.set({ quotes: data.quotes, lastRefresh: Date.now() });
    return data.quotes;
  } catch {
    // Offline or Google is slow — keep using the cache.
  }
}

main();

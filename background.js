// The shared sheet's web app URL and secret (not in git — see config.example.js)
importScripts("config.js");
// openEditor(), shared with the new tab page
importScripts("editor.js");

const MENU_ID = "underline-selection";
const REQUEST_TIMEOUT_MS = 15000;

// ---------- Entry points: right-click menu, keyboard shortcut, toolbar icon ----------

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: "Underline “%s”", contexts: ["selection"] });
  });
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  flushPending(await getSettings());
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) underline(tab, info.selectionText);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "underline-selection") underline(tab);
});

chrome.action.onClicked.addListener((tab) => underline(tab));

// ---------- Core ----------

async function underline(tab, selectionText) {
  const settings = await getSettings();
  if (!isConfigured(settings)) {
    chrome.runtime.openOptionsPage();
    return;
  }

  // With text selected the card opens to review it; with nothing selected it opens empty to type one in.
  // Either way the card sends a "save" message back.
  const quote = clean(selectionText || (await readSelection(tab)));
  if (await showEditor(tab, quote)) return;

  // The page can't show the card (Underline's own new tab, PDF viewer, chrome:// pages)
  if (isUnderlineNewTab(tab)) {
    chrome.runtime.sendMessage({ type: "compose", tabId: tab.id }).catch(() => {});
  } else if (quote) {
    notify(tab, "Underlining…", "pending");
    const result = await save(tab, quote, true);
    notify(tab, result.message, result.state);
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html#add") });
  }
}

function isUnderlineNewTab(tab) {
  const url = tab?.url || tab?.pendingUrl || "";
  return url.startsWith("chrome://newtab") || url.startsWith(chrome.runtime.getURL("newtab.html"));
}

async function save(tab, rawQuote, withSource) {
  const settings = await getSettings();
  if (!isConfigured(settings)) return { state: "error", message: "Add your name in Underline settings" };

  const quote = clean(rawQuote);
  if (!quote) return { state: "error", message: "Nothing to save" };

  const entry = {
    quote,
    contributor_name: settings.name,
    social_link: settings.socialLink,
    source_title: withSource ? tab?.title || "" : "",
    source_url: withSource ? tab?.url || "" : "",
    added_at: new Date().toISOString()
  };

  try {
    const result = await send(settings, entry);
    if (!result.duplicate) await showOnNextTab(entry);
    flushPending(settings);
    return { state: "success", message: result.duplicate ? "Already in the list" : "Underlined" };
  } catch (err) {
    if (!err.retryable) return { state: "error", message: err.message };
    await addPending(entry);
    return { state: "success", message: "Offline — saved, will sync later" };
  }
}

// The new tab page shows "next" first, and the cache keeps it in rotation until the next refresh.
async function showOnNextTab({ quote, contributor_name, social_link, source_title, source_url }) {
  const saved = { quote, contributor_name, social_link, source_title, source_url };
  const { quotes = [] } = await chrome.storage.local.get("quotes");
  await chrome.storage.local.set({ next: saved, quotes: [...quotes, saved] });
}

async function showEditor(tab, quote) {
  if (!tab?.id || isUnderlineNewTab(tab)) return false;
  const { theme = "auto" } = await chrome.storage.sync.get("theme");
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: openEditor,
      args: [quote, tab.title || "", theme]
    });
    return true;
  } catch {
    return false;
  }
}

async function send(settings, payload) {
  let res;
  try {
    res = await fetch(settings.endpoint, {
      method: "POST",
      // text/plain keeps this a "simple" request, which Apps Script handles without CORS preflight
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, secret: settings.secret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw requestError("Couldn't reach Google", true);
  }

  if (res.status >= 500) throw requestError("Google had a hiccup", true);

  let data;
  try {
    data = await res.json();
  } catch {
    // Apps Script answers with an HTML sign-in page when the web app isn't shared with "Anyone"
    throw requestError("Check your web app URL and that access is set to “Anyone”", false);
  }
  if (!data.ok) throw requestError(data.error || "Something went wrong", false);
  return data;
}

function requestError(message, retryable) {
  const err = new Error(message);
  err.retryable = retryable;
  return err;
}

// ---------- Reading the selection ----------

async function readSelection(tab) {
  if (!tab?.id) return "";
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString()
    });
    return result || "";
  } catch {
    return ""; // chrome:// pages, the PDF viewer, the Web Store, etc.
  }
}

function clean(text) {
  return (text || "")
    .replace(/­/g, "")              // soft hyphens from justified text
    .replace(/\s+/g, " ")                // line breaks from columns and e-readers
    .trim()
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

// ---------- Offline queue ----------

let flushing = false;

async function addPending(entry) {
  const { pending = [] } = await chrome.storage.local.get("pending");
  pending.push(entry);
  await chrome.storage.local.set({ pending });
}

async function flushPending(settings) {
  if (flushing || !isConfigured(settings)) return;
  flushing = true;
  try {
    const { pending = [] } = await chrome.storage.local.get("pending");
    const stillPending = [];
    for (const entry of pending) {
      try {
        await send(settings, entry);
      } catch (err) {
        if (err.retryable) stillPending.push(entry);
      }
    }
    await chrome.storage.local.set({ pending: stillPending });
  } finally {
    flushing = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "save" && sender.tab) {
    save(sender.tab, msg.quote, msg.withSource).then(reply);
    return true;
  }
  if (msg?.type === "flush") {
    getSettings().then(flushPending).then(() => reply(true));
    return true;
  }
});

// ---------- Settings ----------

async function getSettings() {
  const { name = "", socialLink = "" } = await chrome.storage.sync.get(["name", "socialLink"]);
  const { endpoint = "", secret = "" } = self.UNDERLINE_CONFIG || {};
  return { endpoint, secret, name, socialLink };
}

function isConfigured(settings) {
  return Boolean(settings.endpoint && settings.secret && settings.name);
}

// ---------- Feedback ----------

async function notify(tab, message, state) {
  if (tab?.id) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showToast,
        args: [message, state]
      });
      return;
    } catch {
      // Page can't be scripted — fall through to the toolbar badge
    }
  }
  if (state === "pending") return;
  const text = state === "success" ? "✓" : "!";
  const color = state === "success" ? "#2e7d32" : "#c62828";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text, tabId: tab?.id });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId: tab?.id }), 2500);
}

// Runs inside the page. Must be self-contained.
function showToast(message, state) {
  const ID = "__underline_toast";
  let host = document.getElementById(ID);
  if (!host) {
    host = document.createElement("div");
    host.id = ID;
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;bottom:28px;left:50%;transform:translateX(-50%);pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        .t {
          font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #eaeae4; background: #111110;
          border: 1px solid rgba(234,234,228,.14); border-radius: 999px;
          padding: 10px 18px; box-shadow: 0 10px 30px rgba(0,0,0,.35);
          display: flex; align-items: center; gap: 10px; white-space: nowrap;
          opacity: 0; transform: translateY(8px);
          transition: opacity .2s ease, transform .2s ease;
        }
        .t.show { opacity: 1; transform: none; }
        .mark { width: 18px; height: 2px; border-radius: 1px; background: #eaeae4; }
        .success .mark { background: #9be29b; }
        .error .mark { background: #ff8a80; }
        .pending .mark { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 50% { opacity: .25; } }
      </style>
      <div class="t"><span class="mark"></span><span class="msg"></span></div>`;
    document.documentElement.appendChild(host);
  }
  const toast = host.shadowRoot.querySelector(".t");
  toast.className = "t " + state;
  toast.querySelector(".msg").textContent = message;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(window.__underlineToastTimer);
  if (state !== "pending") {
    window.__underlineToastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }
}

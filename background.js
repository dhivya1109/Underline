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

  const quote = clean(selectionText || (await readSelection(tab)));
  if (!quote) {
    notify(tab, "Select some text first", "error");
    return;
  }

  // Let the reader review and edit first; the editor sends a "save" message back.
  if (await showEditor(tab, quote)) return;

  // Page can't show the editor (PDF viewer, chrome:// pages) — save as-is
  notify(tab, "Underlining…", "pending");
  const result = await save(tab, quote);
  notify(tab, result.message, result.state);
}

async function save(tab, rawQuote) {
  const settings = await getSettings();
  if (!isConfigured(settings)) return { state: "error", message: "Finish setup in Underline settings" };

  const quote = clean(rawQuote);
  if (!quote) return { state: "error", message: "Nothing to save" };

  const entry = {
    quote,
    contributor_name: settings.name,
    social_link: settings.socialLink,
    source_title: tab?.title || "",
    source_url: tab?.url || "",
    added_at: new Date().toISOString()
  };

  try {
    const result = await send(settings, entry);
    flushPending(settings);
    return { state: "success", message: result.duplicate ? "Already in your list" : "Underlined" };
  } catch (err) {
    if (!err.retryable) return { state: "error", message: err.message };
    await addPending(entry);
    return { state: "success", message: "Offline — saved, will sync later" };
  }
}

async function showEditor(tab, quote) {
  if (!tab?.id) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: openEditor,
      args: [quote, tab.title || ""]
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
    save(sender.tab, msg.quote).then(reply);
    return true;
  }
  if (msg?.type === "flush") {
    getSettings().then(flushPending).then(() => reply(true));
    return true;
  }
});

// ---------- Settings ----------

async function getSettings() {
  const { endpoint = "", secret = "", name = "", socialLink = "" } =
    await chrome.storage.sync.get(["endpoint", "secret", "name", "socialLink"]);
  return { endpoint, secret, name, socialLink };
}

function isConfigured(settings) {
  return Boolean(settings.endpoint && settings.secret);
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

// Runs inside the page. Must be self-contained.
function openEditor(quote, sourceTitle) {
  const ID = "__underline_editor";
  document.getElementById(ID)?.remove();

  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:24px;bottom:24px";
  // Keep the page's own keyboard shortcuts (Medium, Substack, etc.) from firing while typing
  for (const type of ["keydown", "keyup", "keypress"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; }
      .card {
        width: min(420px, calc(100vw - 48px));
        font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #eaeae4; background: #111110;
        border: 1px solid rgba(234,234,228,.14); border-radius: 14px;
        padding: 16px; box-shadow: 0 18px 50px rgba(0,0,0,.4);
        opacity: 0; transform: translateY(10px);
        transition: opacity .2s ease, transform .2s ease;
      }
      .card.show { opacity: 1; transform: none; }
      .head {
        display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
        font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
        color: rgba(234,234,228,.5);
      }
      .mark { width: 18px; height: 2px; border-radius: 1px; background: #eaeae4; }
      textarea {
        display: block; width: 100%; min-height: 72px; resize: none;
        font: 500 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #eaeae4; background: #060606;
        border: 1px solid rgba(234,234,228,.14); border-radius: 10px; padding: 10px 12px;
      }
      textarea:focus { outline: none; border-color: rgba(234,234,228,.45); }
      textarea:disabled { opacity: .6; }
      .source {
        margin-top: 8px; font-size: 12px; color: rgba(234,234,228,.4);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
      .status { flex: 1; font-size: 12px; color: rgba(234,234,228,.45); }
      .status.success { color: #9be29b; }
      .status.error { color: #ff8a80; }
      button {
        font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        border-radius: 8px; padding: 9px 14px; cursor: pointer;
        border: 1px solid #eaeae4; background: #eaeae4; color: #060606;
      }
      button.cancel { background: transparent; color: #eaeae4; border-color: rgba(234,234,228,.18); }
      button:disabled { opacity: .5; cursor: default; }
    </style>
    <div class="card" role="dialog" aria-label="Underline">
      <div class="head"><span class="mark"></span>Underline</div>
      <textarea aria-label="Quote"></textarea>
      <div class="source"></div>
      <div class="foot">
        <span class="status">Enter to save \u00b7 Esc to cancel</span>
        <button class="cancel" type="button">Cancel</button>
        <button class="save" type="button">Save</button>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const card = $(".card");
  const area = $("textarea");
  const status = $(".status");
  const saveBtn = $(".save");

  area.value = quote;
  $(".source").textContent = sourceTitle;

  const fit = () => {
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight + 2, 320) + "px";
  };
  const close = () => {
    card.classList.remove("show");
    setTimeout(() => host.remove(), 200);
  };
  const setStatus = (text, state = "") => {
    status.textContent = text;
    status.className = "status " + state;
  };

  async function save() {
    const text = area.value.replace(/\s+/g, " ").trim();
    if (!text) return setStatus("Nothing to save", "error");

    saveBtn.disabled = area.disabled = true;
    setStatus("Saving\u2026");

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "save", quote: text });
    } catch {
      result = { state: "error", message: "Underline was updated \u2014 reload this page" };
    }

    setStatus(result.message, result.state);
    if (result.state === "error") {
      saveBtn.disabled = area.disabled = false;
      area.focus();
      return;
    }
    setTimeout(close, 1100);
  }

  area.addEventListener("input", fit);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      close();
    }
  });
  saveBtn.addEventListener("click", save);
  $(".cancel").addEventListener("click", close);

  // Re-measure whenever the card's width settles or changes
  new ResizeObserver(fit).observe(card);

  requestAnimationFrame(() => {
    card.classList.add("show");
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
}

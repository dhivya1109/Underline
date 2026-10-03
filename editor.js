// The review/compose card. Used two ways:
//  - background.js injects it into the page you're reading (so it must stay self-contained)
//  - newtab.html loads this file and calls it directly
//
// quote:       the selected text, or "" to type one in
// sourceTitle: the page it came from ("" for none)
// themePref:   "dark" | "light" | "auto"
function openEditor(quote, sourceTitle, themePref) {
  const ID = "__underline_editor";
  document.getElementById(ID)?.remove();

  const dark =
    themePref === "dark" ||
    (themePref !== "light" && !matchMedia("(prefers-color-scheme: light)").matches);
  const c = dark
    ? { card: "#1b1a18", field: "#121110", fg: "#efe9dd", muted: "rgba(239,233,221,.55)", line: "rgba(239,233,221,.14)", focus: "rgba(239,233,221,.45)", ok: "#9be29b", err: "#ff8a80", shadow: "rgba(0,0,0,.45)" }
    : { card: "#fffdf8", field: "#f3efe6", fg: "#141210", muted: "rgba(20,18,16,.55)", line: "rgba(20,18,16,.14)", focus: "rgba(20,18,16,.45)", ok: "#2e7d32", err: "#c62828", shadow: "rgba(0,0,0,.18)" };
  const composing = !quote;

  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:24px;bottom:24px";
  // Keep the page's own keyboard shortcuts (Medium, Substack, etc.) from firing while typing
  for (const type of ["keydown", "keyup", "keypress"]) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }

  const font = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; }
      .card {
        width: min(440px, calc(100vw - 48px));
        font: 14px/1.5 ${font};
        color: ${c.fg}; background: ${c.card};
        border: 1px solid ${c.line}; border-radius: 14px;
        padding: 16px; box-shadow: 0 18px 50px ${c.shadow};
        opacity: 0; transform: translateY(10px);
        transition: opacity .2s ease, transform .2s ease;
      }
      .card.show { opacity: 1; transform: none; }
      .head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
      .wordmark {
        font: 700 15px/1 ${font}; letter-spacing: -0.01em;
        text-decoration: underline; text-decoration-color: ${c.fg};
        text-decoration-thickness: 2px; text-underline-offset: 4px;
      }
      .dot { display: inline-block; width: 3px; height: 3px; margin-left: 1px; border-radius: 50%; background: #e5322d; }
      .mode { font-size: 12px; color: ${c.muted}; }
      textarea {
        display: block; width: 100%; min-height: 84px; resize: none;
        font: 500 16px/1.5 ${font};
        color: ${c.fg}; background: ${c.field};
        border: 1px solid ${c.line}; border-radius: 10px; padding: 10px 12px;
      }
      textarea::placeholder { color: ${c.muted}; }
      textarea:focus { outline: none; border-color: ${c.focus}; }
      textarea:disabled { opacity: .6; }
      .source { margin-top: 8px; font-size: 12px; color: ${c.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
      .status { flex: 1; font-size: 12px; color: ${c.muted}; }
      .status.success { color: ${c.ok}; }
      .status.error { color: ${c.err}; }
      button {
        font: 600 13px/1 ${font};
        border-radius: 8px; padding: 9px 14px; cursor: pointer;
        border: 1px solid ${c.fg}; background: ${c.fg}; color: ${c.card};
      }
      button.cancel { background: transparent; color: ${c.fg}; border-color: ${c.line}; }
      button:disabled { opacity: .5; cursor: default; }
    </style>
    <div class="card" role="dialog" aria-label="Underline">
      <div class="head">
        <span class="wordmark">Underline<span class="dot"></span></span>
        <span class="mode"></span>
      </div>
      <textarea aria-label="Quote"></textarea>
      <div class="source"></div>
      <div class="foot">
        <span class="status">Enter to save · Esc to cancel</span>
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
  area.placeholder = "Type or paste a line you want to keep…";
  $(".mode").textContent = composing ? "Add a quote" : "Review";
  if (sourceTitle) $(".source").textContent = "From " + sourceTitle;
  else $(".source").remove();

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
    if (!text) return setStatus("Write something first", "error");

    saveBtn.disabled = area.disabled = true;
    setStatus("Saving…");

    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "save", quote: text, withSource: Boolean(sourceTitle) });
    } catch {
      result = { state: "error", message: "Underline was updated — reload this page" };
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

const FIELDS = ["name", "socialLink"];

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

async function load() {
  const saved = await chrome.storage.sync.get(FIELDS);
  FIELDS.forEach((f) => ($(f).value = saved[f] || ""));

  const [command] = (await chrome.commands.getAll()).filter((c) => c.name === "underline-selection");
  $("shortcut").textContent = command?.shortcut || "no shortcut set";

  const theme = window.underlineTheme.get();
  document.querySelectorAll('input[name="theme"]').forEach((radio) => {
    radio.checked = radio.value === theme;
    radio.addEventListener("change", () => window.underlineTheme.set(radio.value));
  });

  refreshPending();
}

async function refreshPending() {
  const { pending = [] } = await chrome.storage.local.get("pending");
  $("pending-box").hidden = pending.length === 0;
  $("pending-count").textContent = pending.length === 1 ? "1 quote" : `${pending.length} quotes`;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  if (!values.name) return setStatus("Add your name first", "err");

  // Accept "www.linkedin.com/in/..." or "linkedin.com/in/..." and add the https:// for them
  if (values.socialLink && !/^https?:\/\//i.test(values.socialLink)) {
    values.socialLink = "https://" + values.socialLink;
    $("socialLink").value = values.socialLink;
  }
  if (values.socialLink && !/^https?:\/\/[^\s/]+\.\S+$/i.test(values.socialLink)) {
    return setStatus("That doesn't look like a link — check your LinkedIn URL", "err");
  }

  await chrome.storage.sync.set(values);
  setStatus("Saved — you're ready to underline", "ok");
});

$("retry").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "flush" });
  refreshPending();
});

$("shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

load();

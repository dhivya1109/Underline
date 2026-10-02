const FIELDS = ["name", "socialLink", "endpoint", "secret"];
const ENDPOINT_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function readForm() {
  return Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
}

function validate(values) {
  if (!ENDPOINT_PATTERN.test(values.endpoint)) {
    return "The web app URL should look like https://script.google.com/macros/s/…/exec";
  }
  if (!values.secret) return "Add the secret from your Apps Script";
  return "";
}

async function load() {
  const saved = await chrome.storage.sync.get(FIELDS);
  FIELDS.forEach((f) => ($(f).value = saved[f] || ""));

  const [command] = (await chrome.commands.getAll()).filter((c) => c.name === "underline-selection");
  $("shortcut").textContent = command?.shortcut || "no shortcut set";

  refreshPending();
}

async function refreshPending() {
  const { pending = [] } = await chrome.storage.local.get("pending");
  $("pending-box").hidden = pending.length === 0;
  $("pending-count").textContent = pending.length === 1 ? "1 quote" : `${pending.length} quotes`;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const values = readForm();
  const problem = validate(values);
  if (problem) return setStatus(problem, "err");
  await chrome.storage.sync.set(values);
  setStatus("Saved", "ok");
});

$("test").addEventListener("click", async () => {
  const values = readForm();
  const problem = validate(values);
  if (problem) return setStatus(problem, "err");

  setStatus("Testing…");
  try {
    const res = await fetch(values.endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ping: true, secret: values.secret })
    });
    const data = await res.json().catch(() => null);
    if (!data) return setStatus("Got a sign-in page — set the deployment's access to “Anyone”", "err");
    if (!data.ok) return setStatus(data.error, "err");
    setStatus("Connected", "ok");
  } catch {
    setStatus("Couldn't reach that URL", "err");
  }
});

$("retry").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "flush" });
  refreshPending();
});

$("shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

load();

const FIELDS = ["name", "socialLink"];

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

async function load() {
  const saved = await chrome.storage.sync.get(FIELDS);
  FIELDS.forEach((f) => ($(f).value = saved[f] || ""));
  // The admin code stays on this computer only (local, not synced)
  const { adminCode = "" } = await chrome.storage.local.get("adminCode");
  $("adminCode").value = adminCode;

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

  // Check an admin code with the sheet before keeping it
  const adminCode = $("adminCode").value.trim();
  if (adminCode) {
    setStatus("Checking the admin code…");
    const isAdmin = await checkAdminCode(adminCode);
    if (isAdmin === null) return setStatus("Couldn't reach Google to check the admin code", "err");
    if (!isAdmin) return setStatus("That isn't the admin code", "err");
  }

  await chrome.storage.sync.set(values);
  await chrome.storage.local.set({ adminCode });
  setStatus(adminCode ? "Saved — admin: your quotes go live straight away" : "Saved — you're ready to underline", "ok");
});

// true = admin code, false = not, null = couldn't check
async function checkAdminCode(code) {
  const { endpoint } = self.UNDERLINE_CONFIG || {};
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ping: true, secret: code })
    });
    const data = await res.json();
    return Boolean(data.ok && data.admin);
  } catch {
    return null;
  }
}

$("retry").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "flush" });
  refreshPending();
});

$("shortcuts").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

load();

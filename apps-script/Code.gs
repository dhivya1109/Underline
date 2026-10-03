/**
 * Underline — Google Apps Script receiver.
 *
 * Paste this into the Apps Script editor of your quotes sheet
 * (Extensions → Apps Script), set SECRET, then deploy as a web app.
 * See README.md for the full steps.
 */

// Any long random string. Put the same value in the extension's config.js.
const SECRET = "change-me-to-something-long-and-random";

// The tab to write into, by its gid (the number after "gid=" in the sheet URL).
// Leave as null to use the first tab.
const SHEET_GID = null;

// Limits that keep the sheet tidy now that friends share it.
const MAX_QUOTE_LENGTH = 1000;
const MAX_SAVES_PER_MINUTE = 20;

// Two quotes count as the same when one is mostly the other (e.g. a few extra words).
const DUPLICATE_OVERLAP = 0.6;

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return json({ ok: false, error: "Secret doesn't match the Apps Script" });
    if (data.ping) return json({ ok: true });
    if (data.action === "list") return json({ ok: true, quotes: listQuotes() });

    const quote = String(data.quote || "").trim();
    if (!quote) return json({ ok: false, error: "Nothing to save" });
    if (quote.length > MAX_QUOTE_LENGTH) {
      return json({ ok: false, error: "That's too long — keep it under " + MAX_QUOTE_LENGTH + " characters" });
    }
    if (!underRateLimit()) return json({ ok: false, error: "Too many saves right now — try again in a minute" });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet();
      const headers = getHeaders(sheet);
      const quoteCol = headers.indexOf("quote");
      if (quoteCol === -1) return json({ ok: false, error: "Sheet has no \"quote\" column" });

      if (isDuplicate(sheet, quoteCol, quote)) return json({ ok: true, duplicate: true });

      // Fill only the columns the sheet actually has, matched by header name.
      const values = {
        quote: quote,
        contributor_name: text(data.contributor_name, 80),
        social_link: webLink(data.social_link),
        active: true,
        source_title: text(data.source_title, 300),
        source_url: webLink(data.source_url),
        added_at: data.added_at ? new Date(data.added_at) : new Date()
      };
      sheet.appendRow(headers.map((h) => (h in values ? values[h] : "")));
    } finally {
      lock.releaseLock();
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// Visiting the web app URL in a browser shows this — handy to confirm the deployment works.
function doGet() {
  return ContentService.createTextOutput("Underline is listening.");
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (SHEET_GID !== null) {
    const match = ss.getSheets().find((s) => s.getSheetId() === SHEET_GID);
    if (match) return match;
  }
  return ss.getSheets()[0];
}

// Every active quote, for the new tab page.
function listQuotes() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaders(sheet);
  const activeCol = headers.indexOf("active");
  const fields = ["quote", "contributor_name", "social_link", "source_title", "source_url"];

  return sheet
    .getRange(2, 1, lastRow - 1, headers.length)
    .getValues()
    .filter((row) => activeCol === -1 || String(row[activeCol]).toUpperCase() === "TRUE")
    .map((row) => {
      const quote = {};
      fields.forEach((f) => (quote[f] = headers.indexOf(f) === -1 ? "" : String(row[headers.indexOf(f)]).trim()));
      return quote;
    })
    .filter((q) => q.quote);
}

function getHeaders(sheet) {
  return sheet
    .getRange(1, 1, 1, sheet.getLastColumn())
    .getValues()[0]
    .map((h) => String(h).trim().toLowerCase());
}

function getQuotes(sheet, quoteCol) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet
    .getRange(2, quoteCol + 1, lastRow - 1, 1)
    .getValues()
    .map((row) => normalize(row[0]));
}

function isDuplicate(sheet, quoteCol, quote) {
  const target = normalize(quote);
  return getQuotes(sheet, quoteCol).some((existing) => isSameQuote(existing, target));
}

// Both arguments must already be normalized.
function isSameQuote(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return longer.includes(shorter) && shorter.length / longer.length >= DUPLICATE_OVERLAP;
}

/**
 * One-off cleanup: run this from the Apps Script editor to delete repeated
 * quotes already in the sheet. The earliest copy of each quote is kept.
 */
function removeDuplicates() {
  const sheet = getSheet();
  const quoteCol = getHeaders(sheet).indexOf("quote");
  if (quoteCol === -1) throw new Error("Sheet has no \"quote\" column");

  const kept = [];
  const duplicateRows = [];
  getQuotes(sheet, quoteCol).forEach((quote, i) => {
    if (!quote) return;
    if (kept.some((k) => isSameQuote(k, quote))) duplicateRows.push(i + 2);
    else kept.push(quote);
  });

  // Delete from the bottom up so row numbers don't shift.
  duplicateRows.reverse().forEach((row) => sheet.deleteRow(row));
  Logger.log("Removed " + duplicateRows.length + " duplicate row(s).");
}

function underRateLimit() {
  const cache = CacheService.getScriptCache();
  const key = "saves-" + Math.floor(Date.now() / 60000);
  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 120);
  return count <= MAX_SAVES_PER_MINUTE;
}

function text(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

// Only keep real web links, so nothing like "javascript:" ends up in a clickable cell.
function webLink(value) {
  const link = text(value, 2000);
  return /^https?:\/\//i.test(link) ? link : "";
}

// Ignore case, punctuation and quote marks so "Be kind." matches be kind
function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

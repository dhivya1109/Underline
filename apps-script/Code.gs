/**
 * Underline — Google Apps Script receiver.
 *
 * Paste this into the Apps Script editor of your quotes sheet
 * (Extensions → Apps Script), set SECRET, then deploy as a web app.
 * See README.md for the full steps.
 */

// Any long random string. Paste the same value into Underline's settings.
const SECRET = "change-me-to-something-long-and-random";

// The tab to write into, by its gid (the number after "gid=" in the sheet URL).
// Leave as null to use the first tab.
const SHEET_GID = null;

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return json({ ok: false, error: "Secret doesn't match the Apps Script" });
    if (data.ping) return json({ ok: true });

    const quote = String(data.quote || "").trim();
    if (!quote) return json({ ok: false, error: "Nothing to save" });

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet();
      const headers = sheet
        .getRange(1, 1, 1, sheet.getLastColumn())
        .getValues()[0]
        .map((h) => String(h).trim().toLowerCase());

      const quoteCol = headers.indexOf("quote");
      if (quoteCol === -1) return json({ ok: false, error: "Sheet has no \"quote\" column" });

      if (isDuplicate(sheet, quoteCol, quote)) return json({ ok: true, duplicate: true });

      // Fill only the columns the sheet actually has, matched by header name.
      const values = {
        quote: quote,
        contributor_name: data.contributor_name || "",
        social_link: data.social_link || "",
        active: true,
        source_title: data.source_title || "",
        source_url: data.source_url || "",
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

function isDuplicate(sheet, quoteCol, quote) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const target = normalize(quote);
  return sheet
    .getRange(2, quoteCol + 1, lastRow - 1, 1)
    .getValues()
    .some((row) => normalize(row[0]) === target);
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, " ").trim();
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

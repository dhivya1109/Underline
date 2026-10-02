# Underline

When you're reading and a line stops you, select it and press one key. Underline saves it to your Google Sheet, with no forms and no typing your name in again.

## Saving a quote

Select the text on any page, then use whichever is quickest:

- **Keyboard:** `Alt+Shift+U`. You can change this at `chrome://extensions/shortcuts`.
- **Toolbar:** click the Underline icon.
- **Right-click:** choose **Underline "…"**.

A small card opens at the bottom right with the text you selected. Edit it if you want, then press **Enter** (or click **Save**) to add it to the sheet. Press **Esc** to cancel. On pages where the card can't open, such as PDFs, the text is saved directly and a toast confirms it. Each row gets the quote, your name and link, `active = TRUE`, the page title and URL, and a timestamp. If you save the same quote twice, it's only stored once. If you're offline, the quote is kept and synced the next time you save something, the next time Chrome starts, or when you click **Sync now** in settings.

## Setup (about 5 minutes, done once)

### 1. The sheet

The first row of your sheet needs headers. Underline only fills in the columns that exist, matched by name, so column order and any extra columns don't matter.

| quote | contributor_name | social_link | active | source_title | source_url | added_at |
|---|---|---|---|---|---|---|

Only `quote` is required. These are the same columns Ponder reads, so anything you underline also shows up in Ponder's rotation.

### 2. The Apps Script

1. In the sheet, open **Extensions → Apps Script**.
2. Replace everything in the editor with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Change `SECRET` to a long random string. If the quotes live on a tab other than the first one, set `SHEET_GID` to that tab's number (the digits after `gid=` in its URL).
4. Click **Deploy → New deployment**. Under the gear icon, choose **Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy**, approve the permissions, and copy the **Web app URL** (it ends in `/exec`).

"Anyone" means anyone who has the URL can reach the script. The secret is what stops them from writing to your sheet.

If you edit the script later, use **Deploy → Manage deployments → Edit → New version**. That keeps the same URL.

### 3. The extension

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. The settings page opens. Fill in your name, the web app URL and the secret, then click **Save** and then **Test connection**.

## Where it works

| Where | Works? |
|---|---|
| Medium, Substack, blogs, news sites | Yes |
| PDFs open in Chrome | Right-click only. The shortcut and the toolbar icon can't read text in Chrome's PDF viewer. |
| Kindle Cloud Reader (`read.amazon.com`) | Usually no. Kindle draws its pages in a way that doesn't expose selectable text. |
| Kindle app, other desktop apps | No. Chrome extensions only work inside Chrome. |

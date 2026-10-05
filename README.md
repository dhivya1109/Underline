# Underline

When you're reading and a line stops you, select it and press one key. Underline saves it to a shared Google Sheet, and every new tab shows one of the lines you and your friends have saved.

## Saving a quote

Select the text on any page, then use whichever is quickest:

- **Keyboard:** `Alt+Shift+U`. You can change this at `chrome://extensions/shortcuts`.
- **Toolbar:** click the Underline icon.
- **Right-click:** choose **Underline "…"**.

A card opens with the text you selected. Edit it if you want, then press **Enter** (or click **Save**). Press **Esc** to cancel.

**Typing a quote in yourself:** press `Alt+Shift+U` with nothing selected, on any page or on the new tab. The card opens empty. This is handy for books, Kindle, or anything you can't select.

On pages where the card can't open, such as PDFs in Chrome, right-click saves the selection directly and a toast confirms it.

Each row gets the quote, your name and LinkedIn, `active = TRUE`, the page title and URL, and a timestamp. Quotes that are the same or nearly the same as one already in the sheet aren't saved twice. If you're offline, the quote is kept and synced later.

## The new tab

Every new tab shows one saved quote with **— Name** in the bottom left. Clicking the name opens that person's LinkedIn, if they added one in settings. Quotes are shuffled so none repeat until all have been shown, and a quote you just saved appears on your very next tab.

Switch between light and dark with the button in the bottom left, or under **Appearance** in settings.

## Outside Chrome: the Windows app

Chrome extensions only work inside Chrome. For the Kindle app, Word, PDF readers and everything else, there's a small Windows app in [`desktop/`](desktop/).

Select text in any app and press **Ctrl+Shift+U**. The app copies the selection, shows the same review card, and saves to the same sheet. With nothing selected, the card opens empty so you can type a quote. It lives in the system tray by the clock: click the icon to add a quote, or right-click it for settings.

**Build it** (no installs needed; it uses the C# compiler that comes with Windows):

```powershell
powershell -ExecutionPolicy Bypass -File desktopuild.ps1
```

This reads the web app URL and secret from `config.js` and writes `desktopuildUnderline.exe`, a single file you can share. On first run it asks for your name and LinkedIn, and can start itself with Windows. Windows may warn that the app is unrecognised because it isn't code-signed: click **More info → Run anyway**.

## How it's shared

Everyone who installs Underline saves into **one shared sheet**, owned by the person who sets it up. Each quote is credited with the name the reader enters in Underline's settings. Readers only type their name; the sheet details are built into the extension.

## Setup for the sheet owner (about 5 minutes, done once)

### 1. The sheet

The first row of your sheet needs headers. Underline only fills in the columns that exist, matched by name, so column order and any extra columns don't matter.

| quote | contributor_name | social_link | active | source_title | source_url | added_at |
|---|---|---|---|---|---|---|

Only `quote` is required. Set `active` to `FALSE` on any row to hide it from new tabs without deleting it.

### 2. The Apps Script

1. In the sheet, open **Extensions → Apps Script**.
2. Replace everything in the editor with [`apps-script/Code.gs`](apps-script/Code.gs).
3. Change `SECRET` to a long random string. If the quotes live on a tab other than the first one, set `SHEET_GID` to that tab's number (the digits after `gid=` in its URL).
4. Click **Deploy → New deployment**. Under the gear icon, choose **Web app**:
   - **Execute as:** Me
   - **Who has access:** Anyone
5. Click **Deploy**, approve the permissions, and copy the **Web app URL** (it ends in `/exec`).

"Anyone" means anyone who has the URL can reach the script. The secret is what stops them from writing to your sheet.

If you edit the script later, use **Deploy → Manage deployments → Edit → New version** to keep the same URL. If you make a new deployment instead, put the new URL in `config.js`.

To clean out repeated quotes already in the sheet, choose `removeDuplicates` in the Apps Script toolbar and click **Run**. The first copy of each quote is kept.

### 3. The extension

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
Before loading it, connect the extension to your sheet:

1. Copy `config.example.js` to `config.js`.
2. In `config.js`, paste your web app URL and the same secret you put in the Apps Script.

`config.js` is ignored by git, so the secret never goes to GitHub. It is included in the extension you share, though, so anyone who installs it could find it. That's why the Apps Script caps quote length at 1000 characters and the whole sheet at 20 saves per minute.

Then load it:

1. Go to `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. The settings page opens. Enter your name (and LinkedIn, if you like) and click **Save**.
4. Open a new tab. If Chrome asks whether to keep the change, click **Keep it**.

## Where it works

| Where | Works? |
|---|---|
| Medium, Substack, blogs, news sites | Yes |
| PDFs open in Chrome | Right-click only. The shortcut and the toolbar icon can't read text in Chrome's PDF viewer. |
| Kindle Cloud Reader (`read.amazon.com`) | Usually no. Kindle draws its pages in a way that doesn't expose selectable text. |
| Kindle app, other desktop apps | No. Chrome extensions only work inside Chrome. |

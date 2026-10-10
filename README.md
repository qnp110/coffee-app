# coffee-app

A small personal web app for coffee dosing, made for the iPhone home screen.
Plain HTML, CSS and JavaScript: no frameworks, no build step, no backend. It runs entirely on your device and works offline.

## Features

- **Ratio calculator** with two modes:
  - *Espresso*: ratio = yield / dose (e.g. 18 g → 36 g is 1:2).
  - *Filter*: ratio = water / dose (e.g. 15 g + 240 g water is 1:16). The cup yield is estimated as
    `water − absorption × dose`, where absorption (water retained by the grounds) defaults to 2 g per g of coffee.
  - Changing the dose keeps the ratio and scales the recipe. Changing yield/water or the ratio updates the other one.
  - Commas are accepted as decimal separator.
- **Grinders**: add, edit and delete grinders, each with a free-form list of settings ("Espresso: 14", "V60: 22 clicks").
- **Brew notes**: date, grinder, grind setting, dose, yield, time (seconds or m:ss), rating 1-5 and free text. Newest first.
- **Backup**: export all data as a JSON file and import it again (validated, with a confirmation before anything is replaced).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, iOS meta tags, all views and dialogs |
| `style.css` | Mobile-first layout, light/dark theme, iPhone safe areas |
| `app.js` | All app logic: storage, calculator, grinders, notes, backup |
| `sw.js` | Service worker that caches the app for offline use |
| `manifest.json` | Web app manifest (name, icons, colours) |
| `icons/` | App icons (180, 192, 512 px) |
| `tools/make_icons.py` | Regenerates the placeholder icons (`python3 tools/make_icons.py`, run from the repo root) |

All paths are relative (`./`), so the app works from the `/coffee-app/` subfolder on GitHub Pages.

## Run locally

Serve the **parent** folder so the URL matches GitHub Pages (`/coffee-app/`):

```bash
cd ..   # the folder that contains coffee-app/
python3 -m http.server 8000
```

Then open <http://localhost:8000/coffee-app/>. Serving from inside the repo (`http://localhost:8000/`) also works.
The service worker only runs on `localhost` or over HTTPS, so offline mode cannot be tested via a plain `http://` LAN address.

## Deploy on GitHub Pages

1. Push the repo to GitHub.
2. Open the repo's **Settings > Pages**.
3. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then save.
4. After a minute or so the app is live at `https://<username>.github.io/coffee-app/`.

### Deploying changes: bump the cache version

The service worker serves the cached app first, so **every time you change a file, bump `CACHE_VERSION` in `sw.js`**
(e.g. `'v1'` → `'v2'`). Otherwise phones keep showing the old version. When the new version has loaded in the
background, the app shows "A new version is ready" with a Reload button.

## Install on iPhone

1. Open `https://<username>.github.io/coffee-app/` in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Start the app from the new home screen icon. It opens full screen and works offline.

## Where is my data stored?

- Everything (grinders, notes and the last calculator values) is stored in the browser's **localStorage**, as one
  JSON entry under the key `coffee-app:data`. It is a few kilobytes; nothing is ever sent to a server.
- It is **not a file you can see** in the Files app. It lives in the browser's private website data.
- The home screen app has **its own storage, separate from Safari**. Notes entered in a Safari tab do not appear in the
  installed app, and vice versa. Use Export/Import to move data between them.
- The app shell (HTML, CSS, JS, icons) is also cached by the service worker, separately from your data.

### Seeing and deleting the data

- **See it**: Data tab > *Export backup* creates a real JSON file you can save to Files and open. On a computer you
  can also look in the browser's developer tools (Application > Local Storage).
- **Delete it on iPhone**:
  - Installed app: deleting the home screen icon removes the app together with its data.
  - Safari tab: Settings > Apps > Safari > Advanced > Website Data, then delete the entry for `github.io`.
    Note that `github.io` is shared by all GitHub Pages sites under that domain.
- **Delete it on a computer**: clear the site data for the page (in Chrome: DevTools > Application > Storage > Clear site data).

### Keeping it safe

- iOS may delete website data that has not been used for a while, and deleting the home screen icon deletes the data.
  The app asks for persistent storage on start (status visible in the Data tab), but this is best effort.
- **Export a backup regularly** and keep it in Files or iCloud Drive.
- Import replaces *all* current data, after a confirmation that shows what will be replaced.
- If stored data ever cannot be read (corrupted, or written by a newer version), the app stops saving so it is not
  overwritten. Export then saves the raw stored data unchanged, so nothing is lost.

## Privacy and security

- No backend, no analytics, no external requests. A Content Security Policy only allows files from the app itself.
- User text is always inserted as plain text (`textContent`), never as HTML.

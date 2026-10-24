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
- **Beans**: one entry per coffee with name, grinder (free text, earlier names are suggested), a free-form list of
  grind settings ("Espresso: 14", "V60: 22 clicks"), bean info (roaster, origin, roast date…) and notes.
- **Brew notes**: date, bean, grind setting (suggested from the bean's settings), dose, yield, time (seconds or m:ss),
  rating 1-5 and free text. The grinder comes from the bean. Newest first.
- **Backup**: export all data as a JSON file and import it again (validated, with a confirmation before anything is replaced).

Tap a bean or note card to edit it; the Delete button is at the bottom of the editor.

## Design

iOS-inspired: large titles, inset grouped lists, segmented controls and bottom sheets, using the system font.
Colours are pastels (peach, lavender, sage, sky, butter) with a terracotta accent, defined as CSS variables at the
top of `style.css` with a separate dark-mode set. Change them there to retheme the whole app.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, iOS meta tags, all views and editor sheets |
| `style.css` | Mobile-first layout, pastel light/dark theme, iPhone safe areas |
| `app.js` | All app logic: storage and migrations, calculator, beans, notes, backup |
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
(e.g. `'v2'` → `'v3'`). Otherwise phones keep showing the old version. When the new version has loaded in the
background, the app shows "A new version is ready" with a Reload button. You do not need to re-add the app to the
home screen, except to pick up a changed app name or icon (iOS stores those at install time; export your data first,
because removing the app deletes it).

## Install on iPhone

1. Open `https://<username>.github.io/coffee-app/` in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Start the app from the new home screen icon. It opens full screen and works offline.

## Where is my data stored?

- Everything (beans, notes and the last calculator values) is stored in the browser's **localStorage**, as one
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

### Schema versions and migrations

The stored JSON has a `schemaVersion` field (currently 2). When the data shape changes, existing data is not thrown
away: `normalizeData()` in `app.js` runs one migration step per version (`migrateV1toV2()`, and so on), both when the
app loads its saved data and when you import an older backup. To change the data shape:

1. Bump `SCHEMA_VERSION` in `app.js`.
2. Add a `migrateVxToVy()` function that converts the previous shape, and call it in `normalizeData()`.
3. Update the normalize functions and the data shape comment in `app.js`.

Version 1 had "grinders" instead of "beans". On upgrade, each grinder becomes a bean named "Unnamed bean" that
keeps the grinder name and settings, and brew notes stay linked to it.

## Privacy and security

- No backend, no analytics, no external requests. A Content Security Policy only allows files from the app itself.
- User text is always inserted as plain text (`textContent`), never as HTML.

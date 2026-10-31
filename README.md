# 🎃 Trick-or-Treat Map

A neighborhood map where people tap their house to say whether they're handing out candy, and trick-or-treaters rate houses with 1–5 🍬. Built for the Woodside Piamonte & Tramonte Families neighborhood (the streets between Anastasia Way, Romano Dr and Sofia Dr).

- Hosting: GitHub Pages (free)
- Shared data: Firebase Realtime Database, Spark plan (free, no credit card)
- Map: streets (`streets.json`) and house outlines (`buildings.json`) from OpenStreetMap, drawn by the app itself, so no tile server or API key is needed
- House numbers: Placer County address points, matched to each outline and saved in `buildings.json`

## Try it locally (demo mode)

With `firebaseConfig = null` in `config.js`, data is only saved in your browser.

From the project folder, run:

```
python -m http.server 8765 --bind 127.0.0.1
```
Open http://127.0.0.1:8765. Opening `index.html` by double-click won't work because browsers block `fetch` and modules on `file://`.

## 1. Set up Firebase (about 10 minutes)

1. Go to https://console.firebase.google.com, click **Create a project** (Google Analytics: off).
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
3. **Build → Realtime Database → Create database** (pick a US location, start in **locked mode**).
4. In the database, open the **Rules** tab, paste the contents of `database.rules.json`, click **Publish**.
5. **Project settings (gear) → General → Your apps → Web (`</>`)**, register an app (no hosting), copy the `firebaseConfig` object.
6. Paste it into `config.js` in place of `null`. Make sure it includes `databaseURL`.
7. **Authentication → Settings → Authorized domains → Add domain:** `<your-github-username>.github.io`

The Firebase config values are meant to be public. The database rules are what protect the data.

## 2. Publish on GitHub Pages

1. Create a public repo on github.com (e.g. `trick-or-treat-map`).
2. Upload all files in this folder (drag-and-drop on the repo page works), or:
   ```
   git init && git add . && git commit -m "feat: Add trick-or-treat map"
   git branch -M main
   git remote add origin https://github.com/<you>/trick-or-treat-map.git
   git push -u origin main
   ```
3. Repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root → Save.**
4. After a minute the site is at `https://<you>.github.io/trick-or-treat-map/`. Share that link (or a QR code) in the neighborhood group.

## How it works

- Tap a house outline → check in: Yes/No, your own candy level (1–5), tags (decorations, haunted yard, teal pumpkin), and a note.
- Only real house outlines can be selected. To add a house that's missing, add its outline to `buildings.json`.
- Tap a 🎃 to see details and rate it. The leaderboard ranks houses by visitor ratings; the top 3 get a 👑 on the map.
- Everyone gets a silent anonymous login. Only the device that claimed a house can edit or remove it, and each device gets one rating per house (changeable). You can't rate your own house.

## Wrong house? (conflict resolution)

- **Before saving:** tapping an unclaimed house highlights it in yellow and shows its address with a "Yes, this is my house" step.
- **🏠 My house** (top bar) jumps to your own check-in. Your houses have a white outline.
- **Owner picked the wrong house:** open it and tap **Wrong house?** (or **Edit → Wrong house? Move it**), then tap the right house. The check-in moves, and ratings on the wrong house are cleared.
- **Someone claimed your house:** tap it and choose **🏠 This is actually my house**, with an optional note. The person who claimed it sees a yellow alert next time they open the map, with buttons to move or remove their check-in. The organizer sees the report too. Once it's released, tap the house and check in.

## Organizer (admin) setup

1. Open the site with `?admin` at the end, e.g. `https://<your-username>.github.io/trick-or-treat-map/?admin`.
2. The 🛠 panel shows this browser's ID with a **Copy** button.
3. In the Firebase console, open **Realtime Database → Data**. Add a child `admins`, and under it a child whose key is your ID and whose value is `true` (boolean).
4. Reload with `?admin`. The 🛠 button now shows open reports, and every house has **Remove claim** and **Dismiss reports**.

The organizer button stays visible on that browser without `?admin` once it's set up. Repeat for each device you use (phone, laptop). If you clear browser data, the ID changes and you need to add the new one.

## Limits and caveats

- Free plan allows 100 simultaneous connections, which is plenty for one neighborhood.
- Anyone who clears their browser data gets a new identity, so ratings are for fun, not fraud-proof.
- If a report goes unanswered, remove the claim from the 🛠 Organizer panel (or delete it in Firebase under Realtime Database → Data → houses).
- To change the area, edit `bounds` in `config.js` and the `lat`/`lng` limits in `database.rules.json`, and regenerate `buildings.json` from OpenStreetMap (Overpass query: `way[building](south,west,north,east);out tags geom;`).
- To reset for next year, delete the `houses`, `ratings` and `reports` nodes in the Firebase console.

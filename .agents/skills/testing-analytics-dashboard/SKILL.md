---
name: testing-analytics-dashboard
description: Test the web-core analytics dashboard (dashboard.html) end-to-end against the local Express server. Use when verifying dashboard UI changes, live-update behavior, or that profile IP/location data comes from real APIs (not fabricated).
---

# Testing the web-core analytics dashboard

## App overview
- Node/Express app. `npm install` then `npm start` (or `node server.js`) → http://localhost:3000.
- `index.html` = tracked page (a full-screen image). `tracker.js` fires events to `POST /api/log_data`:
  Page Load (on load), Image Click (click the image), Scroll Depth, Page Exit.
- `dashboard.html` reads `GET /api/recent` + `GET /api/sessions` and auto-refreshes every 5s.
- Events are appended to `data.json` (one JSON object per line).

## How to generate REAL data (no fabrication)
1. Open `http://localhost:3000/index.html` in a browser tab → fires a Page Load.
2. Click the landscape image N times → N Image Click events.
   - A fresh browser origin gets a new `traker_user_id` (localStorage) + session → a brand-new profile.
3. Verify backend received it: `curl -s localhost:3000/api/sessions | python3 -m json.tool`
   and/or `tail -n 3 data.json`. Real geolocation comes from ipapi.co; for loopback the server
   uses the client-reported `publicIP`/geo, so you typically see the VM's real public IP + city.

## Key adversarial assertions for dashboard changes
- Live update: after generating a visit, dashboard auto-refreshes (no manual reload) within ~5s.
  Total Visits increments by the number of events; Active Sessions +1; a new Profile card appears.
- Real vs fake: the new profile's IP must equal the value from `/api/sessions` (a valid public IP,
  or `::1` for localhost) — never a random/fabricated IP. Location must match the API's geo string
  or be literally "Unknown". Cross-check the card against `curl /api/sessions`.
- Removed sections (this PR trimmed the UI): confirm absent via
  `curl -s localhost:3000/dashboard.html | grep -c <term>` == 0 for: canvas, "Daily Traffic",
  "Device Platform", "Time Spent", "Last Active", "Browser", "Image Clicks", "Most Active".

## Tips
- Maximize window before recording: `sudo apt-get install -y wmctrl 2>/dev/null; wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`.
- The dashboard has a date filter defaulting to "Last 7 Days" — recent test events fall inside it.
- If counts don't change, the auto-refresh (`setInterval(reloadData, 5000)`) or the fetch to
  `/api/recent`/`/api/sessions` might be broken — check the browser console and that the server is up.

## Devin Secrets Needed
- None. Fully local; no credentials or external secrets required.

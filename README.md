# TrailMates

A simple group hiking app for Android and the web. Big buttons, large text, few screens.

- **Trails from AllTrails** – on the AllTrails website, open a trail, select **Download Route → GPX**. In TrailMates, tap **Add a Trail** and select the file. All users see the trail.
- **See other hikers** – all logged-in hikers show on the map with their name and color.
- **Offline maps** – on a trail, tap **Save Map for No Signal** before you go.
- **Distance walked and left, time left, finish time** – the time estimate learns your real speed after 10 minutes.
- **Elevation graph** – shows where you are on the climb.

## 1. Server (CasaOS / Docker)

1. Push this repo to GitHub. The **Docker image** action builds `ghcr.io/<owner>/trailmates:latest`.
2. On GitHub: **Packages → trailmates → Package settings → Change visibility → Public** (or log CasaOS in to ghcr.io).
3. In CasaOS: **App Store → Custom Install → Import**, and paste `docker-compose.yml`.
4. Open `http://<server-ip>:8095`. Log in as `admin` / `changeme`. Change the password in **Settings**.
5. In **Settings → Hikers**, add an account for each hiker.

Use HTTPS (for example a reverse proxy or Cloudflare tunnel). Phones need HTTPS for location in the web version.

| Variable | Default | Use |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random (see log) | First admin. Used only on first start. |
| `TILE_URL` | OpenStreetMap | Map tile source. The server keeps a copy of each tile in `/data/tiles`. |
| `LOCATION_MAX_AGE_MIN` | `60` | Hide hikers not seen for this many minutes. |

Data (users, trails, map tiles) is in `/data`.

## 2. Android app

The **Android APK** action builds the app on each push to `main`.
On the phone, open the repo's **Releases → TrailMates Android (latest)**, download `TrailMates.apk`, and open it. Allow “install unknown apps” if the phone asks.
On first start, type the server address, your name and your password.
When you start a hike, allow location **“All the time”**. Then your group sees you when the screen is off.

The web version is also installable: open the server address in Chrome and select **Add to Home screen**. The web version shares your location only while the app is open.

## Development

```bash
cd server && npm install && cd ..
DATA_DIR=./data ADMIN_PASSWORD=test node server/index.js
node --test test/*.test.js
```

## Notes

- AllTrails has no public API and does not permit scraping, so the app imports GPX files only.
- OpenStreetMap tiles have a [usage policy](https://operations.osmfoundation.org/policies/tiles/). The app saves only the tiles along each trail, and the server keeps a copy, so each tile is downloaded one time. For heavy use, set `TILE_URL` to a tile service with a key.

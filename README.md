# RideWithGPS Street View

A Chrome and Firefox extension for the [RideWithGPS route planner](https://ridewithgps.com/routes/new). Pick a point on the map and a Google Street View panel opens at that spot.

## Features

- A **Street View** button sits at the top left of the map. Turn it on, then click the map to pick a point. Clicks in this mode never add control points to your route. Press it again, or press `Esc`, to go back to normal planning.
- **Alt+click** (Option+click on a Mac) picks a point at any time, without turning the mode on.
- A click within 30 px of the route **snaps onto the route**, and the view faces the direction of travel.
- **◀ / ▶** move 25 m back or forward along the route. Hold Shift to move 100 m. The view keeps facing the way you were looking.
- **⇅** turns the view around. **↗** opens the same spot in Google Maps.
- A yellow marker with a wedge shows the point and heading on the map.
- You can drag the panel by its header and resize it from the bottom-right corner. Its position and size are remembered.

It runs on any ridewithgps.com page with a map, so it also works on saved routes and rides.

## Install (development)

### Chrome / Edge / Brave

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

### Firefox (128 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `manifest.json` in this folder.

A temporary add-on is removed when Firefox restarts. To install it permanently, sign it through [addons.mozilla.org](https://addons.mozilla.org/developers/) (it can be unlisted). Before you submit, replace the placeholder `browser_specific_settings.gecko.id` in `manifest.json` with an ID you own.

If the button doesn't show up in Firefox, open the Extensions toolbar menu and allow the extension on ridewithgps.com.

## Packaging

```bash
./scripts/package.sh
```

This writes `dist/rwgps-streetview-<version>.zip`. You can upload the same zip to the Chrome Web Store and to AMO.

## How it works

- RideWithGPS draws its map with MapLibre GL but doesn't expose the map object. The content script runs in the page's main world (`"world": "MAIN"`). It walks up the React tree from the `.maplibregl-map` element to find the map instance, then uses `map.project` and `map.unproject` to convert between screen and map coordinates.
- The route line comes from the map's GeoJSON sources. It uses the feature that RideWithGPS tags `subset: "overall"`, or the longest line if no feature has that tag.
- Picks are intercepted with capture-phase `pointerdown`/`pointerup`/`click` listeners on `window`, so RideWithGPS never sees them.
- Street View is Google's keyless embed (`maps.google.com/maps?layer=c&cbll=…&output=svembed`). It shows the nearest panorama to the point. No API key is needed.

## Caveats

- The extension relies on RideWithGPS internals: the MapLibre class names, React fiber keys and the route's GeoJSON source. A RideWithGPS update could break it. `findMap`, `readRoute` and `attach` in `content/streetview.js` are the places to check first.
- The keyless Street View embed isn't an official Google API and could change. The fallback is the official [Maps Embed API](https://developers.google.com/maps/documentation/embed/embedding-map#streetview_mode) (`/maps/embed/v1/streetview?key=…`), which needs a free API key.

## Icons

`icons/icon.svg` is the source. The PNGs (16, 32, 48 and 128 px) were rendered from it. If you change the SVG, re-export the PNGs at those sizes, for example with `rsvg-convert -w 128 icons/icon.svg -o icons/icon-128.png`.

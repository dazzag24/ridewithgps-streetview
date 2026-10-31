#!/bin/sh
# Builds a zip suitable for both the Chrome Web Store and addons.mozilla.org.
set -eu
cd "$(dirname "$0")/.."
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
mkdir -p dist
out="dist/rwgps-streetview-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json content icons/*.png
echo "$out"

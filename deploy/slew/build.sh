#!/bin/sh
set -eu

node --version
npm run build:server
output=tmp/slew
mkdir -p "$output/server/dist"
cp -R dist/. "$output/server/dist/"
cp package.json package-lock.json "$output/server/"
cp deploy/slew/run.mjs "$output/server/"
cp deploy/slew/slew.json "$output/"
npm ci --prefix "$output/server" --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund

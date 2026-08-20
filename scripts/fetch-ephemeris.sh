#!/usr/bin/env bash
#
# Download the Swiss Ephemeris data files this service needs into ./ephe.
#
# Without the `.se1` files the service runs on the built-in Moshier ephemeris,
# which cannot place Chiron or the four major asteroids (they come back in
# `unavailableBodies`) and is lower precision than Swiss. Without `sefstars.txt`
# the fixed-star technique on /advanced degrades to `available:false` — sweph
# ships a tiny built-in star table, so a partial catalogue is worse than none
# and `computeFixedStars` deliberately refuses it. The README calls these files
# the production configuration.
#
# SOURCE: Astrodienst's own public repository. Their old FTP path
# (astro.com/ftp/swisseph/ephe) was retired in September 2023 and now just
# redirects readers to this repo — the README's old URL 404s.
#
# WHY A SCRIPT AND NOT COMMITTED FILES: ~4MB of binary data that is not ours to
# redistribute; fetching keeps the provenance obvious and the repo clean.
#
# RANGE: `_18`/`_24` are Astrodienst's 600-year blocks. 1800–2399 covers every
# living person's birth chart and the transits/progressions this app computes.
# Add `_12` (1200–1799) only if you ever need historical charts.
#
# LICENCE: the Swiss Ephemeris is dual-licensed AGPL-3.0 or commercial. This
# service is AGPL-3.0 and publishes its source, which is what permits use of the
# data here. See services/compute/README.md → "License".
#
# Usage:  ./scripts/fetch-ephemeris.sh          (from services/compute)
set -euo pipefail

BASE="https://raw.githubusercontent.com/aloistr/swisseph/master/ephe"
DEST="$(cd "$(dirname "$0")/.." && pwd)/ephe"

# Planets, Moon, and the asteroid file (Chiron + Ceres/Pallas/Juno/Vesta live
# in `seas_*`). All three prefixes are needed; `seas_` is the one whose absence
# silently costs you Chiron.
#
# `sefstars.txt` is the fixed-star catalogue: a small text file (~140KB), not an
# .se1 block, and the only thing `swe_fixstar2_ut` reads. Its absence is what
# makes the Advanced screen's fixed-star technique report "catalogue not
# installed".
FILES=(
  sepl_18.se1 sepl_24.se1
  semo_18.se1 semo_24.se1
  seas_18.se1 seas_24.se1
  sefstars.txt
)

mkdir -p "$DEST"
echo "Fetching Swiss Ephemeris files into $DEST"

for f in "${FILES[@]}"; do
  if [ -s "$DEST/$f" ]; then
    echo "  = $f (already present)"
    continue
  fi
  echo "  ↓ $f"
  # `--fail` so a 404 is an error rather than an HTML error page written to a
  # .se1 file, which would fail much later and far less clearly.
  curl --fail --location --silent --show-error --output "$DEST/$f" "$BASE/$f"
done

echo
echo "Done. $(ls -1 "$DEST" | wc -l | tr -d ' ') files, $(du -sh "$DEST" | cut -f1) total."
echo "Set SWEPH_PATH=$DEST to use them locally; the Docker build picks up ./ephe automatically."

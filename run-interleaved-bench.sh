#!/usr/bin/env bash
set -euo pipefail

BASELINE="/Users/mejiasdev/Developer/oss/Leaflet.bench-baseline"
PROJECTION="/Users/mejiasdev/Developer/oss/Leaflet.perf-projection-cache"
SPATIAL="/Users/mejiasdev/Developer/oss/Leaflet.perf-canvas-spatial-index"
SPEC="spec/suites/perf/MainBaselineBenchSpec.js"
OUT_DIR="/Users/mejiasdev/Developer/oss/Leaflet.bench-baseline/bench-logs"
mkdir -p "$OUT_DIR"

run_one() {
  local label="$1"
  local dir="$2"
  local log="$OUT_DIR/${label}.log"
  echo ">>> Running $label in $dir"
  (
    cd "$dir"
    npx vitest run --project=chromium --reporter=verbose "$SPEC" 2>&1 || true
  ) | tee "$log"
  rg "BENCH_RESULT" "$log" || true
  echo "---"
}

run_one "baseline-run1" "$BASELINE"
run_one "projection-run1" "$PROJECTION"
run_one "spatial-run1" "$SPATIAL"
run_one "baseline-run2" "$BASELINE"
run_one "projection-run2" "$PROJECTION"
run_one "spatial-run2" "$SPATIAL"

echo "Done. Logs in $OUT_DIR"
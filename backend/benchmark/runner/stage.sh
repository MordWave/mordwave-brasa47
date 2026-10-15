#!/bin/sh
# Assembles the clean build context for bench-runner (no .out fixtures, reports, tests or scripts that
# talk to Railway) and prints its path. Upload with:
#   railway up "$(sh benchmark/runner/stage.sh)" --path-as-root -s bench-runner -e benchmark --detach
set -eu
cd "$(dirname "$0")/../.."          # backend/
stage="${STAGE_DIR:-$(mktemp -d)}"
mkdir -p "$stage/benchmark/lib"
cp -R benchmark/k6 "$stage/benchmark/k6"
cp -R benchmark/runner "$stage/benchmark/runner"
cp benchmark/export-fixture.mjs "$stage/benchmark/"
cp benchmark/lib/guards.mjs benchmark/lib/fixture.mjs "$stage/benchmark/lib/"
cp benchmark/runner/Dockerfile "$stage/Dockerfile"
rm -f "$stage/benchmark/runner/stage.sh"
[ ! -e "$stage/benchmark/.out" ] || { echo "stage contains .out" >&2; exit 1; }
echo "$stage"

#!/usr/bin/env bash
# Installs the pinned gitleaks (GITLEAKS_VERSION) after checking its sha256; prints the binary's path.
# Usage: GITLEAKS="$(scripts/install-gitleaks.sh)"; "$GITLEAKS" git ...
set -euo pipefail
v="${GITLEAKS_VERSION:?set GITLEAKS_VERSION}"
dir="${RUNNER_TEMP:-/tmp}/gitleaks-$v"
mkdir -p "$dir" && cd "$dir"
base="https://github.com/gitleaks/gitleaks/releases/download/v${v}"
curl -sSfL -o gitleaks.tgz "$base/gitleaks_${v}_linux_x64.tar.gz"
curl -sSfL -o checksums.txt "$base/gitleaks_${v}_checksums.txt"
grep " gitleaks_${v}_linux_x64.tar.gz$" checksums.txt | awk '{print $1"  gitleaks.tgz"}' | sha256sum -c - >&2
tar -xzf gitleaks.tgz gitleaks
echo "$dir/gitleaks"

#!/bin/sh
# Pru installer (F3): fresh checkout -> proxied with zero manual config.
# Local only. No curl-piped URLs ship until the owner confirms the domain.
set -eu

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"

command -v bun >/dev/null 2>&1 || {
  echo "Pru needs Bun first: https://bun.sh" >&2
  exit 1
}

echo "Pru: installing dependencies..."
bun install --cwd "${REPO_DIR}"

echo "Pru: linking ~/.local/bin/pru..."
mkdir -p "${BIN_DIR}"
printf '#!/bin/sh\nexec bun "%s/src/cli.ts" "$@"\n' "${REPO_DIR}" > "${BIN_DIR}/pru"
chmod +x "${BIN_DIR}/pru"

echo "Pru: pointing Claude Code at the daemon..."
"${BIN_DIR}/pru" install

echo "Pru: verifying the books..."
"${BIN_DIR}/pru" status >/dev/null
echo "Pru is on the books. Start the daemon with: pru start"
echo "If ~/.local/bin is not on your PATH, add: export PATH=\"\$HOME/.local/bin:\$PATH\""

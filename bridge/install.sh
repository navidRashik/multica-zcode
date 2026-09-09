#!/usr/bin/env bash
# Install the multica-zcode bridge for the current user.
set -euo pipefail

ZCODE_CJS_CANDIDATES=(
  "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
  "${ZCODE_CJS:-}"
)
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.nvm/versions/node"/*/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
[ -n "$NODE_BIN" ] || { echo "error: node not found on PATH or nvm" >&2; exit 1; }

ZCODE_CJS_RESOLVED=""
for c in "${ZCODE_CJS_CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -f "$c" ] && { ZCODE_CJS_RESOLVED="$c"; break; }
done
[ -n "$ZCODE_CJS_RESOLVED" ] || { echo "error: zcode.cjs not found; set ZCODE_CJS=/path/to/zcode.cjs" >&2; exit 1; }

DEST_DIR="$HOME/.multica/bin"
mkdir -p "$DEST_DIR"
cp "$(dirname "$0")/multica-zcode.mjs" "$DEST_DIR/multica-zcode.mjs"
cat > "$DEST_DIR/multica-zcode" <<EOF
#!/bin/bash
# multica-zcode bridge (installed by multica-zcode/bridge/install.sh)
ZCODE_CJS="$ZCODE_CJS_RESOLVED" exec "$NODE_BIN" "$DEST_DIR/multica-zcode.mjs" "\$@"
EOF
chmod +x "$DEST_DIR/multica-zcode"

echo "Installed: $DEST_DIR/multica-zcode"
echo "  node:     $NODE_BIN"
echo "  zcode.cjs: $ZCODE_CJS_RESOLVED"
echo
echo "Wire it into Multica (claude provider override):"
echo "  export MULTICA_CLAUDE_PATH=\"\$HOME/.multica/bin/multica-zcode\""
echo "  multica daemon restart"
echo
echo "For boot persistence on macOS put MULTICA_CLAUDE_PATH in"
echo "~/Library/LaunchAgents/ai.multica.daemon.plist EnvironmentVariables."
echo
echo "Verify headless zcode is configured: \$DEST_DIR/multica-zcode --version"

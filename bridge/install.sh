#!/usr/bin/env bash
# Install the multica-zcode plugin: the bridge binary plus a native Multica
# "ZCode" runtime profile, so zcode shows up as its own runtime in the
# workspace — no Multica code changes, no claude-provider hijacking.
#
#   bridge/install.sh              # plugin install (recommended)
#   MULTICA_ZCODE_WITH_AGENT=1 …   # also create a workspace agent on it
#
# Legacy mode (override the daemon's claude provider via MULTICA_CLAUDE_PATH)
# is still available by passing --legacy.
set -euo pipefail

LEGACY=0
[ "${1:-}" = "--legacy" ] && LEGACY=1

# ── resolve node ─────────────────────────────────────────────────────────────
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.nvm/versions/node"/*/bin/node; do
    [ -x "$c" ] && NODE_BIN="$c" && break
  done
fi
[ -n "$NODE_BIN" ] || { echo "error: node not found on PATH or nvm" >&2; exit 1; }

# ── resolve zcode runtime (native binary preferred, desktop bundle fallback) ─
ZCODE_ON_PATH="$(command -v zcode || true)"
ZCODE_CJS_RESOLVED=""
if [ -z "$ZCODE_ON_PATH" ]; then
  for c in "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs" "${ZCODE_CJS:-}"; do
    [ -n "$c" ] && [ -f "$c" ] && { ZCODE_CJS_RESOLVED="$c"; break; }
  done
  [ -n "$ZCODE_CJS_RESOLVED" ] || {
    echo "error: zcode CLI not on PATH and no ZCode.app bundle found (set ZCODE_CJS=/path/to/zcode.cjs)" >&2
    exit 1
  }
fi

# ── install the bridge ───────────────────────────────────────────────────────
DEST_DIR="$HOME/.multica/bin"
mkdir -p "$DEST_DIR"
cp "$(dirname "$0")/multica-zcode.mjs" "$DEST_DIR/multica-zcode.mjs"
cat > "$DEST_DIR/multica-zcode" <<EOF
#!/bin/bash
# multica-zcode bridge (installed by multica-zcode/bridge/install.sh)
ZCODE_CJS="$ZCODE_CJS_RESOLVED" exec "$NODE_BIN" "$DEST_DIR/multica-zcode.mjs" "\$@"
EOF
chmod +x "$DEST_DIR/multica-zcode"

BRIDGE="$DEST_DIR/multica-zcode"
echo "Installed bridge: $BRIDGE"
echo "  node:  $NODE_BIN"
if [ -n "$ZCODE_ON_PATH" ]; then
  echo "  zcode: $ZCODE_ON_PATH (native app-server)"
else
  echo "  zcode: $ZCODE_CJS_RESOLVED (desktop bundle via node)"
fi

# ── headless zcode sanity ────────────────────────────────────────────────────
CLI_CFG="$HOME/.zcode/cli/config.json"
CLI_CRED="$HOME/.zcode/cli/credentials.json"
if [ ! -f "$CLI_CFG" ] || ! grep -q '"provider"' "$CLI_CFG" || [ ! -f "$CLI_CRED" ]; then
  cat >&2 <<'WARN'
warning: headless zcode is not configured yet (~/.zcode/cli/config.json needs a
warning: provider entry + model, and credentials.json must exist). Run once:
warning:   zcode login
warning: then set  model.main  to a "builtin:zai-coding-plan/GLM-..." ref.
WARN
fi

if [ "$LEGACY" = "1" ]; then
  cat <<EOF

Legacy wiring (claude-provider override):
  export MULTICA_CLAUDE_PATH="$BRIDGE"
  multica daemon restart
For boot persistence on macOS put MULTICA_CLAUDE_PATH in
~/Library/LaunchAgents/ai.multica.daemon.plist EnvironmentVariables.
EOF
  exit 0
fi

# ── plugin mode: create the ZCode runtime profile ────────────────────────────
command -v multica >/dev/null || { echo "error: multica CLI not found (brew install multica-ai/tap/multica)" >&2; exit 1; }

PROFILE_NAME="ZCode"
PROFILE_DESC="ZCode agent (GLM via z.ai coding plan) — bridge-backed runtime profile"
PROFILES_JSON="$(multica runtime profile list --output json 2>/dev/null || echo '[]')"
PROFILE_ID="$(
  printf '%s' "$PROFILES_JSON" | python3 -c '
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
rows=rows if isinstance(rows,list) else rows.get("profiles",[])
for r in rows:
    if r.get("display_name")=="'"$PROFILE_NAME"'" or r.get("command_name")=="multica-zcode":
        print(r.get("id","")); break
' 2>/dev/null || true
)"

if [ -n "$PROFILE_ID" ]; then
  echo "Runtime profile already exists: $PROFILE_NAME ($PROFILE_ID)"
else
  echo "Creating runtime profile '$PROFILE_NAME' (protocol family: claude)…"
  CREATE_JSON="$(multica runtime profile create \
    --display-name "$PROFILE_NAME" \
    --command-name multica-zcode \
    --protocol-family claude \
    --description "$PROFILE_DESC" \
    --output json)"
  PROFILE_ID="$(
    printf '%s' "$CREATE_JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
d=d.get("profile",d)
print(d.get("id",""))'
  )"
  [ -n "$PROFILE_ID" ] || { echo "error: could not read profile id from create output" >&2; exit 1; }
fi

# ~/.multica/bin is not on the daemon's PATH — pin the executable for this machine.
echo "Pinning per-machine executable path…"
multica runtime profile set-path "$PROFILE_ID" --path "$BRIDGE" >/dev/null

cat <<EOF

Plugin installed.
  Bridge:   $BRIDGE
  Profile:  $PROFILE_NAME ($PROFILE_ID)

Next steps:
  1. Restart the daemon so it picks up the profile:
       multica daemon restart
  2. Wait ~a minute for the daemon to probe and register the new runtime, then:
       multica runtime list            # find the "ZCode (navid-…-local)" runtime id
  3. Create an agent on it (or skip and set the runtime on an existing agent):
       multica agent create --name zcode --runtime-id <runtime-id> --public-to-workspace
  4. Assign it an issue. Multica's UI now lists ZCode as its own runtime.

If you previously used the legacy MULTICA_CLAUDE_PATH override, remove it from
~/Library/LaunchAgents/ai.multica.daemon.plist so the real Claude runtime is no
longer shadowed, then:  launchctl bootout gui/\$(id -u)/ai.multica.daemon 2>/dev/null;
launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/ai.multica.daemon
EOF

if [ "${MULTICA_ZCODE_WITH_AGENT:-0}" = "1" ]; then
  echo
  echo "MULTICA_ZCODE_WITH_AGENT=1: agent creation needs the daemon to register the"
  echo "new runtime first (multica runtime list) — run the agent create command from"
  echo "step 3 above once the ZCode runtime appears."
fi

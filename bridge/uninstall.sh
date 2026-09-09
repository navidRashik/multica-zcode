#!/usr/bin/env bash
# Remove the multica-zcode plugin: runtime profile, agent, bridge binary, and
# any legacy MULTICA_CLAUDE_PATH wiring. Best-effort at every step.
set -uo pipefail

echo "Removing multica-zcode plugin…"

# 1. Agent named "zcode"
AGENTS_JSON="$(multica agent list --output json 2>/dev/null || echo '[]')"
AGENT_ID="$(printf '%s' "$AGENTS_JSON" | python3 -c '
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
rows=rows if isinstance(rows,list) else rows.get("agents",[])
for a in rows:
    if a.get("name")=="zcode":
        print(a.get("id","")); break
' 2>/dev/null || true)"
if [ -n "${AGENT_ID:-}" ]; then
  echo "Deleting agent zcode ($AGENT_ID)…"
  multica agent delete "$AGENT_ID" 2>/dev/null || echo "  (agent delete failed; remove it in the UI)"
else
  echo "No agent named 'zcode' found."
fi

# 2. Runtime profile "ZCode"
PROFILES_JSON="$(multica runtime profile list --output json 2>/dev/null || echo '[]')"
PROFILE_ID="$(printf '%s' "$PROFILES_JSON" | python3 -c '
import json,sys
try: rows=json.load(sys.stdin)
except Exception: rows=[]
rows=rows if isinstance(rows,list) else rows.get("profiles",[])
for r in rows:
    if r.get("display_name")=="ZCode" or r.get("command_name")=="multica-zcode":
        print(r.get("id","")); break
' 2>/dev/null || true)"
if [ -n "${PROFILE_ID:-}" ]; then
  echo "Deleting runtime profile ZCode ($PROFILE_ID)…"
  multica runtime profile delete "$PROFILE_ID" 2>/dev/null || echo "  (profile delete failed; remove it in the UI)"
else
  echo "No ZCode runtime profile found."
fi

# 3. Bridge binary
if [ -f "$HOME/.multica/bin/multica-zcode" ]; then
  rm -f "$HOME/.multica/bin/multica-zcode" "$HOME/.multica/bin/multica-zcode.mjs"
  echo "Removed ~/.multica/bin/multica-zcode(.mjs)."
fi

# 4. Legacy LaunchAgent override
PLIST="$HOME/Library/LaunchAgents/ai.multica.daemon.plist"
if [ -f "$PLIST" ] && grep -q "MULTICA_CLAUDE_PATH" "$PLIST"; then
  cat <<EOF

NOTE: $PLIST still contains MULTICA_CLAUDE_PATH (legacy claude-provider
override). Remove that <key>MULTICA_CLAUDE_PATH</key> + <string>…</string> pair
from EnvironmentVariables, then:
  launchctl bootout gui/\$(id -u)/ai.multica.daemon 2>/dev/null
  launchctl bootstrap gui/\$(id -u) $PLIST
EOF
fi

echo "Done. Restart the daemon:  multica daemon restart"

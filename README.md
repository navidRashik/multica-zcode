# multica-zcode

First-class [Multica](https://github.com/multica-ai/multica) support for the
[ZCode](https://z.ai) coding-agent CLI.

Multica speaks a per-provider protocol to each agent CLI it drives (Claude Code's
stream-json, Codex app-server, ACP, …). ZCode is not one of its 26 built-in
providers. This repo closes that gap two ways:

1. **`bridge/` — works today.** A drop-in shim that presents Claude Code's
   stream-json protocol to Multica's daemon and translates it onto ZCode's own
   `app-server` protocol. Tool calls stream live into Multica's execution log,
   token usage is reported per run, and zcode session ids pass through so
   Multica's resume works unchanged.

2. **`upstream/` — the path to native support.** A documented ZCode Protocol
   spec, a self-contained Go client for it, and an integration guide for
   upstreaming a native `zcode` provider into `multica-ai/multica` (new
   descriptor entry + driver, no shim needed).

## Quick start (self-host, macOS/Linux)

```bash
git clone https://github.com/navidRashik/multica-zcode.git
cd multica-zcode/bridge
./install.sh          # installs to ~/.multica/bin, checks prerequisites
```

Then point the daemon's `claude` provider at the bridge and restart it:

```bash
export MULTICA_CLAUDE_PATH="$HOME/.multica/bin/multica-zcode"
multica daemon restart
```

For a boot-persistent setup (launchd), keep `MULTICA_CLAUDE_PATH` in
`~/Library/LaunchAgents/ai.multica.daemon.plist` under `EnvironmentVariables`.

Finally create an agent in Multica backed by the `claude` provider on your
local runtime — it will actually run zcode:

```bash
multica agent create --name zcode --runtime-id <claude-runtime-id> --public-to-workspace
multica issue create --title "Hello" --assignee zcode
```

## Requirements

- [Multica](https://github.com/multica-ai/multica) CLI + daemon (self-host or cloud runtime)
- ZCode CLI (the desktop app bundles it at
  `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`; override with
  `ZCODE_CJS=/path/to/zcode.cjs`)
- Headless zcode configured once: `~/.zcode/cli/config.json` needs a `provider`
  entry and a `model` string (e.g. `"builtin:zai-coding-plan/GLM-5.3"`) and
  `~/.zcode/cli/credentials.json` present. Run `zcode login` to generate both.

## What the bridge supports

| Capability | Status |
|---|---|
| Assign issue → zcode run → result on the board | ✅ |
| Live tool-call events in Multica's execution log | ✅ (via `session/event`) |
| Token usage per run | ✅ (zcode `usage` → claude result usage) |
| Session resume across runs (`--resume sess_…`) | ✅ (ids pass through 1:1) |
| `--version` discovery probes | ✅ |
| Autonomous permissions | ✅ (yolo mode + allow-once fallback) |
| Streaming text deltas / thinking | partial (final text only; deltas arrive as keepalives) |
| Cost in USD | reported as 0 (z.ai plan billing is not per-token USD) |

## How it works

```
Multica daemon ──claude stream-json──▶ multica-zcode bridge ──ZCode Protocol──▶ zcode app-server
              ◀──stream-json events──                     ◀──session/events──
```

The bridge is a strict protocol adapter: it owns no state beyond the running
app-server child. See `protocol/PROTOCOL.md` for the wire format.

## License

MIT — see [LICENSE](LICENSE).

# multica-zcode

A [Multica](https://github.com/multica-ai/multica) **plugin** that adds
[ZCode](https://z.ai) (GLM-5.x via the z.ai coding plan) as a first-class
runtime in your workspace — its own entry in the runtime picker, named
"ZCode", with live tool-call streaming, per-run token usage, and session
resume. **No Multica code changes.** Everything routes through Multica's
supported extension point: custom runtime profiles.

```
Multica daemon ──claude stream-json──▶ multica-zcode bridge ──ZCode Protocol──▶ zcode app-server
              ◀──stream-json events──                     ◀──session/events──
```

The bridge is a strict protocol adapter: it presents Claude Code's
stream-json protocol to the daemon and translates onto zcode's own
app-server protocol (`session/create → setMode yolo → subscribe
desktop-continuous → session/send`). It owns no state beyond the running
child.

## Install (plugin mode)

```bash
git clone https://github.com/navidRashik/multica-zcode.git
cd multica-zcode/bridge
./install.sh
multica daemon restart
# then: multica runtime list          → grab the ZCode runtime id
#       multica agent create --name zcode --runtime-id <id> --public-to-workspace
```

`install.sh` does three things:

1. installs the bridge to `~/.multica/bin/multica-zcode`,
2. creates a **ZCode runtime profile** (`multica runtime profile create
   --protocol-family claude --command-name multica-zcode`) and pins the
   per-machine executable path,
3. prints the agent-creation step.

After the daemon restarts, the ZCode runtime appears in the workspace's
runtime picker like any built-in CLI, and any agent can be pointed at it.

### Requirements

- [Multica](https://github.com/multica-ai/multica) CLI + daemon (self-host or
  cloud runtime), authenticated (`multica login`)
- The zcode CLI on PATH (`zcode`, ≥0.15 — the native binary speaks the
  app-server protocol directly), **or** the ZCode desktop app
  (`/Applications/ZCode.app`, used via its bundled `zcode.cjs` + node)
- Node ≥18 (to run the bridge itself)
- Headless zcode configured once: `~/.zcode/cli/config.json` with a `provider`
  entry + `model` (e.g. `"builtin:zai-coding-plan/GLM-5.3"`) and
  `~/.zcode/cli/credentials.json`. Running `zcode login` generates both.

### Credential self-healing

The desktop ZCode app re-issues the coding-plan API key when it refreshes its
session, which silently breaks a headless CLI config copied from it
(`Authentication Failed`, type 1000). The bridge detects the rotation at every
spawn and re-syncs `builtin:zai*` provider keys from the desktop config
(`~/.zcode/v2/config.json` → `~/.zcode/cli/config.json`), so runs keep working
without manual re-copying.

## What the bridge supports

| Capability | Status |
|---|---|
| Own named runtime in the picker (runtime profile) | ✅ |
| Assign issue → zcode run → result on the board | ✅ |
| Live tool-call events in Multica's execution log | ✅ (via `session/event`) |
| Token usage per run | ✅ (zcode `usage` → claude result usage) |
| Session resume across runs (`--resume sess_…`) | ✅ (ids pass through 1:1) |
| Model selection (`--model` → `session/setModel`) | ✅ for zcode refs (`providerId/modelId`, e.g. `builtin:zai-coding-plan/GLM-5.3`) or bare GLM ids; other ids fall back to the session default |
| Reasoning off (`--effort disabled` → `session/setThoughtLevel`) | ✅ (on is the zcode default; zcode 0.15.2 rejects re-enabling) |
| `--version` discovery probes | ✅ |
| Autonomous permissions | ✅ (yolo mode + allow-once fallback) |
| Streaming text deltas / thinking | partial (final text only; deltas arrive as keepalives) |
| Cost in USD | reported as 0 (z.ai plan billing is not per-token USD) |

Known trade-off of the profile approach: the runtime profile's protocol family
is `claude`, so Multica's static Claude model list is shown in pickers and
priced with Claude rates. Model ids that aren't zcode refs are ignored by the
bridge (the session keeps its default model). Killing that last bit of
impersonation needs a native provider upstream — see `upstream/`.

## Uninstall

```bash
cd multica-zcode/bridge
./uninstall.sh
```

Removes the agent, the runtime profile, and the bridge binary, and flags any
legacy `MULTICA_CLAUDE_PATH` still sitting in the launchd plist.

## Legacy mode (not recommended)

The pre-profile way: point the daemon's `claude` provider at the bridge.

```bash
./install.sh --legacy
export MULTICA_CLAUDE_PATH="$HOME/.multica/bin/multica-zcode"
multica daemon restart
```

This makes the workspace's *Claude* runtime actually run zcode — it stops
being Claude and becomes a fake one. Kept only for daemons too old for
`multica runtime profile`.

## How it works

Each Multica run spawns one `zcode app-server` child (native `zcode` binary if
installed, else node + the desktop bundle). The bridge handshake creates or
resumes the session, sets yolo mode, subscribes to `desktop-continuous`
events, maps `--model`/`--effort` onto `session/setModel` /
`session/setThoughtLevel`, sends the prompt, and streams `tool_input_start`
events as tool_use blocks back into Multica's execution log. The completion
event (`payload.response` + `payload.usage`) becomes the stream-json result.
See `protocol/PROTOCOL.md` for the full reverse-engineered wire spec with
verified param shapes.

## Upstream path to a native provider

`upstream/` documents what a first-class `zcode` provider inside
multica-ai/multica would take: a protocol spec, a self-contained Go client
(`zcode_protocol.go`), a reference daemon-side driver
(`zcode_driver.go.reference` — written against the v0.4.41 tree, not merged),
and `INTEGRATION.md`, a step-by-step upstreaming guide (descriptor entry +
driver + per-provider plumbing checklist).

## License

MIT

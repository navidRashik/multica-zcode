# Upstreaming a native `zcode` provider into multica-ai/multica

Everything below is based on the multica-ai/multica source at v0.4.41. The end
state: Multica lists **ZCode** as a first-class provider (own name, model
catalog, skills dir, session resume) with no bridge.

## Why a native provider beats the bridge

The bridge works by impersonating `claude`, so Multica shows "Claude", routes
any claude-model selection blindly, and prices usage with Claude rates. A
native provider fixes naming, catalog, and accounting, and drops one process
hop.

## 1. Declare the runtime descriptor

`server/pkg/agent/builtin_runtimes.go` states the design goal directly:
*"Adding a new compatible fork of an existing runtime is a descriptor entry,
not a cross-stack change."* Add:

```go
{
  ID:             "zcode",
  ProtocolFamily: "zcode",          // new entry in SupportedTypes (see §2)
  DefaultCommand: "zcode",
  EnvPrefix:      "MULTICA_ZCODE",  // → MULTICA_ZCODE_PATH / MULTICA_ZCODE_MODEL
  DisplayName:    "ZCode",
  SkillsDir:      ".zcode/skills",
  UserSkillsDir:  ".zcode/cli/skills",
},
```

## 2. New protocol family + driver

- Register `"zcode"` in the `SupportedTypes` / `NewRuntime` dispatch
  (`server/internal/daemon/config.go` ~line 973 lists provider keys;
  `NewRuntime` builds the family backend).
- Implement the driver in `server/pkg/agent/zcode.go`, modeled on
  `qwen.go`/`claude.go`:
  - `ExecOptions` → argv: unlike claude, zcode takes **no** stream-json flags.
    Launch `zcode app-server` (long-lived child per run) and drive the
    protocol (see `protocol/PROTOCOL.md`; reference client in
    `upstream/zcode_protocol.go`).
  - Prompt delivery: `session/send {sessionId, content}` per user message.
  - Live transcript: map `session/event` payloads with
    `kind:"tool_input_start|tool_input_end"` to tool_use blocks and the
    completion event (`payload.response` + `payload.usage`) to the result —
    same Message{Type: …} stream the claude driver feeds the daemon today.
  - Resume: Multica stores the returned session id and passes it back via
    `opts.ResumeSessionID`; zcode session ids (`sess_…`) are stable strings,
    map them 1:1 via `session/resume`, falling back to a fresh session when
    resume errors (the daemon already handles `ResumeRejected`).
  - Permissions: run with `session/setMode {mode:"yolo"}` for autonomous
    tasks; honor the agent's permission mode if Multica later surfaces it.
- Version probe: the daemon runs the binary with `--version` and parses the
  output. zcode prints `zcode <semver>`; return that (do NOT emit protocol
  frames for `--version` — the probe parses plain text, see
  `agents_refresh.go`).

## 3. Per-provider plumbing (grep checklist)

Sites the descriptor comment names — all keyed off the descriptor, but verify
each compiles/parses with the new key:

- `server/internal/daemon/agents_probe.go` — env-path probe
  (`MULTICA_ZCODE_PATH`, `MULTICA_ZCODE_MODEL`).
- `server/internal/daemon/config.go` — provider key list, idle-watchdog knobs.
- `server/internal/daemon/daemon.go` — `defaultArgsForProvider` (return nil),
  display-name override, execenv env allowlists.
- `server/internal/daemon/local_skills.go` — skills dirs (`.zcode/skills`,
  `~/.zcode/cli/skills`), provider gates.
- `server/internal/daemon/agents_refresh.go` — minimum supported version.
- `server/internal/metrics/pricing.go` (+`labels.go`) — usage labels; z.ai
  plan billing has no per-token USD, keep cost 0.
- `apps/web` display maps — provider label/icon so the board shows "ZCode".

## 4. Model catalog

`session/create`'s response embeds the live catalog
(`settings.model.available[]`: `ref.{providerId,modelId}`, `label`,
`contextWindow`, `maxOutputTokens`, `reasoning.levels[]`). Implement the
provider's ListModels by running the handshake and projecting that array —
no static table to maintain. `--model`/`--effort` map to
`session/setModel` and `session/setThoughtLevel`.

## 5. Tests

Mirror the existing per-driver tests (`qwen_test.go`, `claude.go`'s blocked
args tests): fake a `zcode` binary (shell script emitting canned NDJSON) and
assert argv construction, event mapping, completion detection, and resume
fallback.

## Acceptance

- `multica agent create --provider zcode` works from the CLI.
- Issue assigned to a zcode agent streams tool calls into the execution log.
- Token usage lands in `agent stream protocol summary`.
- `MULTICA_ZCODE_PATH` points at the desktop-bundled
  `…/ZCode.app/Contents/Resources/glm/zcode.cjs` via a `node` wrapper.

## Status (2026-09-10)

Implemented and deployed on one machine against the v0.4.41 tree: descriptor
site changes, a zcode driver speaking the app-server protocol over NDJSON,
live model-catalog discovery via session/create's `settings.model.available`,
and the probe / display-name / skills / execenv / metrics plumbing. A snapshot
of the daemon-side driver lives in `upstream/zcode_driver.go.reference` (same
package layout, compile-verified against the tree; not submitted upstream).
Verified wire shapes (setModel / setThoughtLevel / stop, zcode 0.15.2) are
documented in `protocol/PROTOCOL.md`.

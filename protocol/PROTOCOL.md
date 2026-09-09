# ZCode Protocol (app-server) — reverse-engineered spec

This documents the NDJSON protocol spoken by `zcode app-server` as observed in
zcode 0.16.x. It is sufficient to drive zcode headlessly from any language.

## Framing

One JSON message per line over the child's stdin/stdout. No `jsonrpc` key.

```jsonc
// request (either direction)
{"id": "m1", "method": "session/create", "params": {...}}

// response to a request
{"id": "m1", "result": {...}}
{"id": "m1", "error": {"code": -32602, "message": "Invalid params — …", "data": {...}}}

// notification (no id)
{"method": "session/event", "params": {...}}
```

The server also sends *requests* to the client (e.g. preference prompts). The
client must answer them with `{"id": <server's id>, "result": {...}}` or the
originating call hangs.

## Handshake → run sequence

```
→ {"id":"1","method":"session/create",
    "params":{"workspace":{"workspacePath":"/abs/cwd","workspaceKey":"/abs/cwd"}}}
← {result:{ session:{sessionId:"sess_…", model:{…}, settings:{…}}, protocol:{version:1}, … }}

← {"id":"server-1","method":"session/requestRuntimePreferences",
    "params":{"sessionId":"sess_…","scope":"runtime-materialization"}}
→ {"id":"server-1","result":{"nativeSearchEnhancementsEnabled":false}}

→ {"id":"2","method":"session/setMode","params":{"sessionId":"sess_…","mode":"yolo"}}
→ {"id":"3","method":"session/subscribe",
    "params":{"sessionId":"sess_…","deliveryKind":"desktop-continuous"}}
→ {"id":"4","method":"session/send","params":{"sessionId":"sess_…","content":"<prompt>"}}

← session/event notifications stream until the final event (below)
```

- `workspaceKey` may equal `workspacePath`.
- `session/resume` with `{"sessionId":"sess_…"}` replaces `session/create` when
  continuing an existing session. If the session is gone the call errors —
  create a fresh one.
- Modes: `build` (approves side effects), `plan`, `edit`, `yolo`
  (autonomous — no permission prompts).
- With a different `deliveryKind` no `session/event` notifications are emitted
  (observed error mentions `desktop-continuous` / `web-remote-replayable`).

## Server→client requests seen in practice

| method | answer with |
|---|---|
| `session/requestRuntimePreferences` | `{"nativeSearchEnhancementsEnabled": false}` |
| `interaction/requestPermission` | the matching option's `response` object, e.g. `{"decision":"allow","reason":"…"}` from `params.options[].response` |
| `interaction/requestOfficialMcpAuthHeaders` | `{}` |
| `v4/telemetry/event` | `{}` |
| `process/mcpTelemetry`, `process/resourceSample`, `computer-use/operation-event` | `{}` (notifications-style noise; answering is harmless) |

## session/event stream

Each notification `params` carries `{sessionId, eventId, seq, timestamp, traceId, turnId,
deliveryKind, payload}`. Payload shapes observed during one run:

- title generation: `{previousTitle, source:"first_input"|"generated", title}`
- user input accepted: `{turnNumber, input, messageId, foregroundExecutionId, queryId}`
- model selection: `{modelRef:{providerId, modelId, role}}`
- turn stats: `{messageCount, model, toolCount, iteration}`
- model request: `{baseURL, maxAttempts, model, requestId, modelRequestSessionType:"main"}`
- tool streaming: `{kind:"tool_input_start"|"tool_input_end", assistantMessageId,
  toolCallId, toolName, delta, done}`
- workspace checkpoint: `{checkpointId, messageId, toolMessageId, scope}`
- **final/completion event**: `{response:"<assistant text>", tokenCount, usage:{
  source, modelRequestCount, inputTokens, outputTokens, totalTokens,
  cacheReadTokens, cacheWriteTokens, reasoningTokens, …}}`

Completion detection: the event whose `payload` contains both `response` and
`usage`. Anything else is progress.

## Useful methods (from the method registry)

`session/{create, resume, list, read, messages, events, subscribe, send, stop,
cancelBackgroundTask, fork, compact, goal, close, setModel, setMode,
setThoughtLevel, usage, subagents, requestRuntimePreferences,
updateRuntimeModelConfig}`, `workspace/{setDefaultModel, setDefaultMode,
upsertModelProvider, readState, …}`, `plugins/*`, `usage/stats`.

`session/create`'s response includes the full model catalog
(`settings.model.available[]` with `ref`, `label`, `contextWindow`,
`maxOutputTokens`, `reasoning.levels[]`) — enough to populate a provider's
model list without any static table.

## Errors

Zod validation failures come back as
`error.data.message` with `path`/`expected` per issue — useful for schema
discovery: send `{}`, read the first complaint, add the field.

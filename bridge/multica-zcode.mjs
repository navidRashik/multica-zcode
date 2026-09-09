#!/usr/bin/env node
// multica-zcode bridge — lets Multica drive the zcode CLI as if it were
// Claude Code's stream-json protocol, backed by zcode's own "ZCode Protocol"
// app-server (NDJSON) so Multica's execution log sees live tool calls.
//
// Multica spawns: <bridge> -p --output-format stream-json --input-format
//   stream-json --verbose --permission-mode bypassPermissions [--model M]
//   [--effort L] [--resume <sess_...>] [--max-turns N] [custom args...]
// and streams user messages in over stdin. This shim:
//   1. answers `--version` probes with a claude-style version line,
//   2. maps each stream-json user message onto a ZCode Protocol session turn,
//   3. forwards tool-call events and the final response back as stream-json,
//   4. maps --model onto session/setModel and --effort onto
//      session/setThoughtLevel (v3).
//
// zcode session ids pass through unchanged so Multica's `--resume sess_...`
// maps 1:1 onto `session/resume`.
//
// The app-server child is resolved in this order (v3):
//   1. $ZCODE_BIN (explicit override),
//   2. `zcode` on PATH (the native SEA binary speaks the protocol directly),
//   3. node + $ZCODE_CJS (default the desktop app's bundled zcode.cjs).

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ZCODE_BIN = process.env.ZCODE_BIN || '';
const ZCODE_CJS = process.env.ZCODE_CJS || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const APP_SERVER_TIMEOUT_MS = 15_000; // handshake budget
const IDLE_KEEPALIVE_MS = 120_000;

const argv = process.argv.slice(2);

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const dbg = (msg) => process.stderr.write(`[multica-zcode] ${msg}\n`);

// ---- credential self-healing -----------------------------------------------
// The desktop ZCode app (config at ~/.zcode/v2) re-issues the coding-plan API
// key whenever it refreshes its session; a CLI config copied from it then
// starts failing with "Authentication Failed" (type 1000). Before spawning the
// app-server, copy any rotated builtin:zai* provider apiKey from the desktop
// config into the CLI config. Best-effort: no desktop config or any write
// failure just skips the sync (the run then uses the CLI config as-is).

function syncRotatedApiKeys() {
  try {
    const cliPath = join(homedir(), '.zcode', 'cli', 'config.json');
    const v2Path = join(homedir(), '.zcode', 'v2', 'config.json');
    if (!existsSync(cliPath) || !existsSync(v2Path)) return;
    const cli = JSON.parse(readFileSync(cliPath, 'utf8'));
    const v2 = JSON.parse(readFileSync(v2Path, 'utf8'));
    let changed = false;
    for (const [id, entry] of Object.entries(v2.provider || {})) {
      if (!id.startsWith('builtin:zai')) continue;
      const newKey = entry?.options?.apiKey;
      const cliEntry = cli.provider?.[id];
      if (!newKey || !cliEntry || cliEntry?.options?.apiKey === newKey) continue;
      cliEntry.options.apiKey = newKey;
      changed = true;
      dbg(`rotated apiKey for provider ${id} from desktop config`);
    }
    if (!changed) return;
    const tmp = cliPath + '.tmp-zsync';
    writeFileSync(tmp, JSON.stringify(cli, null, 2), { mode: 0o600 });
    renameSync(tmp, cliPath);
  } catch (e) {
    dbg(`credential sync skipped: ${e.message?.split('\n')[0]}`);
  }
}
syncRotatedApiKeys();

if (argv.includes('--version') || argv.includes('-v')) {
  console.log('2.1.265 (multica-zcode-bridge)');
  process.exit(0);
}

// ---- argv extraction -------------------------------------------------------
// The daemon (claude protocol family) owns model/effort selection; custom args
// ride through untouched. zcode takes none of them as CLI flags — they map to
// protocol messages after the handshake.

let resumeId = '';
let requestedModel = '';
let requestedEffort = '';
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--resume' || argv[i] === '--session-id') && argv[i + 1]) {
    resumeId = argv[i + 1];
    i++;
  } else if (argv[i] === '--model' && argv[i + 1]) {
    requestedModel = argv[i + 1];
    i++;
  } else if (argv[i] === '--effort' && argv[i + 1]) {
    requestedEffort = argv[i + 1];
    i++;
  }
}


function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  if (content && content.type === 'text') return content.text || '';
  return '';
}

// ---------------------------------------------------------------- app-server

class AppServer {
  constructor(cwd) {
    this.cwd = cwd;
    this.child = spawnAppServerReal(cwd);
    this.pending = new Map(); // id -> resolve
    this.events = [];         // drained by the turn runner
    this.wake = null;
    this.seq = 0;
    this.dead = null;
    this.child.stdout.setEncoding('utf8');
    let buf = '';
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    this.child.stderr.on('data', (d) => dbg(`app-server stderr: ${String(d).trim()}`));
    this.child.on('exit', (code, signal) => dbg(`app-server exit code=${code} signal=${signal}`));
    this.child.on('error', (e) => dbg(`app-server spawn error: ${e.message}`));
    this.child.on('close', (code) => {
      dbg(`app-server closed (code ${code})`);
      this.dead = `app-server exited (code ${code})`;
      if (this.wake) this.wake();
    });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(String(msg.id));
      if (p) { this.pending.delete(String(msg.id)); p(msg); }
      return;
    }
    if (msg.method) {
      if (msg.method === 'session/event') {
        this.events.push(msg.params || {});
      } else {
        // Auto-answer server requests. Permission prompts are allowed with the
        // first "allow" option offered (yolo mode should prevent these).
        let result = {};
        if (msg.method === 'session/requestRuntimePreferences') {
          result = { nativeSearchEnhancementsEnabled: false };
        } else {
          const opts = msg.params?.options;
          if (Array.isArray(opts)) {
            const allow = opts.find((o) => o?.response?.decision === 'allow');
            if (allow) result = allow.response;
          }
        }
        this.send({ id: msg.id, result });
      }
      if (this.wake) this.wake();
    }
  }

  send(obj) {
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = APP_SERVER_TIMEOUT_MS) {
    const id = 'mzb' + ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message || 'error'}`));
        else resolve(msg.result);
      });
      this.send({ id, method, params });
    });
  }

  // Resolves with the next session event; null only when the process is gone.
  // Auto-answered server requests also wake us — treat those as spurious and
  // keep waiting rather than ending the turn.
  nextEvent() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.wake = () => {
        if (this.events.length) {
          this.wake = null;
          resolve(this.events.shift());
        } else if (this.dead) {
          this.wake = null;
          resolve(null);
        }
      };
    });
  }

  kill() { try { this.child.kill(); } catch { /* already gone */ } }
}

// spawnAppServerReal resolves the zcode runtime once, at first use:
// $ZCODE_BIN → `zcode` on PATH → node + $ZCODE_CJS. The native SEA binary
// (zcode ≥0.15) speaks the app-server protocol directly, so node is only
// needed when the CLI is not installed and only the desktop bundle exists.
let appServerCmdCache = null;

function resolveAppServerCommand() {
  if (appServerCmdCache) return appServerCmdCache;
  if (ZCODE_BIN) {
    appServerCmdCache = { cmd: ZCODE_BIN, args: ['app-server'] };
    return appServerCmdCache;
  }
  try {
    execFileSync('zcode', ['--version'], { stdio: 'pipe', timeout: 10_000 });
    appServerCmdCache = { cmd: 'zcode', args: ['app-server'] };
    return appServerCmdCache;
  } catch (e) {
    dbg(`native 'zcode' binary not usable (${String(e.message).split('\n')[0]}); using node + $ZCODE_CJS`);
  }
  appServerCmdCache = { cmd: process.execPath, args: [ZCODE_CJS, 'app-server'] };
  return appServerCmdCache;
}

function spawnAppServerReal(cwd) {
  const { cmd, args } = resolveAppServerCommand();
  dbg(`app-server: ${cmd} ${args.join(' ')}`);
  return spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

// ---- model / effort mapping ------------------------------------------------

// session/setModel expects {sessionId, model:{providerId, modelId}} (verified
// against zcode 0.15.2). Multica (claude family) sends claude-style model ids
// it cannot know how to translate, so only ids that look like a zcode ref —
// "providerId/modelId" — or a GLM id are applied; anything else is ignored
// and the session keeps its default model.
function parseModelRef(model, fallbackProviderId) {
  const id = String(model || '').trim();
  if (!id) return null;
  const slash = id.indexOf('/');
  if (slash > 0 && slash < id.length - 1) {
    return { providerId: id.slice(0, slash), modelId: id.slice(slash + 1) };
  }
  if (/^glm/i.test(id) && fallbackProviderId) {
    return { providerId: fallbackProviderId, modelId: id };
  }
  return null;
}

// session/setThoughtLevel expects {sessionId, thoughtLevel} (verified against
// zcode 0.15.2, whose settings catalog advertises "enabled"/"disabled" but
// whose setThoughtLevel rejected "enabled" on GLM-5.3 with "Unsupported
// reasoning effort"). The session default already has thinking on, so only
// the explicit-off mapping is applied; other effort values are ignored.
function parseThoughtLevel(effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (['off', 'none', 'disabled', 'minimal'].includes(e)) return 'disabled';
  return null;
}

async function primeSession(srv, sessionId) {
  await srv.request('session/setMode', { sessionId, mode: 'yolo' });
  await srv.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
}

// applyModelAndEffort best-effort applies the daemon's selections after the
// session exists. Failures are logged and ignored: the session default is
// always a working configuration.
async function applyModelAndEffort(srv, sessionId, sessionModel) {
  if (requestedModel) {
    const ref = parseModelRef(requestedModel, sessionModel?.providerId);
    if (ref) {
      try {
        await srv.request('session/setModel', { sessionId, model: ref });
        dbg(`model set: ${ref.providerId}/${ref.modelId}`);
      } catch (e) {
        dbg(`session/setModel failed (${e.message}); keeping session default`);
      }
    } else {
      dbg(`model "${requestedModel}" is not a zcode ref (providerId/modelId) or GLM id; ignoring`);
    }
  }
  if (requestedEffort) {
    const level = parseThoughtLevel(requestedEffort);
    if (level) {
      try {
        await srv.request('session/setThoughtLevel', { sessionId, thoughtLevel: level });
        dbg(`thought level set: ${level}`);
      } catch (e) {
        dbg(`session/setThoughtLevel failed (${e.message}); keeping session default`);
      }
    } else {
      dbg(`effort "${requestedEffort}" has no zcode mapping; ignoring`);
    }
  }
}

// ---- session lifecycle -----------------------------------------------------

async function startSession(cwd, resumeId) {
  const srv = new AppServer(cwd);
  if (resumeId) {
    try {
      const res = await srv.request('session/resume', { sessionId: resumeId });
      const sid = res?.session?.sessionId || resumeId;
      await primeSession(srv, sid);
      await applyModelAndEffort(srv, sid, res?.session?.model);
      return { srv, sessionId: sid };
    } catch (e) {
      dbg(`resume of ${resumeId} failed (${e.message}); starting a fresh session`);
      srv.kill();
      return startSession(cwd, '');
    }
  }
  const res = await srv.request('session/create', {
    workspace: { workspacePath: cwd, workspaceKey: cwd },
  });
  const sessionId = res?.session?.sessionId;
  if (!sessionId) throw new Error('session/create returned no sessionId');
  await primeSession(srv, sessionId);
  await applyModelAndEffort(srv, sessionId, res?.session?.model);
  return { srv, sessionId };
}

// ------------------------------------------------------------- stream-json facade

emit({
  type: 'system',
  subtype: 'init',
  session_id: resumeId || 'zc_pending',
  cwd: process.cwd(),
  model: 'zcode-glm',
  permissionMode: 'bypassPermissions',
  tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch'],
});

let turn = 0;

async function runTurn(prompt) {
  turn++;
  let srv;
  let sessionId;
  try {
    ({ srv, sessionId } = await startSession(process.cwd(), turn === 1 ? resumeId : lastSessionId));
  } catch (e) {
    dbg(`startSession failed: ${e.message}`);
    emit({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: `zcode app-server failed to start: ${e.message}`, session_id: 'zc_error',
    });
    process.exit(1);
  }
  lastSessionId = sessionId;

  try { await srv.request('session/send', { sessionId, content: prompt }); } catch (e) {
    emit({
      type: 'result', subtype: 'error_during_execution', is_error: true,
      result: `session/send failed: ${e.message}`, session_id: sessionId,
    });
    srv.kill();
    process.exit(1);
  }

  let lastEventAt = Date.now();
  const keepalive = setInterval(() => {
    if (Date.now() - lastEventAt > IDLE_KEEPALIVE_MS) {
      emit({
        type: 'assistant',
        message: {
          id: 'zc_keepalive', role: 'assistant',
          content: [{ type: 'thinking', thinking: `zcode is still working (${Math.round((Date.now() - lastEventAt) / 1000)}s since last event)` }],
        },
        session_id: sessionId,
      });
    }
  }, 30_000);

  while (true) {
    const ev = await srv.nextEvent();
    if (!ev) break; // process gone
    lastEventAt = Date.now();
    if (ev.sessionId && ev.sessionId !== sessionId) continue;
    const p = ev.payload || {};
    if (p.kind === 'tool_input_start' && p.toolName) {
      emit({
        type: 'assistant',
        message: {
          id: p.assistantMessageId || `zc_${ev.eventId}`, role: 'assistant', model: 'zcode-glm',
          content: [{ type: 'tool_use', id: p.toolCallId, name: p.toolName, input: {} }],
        },
        session_id: sessionId,
      });
      continue;
    }
    if (p.response !== undefined && p.usage) {
      const usage = {
        input_tokens: p.usage.inputTokens ?? 0,
        output_tokens: p.usage.outputTokens ?? 0,
        cache_read_input_tokens: p.usage.cacheReadTokens ?? 0,
        cache_creation_input_tokens: p.usage.cacheWriteTokens ?? 0,
      };
      emit({
        type: 'assistant',
        message: {
          id: `msg_${sessionId}`, role: 'assistant', model: 'zcode-glm', stop_reason: 'end_turn',
          content: [{ type: 'text', text: p.response }],
        },
        session_id: sessionId,
      });
      emit({
        type: 'result', subtype: 'success', is_error: false,
        result: p.response, session_id: sessionId, usage, total_cost_usd: 0,
      });
      break;
    }
  }
  clearInterval(keepalive);
  srv.kill();
}

let lastSessionId = resumeId;

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { return; }
  if (msg.type !== 'user') return;
  const text = textFromContent(msg.message?.content);
  if (!text.trim()) return;
  runTurn(text);
});

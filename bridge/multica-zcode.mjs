#!/usr/bin/env node
// multica-zcode bridge — lets Multica drive the zcode CLI as if it were
// Claude Code's stream-json protocol, backed by zcode's own "ZCode Protocol"
// app-server (NDJSON) so Multica's execution log sees live tool calls.
//
// Multica spawns: <bridge> -p --output-format stream-json --input-format
//   stream-json --verbose --permission-mode bypassPermissions [--model M]
//   [--resume <sess_...>] [--effort L] [--max-turns N] [custom args...]
// and streams user messages in over stdin. This shim:
//   1. answers `--version` probes with a claude-style version line,
//   2. maps each stream-json user message onto a ZCode Protocol session turn,
//   3. forwards tool-call events and the final response back as stream-json.
//
// zcode session ids pass through unchanged so Multica's `--resume sess_...`
// maps 1:1 onto `session/resume`.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const ZCODE_CJS = process.env.ZCODE_CJS || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const APP_SERVER_TIMEOUT_MS = 15_000; // handshake budget
const IDLE_KEEPALIVE_MS = 120_000;

const argv = process.argv.slice(2);

if (argv.includes('--version') || argv.includes('-v')) {
  console.log('2.1.265 (multica-zcode-bridge)');
  process.exit(0);
}

let resumeId = '';
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--resume' || argv[i] === '--session-id') && argv[i + 1]) {
    resumeId = argv[i + 1];
    i++;
  }
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const dbg = (msg) => process.stderr.write(`[multica-zcode] ${msg}\n`);

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
    this.child = spawn(process.execPath, [ZCODE_CJS, 'app-server'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (d) => dbg(`app-server stderr: ${String(d).trim()}`));
    this.pending = new Map(); // id -> resolve
    this.events = [];         // drained by the turn runner
    this.wake = null;
    this.seq = 0;
    this.dead = null;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
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

async function startSession(cwd, resumeId) {
  const srv = new AppServer(cwd);
  if (resumeId) {
    try {
      const res = await srv.request('session/resume', { sessionId: resumeId });
      const sid = res?.session?.sessionId || resumeId;
      await primeSession(srv, sid);
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
  return { srv, sessionId };
}

async function primeSession(srv, sessionId) {
  await srv.request('session/setMode', { sessionId, mode: 'yolo' });
  await srv.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' });
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
    dbg(`startSession failed: ${e.message}`);    emit({
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
rl.on('close', () => { /* exit happens when the turn completes */ });

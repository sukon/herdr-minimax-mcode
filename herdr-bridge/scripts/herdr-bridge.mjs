#!/usr/bin/env node
// Herdr Bridge — MCode plugin hook script.
//
// Reads a MINIMAX-format Plugin Hook payload from stdin (JSON, schemaVersion
// defined in `packages/agent-modules/plugin-hooks/src/runner.ts`), inspects the
// lifecycle event, and reports the corresponding semantic state to Herdr via
// `$HERDR_BIN_PATH pane report-agent` / `pane release-agent`.
//
// Behavior outside Herdr (HERDR_ENV != 1) is a no-op so the same plugin is safe
// to keep enabled when MCode runs in a normal terminal.
//
// All Herdr I/O is fire-and-forget with a short timeout so a stalled Herdr
// server never blocks the MCode turn loop.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const HERDR_REPORT_TIMEOUT_MS = 2000;
const PANE_RESOLVE_TIMEOUT_MS = 1500;
const STDIN_READ_TIMEOUT_MS = 1500;
const STDIN_MAX_BYTES = 64 * 1024;

const SOURCE = 'mcode-herdr-bridge';
const AGENT = 'mcode';
const STATE_FILE = 'state.json';

// Herdr's documented limits for a resume command. Breaking the argv rules makes
// Herdr reject the *entire* report with `invalid_resume_argv`, so a session id
// carrying an odd character must degrade to "state only", never to a lost
// state report. See https://herdr.dev/docs/add-herdr-support/#report-the-resume-command
const MAX_RESUME_ARGS = 64;
const MAX_RESUME_BYTES = 8 * 1024;
const APOSTROPHE_RE = /'/u;
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/u;

// A Herdr spawn gets a deliberately minimal environment so the MCode session's
// env — which can hold API keys and session tokens — is never handed to the
// Herdr CLI. Windows still needs a handful of system variables before a native
// `.exe` will start at all, so those are allow-listed back in.
const WINDOWS_ENV_ALLOWLIST = [
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

const HERDR_STATE_FOR_EVENT = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PermissionRequest: 'blocked',
  PostToolUse: 'working',
  SubagentStart: 'working',
  SubagentStop: 'working',
  Stop: 'idle',
  PreCompact: 'working',
  PostCompact: 'working',
};

function readStdin() {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), STDIN_READ_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      total += chunk.length;
      if (total <= STDIN_MAX_BYTES) chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

// `--seq` must increase with every report from this source, across sessions and
// restarts. Herdr tracks the last accepted number per source and drops anything
// not strictly higher, so this deliberately stays a single counter shared by
// every pane rather than being scoped per pane: interleaved per-pane counters
// would each look monotonic to Herdr, but a shared one is also what lets a
// timestamp be a valid substitute, which is exactly the fallback used below.
function loadSequenceState(env) {
  const dir = env.PLUGIN_DATA;
  const empty = { seq: Date.now(), panes: {} };
  if (!dir) return empty;
  const file = join(dir, STATE_FILE);
  // Seed from the clock, never from 0. Herdr remembers the last seq it accepted
  // for a source independently of this file, so a first-ever run that starts at
  // 1 is silently rejected if Herdr already saw a higher number for this source
  // — which happens whenever plugin data is cleared or the plugin is reinstalled.
  if (!existsSync(file)) return empty;
  try {
    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    const seq = Number(parsed?.seq);
    if (Number.isFinite(seq) && seq >= 0) {
      const panes = parsed?.panes && typeof parsed.panes === 'object' && !Array.isArray(parsed.panes)
        ? parsed.panes
        : {};
      return { seq: Math.floor(seq), panes };
    }
  } catch {
    // fall through
  }
  // Herdr documents a timestamp as a good seq value, and this is strictly higher
  // than any counter we could have persisted, so recovery is seamless.
  return empty;
}

function persistSequenceState(env, seq, panes) {
  const dir = env.PLUGIN_DATA;
  if (!dir) return;
  let tmp;
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, STATE_FILE);
    // Write-then-rename so two Herdr panes reporting in the same instant can
    // never leave a half-written state file behind. A torn read is already
    // survivable (the loader falls back to a timestamp, which Herdr accepts as
    // a valid seq), but not creating the mess in the first place is cheaper
    // than recovering from it.
    tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ seq, ...(panes ? { panes } : {}) }), 'utf8');
    renameSync(tmp, file);
    tmp = undefined;
  } catch {
    // best effort — never block the MCode turn on disk errors
  } finally {
    if (tmp) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
}

function herdrChildEnv() {
  const env = { PATH: process.env.PATH ?? '' };
  if (process.platform !== 'win32') return env;
  for (const key of WINDOWS_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  return env;
}

function buildResumeArgv(sessionId) {
  // MCode accepts `--resume <id>` (hidden compat alias for `--session <id>` —
  // see `packages/tui/src/cli/contract.ts`).
  return ['mcode', '--resume', sessionId];
}

function isValidResumeArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  if (argv.length > MAX_RESUME_ARGS) return false;
  const [command, ...rest] = argv;
  // Herdr re-runs the command by bare name on the user's PATH, never by path.
  if (typeof command !== 'string') return false;
  if (command.length === 0 || command !== command.trim()) return false;
  if (command.includes('/') || command.includes('\\')) return false;
  for (const arg of argv) {
    if (typeof arg !== 'string') return false;
    if (APOSTROPHE_RE.test(arg) || CONTROL_CHAR_RE.test(arg)) return false;
  }
  return Buffer.byteLength(argv.join(' '), 'utf8') <= MAX_RESUME_BYTES;
}

function runHerdr(herdrBin, args, env) {
  if (!herdrBin) return;
  // On Windows, spawning `.cmd` / `.bat` requires going through cmd.exe because
  // Node's `CreateProcess` refuses non-executable extensions. Real-herdr ships
  // as a native `.exe` and goes through the default branch; the cmd.exe branch
  // is only hit by the test fake-herdr wrapper or a user-installed alias.
  const isWindowsScript = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(herdrBin);
  const command = isWindowsScript ? 'cmd.exe' : herdrBin;
  const fullArgs = isWindowsScript ? ['/d', '/s', '/c', herdrBin, ...args] : args;
  let child;
  try {
    child = spawn(command, fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: herdrChildEnv(),
    });
  } catch {
    // best effort — never let a Herdr spawn failure bubble back into MCode
    return;
  }

  // Drain stdio so the child never blocks on a full pipe buffer, and unref
  // the child so the bridge script can exit without waiting for herdr. The
  // child keeps running until HERDR_REPORT_TIMEOUT_MS, at which point we kill
  // it as a safety net.
  child.stdout?.resume();
  child.stderr?.resume();
  child.unref();

  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* ignore */ }
  }, HERDR_REPORT_TIMEOUT_MS);
  timer.unref();

  child.once('exit', () => clearTimeout(timer));
  child.once('error', () => clearTimeout(timer));
}

function reportState({ herdrBin, paneId, env, seq, state, sessionId, message, resumeArgv }) {
  const args = [
    'pane', 'report-agent', paneId,
    '--source', SOURCE,
    '--agent', AGENT,
    '--state', state,
    '--seq', String(seq),
  ];
  if (sessionId) args.push('--agent-session-id', sessionId);
  if (message) args.push('--message', message);
  if (resumeArgv && resumeArgv.length > 0) {
    args.push('--', ...resumeArgv);
  }
  runHerdr(herdrBin, args, env);
}

function releaseAgent({ herdrBin, paneId, env, seq }) {
  const args = [
    'pane', 'release-agent', paneId,
    '--source', SOURCE,
    '--agent', AGENT,
    '--seq', String(seq),
  ];
  runHerdr(herdrBin, args, env);
}

function messageFor(payload) {
  const event = payload.hook_event_name;
  if (event === 'PreToolUse' && typeof payload.tool_name === 'string') {
    return `tool: ${payload.tool_name}`;
  }
  if (event === 'PermissionRequest' && typeof payload.tool_name === 'string') {
    return `awaiting permission: ${payload.tool_name}`;
  }
  if (event === 'SubagentStart') {
    const t = payload.agent_type;
    if (typeof t === 'string' && t.length > 0) return `subagent: ${t}`;
  }
  if (event === 'PreCompact') return 'compacting';
  return undefined;
}

// ---------------------------------------------------------------------------
// Pane resolution
// ---------------------------------------------------------------------------
//
// Herdr normally hands a process in a managed pane `HERDR_PANE_ID`, and that is
// the only exact answer. MCode, however, sanitises the environment it hands to
// plugin hooks (`safeHookEnvironment` in
// `packages/agent-modules/plugin-hooks/src/runner.ts`), and HERDR_* is not on
// that allowlist — so a plugin hook never sees it and there is no hook field or
// setting to opt back in.
//
// What does survive is PATH, so the `herdr` binary is reachable, and the bridge
// can ask the server which pane it is in. `herdr pane current` is not the
// answer: without HERDR_PANE_ID it falls back to the *focused* pane, which is
// whatever the user last focused and is frequently a different pane.
//
// So we resolve by cwd instead: list the panes and pick the one whose cwd
// matches this MCode session's cwd. The rule is deliberately strict — exactly
// one match, or report nothing. Reporting into the wrong pane would fight
// another agent for its state, which is far worse than staying silent.
//
// Dropping the HERDR_ENV gate has a second consequence worth guarding: a plain
// terminal running MCode is indistinguishable from a pane running it once
// HERDR_* is gone. Without the ownership filter below, such a session would
// happily report into whatever herdr pane happens to share its cwd. So a pane
// already held by a *different* agent is never a candidate.

function normalizeCwd(value) {
  if (typeof value !== 'string') return undefined;
  let text = value.trim();
  if (text.length === 0) return undefined;
  // Strip a trailing separator so `C:\work\` and `C:\work` compare equal.
  while (text.length > 1 && (text.endsWith('/') || text.endsWith('\\'))) {
    text = text.slice(0, -1);
  }
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function isAncestorDir(ancestor, descendant) {
  if (ancestor === descendant) return false;
  const sep = process.platform === 'win32' ? '\\' : '/';
  const alt = process.platform === 'win32' ? '/' : '\\';
  return descendant.startsWith(ancestor + sep) || descendant.startsWith(ancestor + alt);
}

function isClaimable(pane) {
  const holder = pane?.agent;
  return holder === undefined || holder === null || holder === AGENT;
}

function pickPane(panes, sessionCwd) {
  const target = normalizeCwd(sessionCwd);
  if (!target || !Array.isArray(panes)) return undefined;

  const eligible = panes.filter((pane) => isClaimable(pane) && typeof pane?.pane_id === 'string');
  if (eligible.length === 0) return undefined;

  const exact = eligible.filter((pane) => normalizeCwd(pane?.cwd) === target);
  if (exact.length === 1) return exact[0].pane_id;

  // No exact hit — the session may have been started in a subdirectory of the
  // pane's cwd. Same uniqueness rule applies, so an ambiguous ancestor is still
  // a no-op rather than a guess.
  if (exact.length === 0) {
    const nested = eligible.filter((pane) => {
      const paneCwd = normalizeCwd(pane?.cwd);
      return paneCwd ? isAncestorDir(paneCwd, target) : false;
    });
    if (nested.length === 1) return nested[0].pane_id;
  }
  return undefined;
}

// Runs a herdr subcommand and returns its stdout, bounded so a wedged server
// can never eat into the hook's own time budget.
function herdrCapture(herdrBin, args, childEnv) {
  if (!herdrBin) return undefined;
  const isWindowsScript = process.platform === 'win32' && /\.(cmd|bat)$/iu.test(herdrBin);
  const command = isWindowsScript ? 'cmd.exe' : herdrBin;
  const fullArgs = isWindowsScript ? ['/d', '/s', '/c', herdrBin, ...args] : args;
  try {
    const result = spawnSync(command, fullArgs, {
      encoding: 'utf8',
      timeout: PANE_RESOLVE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
      env: childEnv,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

function listPanes(herdrBin, childEnv) {
  const stdout = herdrCapture(herdrBin, ['pane', 'list'], childEnv);
  if (!stdout) return undefined;
  try {
    const parsed = JSON.parse(stdout);
    const panes = parsed?.result?.panes;
    return Array.isArray(panes) ? panes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the pane this session reports into.
 * Returns `{ paneId, cache, cacheChanged }`, or `undefined` when no pane can be
 * identified with confidence.
 */
function resolvePane({ env, herdrBin, sessionId, sessionCwd, panes, isSessionStart = false }) {
  // Fast path: if MCode ever starts passing HERDR_* through, use it and skip
  // the round-trip entirely. Also keeps the test suite's fast path intact.
  if (env.HERDR_ENV === '1' && env.HERDR_PANE_ID) {
    return { paneId: env.HERDR_PANE_ID, cache: panes, cacheChanged: false };
  }

  const cached = sessionId && panes && typeof panes[sessionId] === 'string'
    ? panes[sessionId]
    : undefined;

  // A cached pane id does not outlive its pane: Herdr recycles ids once a pane
  // closes, and a session resumed after a restart can land in a different one.
  // Reporting into a pane that is gone fails with `pane_not_found`, and because
  // Herdr's failure is swallowed here, a stale entry would silently mute every
  // later event for that session with no way to recover.
  //
  // SessionStart is the one event where that is correctable, because it is
  // exactly when a resumed session has to find its new home. Re-probe there and
  // let a fresh answer overwrite the cache. Every other event keeps using the
  // cache: a live process cannot migrate panes mid-session, so re-probing per
  // event would only buy the same answer at the cost of a round-trip per
  // PreToolUse / PostToolUse.
  if (isSessionStart && sessionCwd) {
    const fresh = pickPane(listPanes(herdrBin || 'herdr', herdrChildEnv()), sessionCwd);
    if (fresh) {
      if (!sessionId) return { paneId: fresh, cache: panes, cacheChanged: false };
      const nextCache = { ...(panes ?? {}), [sessionId]: fresh };
      return { paneId: fresh, cache: nextCache, cacheChanged: fresh !== cached };
    }
    // An ambiguous or empty probe proves nothing, so keep the cached mapping
    // rather than discard one that is probably still right.
  }

  if (cached) {
    return { paneId: cached, cache: panes, cacheChanged: false };
  }

  // Fall back to the binary on PATH; MCode does pass PATH through.
  const bin = herdrBin || 'herdr';
  const resolved = pickPane(listPanes(bin, herdrChildEnv()), sessionCwd);
  if (!resolved || !sessionId) {
    return resolved ? { paneId: resolved, cache: panes, cacheChanged: false } : undefined;
  }

  const nextCache = { ...(panes ?? {}), [sessionId]: resolved };
  return { paneId: resolved, cache: nextCache, cacheChanged: true };
}

async function main() {
  const env = process.env;

  // Read stdin before anything else: outside Herdr the payload still arrives
  // and must be drained, otherwise MCode's write can hit a closed pipe.
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = payload.hook_event_name;
  if (typeof event !== 'string') {
    return;
  }

  const sessionId = typeof payload.session_id === 'string' && payload.session_id.length > 0
    ? payload.session_id
    : undefined;

  // Nothing to report for an event we do not map — bail before spending a
  // `pane list` round-trip on it.
  const state = HERDR_STATE_FOR_EVENT[event];
  if (event !== 'SessionEnd' && !state) {
    return;
  }

  const counter = loadSequenceState(env);
  const resolved = resolvePane({
    env,
    herdrBin: env.HERDR_BIN_PATH,
    sessionId,
    sessionCwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
    panes: counter.panes,
    isSessionStart: event === 'SessionStart',
  });
  if (!resolved) {
    return;
  }

  counter.seq += 1;

  if (event === 'SessionEnd') {
    // Drop the mapping as part of letting the pane go. Keeping it would leave a
    // pane id Herdr is free to recycle, and the next process to resume under this
    // session id would then report into whatever pane took that id — or into no
    // pane at all, if none did.
    const remaining = { ...(resolved.cache ?? counter.panes) };
    if (sessionId) delete remaining[sessionId];
    persistSequenceState(env, counter.seq, remaining);
    releaseAgent({
      herdrBin: env.HERDR_BIN_PATH || 'herdr',
      paneId: resolved.paneId,
      env,
      seq: counter.seq,
    });
    return;
  }

  persistSequenceState(env, counter.seq, resolved.cache ?? counter.panes);

  const message = messageFor(payload);

  // An argv Herdr would reject takes the whole state report down with it, so a
  // session id we cannot vouch for degrades to a state-only report instead.
  let resumeArgv;
  if (event === 'SessionStart' && sessionId) {
    const candidate = buildResumeArgv(sessionId);
    if (isValidResumeArgv(candidate)) resumeArgv = candidate;
  }

  reportState({
    herdrBin: env.HERDR_BIN_PATH || 'herdr',
    paneId: resolved.paneId,
    env,
    seq: counter.seq,
    state,
    sessionId,
    message,
    resumeArgv,
  });
  // Do not `process.exit(0)` here — the spawned herdr child has been unref'd
  // so this script can exit naturally when stdin closes and the timer fires.
}

main().catch(() => process.exit(0));
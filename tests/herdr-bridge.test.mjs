// Unit tests for herdr-bridge plugin.
//
// Strategy: spawn `node scripts/herdr-bridge.mjs` with controlled
// HERDR_ENV / HERDR_BIN_PATH / PLUGIN_DATA / HERDR_PANE_ID. HERDR_BIN_PATH
// points to a fake shell script that records the argv it received so each
// test can assert against it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'herdr-bridge', 'scripts', 'herdr-bridge.mjs');

// The bridge spawns herdr as an unref'd child so the script itself can exit
// quickly. Tests therefore poll briefly for the log file to settle.
function waitForLog(logPath, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (!existsSync(logPath)) {
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin briefly */ }
      continue;
    }
    const size = statSync(logPath).size;
    if (size === lastSize) {
      if (stableSince === 0) stableSince = Date.now();
      if (Date.now() - stableSince > 150) return readFileSync(logPath, 'utf8');
    } else {
      lastSize = size;
      stableSince = 0;
    }
    const until = Date.now() + 50;
    while (Date.now() < until) { /* spin briefly */ }
  }
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

function makeFakeHerdr(ticketDir, { paneList = null } = {}) {
  // The fake herdr CLI is a tiny Node script so argv capture works identically
  // on Windows and POSIX. It records every argv element (one per line) into
  // args.log inside the ticket directory.
  const logPath = join(ticketDir, 'args.log');
  const wrapperPath = join(ticketDir, 'fake-herdr.cmd');
  const scriptPath = join(ticketDir, 'fake-herdr.mjs');
  const paneListJson = paneList === null ? null : JSON.stringify(paneList);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
// Herdr argv layout from bridge: ['pane','report-agent',<paneId>,'--source',...,'--seq',N,'--',<resumeArgv>]
// Filter the leading '--log <path>' pair we prepend for the test so it doesn't
// pollute the recorded argv.
let start = 0;
if (argv[0] === '--log' && typeof argv[1] === 'string') start = 2;
const lines = argv.slice(start);
const target = start === 2 ? argv[1] : ${JSON.stringify(logPath)};
// 'pane list' is the resolver probe; answer it instead of recording it as a report.
if (lines[0] === 'pane' && lines[1] === 'list') {
  appendFileSync(${JSON.stringify(join(ticketDir, 'probes.log'))}, 'pane list\\n');
  const payload = ${paneListJson === null ? 'null' : JSON.stringify(paneListJson)};
  if (payload !== null) {
    process.stdout.write(payload);
  }
  process.exit(0);
}
writeFileSync(target, lines.join('\\n') + (lines.length ? '\\n' : ''));
`,
  );
  writeFileSync(
    wrapperPath,
    `@echo off\r\nnode "${scriptPath}" --log "${logPath}" %*\r\nexit /b 0\r\n`,
  );
  return { scriptPath: wrapperPath, logPath, probesLog: join(ticketDir, 'probes.log') };
}

function run({ env, stdin, ticketDir, paneList = null }) {
  if (!ticketDir) ticketDir = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const fake = makeFakeHerdr(ticketDir, { paneList });
  const fullEnv = {
    ...process.env,
    HERDR_ENV: '1',
    HERDR_BIN_PATH: fake.scriptPath,
    HERDR_PANE_ID: 'w1:p1',
    PLUGIN_DATA: ticketDir,
    ...env,
  };
  // Strip HERDR_* so the override takes effect.
  delete fullEnv.HERDR_ENV;
  delete fullEnv.HERDR_BIN_PATH;
  delete fullEnv.HERDR_PANE_ID;
  delete fullEnv.PLUGIN_DATA;
  Object.assign(fullEnv, env);
  if (!('HERDR_ENV' in fullEnv)) fullEnv.HERDR_ENV = '1';
  if (!('HERDR_BIN_PATH' in fullEnv)) fullEnv.HERDR_BIN_PATH = fake.scriptPath;
  if (!('HERDR_PANE_ID' in fullEnv)) fullEnv.HERDR_PANE_ID = 'w1:p1';
  if (!('PLUGIN_DATA' in fullEnv)) fullEnv.PLUGIN_DATA = ticketDir;

  const result = spawnSync(process.execPath, [SCRIPT], {
    env: fullEnv,
    input: stdin ?? '',
    timeout: 10_000,
    windowsHide: true,
  });
  const logText = waitForLog(fake.logPath);
  let argv = logText.split(/\r?\n/).filter(Boolean);
  let stateJson = null;
  const stateFile = join(ticketDir, 'state.json');
  if (existsSync(stateFile)) {
    stateJson = JSON.parse(readFileSync(stateFile, 'utf8'));
  }
  const probeCount = existsSync(fake.probesLog)
    ? readFileSync(fake.probesLog, 'utf8').split(/\r?\n/).filter(Boolean).length
    : 0;
  return { argv, stateJson, probeCount, exitCode: result.status, stderr: result.stderr?.toString() ?? '' };
}

// ---------------------------------------------------------------------------
// Pane resolution helpers — MCode strips HERDR_* from plugin hook children, so
// the bridge has to work the pane out from `pane list` instead. Declared up
// here because tests further down rely on them.
// ---------------------------------------------------------------------------

function paneListOf(panes) {
  return { id: 'cli:pane:list', result: { panes, type: 'pane_list' } };
}

const NO_HERDR_ENV = { HERDR_ENV: '', HERDR_PANE_ID: '' };

const SESSION_START_PAYLOAD = JSON.stringify({
  hook_event_name: 'SessionStart',
  session_id: '019de8c2-de29-73e9-ae0c-e134db34c447',
  source: 'startup',
  cwd: 'C:/work/proj',
});

test('SessionStart reports idle with session id and resume_argv', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv, stateJson } = run({
    env: {
      PLUGIN_DATA: ticket,
    },
    stdin: SESSION_START_PAYLOAD,
    ticketDir: ticket,
  });
  assert.deepEqual(argv.slice(0, 9), [
    'pane', 'report-agent', 'w1:p1',
    '--source', 'mcode-herdr-bridge',
    '--agent', 'mcode',
    '--state', 'idle',
  ]);
  assert.equal(argv.includes('--agent-session-id'), true);
  assert.equal(argv.includes('019de8c2-de29-73e9-ae0c-e134db34c447'), true);
  assert.equal(argv.includes('--'), true);
  const dashIdx = argv.indexOf('--');
  assert.deepEqual(argv.slice(dashIdx + 1), [
    'mcode',
    '--resume',
    '019de8c2-de29-73e9-ae0c-e134db34c447',
  ]);
  assert.ok(Number.isInteger(stateJson?.seq));
  assert.ok(stateJson.seq > 0);
});

test('UserPromptSubmit reports working with no message and no resume_argv', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 's1',
      prompt: 'hello',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.deepEqual(argv.slice(0, 9), [
    'pane', 'report-agent', 'w1:p1',
    '--source', 'mcode-herdr-bridge',
    '--agent', 'mcode',
    '--state', 'working',
  ]);
  assert.equal(argv.includes('--message'), false);
  assert.equal(argv.includes('--'), false);
});

test('PermissionRequest reports blocked with tool name', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  const idx = argv.indexOf('--message');
  assert.notEqual(idx, -1);
  assert.equal(argv[idx + 1], 'awaiting permission: Bash');
  assert.equal(argv[argv.indexOf('--state') + 1], 'blocked');
});

test('PreToolUse reports working with tool: <name>', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 's1',
      tool_name: 'Write',
      tool_use_id: 't1',
      tool_input: { file_path: '/work/x.ts' },
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'working');
  const idx = argv.indexOf('--message');
  assert.notEqual(idx, -1);
  assert.equal(argv[idx + 1], 'tool: Write');
});

test('PostToolUse reports working without message', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Read',
      tool_use_id: 't1',
      tool_input: { file_path: '/work/x.ts' },
      tool_response: 'ok',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'working');
  assert.equal(argv.includes('--message'), false);
});

test('SubagentStart reports working with subagent type', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SubagentStart',
      session_id: 's1',
      agent_id: 'a1',
      agent_type: 'explore',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  const idx = argv.indexOf('--message');
  assert.notEqual(idx, -1);
  assert.equal(argv[idx + 1], 'subagent: explore');
});

test('SubagentStop reports working without message', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SubagentStop',
      session_id: 's1',
      agent_id: 'a1',
      agent_type: 'explore',
      stop_hook_active: true,
      last_assistant_message: 'done',
      agent_transcript_path: '/tmp/a.jsonl',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'working');
  assert.equal(argv.includes('--message'), false);
});

test('Stop reports idle', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: true,
      last_assistant_message: 'all done',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'idle');
});

test('PreCompact reports working with compacting message', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'PreCompact',
      session_id: 's1',
      trigger: 'auto',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'working');
  assert.equal(argv[argv.indexOf('--message') + 1], 'compacting');
});

test('PostCompact reports working without message', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'PostCompact',
      session_id: 's1',
      trigger: 'auto',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'working');
});

test('SessionEnd calls pane release-agent', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 's1',
      reason: 'logout',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.deepEqual(argv.slice(0, 8), [
    'pane', 'release-agent', 'w1:p1',
    '--source', 'mcode-herdr-bridge',
    '--agent', 'mcode',
    '--seq',
  ]);
  assert.equal(argv.includes('--seq'), true);
});

test('--seq is monotonically increasing across calls', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const events = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];
  const seen = [];
  for (const event of events) {
    const { stateJson } = run({
      env: { PLUGIN_DATA: ticket },
      stdin: JSON.stringify({
        hook_event_name: event,
        session_id: 's1',
        ...(event === 'SessionEnd' ? { reason: 'logout' } : {}),
        ...(event === 'SessionStart' ? { source: 'startup' } : {}),
        cwd: '/work',
      }),
      ticketDir: ticket,
    });
    if (stateJson?.seq !== undefined && stateJson.seq !== null) seen.push(stateJson.seq);
  }
  // Seeded from the clock rather than 0, so only the *relationship* between
  // reports is contractual — every one must be exactly one higher than the last.
  assert.ok(seen.length >= 2, `expected several persisted seqs, got ${seen.length}`);
  for (let i = 1; i < seen.length; i += 1) {
    assert.equal(seen[i], seen[i - 1] + 1);
  }
});

test('a first run seeds seq from the clock, not from zero', () => {
  // Herdr remembers the last seq it accepted for a source independently of this
  // file, so starting at 1 would be silently rejected after a plugin-data wipe.
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const before = Date.now();
  const { stateJson } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: SESSION_START_PAYLOAD,
    ticketDir: ticket,
  });
  assert.ok(stateJson.seq >= before, `expected a timestamp seed, got ${stateJson.seq}`);
});

test('--seq recovers from a corrupted state.json', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  writeFileSync(join(ticket, 'state.json'), '{not valid json');
  const { stateJson } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.ok(stateJson.seq > 0);
  assert.ok(Number.isInteger(stateJson.seq));
});

test('outside Herdr (HERDR_ENV != 1) still resolves a pane when one is free', () => {
  // Documents a deliberate consequence of dropping the HERDR_ENV gate: once
  // MCode strips HERDR_*, a plain-terminal MCode is indistinguishable from one
  // in a pane, so the bridge resolves by cwd regardless. The ownership filter
  // (see 'never claims a pane already held by a different agent') is what keeps
  // this from stealing another agent's pane.
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      source: 'startup',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([{ pane_id: 'w5:p1', cwd: '/work/proj' }]),
  });
  assert.equal(argv[2], 'w5:p1');
});

test('an unreachable herdr server is a safe no-op', () => {
  // paneList: null makes the fake server answer `pane list` with nothing,
  // which is what a stopped or unreachable Herdr looks like.
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv, stateJson } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: SESSION_START_PAYLOAD,
    ticketDir: ticket,
  });
  assert.equal(argv.length, 0);
  assert.equal(stateJson, null);
});

test('HERDR_PANE_ID still wins when MCode does pass it through', () => {
  // Guards the fast path: if upstream ever adds HERDR_* to the hook env
  // allowlist, resolution must not fall through to the cwd probe.
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv, probeCount } = run({
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w9:p9', PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      source: 'startup',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([{ pane_id: 'w2:p1', cwd: '/work/proj' }]),
  });
  assert.equal(argv[2], 'w9:p9');
  assert.equal(probeCount, 0);
});

test('malformed JSON stdin exits cleanly without invoking herdr', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: '{not json',
    ticketDir: ticket,
  });
  assert.equal(argv.length, 0);
});

test('unknown event name is a safe no-op', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'NotAnEvent',
      session_id: 's1',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv.length, 0);
});

test('empty stdin is a safe no-op', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: '',
    ticketDir: ticket,
  });
  assert.equal(argv.length, 0);
});

test('SessionStart with empty session_id still reports idle but no resume_argv', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: '',
      source: 'startup',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'idle');
  assert.equal(argv.includes('--agent-session-id'), false);
  assert.equal(argv.includes('--'), false);
});

// Herdr rejects a resume command whose argv breaks its rules with
// `invalid_resume_argv` and drops the *whole* report, so a hostile-looking
// session id must degrade to a state-only report.
test('SessionStart drops resume_argv when session_id contains an apostrophe', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: "s'1",
      source: 'startup',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'idle');
  // The resume *command* is dropped, but the session id itself is still
  // reported: Herdr's argv rules govern the command, not --agent-session-id.
  assert.equal(argv.includes('--'), false);
  assert.equal(argv.includes('--agent-session-id'), true);
});

test('SessionStart drops resume_argv when session_id contains a control char', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 's\u00011',
      source: 'startup',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  assert.equal(argv[argv.indexOf('--state') + 1], 'idle');
  assert.equal(argv.includes('--'), false);
  assert.equal(argv.includes('--agent-session-id'), true);
});

test('state.json is written atomically and leaves no temp file behind', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  run({
    env: { PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/work',
    }),
    ticketDir: ticket,
  });
  const leftovers = readdirSync(ticket).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.ok(Number.isInteger(JSON.parse(readFileSync(join(ticket, 'state.json'), 'utf8')).seq));
});

// ---------------------------------------------------------------------------
// Pane resolution — MCode strips HERDR_* from plugin hook children, so the
// bridge has to work the pane out from `pane list` instead.
// ---------------------------------------------------------------------------

test('resolves the pane by cwd when HERDR_* is not passed through', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv, probeCount } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      source: 'startup',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([
      { pane_id: 'w1:p1', cwd: '/other' },
      { pane_id: 'w2:p1', cwd: '/work/proj' },
    ]),
  });
  assert.equal(argv[2], 'w2:p1');
  assert.equal(argv[argv.indexOf('--state') + 1], 'idle');
  assert.equal(probeCount, 1);
});

test('an ambiguous cwd match is a safe no-op rather than a guess', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([
      { pane_id: 'w1:p1', cwd: '/work/proj' },
      { pane_id: 'w1:p2', cwd: '/work/proj' },
    ]),
  });
  assert.equal(argv.length, 0);
});

test('never claims a pane already held by a different agent', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([
      { pane_id: 'w1:p1', cwd: '/work/proj', agent: 'claude', agent_status: 'working' },
    ]),
  });
  assert.equal(argv.length, 0);
});

test('reclaims its own pane from a previous session', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([
      { pane_id: 'w1:p1', cwd: '/work/proj', agent: 'mcode', agent_status: 'idle' },
    ]),
  });
  assert.equal(argv[2], 'w1:p1');
});

test('a session started in a subdirectory still resolves via the pane cwd', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/work/proj/packages/api',
    }),
    ticketDir: ticket,
    paneList: paneListOf([{ pane_id: 'w1:p1', cwd: '/work/proj' }]),
  });
  assert.equal(argv[2], 'w1:p1');
});

test('no cwd match is a safe no-op', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 's1',
      stop_hook_active: false,
      last_assistant_message: 'x',
      cwd: '/somewhere/else',
    }),
    ticketDir: ticket,
    paneList: paneListOf([{ pane_id: 'w1:p1', cwd: '/work/proj' }]),
  });
  assert.equal(argv.length, 0);
});

test('the resolved pane is cached per session and not re-probed', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const panes = paneListOf([{ pane_id: 'w3:p1', cwd: '/work/proj' }]);
  const payload = (event) => JSON.stringify({
    hook_event_name: event,
    session_id: 's1',
    cwd: '/work/proj',
    ...(event === 'SessionStart' ? { source: 'startup' } : {}),
  });
  const first = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: payload('SessionStart'),
    ticketDir: ticket,
    paneList: panes,
  });
  assert.equal(first.probeCount, 1);
  const second = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: payload('Stop'),
    ticketDir: ticket,
    paneList: panes,
  });
  // probes.log is cumulative, so a second probe would push this to 2.
  assert.equal(second.probeCount, 1);
  assert.equal(second.argv[2], 'w3:p1');
});

test('an unmapped event never triggers a pane list probe', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const { argv, probeCount } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'NotAnEvent',
      session_id: 's1',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: paneListOf([{ pane_id: 'w1:p1', cwd: '/work/proj' }]),
  });
  assert.equal(argv.length, 0);
  assert.equal(probeCount, 0);
});

test('SessionEnd releases the cached pane', () => {
  const ticket = mkdtempSync(join(tmpdir(), 'herdr-bridge-'));
  const panes = paneListOf([{ pane_id: 'w4:p1', cwd: '/work/proj' }]);
  run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      source: 'startup',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: panes,
  });
  const { argv } = run({
    env: { ...NO_HERDR_ENV, PLUGIN_DATA: ticket },
    stdin: JSON.stringify({
      hook_event_name: 'SessionEnd',
      session_id: 's1',
      reason: 'logout',
      cwd: '/work/proj',
    }),
    ticketDir: ticket,
    paneList: panes,
  });
  assert.deepEqual(argv.slice(0, 3), ['pane', 'release-agent', 'w4:p1']);
});
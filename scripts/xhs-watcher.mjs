#!/usr/bin/env node
/**
 * xhs-watcher.mjs — Windows 侧核心 watcher（ESM）
 *
 * 两种模式：
 *   --status-only  纯只读，只 GET /status 和 /agent/state，绝不 takeover/heartbeat/release
 *   默认模式       完整生命周期：takeover → home → start task → heartbeat → 监控 → 总结 → 写进度 → release
 *
 * 用法：
 *   node scripts/xhs-watcher.mjs --runId <id> --agentId <id> --status-only
 *   node scripts/xhs-watcher.mjs --runId <id> --agentId <id>
 *   node scripts/xhs-watcher.mjs --runId <id> --agentId <id> --plan '{"serial":{"task":"纯刷","durationMin":10,"cap":1}}'
 *
 * 环境要求：Node.js >= 18，dashboard 运行在 localhost:17900
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = 'http://localhost:17900';
const PROGRESS_PATH = path.join('C:\\Users\\Public', 'xhs-agent-progress.md');
const RUN_STATE_DIR = path.join('C:\\Users\\Public', 'xhs-agent-runs');
const RETRYABLE_HTTP = new Set([502, 503, 504]);

const DEFAULT_PLAN = {
  '1511f78c':       { task: '纯刷', durationMin: 10, cap: 1 },
  '211d0120':       { task: '纯刷', durationMin: 10, cap: 1 },
  '9b18cccb':       { task: '养号', durationMin: 10, cap: 1 },
  'H6NNHU8LLFHAIRLV': { task: '养号', durationMin: 10, cap: 1 },
};

const STATUS_INTERVAL_S = 60;
const HEARTBEAT_INTERVAL_S = 10;
const MAX_WATCH_S = 20 * 60;

// ── helpers ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--runId')        opts.runId = args[++i];
    else if (a === '--agentId') opts.agentId = args[++i];
    else if (a === '--plan')    opts.plan = JSON.parse(args[++i]);
    else if (a === '--status-only') opts.statusOnly = true;
  }
  if (!opts.runId || !opts.agentId) {
    console.error('用法: node scripts/xhs-watcher.mjs --runId <runId> --agentId <agentId> [--plan <json>] [--status-only]');
    process.exit(1);
  }
  return opts;
}

function httpJson(method, urlPath, data, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const body = data ? JSON.stringify(data) : null;
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout,
    };
    if (body) reqOpts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = http.request(reqOpts, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withRetry(method, urlPath, data, timeout = 15000, attempts = 3, backoff = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await httpJson(method, urlPath, data, timeout);
      if (RETRYABLE_HTTP.has(result.status) && i < attempts - 1) {
        await sleep(backoff * (i + 1));
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
      if (i === attempts - 1) return { status: 0, data: { ok: false, error: e.message } };
      await sleep(backoff * (i + 1));
    }
  }
  return { status: 0, data: { ok: false, error: String(lastErr) } };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString(); }
function sha256(content) { return crypto.createHash('sha256').update(content).digest('hex'); }

// ── run state file ──

function writeRunState(runId, agentId, state) {
  fs.mkdirSync(RUN_STATE_DIR, { recursive: true });
  const statePath = path.join(RUN_STATE_DIR, `${runId}.json`);
  const content = JSON.stringify({ runId, agentId, ...state, updatedAt: ts() }, null, 2);
  fs.writeFileSync(statePath, content, 'utf-8');
  return statePath;
}

// ── progress file with CAS (Compare-And-Swap) ──

function readProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_PATH, 'utf-8');
    const revMatch = raw.match(/revision:\s*(\d+)/);
    return { revision: revMatch ? parseInt(revMatch[1]) : 0, raw, hash: sha256(raw) };
  } catch {
    return { revision: 0, raw: '', hash: '' };
  }
}

function updateProgress(opts, lines, conclusion) {
  // Step 1: read current state
  const before = readProgress();
  const newRev = before.revision + 1;

  // Step 2: build new content — preserve existing structure, append new section
  const newSection = `
---

## Run ${newRev} (${opts.runId})

- agentId: ${opts.agentId}
- startedAt: ${opts.startedAt}
- finishedAt: ${ts()}

### 任务
${JSON.stringify(opts.plan || DEFAULT_PLAN, null, 2)}

### 验证证据
${lines.map(l => `- ${l}`).join('\n')}

### 结论
${conclusion}
`;

  // Append to existing raw content (preserve revision 2 history)
  let content;
  if (before.raw) {
    // Update revision number in the header
    content = before.raw.replace(/revision:\s*\d+/, `revision: ${newRev}`) + newSection;
  } else {
    content = `# xhs-agent-progress\n\nrevision: ${newRev}\n${newSection}`;
  }

  const newHash = sha256(content);

  // Step 3: CAS — re-read to check no concurrent modification
  const recheck = readProgress();
  if (recheck.hash !== before.hash) {
    console.error(`[progress] CAS failed: hash changed during preparation`);
    console.error(`  expected: ${before.hash}`);
    console.error(`  actual:   ${recheck.hash}`);
    console.error(`  aborting write to prevent data loss`);
    return null;
  }

  // Step 4: atomic write via temp file
  const tmpPath = PROGRESS_PATH + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');

  // Step 5: verify temp file
  const tmpContent = fs.readFileSync(tmpPath, 'utf-8');
  if (sha256(tmpContent) !== newHash) {
    console.error(`[progress] temp file hash mismatch, aborting`);
    try { fs.unlinkSync(tmpPath); } catch {}
    return null;
  }

  // Step 6: atomic rename
  fs.renameSync(tmpPath, PROGRESS_PATH);

  // Step 7: post-write verification
  const finalContent = fs.readFileSync(PROGRESS_PATH, 'utf-8');
  const finalHash = sha256(finalContent);
  if (finalHash !== newHash) {
    console.error(`[progress] post-write hash mismatch!`);
    console.error(`  expected: ${newHash}`);
    console.error(`  actual:   ${finalHash}`);
    return null;
  }

  console.log(`[progress] CAS OK: revision ${before.revision} → ${newRev}`);
  console.log(`[progress] before hash: ${before.hash || '(empty)'}`);
  console.log(`[progress] after hash:  ${finalHash}`);
  return { revision: newRev, hash: finalHash };
}

// ── status-only (truly read-only) ──

async function runStatusOnly(opts) {
  const serials = Object.keys(opts.plan || DEFAULT_PLAN);

  console.log(`[${ts()}] ## status-only mode (read-only, no takeover/heartbeat/release)`);

  const { data: payload } = await withRetry('GET', '/status', null, 15000);
  if (!payload?.devices) {
    console.error(`status error: ${JSON.stringify(payload)}`);
    process.exit(1);
  }

  const { data: state } = await withRetry('GET', '/agent/state', null, 10000);
  console.log(`agent.active=${state?.agent?.active} agent.id=${state?.agent?.id}`);

  for (const d of payload.devices) {
    const task = d.task || {};
    const last = d.lastTask || {};
    if (d.running) {
      console.log(`  ${d.serial}: RUN ${task.name} phase=${task.phase} loop=${task.loop} ok=${task.ok} skip=${task.skip} comments=${task.comments} remain=${task.remainingMs}`);
    } else {
      console.log(`  ${d.serial}: IDLE serve=${d.serve} activity=${d.activity} lastLoops=${last.loopsDone} lastOk=${last.ok} lastSkip=${last.skip}`);
    }
  }

  writeRunState(opts.runId, opts.agentId, { phase: 'status-only', status: 'completed' });
  return 0;
}

// ── full lifecycle mode ──

async function runFullLifecycle(opts) {
  const plan = opts.plan || DEFAULT_PLAN;
  const serials = Object.keys(plan);

  // takeover
  const tk = await withRetry('POST', '/agent/takeover', { id: opts.agentId, kind: 'watcher' }, 10000);
  console.log(`[${ts()}] takeover: ${JSON.stringify(tk.data)}`);
  if (!tk.data?.ok) {
    console.error('takeover failed, aborting');
    writeRunState(opts.runId, opts.agentId, { phase: 'takeover', status: 'failed', error: tk.data?.error });
    process.exit(1);
  }

  writeRunState(opts.runId, opts.agentId, { phase: 'taken', status: 'active' });

  let everRunning = false;
  const stallCounts = {};
  const prevProgress = {};
  serials.forEach(s => { stallCounts[s] = 0; });

  try {
    // home all
    console.log(`\n[${ts()}] ## prep home all`);
    for (const serial of serials) {
      const r = await withRetry('POST', '/home', { serial, id: opts.agentId }, 20000);
      console.log(`${serial} home: ${JSON.stringify(r.data)}`);
      await sleep(1000);
    }

    // start tasks
    console.log(`\n[${ts()}] ## start tasks`);
    for (const serial of serials) {
      const task = plan[serial];
      const r = await withRetry('POST', '/task', { serial, action: 'start', queue: [task], id: opts.agentId }, 25000);
      console.log(`${serial} ${task.task}: ${JSON.stringify(r.data)}`);
      await sleep(1000);
    }
    writeRunState(opts.runId, opts.agentId, { phase: 'watching', status: 'active' });

    // watch loop
    console.log(`\n[${ts()}] ## watch loop`);
    const startTime = Date.now();
    let nextStatus = startTime;
    let nextHb = startTime;
    const allLines = [];

    while (true) {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000);

      // heartbeat
      if (now >= nextHb) {
        await withRetry('POST', '/agent/heartbeat', { id: opts.agentId }, 10000);
        nextHb += HEARTBEAT_INTERVAL_S * 1000;
      }

      // status poll
      if (now >= nextStatus) {
        const { data: payload } = await withRetry('GET', '/status', null, 15000);
        if (!payload?.devices) {
          console.log(`[${ts()}] [T+${elapsed}s] status error: ${JSON.stringify(payload)}`);
          nextStatus += STATUS_INTERVAL_S * 1000;
          await sleep(1000);
          if (elapsed > MAX_WATCH_S) break;
          continue;
        }

        const devices = {};
        payload.devices.forEach(d => { devices[d.serial] = d; });
        let allDone = true;

        console.log(`\n[${ts()}] [T+${elapsed}s] status poll`);
        for (const serial of serials) {
          const d = devices[serial] || {};
          const running = !!d.running;
          const task = d.task || {};
          const last = d.lastTask || {};

          if (running) {
            everRunning = true;
            const progress = [task.loop, task.ok, task.skip, task.comments].join(',');
            if (prevProgress[serial] === progress) stallCounts[serial]++;
            else stallCounts[serial] = 0;
            prevProgress[serial] = progress;
            console.log(`- ${serial}: RUN ${task.name} phase=${task.phase} loop=${task.loop} ok=${task.ok} skip=${task.skip} comments=${task.comments} remain=${task.remainingMs} stall=${stallCounts[serial]}`);
            allDone = false;
          } else {
            console.log(`- ${serial}: DONE activity=${d.activity} loopsDone=${last.loopsDone} ok=${last.ok} skip=${last.skip} comments=${last.comments} lastErr=${last.lastErr}`);
          }
        }
        nextStatus += STATUS_INTERVAL_S * 1000;

        if (everRunning && allDone) {
          console.log(`\n[${ts()}] ## final summary`);
          let anyStall = false, anyErr = false;
          for (const serial of serials) {
            const d = devices[serial] || {};
            const last = d.lastTask || {};
            const line = `${serial}: loopsDone=${last.loopsDone}, ok=${last.ok}, skip=${last.skip}, comments=${last.comments}, endedAt=${last.endedAt}, lastErr=${last.lastErr}`;
            console.log(`- ${line}`);
            allLines.push(line);
            if (stallCounts[serial] >= 2) anyStall = true;
            if (last.lastErr) anyErr = true;
          }

          let conclusion;
          if (anyErr) conclusion = '有任务结束但存在 lastErr，需人工复查';
          else if (anyStall) conclusion = '全部结束但中途疑似卡顿';
          else conclusion = '全部自然结束，未发现明显卡顿';
          console.log(`结论: ${conclusion}`);

          const prog = updateProgress(opts, allLines, conclusion);
          if (prog) console.log(`progress: revision=${prog.revision} hash=${prog.hash}`);

          writeRunState(opts.runId, opts.agentId, { phase: 'completed', status: 'ok', conclusion });
          break;
        }
      }

      if (Math.floor((Date.now() - startTime) / 1000) > MAX_WATCH_S) {
        console.log(`\n[${ts()}] ## timeout: exceeded ${MAX_WATCH_S}s`);
        writeRunState(opts.runId, opts.agentId, { phase: 'timeout', status: 'error' });
        break;
      }

      await sleep(1000);
    }
  } finally {
    // release
    const rel = await withRetry('POST', '/agent/release', { id: opts.agentId }, 10000);
    console.log(`\n[${ts()}] release: ${JSON.stringify(rel.data)}`);
    const state = await withRetry('GET', '/agent/state', null, 10000);
    console.log(`[${ts()}] final /agent/state: active=${state.data?.agent?.active}`);
  }

  return 0;
}

// ── main ──

async function main() {
  const opts = parseArgs();
  opts.startedAt = ts();

  console.log(`[${ts()}] ## XHS watcher start`);
  console.log(`runId=${opts.runId} agentId=${opts.agentId}`);
  console.log(`mode=${opts.statusOnly ? 'status-only (read-only)' : 'full-lifecycle'}`);

  if (opts.statusOnly) {
    return runStatusOnly(opts);
  }
  return runFullLifecycle(opts);
}

main().catch(e => {
  console.error('watcher crashed:', e);
  process.exit(1);
});

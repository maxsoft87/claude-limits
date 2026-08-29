'use strict';

/*
 * Управление плавающим окном. Процесс окна поднимается вместе с этим сервером,
 * то есть вместе с Claude Desktop, и завершается, когда закрывается его stdin.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const sources = require('./sources');

const SCRIPT = path.join(__dirname, '..', 'overlay', 'overlay.py');
const HTML = path.join(__dirname, '..', 'overlay', 'overlay.html');
const REFRESH_MS = Math.max(
  5000,
  Number(process.env.CLAUDE_LIMITS_REFRESH_MS) || 60 * 1000
);

let child = null;
let timer = null;
let status = { running: false, reason: 'not started', webkit: null, tracking: null };
let provider = null;
let settingsPath = null;


/* --------------------------------------------------- окружение сессии */

// Claude Desktop запускает MCP-серверы с урезанным окружением: DISPLAY и
// XAUTHORITY туда не попадают, поэтому GUI-процесс без них не стартует.
// Забираем их из окружения родительских процессов — само приложение
// графическое, значит у него они есть.
const GUI_VARS = [
  'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE', 'GDK_BACKEND', 'XDG_CURRENT_DESKTOP',
];

function readProcEnv(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const out = {};
    for (const entry of raw.split('\0')) {
      const index = entry.indexOf('=');
      if (index > 0) out[entry.slice(0, index)] = entry.slice(index + 1);
    }
    return out;
  } catch (_) { return null; }
}

function ancestorPids(limit) {
  const pids = [];
  let pid = process.pid;
  for (let i = 0; i < limit; i += 1) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = /^PPid:\s*(\d+)/m.exec(status);
      if (!match) break;
      pid = Number(match[1]);
      if (!pid || pid === 1) break;
      pids.push(pid);
    } catch (_) { break; }
  }
  return pids;
}

function pick(env) {
  const found = {};
  for (const key of GUI_VARS) if (env[key]) found[key] = env[key];
  return found;
}

function discoverGuiEnv() {
  if (process.platform !== 'linux') return {};
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return pick(process.env);

  for (const pid of ancestorPids(8)) {
    const env = readProcEnv(pid);
    if (env && (env.DISPLAY || env.WAYLAND_DISPLAY)) return pick(env);
  }

  // Родитель мог быть таким же урезанным — ищем любой свой графический процесс.
  try {
    const uid = process.getuid();
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat;
      try { stat = fs.statSync(`/proc/${name}`); } catch (_) { continue; }
      if (stat.uid !== uid) continue;
      const env = readProcEnv(name);
      if (env && (env.DISPLAY || env.WAYLAND_DISPLAY)) return pick(env);
    }
  } catch (_) { /* /proc недоступен */ }
  return {};
}

let guiEnv = null;
function sessionEnv() {
  if (guiEnv) return guiEnv;
  guiEnv = discoverGuiEnv();
  if (!guiEnv.DISPLAY && !guiEnv.WAYLAND_DISPLAY) guiEnv.DISPLAY = ':0';
  return guiEnv;
}

function log(message) {
  process.stderr.write(`[claude-limits/overlay] ${message}\n`);
}

function pythonCandidates() {
  const list = [];
  const configured = (process.env.CLAUDE_LIMITS_PYTHON || '').trim();
  if (configured) list.push(configured);
  list.push('python3', 'python3.12', 'python3.11', 'python3.10', 'python');
  return list;
}

// Выбираем интерпретатор, в котором действительно есть GTK: на многих системах
// стоит несколько python3, и gi собран только для одного из них.
function findPython() {
  const probe = 'import gi; gi.require_version("Gtk","3.0"); from gi.repository import Gtk';
  for (const candidate of pythonCandidates()) {
    try {
      const result = spawnSync(candidate, ['-c', probe], { timeout: 8000, stdio: 'ignore' });
      if (result.status === 0) return candidate;
    } catch (_) { /* следующий */ }
  }
  return null;
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (_) { return { style: 'card', showReset: true, showUpdated: true }; }
}

function writeSettings(value) {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2), 'utf8');
  } catch (_) { /* настройки не критичны */ }
}

function send(payload) {
  if (!child || child.killed || !child.stdin.writable) return;
  try { child.stdin.write(JSON.stringify(payload) + '\n'); } catch (_) {}
}

let pushes = 0;
let lastPush = null;
let lastPayloadAt = null;
let watchers = [];

function pushData(reason) {
  if (!provider) return;
  try {
    const payload = provider();
    pushes += 1;
    lastPush = new Date().toISOString();
    lastPayloadAt = payload.at || null;
    log(`push #${pushes} (${reason || 'timer'}): source=${payload.source} at=${payload.at} `
      + `keys=${Object.keys(payload.limits || {}).join(',') || 'none'}`);
    send(Object.assign({ type: 'data' }, payload));
  } catch (error) {
    log(`could not collect data: ${error.message}`);
  }
}

// Ждать таймер, когда приложение уже переписало файл, незачем: следим за
// изменениями напрямую. watchFile добавлен как страховка — inotify не работает
// на некоторых файловых системах и при подмене файла через переименование.
function watchHistory() {
  stopWatching();
  let pending = null;
  const bump = (why) => {
    clearTimeout(pending);
    pending = setTimeout(() => pushData(why), 400);  // coalesce bursts of events
    pending.unref?.();
  };
  for (const file of sources.historyFiles()) {
    try {
      const watcher = fs.watch(file, () => bump('cache file changed'));
      watcher.unref?.();
      watchers.push(() => watcher.close());
    } catch (_) { /* ниже есть страховка */ }
    try {
      const listener = (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) bump('cache file changed (poll)');
      };
      fs.watchFile(file, { interval: 5000 }, listener);
      watchers.push(() => fs.unwatchFile(file, listener));
    } catch (_) { /* обойдёмся таймером */ }
  }
  log(`watching usage cache files: ${sources.historyFiles().join(', ') || 'none'}`);
}

function stopWatching() {
  for (const off of watchers) { try { off(); } catch (_) {} }
  watchers = [];
}

function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  if (message.type === 'refresh') pushData('button');
  else if (message.type === 'settings') writeSettings(message.value || {});
  else if (message.type === 'ready') {
    status = { running: true, reason: 'running', webkit: message.webkit, tracking: message.tracking };
    log(`panel ready (WebKit ${message.webkit}, tracking the Claude window: ${message.tracking})`);
    // Первый push уходит раньше, чем страница успевает загрузиться, поэтому
    // данные отправляем ещё раз — уже по факту готовности.
    pushData('panel ready');
  } else if (message.type === 'duplicate') {
    status = { running: false, reason: 'the panel is already running from another extension process' };
    log(status.reason);
  } else if (message.type === 'unavailable') {
    status = { running: false, reason: message.message, webkit: null, tracking: null };
    log(`panel unavailable: ${message.message}`);
  }
}

function start(dataProvider, options) {
  provider = dataProvider;
  settingsPath = (options && options.settingsPath)
    || path.join(sources.stateDir(), 'claude-limits-overlay.json');

  if (child) return status;
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    status = { running: false, reason: `platform ${process.platform} is not supported yet` };
    return status;
  }
  if (!fs.existsSync(SCRIPT) || !fs.existsSync(HTML)) {
    status = { running: false, reason: 'panel files are missing from the bundle' };
    return status;
  }
  const python = findPython();
  if (!python) {
    status = { running: false, reason: 'no python3 with GTK found (install python3-gi)' };
    log(status.reason);
    return status;
  }

  const gui = sessionEnv();
  log(`graphical session: ${JSON.stringify(gui)}`);
  const args = [SCRIPT, '--html', HTML, '--state', JSON.stringify(readSettings())];
  child = spawn(python, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
    env: Object.assign({}, process.env, gui, {
      CLAUDE_LIMITS_STATE_DIR: sources.stateDir(),
    }),
  });
  status = { running: true, reason: 'starting', webkit: null, tracking: null };

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => log(String(chunk).trim()));
  child.on('exit', (code) => {
    log(`panel process exited with code ${code}`);
    if (status.running && status.reason === 'running') {
      status = { running: false, reason: `panel process exited (code ${code})` };
    }
    child = null;
    if (timer) { clearInterval(timer); timer = null; }
  });

  pushData('startup');
  timer = setInterval(() => pushData('timer'), REFRESH_MS);
  watchHistory();
  return status;
}

function stop() {
  stopWatching();
  if (timer) { clearInterval(timer); timer = null; }
  if (child) {
    const dying = child;
    try { dying.stdin.end(); } catch (_) {}
    try { dying.kill('SIGTERM'); } catch (_) {}
    // Если окно не ушло по-хорошему, добиваем: пережить приложение оно не должно.
    setTimeout(() => { try { dying.kill('SIGKILL'); } catch (_) {} }, 1500).unref?.();
    child = null;
  }
  status = { running: false, reason: 'stopped' };
  return status;
}

function getStatus() {
  return Object.assign({}, status, {
    pushes,
    lastPush,
    lastPayloadAt,
    refreshMs: REFRESH_MS,
    watchedFiles: sources.historyFiles(),
    script: SCRIPT,
    html: HTML,
    settingsPath,
    sessionEnv: sessionEnv(),
    display: sessionEnv().DISPLAY || null,
    wayland: sessionEnv().WAYLAND_DISPLAY || null,
    sessionType: sessionEnv().XDG_SESSION_TYPE || null,
    python: findPython(),
  });
}

module.exports = { start, stop, getStatus, pushData };

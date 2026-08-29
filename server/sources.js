'use strict';

/*
 * Локальные источники данных о лимитах плана.
 * Читаются только обычные JSON-файлы кэша Claude Desktop в конфиге пользователя
 * и собственный кэш расширения. Никаких паролей, кук и сетевых запросов здесь
 * нет: живые данные запрашивает сама UI-панель внутри приложения.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIMIT_KEYS = [
  'five_hour',
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'seven_day_oauth_apps',
  'seven_day_cowork',
];

// Приложение пишет историю сокращёнными ключами (fh, sd, sds…), а API отдаёт
// полные. Приводим и то, и другое к одному каноническому виду.
const ALIASES = {
  fh: 'five_hour', '5h': 'five_hour', fivehour: 'five_hour', five_hour: 'five_hour',
  sd: 'seven_day', '7d': 'seven_day', sevenday: 'seven_day', seven_day: 'seven_day',
  sds: 'seven_day_sonnet', sonnet: 'seven_day_sonnet', sd_sonnet: 'seven_day_sonnet',
  seven_day_sonnet: 'seven_day_sonnet',
  sdo: 'seven_day_opus', opus: 'seven_day_opus', sd_opus: 'seven_day_opus',
  seven_day_opus: 'seven_day_opus',
  sdoa: 'seven_day_oauth_apps', sdoauth: 'seven_day_oauth_apps', oauth: 'seven_day_oauth_apps',
  seven_day_oauth_apps: 'seven_day_oauth_apps',
  sdc: 'seven_day_cowork', cowork: 'seven_day_cowork', sd_cowork: 'seven_day_cowork',
  seven_day_cowork: 'seven_day_cowork',
};

// Служебные поля выборки, которые не являются лимитами.
const NOT_LIMITS = new Set([
  't', 'timestamp', 'ts', 'at', 'time', 'date', 'created_at', 'fetched_at', 'updated_at',
  'org', 'organization', 'organization_uuid', 'version', 'id', 'uuid',
  'plan', 'tier', 'samples', 'u', 'usage', 'limits', 'history', 'entries', 'data',
]);

function safeExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function configDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(process.env.CLAUDE_CONFIG_DIR);
  if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'Claude'));
  }
  if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, 'Claude'));
  dirs.push(path.join(home, '.config', 'Claude'));
  dirs.push(path.join(home, '.config', 'claude-desktop'));
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i && safeExists(dir));
}

function stateDir() {
  return configDirs()[0] || path.join(os.homedir(), '.claude-limits');
}

function cacheFile() {
  return path.join(stateDir(), 'claude-limits-cache.json');
}

/* --------------------------------------------------------------- shaping */

function toPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Целые считаем процентами (fh: 1 — это 1%, а не 100%), дробные меньше
  // единицы — долей.
  const percent = !Number.isInteger(n) && n > 0 && n < 1 ? n * 100 : n;
  return Math.max(0, Math.min(100, percent));
}

function limitFrom(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const utilization = toPercent(
      value.utilization ?? value.percent ?? value.used ?? value.value
    );
    const resets = value.resets_at ?? value.reset_at ?? value.resetAt ?? value.resetsAt ?? null;
    if (utilization == null && !resets) return null;
    return { utilization, resets_at: resets };
  }
  const utilization = toPercent(value);
  return utilization == null ? null : { utilization, resets_at: null };
}

function shape(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const lower = String(key).toLowerCase();
    if (NOT_LIMITS.has(lower)) continue;
    const canonical = ALIASES[lower];
    // Показываем только известные окна лимитов. Незнакомый ключ нельзя
    // трактовать: неясно, «использовано» это или «осталось». Такие ключи
    // видны в diagnose (unmappedKeys), но в интерфейс не попадают.
    if (!canonical) continue;
    const item = limitFrom(value);
    if (item) out[canonical] = item;
  }
  return Object.keys(out).length ? out : null;
}

// Объект считается выборкой лимитов, только если в нём есть хотя бы один
// заведомо известный ключ — иначе любой {width, height} сошёл бы за лимиты.
function hasKnownLimit(map) {
  return Boolean(map) && LIMIT_KEYS.some((key) => map[key]);
}

// Известные окна лимитов в привычном порядке.
function orderKeys(map) {
  return LIMIT_KEYS.filter((key) => map && map[key]);
}



function merge(...parts) {
  const keys = [];
  for (const part of parts) {
    for (const key of Object.keys(part || {})) if (!keys.includes(key)) keys.push(key);
  }
  const out = {};
  for (const key of LIMIT_KEYS.filter((k) => keys.includes(k)).concat(keys.filter((k) => !LIMIT_KEYS.includes(k)).sort())) {
    for (const part of parts) {
      if (part && part[key]) { out[key] = part[key]; break; }
    }
  }
  return Object.keys(out).length ? out : null;
}

/* -------------------------------------------------- A. кэш Claude Desktop */

const HISTORY_NAMES = [
  'plan-usage-history.json',
  'usage-history.json',
  'plan_usage_history.json',
];

function findHistoryFiles() {
  const found = [];
  for (const dir of configDirs()) {
    for (const name of HISTORY_NAMES) {
      const file = path.join(dir, name);
      if (safeExists(file)) found.push(file);
    }
  }
  return found;
}

// Формат файла может отличаться между сборками приложения, поэтому вместо
// жёсткой схемы обходим JSON целиком и ищем любой объект, в котором есть
// известные ключи лимитов. Ближайшая к нему метка времени наследуется сверху.
const TIME_KEYS = ['t', 'timestamp', 'ts', 'at', 'time', 'date', 'created_at', 'fetched_at', 'updated_at'];

function parseTime(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function walkForLimits(node, depth, inheritedTime, out) {
  if (!node || typeof node !== 'object' || depth > 12) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForLimits(item, depth + 1, inheritedTime, out);
    return;
  }
  let time = inheritedTime;
  for (const key of TIME_KEYS) {
    const parsed = parseTime(node[key]);
    if (parsed) { time = parsed; break; }
  }
  const shaped = shape(node);
  if (hasKnownLimit(shaped)) out.push({ limits: shaped, time });
  for (const value of Object.values(node)) walkForLimits(value, depth + 1, time, out);
}

function readHistory() {
  for (const file of findHistoryFiles()) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { continue; }
    const found = [];
    walkForLimits(data, 0, null, found);
    if (!found.length) continue;
    // Самый свежий по метке времени; при отсутствии меток — последний найденный.
    let best = found[found.length - 1];
    for (const candidate of found) {
      if (!candidate.time) continue;
      if (!best.time || candidate.time > best.time) best = candidate;
    }
    return {
      limits: best.limits,
      source: 'history',
      file,
      at: best.time ? best.time.toISOString() : null,
    };
  }
  return null;
}

/* ------------------------------------------------- B. собственный кэш */

function readCache() {
  try {
    const data = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const shaped = shape(data.limits);
    return shaped ? { limits: shaped, source: 'cache', at: data.at || null } : null;
  } catch (_) { return null; }
}

function writeCache(limits, at) {
  const shaped = shape(limits);
  if (!shaped) return false;
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ limits: shaped, at: at || new Date().toISOString() }, null, 2), 'utf8');
    return true;
  } catch (_) { return false; }
}


/* ------------------------------------------------------------ диагностика */

// Компактный «скелет» JSON: какие ключи и какого типа, без самих значений
// (кроме коротких чисел и строк) — чтобы понять формат чужого файла.
function skeleton(node, depth) {
  if (depth > 4) return '…';
  if (node === null) return 'null';
  if (Array.isArray(node)) {
    return node.length ? [`array(${node.length})`, skeleton(node[0], depth + 1)] : 'array(0)';
  }
  if (typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).slice(0, 25)) out[key] = skeleton(node[key], depth + 1);
    return out;
  }
  if (typeof node === 'string') return node.length > 40 ? `string(${node.length})` : `string:${node}`;
  return `${typeof node}:${node}`;
}

function describeFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    const found = [];
    walkForLimits(data, 0, null, found);
    // Объединение всех ключей, встреченных в выборках, — чтобы сразу увидеть
    // сокращения, которых ещё нет в таблице псевдонимов.
    const seen = {};
    const collectKeys = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (Array.isArray(node)) { for (const item of node) collectKeys(item, depth + 1); return; }
      for (const [key, value] of Object.entries(node)) {
        if (value !== null && typeof value === 'object') { collectKeys(value, depth + 1); continue; }
        seen[key] = (seen[key] || 0) + 1;
      }
    };
    collectKeys(data, 0);
    const samples = Array.isArray(data && data.samples) ? data.samples : null;
    return {
      file,
      bytes: text.length,
      skeleton: skeleton(data, 0),
      keyCounts: seen,
      unmappedKeys: Object.keys(seen).filter((key) => {
        const lower = key.toLowerCase();
        return !NOT_LIMITS.has(lower) && !ALIASES[lower];
      }),
      newestSamples: samples ? samples.slice(-3) : null,
      limitObjectsFound: found.length,
      newest: found.length ? readHistory() : null,
    };
  } catch (error) {
    return { file, error: String((error && error.message) || error) };
  }
}

/* ---------------------------------------------------------------- public */

function collect() {
  const notes = [];
  const history = readHistory();
  if (!history) notes.push('The Claude Desktop usage cache was not found.');
  const cache = readCache();
  const limits = merge(history && history.limits, cache && cache.limits) || {};
  const primary = history || cache;
  return {
    ok: Object.keys(limits).length > 0,
    limits: Object.keys(limits).length ? limits : null,
    source: primary ? primary.source : null,
    at: primary ? primary.at : null,
    notes,
  };
}

function diagnose() {
  const dirs = configDirs();
  return {
    platform: process.platform,
    node: process.version,
    home: os.homedir(),
    configDirs: dirs,
    configDirContents: dirs.map((dir) => {
      try { return { dir, entries: fs.readdirSync(dir).slice(0, 80) }; }
      catch (e) { return { dir, error: String((e && e.message) || e) }; }
    }),
    historyFiles: findHistoryFiles(),
    historyStructure: findHistoryFiles().map(describeFile),
    cacheFile: cacheFile(),
    cachePresent: safeExists(cacheFile()),
    localData: collect(),
  };
}

module.exports = { LIMIT_KEYS, ALIASES, shape, orderKeys, stateDir, findHistoryFiles, historyFiles: findHistoryFiles, collect, diagnose, readHistory, readCache, writeCache };

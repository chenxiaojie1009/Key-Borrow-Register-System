/**
 * 自动备份：把全部业务数据导出到 data/backups/
 *  - JSON：与 GET /api/backup 完全同构，可直接用于 /api/restore
 *  - CSV ：借用记录（含归档），复用 report.buildBorrowCsv
 *  - 默认每周三 14:00 自动备份，保留最近 12 组；错过计划时刻则下次启动补做
 */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { buildBorrowCsv } = require('./report');

const BACKUP_DIR = path.join(store.DATA_DIR, 'backups');
const SETTINGS_FILE = path.join(store.DATA_DIR, 'backup-settings.json');

const DEFAULTS = { enabled: true, weekday: 3, hour: 14, minute: 0, keep: 12, lastRunAt: null, lastResult: null };
const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let timer = null;
let onRunHandler = null;

function defaultSettings() { return Object.assign({}, DEFAULTS); }

function pad2(n) { return String(n).padStart(2, '0'); }

/* 本地时间戳 YYYYMMDD-HHmmss（备份文件名用） */
function localStamp(d) {
  const t = d || new Date();
  return `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}-${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/* 写入并 fsync，避免备份文件写了一半就断电 */
function writeDurable(file, text) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* rename 遇 EPERM/EBUSY（杀软/索引短暂占用）最多重试 3 次 */
function renameWithRetry(from, to) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } catch (err) { /* ignore */ }
    }
  }
  throw lastErr;
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (e) {
    console.error('[backup] 清理文件失败:', file, e.message);
    return false;
  }
}

/* E4：json 与 csv 必须共用同一个序号（i=1 表示无后缀），选一个对两个名字都不冲突的序号成对命名 */
function pairNames(stamp) {
  for (let i = 1; i <= 999; i++) {
    const sfx = i > 1 ? '-' + i : '';
    const jsonName = `借用系统备份_${stamp}${sfx}.json`;
    const csvName = `借用记录_${stamp}${sfx}.csv`;
    if (!fs.existsSync(path.join(BACKUP_DIR, jsonName)) && !fs.existsSync(path.join(BACKUP_DIR, csvName))) {
      return { jsonName, csvName };
    }
  }
  throw new Error('同一秒内备份次数过多，请稍后重试');
}

function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/* 取范围内的整数，非法则用默认值 */
function pickInt(v, min, max, def) {
  const n = intIn(v, min, max);
  return n === null ? def : n;
}

/* 读取设置：缺字段用默认值补齐；文件坏掉时返回默认值并在 lastResult 里标注 */
function loadSettings() {
  const s = defaultSettings();
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return s;
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    if (!raw.trim()) throw new Error('设置文件内容为空');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('设置文件格式不正确');
    if (typeof o.enabled === 'boolean') s.enabled = o.enabled;
    s.weekday = pickInt(o.weekday, 0, 6, DEFAULTS.weekday);
    s.hour = pickInt(o.hour, 0, 23, DEFAULTS.hour);
    s.minute = pickInt(o.minute, 0, 59, DEFAULTS.minute);
    s.keep = pickInt(o.keep, 1, 100, DEFAULTS.keep);
    s.lastRunAt = typeof o.lastRunAt === 'string' && o.lastRunAt ? o.lastRunAt : null;
    s.lastResult = o.lastResult && typeof o.lastResult === 'object' ? o.lastResult : null;
    return s;
  } catch (e) {
    console.error('[backup] 读取备份设置失败，改用默认设置:', e.message);
    const d = defaultSettings();
    d.lastResult = { ok: false, at: new Date().toISOString(), error: '备份设置文件损坏（已使用默认设置）：' + e.message };
    return d;
  }
}

function writeSettingsFile(s) {
  if (!fs.existsSync(store.DATA_DIR)) fs.mkdirSync(store.DATA_DIR, { recursive: true });
  writeDurable(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

/* 保存设置（部分字段）：weekday 0-6（0=周日）、hour 0-23、minute 0-59、keep 1-100 */
function saveSettings(patch) {
  const p = patch || {};
  const next = loadSettings();
  if (p.enabled !== undefined) {
    if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
    else if (p.enabled === 'true' || p.enabled === 'false') next.enabled = p.enabled === 'true';
    else throw new Error('启用开关取值无效');
  }
  const num = (key, label, min, max) => {
    if (p[key] === undefined || p[key] === null || p[key] === '') return;
    const n = intIn(p[key], min, max);
    if (n === null) throw new Error(`${label} 必须为 ${min}-${max} 之间的整数`);
    next[key] = n;
  };
  num('weekday', '备份星期', 0, 6);
  num('hour', '备份小时', 0, 23);
  num('minute', '备份分钟', 0, 59);
  num('keep', '保留份数', 1, 100);
  writeSettingsFile(next);
  return next;
}

/* 本周的计划备份时刻（本地时间；weekday 0=周日） */
function planThisWeek(s, from) {
  const d = new Date(from || Date.now());
  d.setDate(d.getDate() - d.getDay() + s.weekday);
  d.setHours(s.hour, s.minute, 0, 0);
  return d;
}

/* 下次计划备份时刻（严格晚于现在） */
function nextRunAt() {
  const s = loadSettings();
  const now = new Date();
  let p = planThisWeek(s, now);
  if (p.getTime() <= now.getTime()) p = new Date(p.getTime() + 7 * 24 * 3600 * 1000);
  return p.toISOString();
}

/* 组标识：同一时间戳的 json+csv 视为一组（-2/-3 后缀单独成组） */
function groupKey(name) {
  const m = /_(\d{8}-\d{6})(?:-(\d+))?\.(json|csv)$/i.exec(name);
  return m ? `${m[1]}|${m[2] || '1'}` : null;
}

function compareGroupDesc(a, b) {
  const [ta, na] = a.split('|');
  const [tb, nb] = b.split('|');
  if (ta !== tb) return ta < tb ? 1 : -1;
  return Number(nb) - Number(na);
}

/* 列出备份文件（.json/.csv），按时间倒序 */
function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const out = [];
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      if (!/\.(json|csv)$/i.test(name)) continue;
      try {
        const st = fs.statSync(path.join(BACKUP_DIR, name));
        if (st.isFile()) out.push({ name, bytes: st.size, mtime: st.mtime.toISOString() });
      } catch (e) { /* 忽略单个文件失败 */ }
    }
    out.sort((a, b) => {
      if (a.mtime !== b.mtime) return a.mtime < b.mtime ? 1 : -1;
      return a.name < b.name ? 1 : -1;
    });
    return out;
  } catch (e) {
    console.error('[backup] 列出备份文件失败:', e.message);
    return [];
  }
}

/* 下载用：校验文件名（只允许 BACKUP_DIR 下已存在的文件，禁止路径穿越）→ 绝对路径，非法返回 null */
function resolveBackupFile(name) {
  const n = String(name === undefined || name === null ? '' : name).trim();
  if (!n || n !== path.basename(n) || n.indexOf('..') >= 0) return null;
  if (!/\.(json|csv)$/i.test(n)) return null;
  const p = path.join(BACKUP_DIR, n);
  if (p.indexOf(BACKUP_DIR + path.sep) !== 0) return null;
  try {
    const st = fs.statSync(p);
    return st.isFile() ? p : null;
  } catch (e) {
    return null;
  }
}

/* 保留最近 keep 组，返回删除数量。
 * 组 = 同一时间戳+序号的一对 json+csv；**以 JSON 是否存在为准**：
 *  - 孤儿 CSV（没有对应 JSON）不计入保留份数，顺手清掉并记日志；
 *  - 含 JSON 的组按时间倒序保留最近 keep 组，绝不被孤儿挤掉。 */
function pruneBackups(keep) {
  const k = pickInt(keep, 1, 100, DEFAULTS.keep);
  let removed = 0;
  try {
    const groups = new Map();
    for (const f of listBackups()) {
      const key = groupKey(f.name);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { names: [], hasJson: false });
      const g = groups.get(key);
      g.names.push(f.name);
      if (/\.json$/i.test(f.name)) g.hasJson = true;
    }
    const withJson = [];
    for (const [key, g] of groups) {
      if (g.hasJson) { withJson.push([key, g]); continue; }
      for (const name of g.names) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, name)); removed++; }
        catch (e) { console.error('[backup] 删除孤儿 CSV 失败:', name, e.message); }
      }
      console.warn(`[backup] 清理孤儿 CSV（无对应 JSON，不占保留份数）：${g.names.join('、')}`);
    }
    withJson.sort((a, b) => compareGroupDesc(a[0], b[0]));
    for (const [key, g] of withJson.slice(k)) {
      for (const name of g.names) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, name)); removed++; }
        catch (e) { console.error('[backup] 删除旧备份失败:', name, e.message); }
      }
    }
  } catch (e) {
    console.error('[backup] 清理旧备份失败:', e.message);
  }
  return removed;
}

/* 立即备份一次：要么成对成功，要么一份文件都不留（失败也返回 { ok:false, at, error }，不抛错） */
function runBackup(options) {
  const opt = options || {};
  const at = new Date().toISOString();
  const settings = loadSettings();
  let result;
  const done = [];   // 本次已 rename 落地的文件
  let tmps = [];     // 本次的临时文件
  try {
    ensureBackupDir();
    const payload = {
      app: 'key-borrow-register-system',
      exportedAt: new Date().toISOString(),
      dataVersion: 1,
      users: store.loadUsers(),
      borrows: store.loadBorrows(),
      inventory: store.loadInventory()
    };
    // 先在内存里把两份内容都生成完 —— 任何异常都发生在碰磁盘之前（E3）
    const jsonText = JSON.stringify(payload, null, 2);
    const csvText = buildBorrowCsv(payload.borrows);
    const { jsonName, csvName } = pairNames(localStamp(new Date()));
    const jsonPath = path.join(BACKUP_DIR, jsonName);
    const csvPath = path.join(BACKUP_DIR, csvName);
    const jsonTmp = jsonPath + '.tmp';
    const csvTmp = csvPath + '.tmp';
    tmps = [jsonTmp, csvTmp];
    writeDurable(jsonTmp, jsonText);
    writeDurable(csvTmp, csvText);
    // 两份都写全了再一起落地，避免出现"只有一半"的孤儿备份
    renameWithRetry(jsonTmp, jsonPath); done.push(jsonPath);
    renameWithRetry(csvTmp, csvPath); done.push(csvPath);
    tmps = [];
    const files = [
      { name: jsonName, bytes: fs.statSync(jsonPath).size },
      { name: csvName, bytes: fs.statSync(csvPath).size }
    ];
    const counts = { users: payload.users.length, borrows: payload.borrows.length, inventory: payload.inventory.length };
    pruneBackups(settings.keep);
    result = {
      ok: true, at, trigger: opt.trigger || 'manual', by: opt.by || '',
      jsonName, csvName, files, counts
    };
  } catch (e) {
    console.error('[backup] 备份失败:', e.message);
    for (const f of tmps) safeUnlink(f);
    for (const f of done) { if (safeUnlink(f)) console.warn('[backup] 已回滚本次残留的备份文件:', path.basename(f)); }
    result = { ok: false, at, trigger: opt.trigger || 'manual', by: opt.by || '', error: e.message };
  }
  // 记录本次备份结果（供 /api/stats 与前端「上次备份」展示）
  try {
    const next = loadSettings();
    next.lastRunAt = at;
    next.lastResult = result.ok
      ? { ok: true, at, trigger: result.trigger, jsonName: result.jsonName, csvName: result.csvName, counts: result.counts, error: null }
      : { ok: false, at, trigger: result.trigger, error: result.error };
    writeSettingsFile(next);
  } catch (e) {
    console.error('[backup] 记录备份结果失败:', e.message);
  }
  return result;
}

/* 每分钟检查一次；启动时立即检查一次（用于补做错过的计划） */
function checkAndRun() {
  const s = loadSettings();
  if (!s.enabled) return null;
  const planned = planThisWeek(s, new Date());
  if (Date.now() < planned.getTime()) return null;
  const last = s.lastRunAt ? new Date(s.lastRunAt) : null;
  if (last && !isNaN(last.getTime()) && last.getTime() >= planned.getTime()) return null;
  const result = runBackup({ trigger: 'auto', by: 'scheduler' });
  if (typeof onRunHandler === 'function') {
    try { onRunHandler(result); } catch (e) { console.error('[backup] onRun 回调异常:', e.message); }
  }
  return result;
}

function startScheduler(opts) {
  const o = opts || {};
  onRunHandler = typeof o.onRun === 'function' ? o.onRun : null;
  if (timer) clearInterval(timer);
  checkAndRun();
  timer = setInterval(checkAndRun, 60 * 1000);
  if (timer.unref) timer.unref();
  return schedulerStatus();
}

function schedulerStatus() {
  return { running: !!timer, nextRunAt: nextRunAt() };
}

module.exports = {
  BACKUP_DIR,
  SETTINGS_FILE,
  WEEK_LABELS,
  defaultSettings,
  loadSettings,
  saveSettings,
  runBackup,
  listBackups,
  resolveBackupFile,
  pruneBackups,
  startScheduler,
  schedulerStatus
};

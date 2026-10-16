/**
 * 数据持久化层：JSON 文件存储（原子写入 + 防丢加固）
 * 数据目录：项目根目录 /data
 *  - users.json     用户账号
 *  - borrows.json   借用记录（含归档）
 *  - inventory.json 物品库存档案
 *  - quarantine/    读取失败/解析失败的坏数据文件留证目录
 *
 * 加固要点：
 *  1) 读：文件不存在才用 fallback 初始化；文件存在但为空 / 解析失败 / 结构不符时**绝不回退成 fallback**，
 *     而是先隔离坏文件，再尝试用 .bak 恢复；无可用备份则抛 DataError（server 统一返回 503）。
 *  2) 写：写前给当前可用内容留 .bak 快照，新内容写 .tmp 并 fsync 落盘后 rename 原子替换；
 *     写后再把新内容镜像到 .bak，保证 .bak 始终等于「最近一次成功写入」，恢复时不丢最近记录。
 *  3) 锁：启动时抢占 data/.lock（单实例锁），已被活着的实例占用则拒绝启动，避免两个实例互相覆盖。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
const LOCK_FILE = path.join(DATA_DIR, '.lock');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BORROWS_FILE = path.join(DATA_DIR, 'borrows.json');
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');

let lastReadError = null; // 最近一次数据文件读取/解析失败的描述，供 dataHealth 展示
let lastRecovery = null;  // 最近一次自动恢复：{ file, kind:'missing'|'wiped'|'corrupt', count, at, from }

/* 数据文件损坏且无可用备份：server 捕获后返回 503，绝不让写接口静默覆盖历史 */
class DataError extends Error {
  constructor(file, message) {
    super(message || `数据文件损坏：${path.basename(file)}`);
    this.name = 'DataError';
    this.code = 'DATA_UNREADABLE';
    this.file = file;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* 本地时间戳 YYYYMMDD-HHmmss（隔离文件名与备份文件名共用） */
function localStamp(d) {
  const t = d || new Date();
  return `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}-${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
}

/* 同步等待：rename 重试间隔用（Node 主线程可用 Atomics.wait） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/* 结构校验：调用方期望数组时，解析出的非数组同样按损坏处理（否则后续 .push 会抛 TypeError） */
function shapeBad(value, fallback) {
  return Array.isArray(fallback) && !Array.isArray(value);
}

/* 写入并 fsync：避免断电/异常退出留下截断内容 */
function writeDurable(file, text) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, text, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/* rename 遇 EPERM/EBUSY（Windows 上多为杀软/索引占用）最多重试 3 次，仍失败则抛错，不退化成语义更弱的写法 */
function renameWithRetry(from, to) {
  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY') break;
      sleepSync(50);
    }
  }
  throw lastErr;
}

/* 坏文件留证：复制（不删除）到 data/quarantine/<原文件名>.<时间戳>.corrupt */
function quarantine(file) {
  try {
    ensureDir(QUARANTINE_DIR);
    const base = path.basename(file);
    let target = path.join(QUARANTINE_DIR, `${base}.${localStamp()}.corrupt`);
    let i = 2;
    while (fs.existsSync(target)) {
      target = path.join(QUARANTINE_DIR, `${base}.${localStamp()}-${i}.corrupt`);
      i++;
    }
    fs.copyFileSync(file, target);
    console.error('[store] 坏数据文件已隔离留证 ->', target);
    return target;
  } catch (e) {
    console.error('[store] 隔离坏数据文件失败:', e.message);
    return null;
  }
}

/* 读 .bak：存在、非空、可解析、结构匹配才返回值，否则 null（损坏的备份绝不参与恢复） */
function readBakValue(bak, fallback) {
  try {
    if (!fs.existsSync(bak)) return null;
    const raw = fs.readFileSync(bak, 'utf8');
    if (!raw.trim()) return null;
    const p = tryParse(raw);
    if (!p.ok || shapeBad(p.value, fallback)) return null;
    return p.value;
  } catch (e) {
    return null;
  }
}

/* D2/E5：主文件比 .bak 少 → 判定为「被外部清空/改小」，隔离主文件并从 .bak 恢复。
 * 依据：正常写入路径的「写后镜像」（writeJson 第③步）保证 main 与 .bak 内容一致，
 *       所以「main 比 .bak 少」不是任何合法写入能产生的状态：
 *       —— 合法删除/归档记录时，main 与 .bak 是同时变小、且仍然相等；
 *       —— 真正的崩溃/断电只会造成截断或半截 JSON（走损坏分支），不会产生"合法但更短"的数组。
 * 假阳性（例如某次镜像写失败导致 main < bak）按用户确认的方向处理：宁可"复活"也不丢，读取时从 .bak 恢复并告警。
 * 边界：main == bak（正常态/空库/首启）不触发；main > bak（.bak 过期）接受 main、不触发。 */
function isExternalWipe(mainValue, bakValue) {
  return Array.isArray(mainValue) && Array.isArray(bakValue) && mainValue.length < bakValue.length;
}

/* E1：主文件不可用（损坏/丢失）时，若 .bak 解析出来是「合法空数组」，它不是有效恢复源
 * —— 用它恢复等于拿空库覆盖历史，备份系统随后还会报 ok:true 生成一份"看似有效的空备份" */
function isEmptyArrayBak(bakValue) {
  return Array.isArray(bakValue) && bakValue.length === 0;
}

/* 空数组 .bak 一律拒绝恢复：明确报错（接口 503），交给人工用 data/backups 里的备份还原 */
function refuseEmptyBak(file, bak) {
  const base = path.basename(file);
  lastReadError = `${base} 不可用，且 ${path.basename(bak)} 是空数组（已拒绝自动恢复以免清空历史）`;
  console.error(`[store] 检测到 ${path.basename(bak)} 为空数组，拒绝自动恢复以免清空历史：${file}`);
  throw new DataError(file, `数据文件不可用且 .bak 为空数组（拒绝用空备份覆盖历史）：${base}`);
}

/* 记录一次自动恢复（控制台告警 + 供 dataHealth/selfCheck 展示） */
const RECOVERY_LABEL = { missing: '丢失', wiped: '被外部清空成 0 条', shrunk: '被外部改小（比 .bak 少）', corrupt: '损坏' };
function noteRecovery(file, kind, count, reason) {
  const base = path.basename(file);
  lastRecovery = { file: base, kind, count, at: new Date().toISOString(), from: base + '.bak' };
  const what = reason || RECOVERY_LABEL[kind] || '异常';
  lastReadError = `${base} ${what}，已从 .bak 自动恢复（${count} 条）`;
  console.warn(`[store] 数据文件异常（${what}），已从 ${base}.bak 自动恢复：${base}（${count} 条）`);
  return lastRecovery;
}

/* 原子写：tmp + fsync + rename（含 rename 重试），主文件与 .bak 都用它，避免留下半截 JSON */
function writeDurableAtomic(file, text) {
  const tmp = file + '.tmp';
  writeDurable(tmp, text);
  renameWithRetry(tmp, file);
}

function writeJson(file, data, options) {
  const opt = options || {};
  ensureDir(DATA_DIR);
  const text = JSON.stringify(data, null, 2);
  const bak = file + '.bak';
  if (opt.keepBak !== true) {
    // ① 写前快照：当前文件可用时保留上一版本（文件不存在或已损坏时不动 .bak，避免用坏内容覆盖好备份）
    try {
      if (fs.existsSync(file)) {
        const cur = fs.readFileSync(file, 'utf8');
        if (cur.trim() && tryParse(cur).ok) writeDurableAtomic(bak, cur);
      }
    } catch (e) {
      console.error('[store] 写入前备份失败:', file, e.message);
    }
  }
  // ② tmp + fsync + 原子 rename
  writeDurableAtomic(file, text);
  if (opt.keepBak !== true) {
    // ③ 写后镜像：让 .bak 等于最近一次成功写入，坏文件恢复时不会丢最近记录
    try {
      writeDurableAtomic(bak, text);
    } catch (e) {
      console.error('[store] 写入后镜像 .bak 失败:', file, e.message);
    }
  }
}

function readJson(file, fallback) {
  ensureDir(DATA_DIR);
  const bak = file + '.bak';

  /* 主文件不存在（被删除 / 被杀软隔离 / 被云同步搬走）：先查 .bak
   * 有可用 .bak 就恢复，绝不用 fallback 初始化、也绝不让写后镜像把 .bak 清空（否则历史 100% 丢失） */
  if (!fs.existsSync(file)) {
    const bakValue = readBakValue(bak, fallback);
    if (bakValue !== null) {
      if (isEmptyArrayBak(bakValue)) refuseEmptyBak(file, bak); // E1：空数组 .bak 不得当作恢复源
      writeJson(file, bakValue, { keepBak: true }); // 只重建主文件，.bak 原样保留
      noteRecovery(file, 'missing', Array.isArray(bakValue) ? bakValue.length : 0);
      return bakValue;
    }
    // .bak 不存在/不可用：按「首次启动」用 fallback 初始化（新部署首启照旧可用）
    writeJson(file, fallback);
    return fallback;
  }

  let raw = null;
  let readErr = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { readErr = e; }
  const parsed = readErr ? null : tryParse(raw);
  if (!readErr && parsed.ok && !shapeBad(parsed.value, fallback)) {
    // 合法但比 .bak 少（0 条或更短的数组）→ 隔离留证并从 .bak 恢复，绝不静默接受缩水的库
    const bakValue = readBakValue(bak, fallback);
    if (isExternalWipe(parsed.value, bakValue)) {
      const kind = parsed.value.length === 0 ? 'wiped' : 'shrunk';
      console.error(kind === 'wiped'
        ? `[store] 数据文件被外部清空（0 条，.bak 有 ${bakValue.length} 条）: ${file}`
        : `[store] 数据文件记录数异常缩水（主文件 ${parsed.value.length} 条 < .bak ${bakValue.length} 条，非正常写入可产生）: ${file}`);
      quarantine(file);
      writeJson(file, bakValue, { keepBak: true });
      noteRecovery(file, kind, bakValue.length);
      return bakValue;
    }
    return parsed.value;
  }

  // 文件存在却读不出来：绝不回退成 fallback（否则下一次写入会把全部历史覆盖掉）
  const reason = readErr ? ('读取失败：' + readErr.message)
    : (!raw.trim() ? '文件内容为空'
      : (!parsed.ok ? ('JSON 解析失败：' + parsed.error) : '数据结构不符合预期'));
  lastReadError = `${path.basename(file)} ${reason}`;
  console.error(`[store] 数据文件异常（${reason}）：${file}`);
  quarantine(file);

  // 尝试从 .bak 恢复（复制不删除，坏文件已在 quarantine 留证）
  try {
    const bakValue = readBakValue(bak, fallback);
    if (bakValue !== null) {
      if (isEmptyArrayBak(bakValue)) refuseEmptyBak(file, bak); // E1：空数组 .bak 不得当作恢复源
      writeJson(file, bakValue, { keepBak: true }); // .bak 已是这份内容，不再回写，避免覆盖
      noteRecovery(file, 'corrupt', Array.isArray(bakValue) ? bakValue.length : 0, reason);
      return bakValue;
    }
    if (fs.existsSync(bak)) console.error('[store] .bak 同样不可用:', bak);
    else console.error('[store] 未找到备份文件:', bak);
  } catch (e) {
    console.error('[store] 从 .bak 恢复失败:', e.message);
  }
  throw new DataError(file, `数据文件损坏且无可用备份（坏文件已隔离到 data/quarantine）：${path.basename(file)}`);
}

/* ---------------- 密码哈希（scrypt + salt） ---------------- */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    if (!salt || !hash) return false;
    const h = crypto.scryptSync(String(password), String(salt), 64).toString('hex');
    const a = Buffer.from(h, 'hex');
    const b = Buffer.from(String(hash), 'hex');
    // 长度不一致时直接返回 false，避免 timingSafeEqual 抛异常
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/* ---------------- 用户 ---------------- */
function defaultUsers() {
  const now = new Date().toISOString();
  const mk = (username, password, displayName, role) => {
    const { salt, hash } = hashPassword(password);
    return {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      username,
      passwordSalt: salt,
      passwordHash: hash,
      displayName,
      role,                 // admin | operator
      status: 'active',
      createdAt: now,
      lastLoginAt: null
    };
  };
  return [
    mk('admin', 'admin123', '系统管理员', 'admin'),
    mk('operator1', '123456', '运行人员1', 'operator'),
    mk('operator2', '123456', '运行人员2', 'operator')
  ];
}

function loadUsers() {
  return readJson(USERS_FILE, defaultUsers());
}

function saveUsers(users) {
  writeJson(USERS_FILE, users);
}

/* ---------------- 借用记录 ---------------- */
function loadBorrows() {
  return readJson(BORROWS_FILE, []);
}

function saveBorrows(borrows) {
  writeJson(BORROWS_FILE, borrows);
}

/* ---------------- 物品库存档案 ---------------- */
function loadInventory() {
  return readJson(INVENTORY_FILE, []);
}

function saveInventory(inventory) {
  writeJson(INVENTORY_FILE, inventory);
}

/* ---------------- 工具函数 ---------------- */
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/* ---------------- 数据目录单实例锁 ----------------
 * 两个实例共用同一个 DATA_DIR 时，各自「load 整个数组 → 改 → save 整个数组」会互相覆盖，
 * 客户端收到 200 但记录被后写者抹掉。启动时用 data/.lock 抢占锁，抢不到就拒绝启动。
 * 锁文件内容：{ pid, port, startedAt, host }
 */
function readLockFile() {
  try {
    const o = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) {
    return null; // 缺失/空/损坏一律视为无有效持有者
  }
}

/* 进程判活：process.kill(pid, 0) 不抛错即在活；异常（ESRCH、权限等）按「不存活」处理，避免残留锁把用户卡死 */
function isProcessAlive(pid) {
  const n = parseInt(pid, 10);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/* 抢占数据目录锁：成功 { ok:true, lockFile }；被活着的实例占用 { ok:false, heldBy:{pid,port,startedAt} } */
function acquireInstanceLock(options) {
  const opt = options || {};
  ensureDir(DATA_DIR);
  const info = {
    pid: process.pid,
    port: Number(opt.port) || 0,
    startedAt: new Date().toISOString(),
    host: os.hostname()
  };
  let held = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx'); // 'wx' 原子创建：已存在则 EEXIST，两个进程同时启动只有一个能拿到
      try {
        fs.writeSync(fd, JSON.stringify(info, null, 2), null, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true, lockFile: LOCK_FILE };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error('[store] 创建数据目录锁失败:', e.message);
        return { ok: false, heldBy: null, error: e.message };
      }
    }
    held = readLockFile();
    if (held && Number(held.pid) !== process.pid) {
      if (isProcessAlive(held.pid)) {
        sleepSync(300); // 刚被强杀的进程可能还没被系统回收，复检一次再决定，避免误拒
        if (isProcessAlive(held.pid)) {
          return { ok: false, heldBy: { pid: held.pid, port: held.port, startedAt: held.startedAt } };
        }
      }
      console.warn(`[store] 检测到残留的数据目录锁（持有者 PID ${held.pid} 已不存活${held.port ? '，端口 ' + held.port : ''}），自动接管: ${LOCK_FILE}`);
    } else if (!held) {
      console.warn(`[store] 检测到无法解析的数据目录锁，自动接管: ${LOCK_FILE}`);
    }
    // 死锁 / 损坏锁：清掉后重试抢占
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('[store] 清理残留数据目录锁失败:', e.message);
        return { ok: false, heldBy: held ? { pid: held.pid, port: held.port, startedAt: held.startedAt } : null, error: e.message };
      }
    }
  }
  return { ok: false, heldBy: held ? { pid: held.pid, port: held.port, startedAt: held.startedAt } : null };
}

/* 释放锁：只删本进程持有的锁，避免把别人的锁删掉 */
function releaseInstanceLock() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const held = readLockFile();
    if (held && Number(held.pid) !== process.pid) return false;
    fs.unlinkSync(LOCK_FILE);
    return true;
  } catch (e) {
    console.error('[store] 释放数据目录锁失败:', e.message);
    return false;
  }
}

/* ---------------- 数据健康 / 启动自检 / 临时文件清理 ---------------- */
/* 只读计数，不触发写与恢复；不可解析时返回 null */
function countRecords(file) {
  try {
    if (!fs.existsSync(file)) return 0;
    const p = tryParse(fs.readFileSync(file, 'utf8'));
    return p.ok && Array.isArray(p.value) ? p.value.length : null;
  } catch (e) {
    return null;
  }
}

function listQuarantine() {
  try {
    if (!fs.existsSync(QUARANTINE_DIR)) return [];
    return fs.readdirSync(QUARANTINE_DIR).filter(n => n.endsWith('.corrupt')).sort().reverse();
  } catch (e) {
    return [];
  }
}

function dataHealth() {
  const out = {
    users: countRecords(USERS_FILE),
    borrows: countRecords(BORROWS_FILE),
    inventory: countRecords(INVENTORY_FILE),
    borrowsBytes: 0,
    borrowsMtime: null,
    quarantine: listQuarantine(),
    lastReadError,
    lastRecovery          // 本次进程内最近一次自动恢复（file/kind/count/at/from），无则为 null
  };
  const bad = [['users', USERS_FILE], ['borrows', BORROWS_FILE], ['inventory', INVENTORY_FILE]]
    .filter(([k]) => out[k] === null).map(([, f]) => path.basename(f));
  if (bad.length && !out.lastReadError) out.lastReadError = bad.join('、') + ' 无法解析';
  try {
    const st = fs.statSync(BORROWS_FILE);
    out.borrowsBytes = st.size;
    out.borrowsMtime = st.mtime.toISOString();
  } catch (e) { /* 文件不存在时保持 0 / null */ }
  return out;
}

/* 启动自检：逐个尝试读取三个数据文件，任何异常都收集成 errors，不抛出；
 * recoveries 记录本次自检过程中发生的自动恢复（文件丢失 / 被外部清空 / 损坏后从 .bak 恢复） */
function selfCheck() {
  const report = { ok: true, users: null, borrows: null, inventory: null, errors: [], recoveries: [] };
  const steps = [
    [USERS_FILE, 'users', loadUsers],
    [BORROWS_FILE, 'borrows', loadBorrows],
    [INVENTORY_FILE, 'inventory', loadInventory]
  ];
  for (const [file, key, fn] of steps) {
    const before = lastRecovery;
    try {
      const v = fn();
      report[key] = Array.isArray(v) ? v.length : 0;
      if (lastRecovery !== before && lastRecovery) {
        report.recoveries.push(`${lastRecovery.file}: ${RECOVERY_LABEL[lastRecovery.kind] || lastRecovery.kind} -> 已从 .bak 恢复 ${lastRecovery.count} 条`);
      }
    } catch (e) {
      report.ok = false;
      report[key] = null;
      report.errors.push(`${path.basename(file)}: ${e.message}`);
    }
  }
  return report;
}

/* 清理上次异常退出遗留的 *.tmp（只清 DATA_DIR 顶层） */
function cleanupTmp() {
  let n = 0;
  try {
    ensureDir(DATA_DIR);
    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.endsWith('.tmp')) continue;
      try { fs.unlinkSync(path.join(DATA_DIR, name)); n++; } catch (e) { /* 忽略单个文件失败 */ }
    }
  } catch (e) {
    console.error('[store] 清理遗留临时文件失败:', e.message);
  }
  return n;
}

module.exports = {
  hashPassword,
  verifyPassword,
  loadUsers,
  saveUsers,
  loadBorrows,
  saveBorrows,
  loadInventory,
  saveInventory,
  newId,
  DATA_DIR,
  LOCK_FILE,
  DataError,
  dataHealth,
  selfCheck,
  cleanupTmp,
  acquireInstanceLock,
  releaseInstanceLock
};

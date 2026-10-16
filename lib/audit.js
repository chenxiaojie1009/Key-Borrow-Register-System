/**
 * 操作日志：按天追加写 data/logs/YYYY-MM-DD.jsonl（每行一个 JSON）
 *  - 日志失败不能影响业务：写日志的所有异常都被吞掉并 console.error
 *  - 读取时容忍坏行（跳过并计数，不抛错）
 *  - 保留 180 天，由 cleanup() 删除超期文件
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const LOG_DIR = path.join(DATA_DIR, 'logs');
const RETENTION_DAYS = 180;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/* action -> 中文标签（前后端共用，前端下拉框按此写死） */
const ACTIONS = {
  'auth.login': '登录',
  'auth.login_fail': '登录失败',
  'auth.logout': '退出登录',
  'auth.password_change': '修改自己的密码',
  'borrow.submit': '借用人提交借用申请',
  'borrow.confirm': '确认借用',
  'borrow.update': '修改借用记录',
  'borrow.return': '归还确认',
  'borrow.cancel': '取消/驳回',
  'borrow.delete': '删除归档记录',
  'borrow.borrower_return': '借用人声明归还',
  'inventory.add': '新增物品',
  'inventory.import': '导入库存',
  'inventory.update': '修改库存数量',
  'inventory.delete': '删除物品',
  'user.add': '新增用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'user.reset_password': '重置用户密码',
  'data.export': '导出借用记录CSV',
  'data.backup_manual': '手动备份',
  'data.backup_auto': '自动备份',
  'data.restore': '数据还原',
  'backup.settings_update': '修改自动备份设置'
};

function pad2(n) { return String(n).padStart(2, '0'); }

/* 本地日期 YYYY-MM-DD（日志文件按本地日期分天） */
function localDate(d) {
  const t = (d instanceof Date && !isNaN(d.getTime())) ? d : new Date();
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

function str(v) { return v === null || v === undefined ? '' : String(v); }

/* 追加一条日志，返回写入的条目（字段齐全；异常只打印不抛出） */
function log(entry) {
  const src = entry || {};
  const action = str(src.action);
  const e = {
    at: str(src.at) || new Date().toISOString(),
    action,
    label: str(src.label) || ACTIONS[action] || action,
    actor: str(src.actor),
    username: str(src.username),
    role: str(src.role),
    target: str(src.target),
    targetId: src.targetId === null || src.targetId === undefined || src.targetId === '' ? null : String(src.targetId),
    detail: str(src.detail),
    ip: str(src.ip),
    result: str(src.result) || 'ok'
  };
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const at = new Date(e.at);
    fs.appendFileSync(path.join(LOG_DIR, localDate(at) + '.jsonl'), JSON.stringify(e) + '\n', 'utf8');
  } catch (err) {
    console.error('[audit] 写操作日志失败:', err.message);
  }
  return e;
}

/* 已存在的日志文件（YYYY-MM-DD.jsonl），按日期倒序；from/to 为本地日期字符串 */
function listLogFiles(from, to) {
  try {
    if (!fs.existsSync(LOG_DIR)) return [];
    return fs.readdirSync(LOG_DIR)
      .filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .filter(n => {
        const day = n.slice(0, 10);
        if (from && day < from) return false;
        if (to && day > to) return false;
        return true;
      })
      .sort().reverse();
  } catch (e) {
    console.error('[audit] 读取日志目录失败:', e.message);
    return [];
  }
}

function matchEntry(e, f) {
  if (f.actor && str(e.actor) !== f.actor) return false;
  if (f.action) {
    const want = f.action.split(',').map(s => s.trim()).filter(Boolean);
    if (want.length && want.indexOf(str(e.action)) < 0) return false;
  }
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    const hay = [e.target, e.detail, e.actor, e.username, e.ip, e.targetId, e.no].map(str).join(' ').toLowerCase();
    if (hay.indexOf(kw) < 0) return false;
  }
  return true;
}

function normalizeFilter(f) {
  const src = f || {};
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(str(v).trim()) ? str(v).trim() : '');
  const page = Math.max(1, parseInt(src.page, 10) || 1);
  let pageSize = parseInt(src.pageSize, 10) || DEFAULT_PAGE_SIZE;
  pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, pageSize));
  return {
    from: day(src.from),
    to: day(src.to),
    actor: str(src.actor).trim(),
    action: str(src.action).trim(),
    keyword: str(src.keyword).trim(),
    page,
    pageSize
  };
}

/* 从最新日志文件开始逐行读取（文件内倒序），最多收集 limit 条匹配项（limit=0 表示不限） */
function collect(filter, limit) {
  const list = [];
  let skipped = 0;
  for (const name of listLogFiles(filter.from, filter.to)) {
    let lines;
    try { lines = fs.readFileSync(path.join(LOG_DIR, name), 'utf8').split('\n'); }
    catch (e) { console.error('[audit] 读取日志文件失败:', name, e.message); continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text) continue;
      let e;
      try { e = JSON.parse(text); } catch (err) { skipped++; continue; } // 坏行跳过
      if (!e || typeof e !== 'object' || Array.isArray(e)) { skipped++; continue; }
      if (!matchEntry(e, filter)) continue;
      list.push(e);
      if (limit && list.length >= limit) return { list, skipped };
    }
  }
  return { list, skipped };
}

/* 分页查询：结果按时间倒序（最新在前） */
function query(params) {
  const f = normalizeFilter(params);
  const all = collect(f, 0).list;
  const start = (f.page - 1) * f.pageSize;
  return {
    total: all.length,
    page: f.page,
    pageSize: f.pageSize,
    list: all.slice(start, start + f.pageSize)
  };
}

/* 导出用：一次取回最多 limit 条匹配项（默认 20000），避免逐页重复读文件 */
function queryAll(params, limit) {
  const f = normalizeFilter(params);
  const max = Math.max(1, Math.min(200000, parseInt(limit, 10) || 20000));
  return collect(f, max).list;
}

/* 删除超期日志文件，返回删除数量 */
function cleanup(retentionDays) {
  const days = Number.isInteger(retentionDays) ? retentionDays : RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const cutoffDay = localDate(cutoff);
  let removed = 0;
  try {
    for (const name of listLogFiles('', '')) {
      if (name.slice(0, 10) >= cutoffDay) continue;
      try { fs.unlinkSync(path.join(LOG_DIR, name)); removed++; }
      catch (e) { console.error('[audit] 删除超期日志失败:', name, e.message); }
    }
  } catch (e) {
    console.error('[audit] 清理超期日志失败:', e.message);
  }
  return removed;
}

module.exports = { LOG_DIR, ACTIONS, log, query, queryAll, cleanup };

/**
 * 借用记录报表生成（server.js 的 /api/export 与自动备份共用）
 * CSV 列顺序、字段、公式注入防护、时间格式与改造前 /api/export 完全一致。
 */
'use strict';

const { getItems, isOverdue } = require('./borrow-utils');

/* CSV 公式注入防护：以 = + - @ 制表符开头的内容会被 Excel 当作公式执行，前置单引号使其按文本显示 */
function csvSafe(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }

function esc(v) {
  let s = v === null || v === undefined ? '' : String(v);
  s = csvSafe(s);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function fmt(v) { return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : ''; }

const STATUS_MAP = { pending: '待确认', confirmed: '已确认(借用中)', returned: '已归还(归档)', cancelled: '已取消(归档)' };

/* 返回带 \uFEFF BOM、\r\n 分隔的 CSV 文本 */
function buildBorrowCsv(borrows) {
  const list = Array.isArray(borrows) ? borrows : [];
  const rows = [];
  rows.push(['借用单号', '借用人', '借用原因', '物品清单', '借用时间', '计划归还时间', '实际归还时间', '状态', '确认人', '确认时间', '归还人', '借用人声明归还', '借用人归还备注', '归还照片', '是否超期', '借用人备注', '运行人员备注', '取消原因', '创建时间']);
  for (const b of list) {
    if (!b || typeof b !== 'object') continue; // 手工改坏的记录（null/标量）跳过，保证导出与备份永不崩
    const items = getItems(b);
    const itemList = items.map(it => `${it.itemType}-${it.itemName}×${it.quantity}`).join('；');
    rows.push([
      b.no, b.borrowerName, b.borrowReason || '', itemList,
      fmt(b.borrowTime), fmt(b.plannedReturnTime), fmt(b.returnedAt),
      STATUS_MAP[b.status] || b.status,
      b.confirmedBy || '', fmt(b.confirmedAt), b.returnedBy || '',
      b.borrowerReturn && b.borrowerReturn.confirmed ? fmt(b.borrowerReturn.at) : '',
      (b.borrowerReturn && b.borrowerReturn.note) || '',
      b.borrowerReturn && b.borrowerReturn.photo ? '有' : '无',
      isOverdue(b) ? '是' : '否',
      b.borrowNote || '', b.operatorNote || '', b.cancelReason || '',
      fmt(b.createdAt)
    ]);
  }
  return '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
}

module.exports = { buildBorrowCsv, csvSafe, esc };

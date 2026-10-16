/**
 * 借用记录通用纯函数（server.js 与 report.js 共用）
 * 由 server.js 原样搬出；normalizeItems 已改为「严格校验 + 不再静默改值」的实现。
 */
'use strict';

const MAX_ITEMS = 20;  // 单笔最多 20 件物品
const MAX_QTY = 999;   // 单件数量上限

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isOverdue(b) {
  if (!b || typeof b !== 'object') return false; // 手工改坏的记录（null/标量）不当成超期，也不抛错
  if (b.status === 'returned' || b.status === 'cancelled') return false;
  const t = parseDate(b.plannedReturnTime);
  if (!t) return false;
  return t.getTime() < Date.now();
}

/* 数量解析：只接受 1..999 的整数（兼容 "3" 这类数字字符串），其余一律返回 null 由调用方拒绝 */
function parseQuantity(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^[0-9]+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/* 严格校验并规范化物品清单（兼容旧版单物品字段）
 * 返回 { ok:true, items:[{itemType,itemName,quantity}] } 或 { ok:false, error:'中文原因' }
 * 任何会改变借用人提交值的情况都返回错误（接口转成 400），不再静默兜底成 1 / 静默截断 / 静默丢掉第 21 件。
 * 例外：整行空白的行（类型/名称/数量全空）仍然忽略，避免页面上多余空行导致无法提交。
 */
function validateItems(input) {
  if (Array.isArray(input) && input.length > MAX_ITEMS) {
    return { ok: false, error: `单笔最多登记 ${MAX_ITEMS} 件物品` };
  }
  const arr = Array.isArray(input) ? input : (input && typeof input === 'object' ? [input] : []);
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const rawQty = it.quantity !== undefined && it.quantity !== null ? it.quantity : it.qty;
    const typeRaw = String(it.itemType !== undefined && it.itemType !== null ? it.itemType : (it.type || '')).trim();
    const nameRaw = String(it.itemName !== undefined && it.itemName !== null ? it.itemName : (it.name || '')).trim();
    const hasQty = rawQty !== undefined && rawQty !== null && rawQty !== '';
    if (!typeRaw && !nameRaw && !hasQty) continue; // 整行空白：忽略
    const name = nameRaw.slice(0, 50);
    if (!name) return { ok: false, error: '物品名称不能为空' };
    const type = typeRaw.slice(0, 20) || '其他';
    const qty = parseQuantity(rawQty);
    if (qty === null || qty < 1 || qty > MAX_QTY) {
      return { ok: false, error: `「${name}」的数量必须是 1-${MAX_QTY} 的整数` };
    }
    out.push({ itemType: type, itemName: name, quantity: qty });
  }
  return { ok: true, items: out };
}

/* 兼容旧调用：合法输入返回数组，非法输入返回空数组（新代码请用 validateItems 以给出明确 400） */
function normalizeItems(input) {
  const v = validateItems(input);
  return v.ok ? v.items : [];
}

/* 读取物品清单。
 * 读路径必须容错（E2）：手工改坏的 borrows.json（items 含 null / 非对象 / 缺名称）也要能导出与备份，
 * 绝不抛异常 —— 导出与备份是数据损坏时的最后一道防线。合法数据的输出与旧实现逐字节一致。 */
function getItems(b) {
  const rec = (b && typeof b === 'object') ? b : {};
  if (Array.isArray(rec.items) && rec.items.length) {
    const out = [];
    for (const it of rec.items) {
      if (!it || typeof it !== 'object') continue; // 畸形项（null / 字符串 / 数字）跳过，不抛错
      const name = (it.itemName === undefined || it.itemName === null) ? '' : String(it.itemName);
      out.push({
        itemType: it.itemType || '其他',
        itemName: name || '（未知物品）',
        quantity: Number(it.quantity) || 1
      });
    }
    if (out.length) return out;
  }
  if (rec.itemName) return [{ itemType: rec.itemType || '其他', itemName: String(rec.itemName), quantity: Number(rec.quantity) || 1 }];
  return [];
}

function itemsSummary(b) {
  return getItems(b).map(it => `${it.itemType}·${it.itemName}×${it.quantity}`).join('；');
}

/* E2：手工改坏的 borrows.json 里可能有 null / 标量条目。
 * 读路径（列表/统计/导出）先过滤掉它们，避免一条垃圾记录让整个接口 500；对合法数据是恒等变换。 */
function isRecord(b) {
  return !!b && typeof b === 'object' && !Array.isArray(b);
}

function validRecords(list) {
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

module.exports = {
  parseDate, isOverdue, normalizeItems, validateItems, parseQuantity,
  getItems, itemsSummary, isRecord, validRecords, MAX_ITEMS, MAX_QTY
};

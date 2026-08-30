/**
 * 钥匙、工具、标识牌 借用登记与归还确认系统 —— 后端主服务
 * 运行：node server.js   默认端口 10800
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const QRCode = require('qrcode');

const store = require('./lib/store');

const PORT = Number(process.env.PORT) || 10800;
const HOST = process.env.HOST || '0.0.0.0'; // 监听所有网卡，允许手机同局域网访问

/* ---------------- 会话密钥：优先环境变量，否则首次启动随机生成并持久化到 data/ ----------------
 * 避免在源码中硬编码密钥（重启后仍保持同一密钥，登录态不丢失）。
 */
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    const f = path.join(store.DATA_DIR, 'session-secret');
    if (fs.existsSync(f)) {
      const s = fs.readFileSync(f, 'utf8').trim();
      if (s) return s;
    }
    const s = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.writeFileSync(f, s, { encoding: 'utf8', mode: 0o600 });
    return s;
  } catch (e) {
    return crypto.randomBytes(32).toString('hex');
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '3mb' })); // 手写签字图片（已限制 2MB）
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

/* 安全响应头；API 响应禁止缓存（含借用记录等业务数据） */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// 页面路由
app.get('/', (req, res) => res.redirect('/dashboard.html'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/borrow', (req, res) => res.sendFile(path.join(__dirname, 'public', 'borrow.html')));
app.get('/track', (req, res) => res.sendFile(path.join(__dirname, 'public', 'track.html')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

/* ---------------- 会话 ---------------- */
app.use(session({
  name: 'kbrsid',
  secret: loadSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 } // 12 小时；sameSite=lax 防 CSRF
}));

/* ---------------- 简单内存限流 ----------------
 * 同一 key 在时间窗内最多 maxHits 次，超出返回 429。
 * 用于登录防暴力破解、公开查询接口防刷（单进程内存版，重启即清零，够用）。
 */
function rateLimit({ windowMs, maxHits, keyOf, message }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  timer.unref(); // 不阻止进程退出
  return (req, res, next) => {
    const key = keyOf(req);
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now > rec.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > maxHits) return res.status(429).json({ error: message });
    next();
  };
}

const clientIP = req => req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.ip;
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, maxHits: 8,
  keyOf: req => clientIP(req) + '|' + String((req.body || {}).username || '').toLowerCase(),
  message: '尝试次数过多，请 10 分钟后再试'
});
const trackLimiter = rateLimit({
  windowMs: 60 * 1000, maxHits: 30,
  keyOf: req => clientIP(req),
  message: '查询过于频繁，请稍后再试'
});

/* ---------------- 工具函数 ---------------- */
function getLanIP() {
  try {
    const nets = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          candidates.push({ name, address: net.address });
        }
      }
    }
    // 优先选择私网地址（10.x / 172.16-31.x / 192.168.x），这些更可能是手机可访问的局域网地址
    const priv = candidates.find(c => /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(c.address));
    if (priv) return priv.address;
    if (candidates.length) return candidates[0].address;
  } catch (e) { /* ignore */ }
  return '127.0.0.1';
}

function nowISO() { return new Date().toISOString(); }

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function isOverdue(b) {
  if (b.status === 'returned' || b.status === 'cancelled') return false;
  const t = parseDate(b.plannedReturnTime);
  if (!t) return false;
  return t.getTime() < Date.now();
}

function genBorrowNo(borrows) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const prefix = `BR-${y}${m}${day}-`;
  let max = 0;
  for (const b of borrows) {
    if (b.no && b.no.startsWith(prefix)) {
      const n = parseInt(b.no.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

/* 多物品：规范化物品清单（兼容旧版单物品字段），并做长度/数量上限校验 */
function normalizeItems(input) {
  // input 可能是 {itemType,itemName,quantity} 或 [{...},...]
  let arr = Array.isArray(input) ? input : (input && !Array.isArray(input) ? [input] : []);
  const out = [];
  for (const it of arr.slice(0, 20)) { // 单笔最多 20 件物品
    if (!it) continue;
    const type = String(it.itemType || it.type || '').trim().slice(0, 20) || '其他';
    const name = String(it.itemName || it.name || '').trim().slice(0, 50);
    const qty = parseInt(it.quantity ?? it.qty, 10);
    if (!name) continue;
    out.push({ itemType: type, itemName: name, quantity: Number.isInteger(qty) && qty >= 1 ? Math.min(qty, 999) : 1 });
  }
  return out;
}
function getItems(b) {
  if (Array.isArray(b.items) && b.items.length) {
    return b.items.map(it => ({ itemType: it.itemType || '其他', itemName: it.itemName, quantity: Number(it.quantity) || 1 }));
  }
  if (b.itemName) return [{ itemType: b.itemType || '其他', itemName: b.itemName, quantity: Number(b.quantity) || 1 }];
  return [];
}
function itemsSummary(b) {
  return getItems(b).map(it => `${it.itemType}·${it.itemName}×${it.quantity}`).join('；');
}

/* ---------------- 物品库存 ---------------- */
function isOnLoan(b) { return b && !b.archived && (b.status === 'pending' || b.status === 'confirmed'); }
/* 统计某物品当前"未归还"借出数量（含待确认与借用中） */
function borrowedQty(itemType, itemName) {
  let qty = 0;
  for (const b of store.loadBorrows()) {
    if (!isOnLoan(b)) continue;
    for (const it of getItems(b)) {
      if (it.itemType === itemType && it.itemName === itemName) qty += (Number(it.quantity) || 0);
    }
  }
  return qty;
}
/* 库存档案 + 实时可用数量 */
function invWithAvailable() {
  return store.loadInventory().map(it => {
    const total = Number(it.total) || 0;
    const borrowed = borrowedQty(it.itemType, it.itemName);
    return { id: it.id, itemType: it.itemType, itemName: it.itemName, total, borrowed, available: Math.max(0, total - borrowed) };
  });
}
/* 规范化导入数据 */
function normalizeInventory(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  for (const it of arr) {
    const type = String(it.itemType || it.type || '').trim();
    const name = String(it.itemName || it.name || '').trim();
    const total = parseInt(it.total ?? it.quantity, 10);
    if (!type || !name) continue;
    if (!Number.isInteger(total) || total < 1) continue;
    out.push({ itemType: type, itemName: name, total });
  }
  return out;
}

function publicBorrow(b) {
  const items = getItems(b);
  return {
    id: b.id, no: b.no, borrowerName: b.borrowerName, signature: b.signature || null,
    items,
    itemType: items[0] ? items[0].itemType : b.itemType,
    itemName: items[0] ? items[0].itemName : b.itemName,
    quantity: items[0] ? items[0].quantity : b.quantity,
    borrowTime: b.borrowTime, plannedReturnTime: b.plannedReturnTime,
    status: b.status, operatorNote: b.operatorNote || '',
    confirmedBy: b.confirmedBy || null, confirmedAt: b.confirmedAt || null,
    returnedBy: b.returnedBy || null, returnedAt: b.returnedAt || null,
    cancelReason: b.cancelReason || '',
    createdAt: b.createdAt, archived: !!b.archived,
    history: b.history || [],
    overdue: isOverdue(b)
  };
}

/* ---------------- 权限中间件 ----------------
 * 每次请求回查用户表：账号被停用/删除后登录态立即失效；角色、显示名变更实时生效。
 */
function sessionUser(req) {
  const su = req.session.user;
  if (!su) return null;
  const u = store.loadUsers().find(x => x.id === su.id && x.status === 'active');
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role };
}
function requireAuth(req, res, next) {
  const u = sessionUser(req);
  if (!u) return res.status(401).json({ error: '未登录、登录已过期或账号已停用' });
  req.session.user = u; // 同步最新资料
  next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可执行此操作' });
    next();
  });
}
function requireStaff(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'operator') {
      return res.status(403).json({ error: '无权限执行此操作' });
    }
    next();
  });
}

/* 出厂内置账号的默认密码，仅用于“请修改默认密码”提醒标记 */
const DEFAULT_PASSWORDS = { admin: 'admin123', operator1: '123456', operator2: '123456' };
function isDefaultPassword(u) {
  const def = DEFAULT_PASSWORDS[u && u.username];
  if (!def) return false;
  try { return store.verifyPassword(def, u.passwordSalt, u.passwordHash); } catch (e) { return false; }
}

/* ================= 认证 ================= */
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const users = store.loadUsers();
  const u = users.find(x => x.username === String(username).trim() && x.status === 'active');
  if (!u || !store.verifyPassword(String(password), u.passwordSalt, u.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  u.lastLoginAt = nowISO();
  store.saveUsers(users);
  req.session.user = {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role
  };
  res.json({
    ok: true,
    user: { id: u.id, username: u.username, displayName: u.displayName, role: u.role },
    mustChangePassword: isDefaultPassword(u) // 仍在使用出厂默认密码时提醒修改
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = store.loadUsers().find(x => x.id === req.session.user.id);
  res.json({ user: req.session.user, mustChangePassword: u ? isDefaultPassword(u) : false });
});

/* 登录用户修改自己的密码（需验证当前密码） */
app.post('/api/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const users = store.loadUsers();
  const u = users.find(x => x.id === req.session.user.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (!store.verifyPassword(String(currentPassword || ''), u.passwordSalt, u.passwordHash)) {
    return res.status(400).json({ error: '当前密码不正确' });
  }
  const np = String(newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (np.length > 64) return res.status(400).json({ error: '新密码最长 64 位' });
  if (np === String(currentPassword)) return res.status(400).json({ error: '新密码不能与当前密码相同' });
  const { salt, hash } = store.hashPassword(np);
  u.passwordSalt = salt;
  u.passwordHash = hash;
  u.passwordChangedAt = nowISO();
  store.saveUsers(users);
  res.json({ ok: true });
});

/* ================= 健康检查 ================= */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

/* ================= 物品库存：借用人可用候选（公开） =================
 * 借用人选择类型 + 输入名称时联想；仅返回"当前有可用库存"的物品。
 */
app.get('/api/inventory/options', (req, res) => {
  const type = String(req.query.type || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = invWithAvailable().filter(x => x.available > 0);
  if (type) list = list.filter(x => x.itemType === type);
  if (q) list = list.filter(x => x.itemName.toLowerCase().includes(q));
  list.sort((a, b) => a.itemName.localeCompare(b.itemName, 'zh'));
  res.json({ ok: true, list: list.slice(0, 30).map(x => ({ itemType: x.itemType, itemName: x.itemName, available: x.available })) });
});

/* ================= 借用登记（公开，二维码扫码进入） ================= */
app.post('/api/borrows', (req, res) => {
  const b = req.body || {};
  const borrowerName = String(b.borrowerName || '').trim();
  const signature = String(b.signature || '').trim();
  const borrowTime = parseDate(b.borrowTime);
  const plannedReturnTime = parseDate(b.plannedReturnTime);

  // 物品清单：优先 items 数组（多物品），兼容旧版单物品字段
  let items = normalizeItems(b.items);
  if (!items.length) items = normalizeItems({ itemType: b.itemType, itemName: b.itemName, quantity: b.quantity });

  if (!borrowerName) return res.status(400).json({ error: '请填写借用人姓名' });
  if (borrowerName.length > 30) return res.status(400).json({ error: '借用人姓名最长 30 字' });
  if (!signature) return res.status(400).json({ error: '请进行手写签字' });
  // 签字必须是 PNG 图片的 data URL，且不超过 2MB（同时防止把任意文本/脚本存进签字字段）
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > 2 * 1024 * 1024) {
    return res.status(400).json({ error: '手写签字内容无效，请重新签字' });
  }
  if (!items.length) return res.status(400).json({ error: '请至少填写一件借用物品' });
  // 库存校验：导入过库存的物品，被借出后不可超量借用
  const invList = store.loadInventory();
  const invMap = new Map(invList.map(x => [x.itemType + '|' + x.itemName, Number(x.total) || 0]));
  for (const it of items) {
    const key = it.itemType + '|' + it.itemName;
    if (!invMap.has(key)) continue; // 未导入库存的手填物品/其他类型不校验
    const avail = Math.max(0, invMap.get(key) - borrowedQty(it.itemType, it.itemName));
    if (avail < it.quantity) {
      return res.status(400).json({ error: `「${it.itemName}」库存不足：当前可用仅 ${avail} 件，无法借用 ${it.quantity} 件` });
    }
  }
  if (!borrowTime) return res.status(400).json({ error: '借用时间无效' });
  if (!plannedReturnTime) return res.status(400).json({ error: '计划归还时间无效' });
  if (plannedReturnTime.getTime() < borrowTime.getTime()) {
    return res.status(400).json({ error: '计划归还时间不能早于借用时间' });
  }
  // 时间合理性：借用时间距离现在最多 ±7 天（允许补登）；借期最长 90 天
  const now = Date.now();
  if (Math.abs(borrowTime.getTime() - now) > 7 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: '借用时间需在当前时间前后 7 天以内' });
  }
  if (plannedReturnTime.getTime() - borrowTime.getTime() > 90 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: '借期最长 90 天，请修改计划归还时间' });
  }

  const borrows = store.loadBorrows();
  const first = items[0];
  const record = {
    id: store.newId('b'),
    no: genBorrowNo(borrows),
    queryToken: crypto.randomBytes(12).toString('hex'), // 借用人查询记录状态的专属凭证
    borrowerName,
    signature,
    items,
    itemType: first.itemType,   // 冗余首项，兼容旧显示
    itemName: first.itemName,
    quantity: first.quantity,
    borrowTime: borrowTime.toISOString(),
    plannedReturnTime: plannedReturnTime.toISOString(),
    status: 'pending',                 // pending -> confirmed -> returned / cancelled
    operatorNote: '',
    confirmedBy: null, confirmedAt: null,
    returnedBy: null, returnedAt: null,
    cancelReason: '',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    archived: false,
    history: [{
      action: '提交借用申请', by: borrowerName, at: nowISO(),
      note: '登记借用 ' + items.map(it => `${it.itemName}×${it.quantity}`).join('、')
    }]
  };
  borrows.push(record);
  store.saveBorrows(borrows);
  res.json({
    ok: true,
    record: publicBorrow(record),
    queryToken: record.queryToken,
    trackUrl: '/track?token=' + record.queryToken
  });
});

/* ================= 借用人状态查询（公开，无需登录） =================
 * 借用人可在登记成功页保存"专属查询二维码"，或到 /track 输入单号+姓名，
 * 随时核实运行人员是否已点"归还确认"（含确认人/归还人/时间/是否超期）。
 */
function trackStatus(b) {
  const items = getItems(b);
  return {
    no: b.no,
    borrowerName: b.borrowerName,
    items,
    itemType: items[0] ? items[0].itemType : b.itemType,
    itemName: items[0] ? items[0].itemName : b.itemName,
    quantity: items[0] ? items[0].quantity : b.quantity,
    borrowTime: b.borrowTime,
    plannedReturnTime: b.plannedReturnTime,
    status: b.status,
    confirmedBy: b.confirmedBy || null,
    confirmedAt: b.confirmedAt || null,
    returnedBy: b.returnedBy || null,
    returnedAt: b.returnedAt || null,
    cancelReason: b.cancelReason || '',
    operatorNote: b.operatorNote || '',
    overdue: isOverdue(b),
    createdAt: b.createdAt
  };
}

app.get('/api/track/status', trackLimiter, (req, res) => {
  const token = String(req.query.token || '').trim();
  const no = String(req.query.no || '').trim();
  const name = String(req.query.name || '').trim();
  if (!token && !(no && name)) {
    return res.status(400).json({ error: '请提供查询凭证，或输入借用单号与借用人姓名' });
  }
  const borrows = store.loadBorrows();
  let b = null;
  if (token) b = borrows.find(x => x.queryToken === token);
  else b = borrows.find(x => x.no === no && x.borrowerName === name);
  if (!b) return res.status(404).json({ error: '未找到对应记录，请核对借用单号与借用人姓名' });
  res.json({ ok: true, record: trackStatus(b) });
});

app.get('/api/track/qr', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少查询凭证' });
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x.queryToken === token);
  if (!b) return res.status(404).json({ error: '无效的查询凭证' });
  const lanIP = getLanIP();
  const base = String(req.query.base || '').trim().replace(/\/+$/, '');
  const origin = base || `http://${lanIP}:${PORT}`;
  const url = origin + '/track?token=' + token;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 260, margin: 2 });
    res.json({ ok: true, qrDataUrl, url });
  } catch (e) {
    res.status(500).json({ error: '二维码生成失败' });
  }
});

/* ================= 借用记录查询（管理员/运行人员） ================= */
app.get('/api/borrows', requireStaff, (req, res) => {
  const scope = req.query.scope || 'active'; // active | archive | all
  let borrows = store.loadBorrows();
  if (scope === 'active') borrows = borrows.filter(b => !b.archived && (b.status === 'pending' || b.status === 'confirmed'));
  else if (scope === 'archive') borrows = borrows.filter(b => b.archived || b.status === 'returned' || b.status === 'cancelled');
  borrows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ list: borrows.map(publicBorrow) });
});

app.get('/api/borrows/:id', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '记录不存在' });
  res.json({ record: publicBorrow(b) });
});

/* 运行人员/管理员：修改借用人提交的信息 */
app.put('/api/borrows/:id', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '记录不存在' });
  if (b.status === 'returned' || b.status === 'cancelled') {
    return res.status(400).json({ error: '已归档记录不可修改' });
  }
  const p = req.body || {};
  const changes = [];
  const setStr = (key, label, maxLen) => {
    if (typeof p[key] === 'string' && p[key].trim() !== '') {
      const v = p[key].trim().slice(0, maxLen || 200);
      if (b[key] !== v) { b[key] = v; changes.push(label); }
    }
  };
  const setNum = (key, label) => {
    if (p[key] !== undefined && p[key] !== null && p[key] !== '') {
      const n = parseInt(p[key], 10);
      if (Number.isInteger(n) && n >= 1 && n !== b[key]) { b[key] = n; changes.push(label); }
    }
  };
  setStr('borrowerName', '借用人', 30);
  setStr('operatorNote', '备注', 200);
  // 多物品清单修改
  if (Array.isArray(p.items)) {
    const newItems = normalizeItems(p.items);
    if (!newItems.length) return res.status(400).json({ error: '至少保留一件有效物品' });
    const oldSummary = itemsSummary(b);
    const newSummary = newItems.map(it => `${it.itemType}·${it.itemName}×${it.quantity}`).join('；');
    b.items = newItems;
    b.itemType = newItems[0].itemType;
    b.itemName = newItems[0].itemName;
    b.quantity = newItems[0].quantity;
    if (oldSummary !== newSummary) changes.push('物品清单');
  } else {
    setStr('itemType', '物品类型');
    setStr('itemName', '物品名称');
    setNum('quantity', '数量');
    if (p.itemType !== undefined || p.itemName !== undefined || p.quantity !== undefined) {
      b.items = normalizeItems({ itemType: b.itemType, itemName: b.itemName, quantity: b.quantity });
    }
  }
  if (p.borrowTime) {
    const t = parseDate(p.borrowTime);
    if (t && t.toISOString() !== b.borrowTime) { b.borrowTime = t.toISOString(); changes.push('借用时间'); }
  }
  if (p.plannedReturnTime) {
    const t = parseDate(p.plannedReturnTime);
    if (t) {
      if (t.toISOString() !== b.plannedReturnTime) { b.plannedReturnTime = t.toISOString(); changes.push('计划归还时间'); }
      if (parseDate(b.plannedReturnTime).getTime() < parseDate(b.borrowTime).getTime()) {
        return res.status(400).json({ error: '计划归还时间不能早于借用时间' });
      }
    }
  }
  // 支持运行人员修改借用人手写签字（可选），同样要求 PNG data URL 且不超过 2MB
  if (typeof p.signature === 'string' && p.signature !== b.signature) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(p.signature) || p.signature.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: '签字内容无效，请重新签字' });
    }
    b.signature = p.signature; changes.push('手写签字');
  }
  if (changes.length > 0) {
    b.updatedAt = nowISO();
    b.history = b.history || [];
    b.history.push({ action: '运行人员修改', by: req.session.user.displayName, at: nowISO(), note: '修改内容：' + changes.join('、') });
    store.saveBorrows(borrows);
  }
  res.json({ ok: true, record: publicBorrow(b), changes });
});

/* 运行人员/管理员：确认借用（留下确认借用标志） */
app.post('/api/borrows/:id/confirm', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '记录不存在' });
  if (b.status === 'returned' || b.status === 'cancelled') {
    return res.status(400).json({ error: '已归档记录不可确认' });
  }
  b.status = 'confirmed';
  b.confirmedBy = req.session.user.displayName;
  b.confirmedAt = nowISO();
  b.updatedAt = b.confirmedAt;
  b.history = b.history || [];
  b.history.push({ action: '确认借用', by: req.session.user.displayName, at: b.confirmedAt, note: '确认借用申请，放行物品' });
  store.saveBorrows(borrows);
  res.json({ ok: true, record: publicBorrow(b) });
});

/* 运行人员/管理员：归还确认 */
app.post('/api/borrows/:id/return', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '记录不存在' });
  if (b.status === 'returned' || b.status === 'cancelled') {
    return res.status(400).json({ error: '该记录已归档' });
  }
  b.status = 'returned';
  b.returnedBy = req.session.user.displayName;
  b.returnedAt = nowISO();
  b.updatedAt = b.returnedAt;
  b.archived = true; // 归还完成后归档，不再显示在借用目录
  b.history = b.history || [];
  b.history.push({ action: '归还确认', by: req.session.user.displayName, at: b.returnedAt, note: '确认物品已归还，记录归档' });
  store.saveBorrows(borrows);
  res.json({ ok: true, record: publicBorrow(b) });
});

/* 运行人员/管理员：取消/驳回（归档） */
app.post('/api/borrows/:id/cancel', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '记录不存在' });
  if (b.status === 'returned' || b.status === 'cancelled') {
    return res.status(400).json({ error: '该记录已归档' });
  }
  b.status = 'cancelled';
  b.cancelReason = String((req.body || {}).reason || '').trim().slice(0, 200) || '未说明原因';
  b.archived = true;
  b.updatedAt = nowISO();
  b.history = b.history || [];
  b.history.push({ action: '取消/驳回', by: req.session.user.displayName, at: nowISO(), note: b.cancelReason });
  store.saveBorrows(borrows);
  res.json({ ok: true, record: publicBorrow(b) });
});

/* 管理员：删除归档记录（硬删除，控制台留痕） */
app.delete('/api/borrows/:id', requireAdmin, (req, res) => {
  const borrows = store.loadBorrows();
  const idx = borrows.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '记录不存在' });
  const [removed] = borrows.splice(idx, 1);
  store.saveBorrows(borrows);
  console.log(`[audit] ${nowISO()} 管理员 ${req.session.user.displayName} 删除归档记录 ${removed.no}（${removed.borrowerName}）`);
  res.json({ ok: true, removed: removed.id });
});

/* ================= 统计 ================= */
app.get('/api/stats', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const active = borrows.filter(b => !b.archived && (b.status === 'pending' || b.status === 'confirmed'));
  const pending = borrows.filter(b => b.status === 'pending' && !b.archived);
  const confirmed = borrows.filter(b => b.status === 'confirmed' && !b.archived);
  const overdue = active.filter(isOverdue);
  const archive = borrows.filter(b => b.archived || b.status === 'returned' || b.status === 'cancelled');
  res.json({
    pending: pending.length,
    active: active.length,
    confirmed: confirmed.length,
    overdue: overdue.length,
    archived: archive.length,
    overdueList: overdue.map(publicBorrow)
  });
});

/* ================= 二维码 ================= */
app.get('/api/qrcode', requireStaff, async (req, res) => {
  const lanIP = getLanIP();
  const base = req.query.base ? String(req.query.base).trim().replace(/\/+$/, '') : `http://${lanIP}:${PORT}`;
  const url = base + '/borrow';
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ url, qrDataUrl, lanIP, port: PORT });
  } catch (e) {
    res.status(500).json({ error: '二维码生成失败：' + e.message });
  }
});

/* ================= 数据导出（CSV） ================= */
app.get('/api/export', requireStaff, (req, res) => {
  const scope = req.query.scope || 'all'; // all | active | archive
  let borrows = store.loadBorrows();
  if (scope === 'active') borrows = borrows.filter(b => !b.archived && (b.status === 'pending' || b.status === 'confirmed'));
  else if (scope === 'archive') borrows = borrows.filter(b => b.archived || b.status === 'returned' || b.status === 'cancelled');
  borrows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  // CSV 公式注入防护：以 = + - @ 制表符开头的内容会被 Excel 当作公式执行，前置单引号使其按文本显示
  const csvSafe = s => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);
  const esc = v => {
    let s = v === null || v === undefined ? '' : String(v);
    s = csvSafe(s);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const fmt = v => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '');
  const statusMap = { pending: '待确认', confirmed: '已确认(借用中)', returned: '已归还(归档)', cancelled: '已取消(归档)' };
  const rows = [];
  rows.push(['借用单号', '借用人', '物品清单', '借用时间', '计划归还时间', '实际归还时间', '状态', '确认人', '确认时间', '归还人', '是否超期', '备注', '创建时间']);
  for (const b of borrows) {
    const items = getItems(b);
    const list = items.map(it => `${it.itemType}-${it.itemName}×${it.quantity}`).join('；');
    rows.push([
      b.no, b.borrowerName, list,
      fmt(b.borrowTime), fmt(b.plannedReturnTime), fmt(b.returnedAt),
      statusMap[b.status] || b.status,
      b.confirmedBy || '', fmt(b.confirmedAt), b.returnedBy || '',
      isOverdue(b) ? '是' : '否',
      (b.operatorNote || '') + (b.cancelReason ? ' 取消原因:' + b.cancelReason : ''),
      fmt(b.createdAt)
    ]);
  }
  const csv = '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n');
  const scopeName = { all: '全部', active: '借用中', archive: '归档' }[scope] || scope;
  const fileName = `借用记录_${scopeName}_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(csv);
});

/* ================= 数据备份（管理员）：一键打包下载全部业务数据 ================= */
app.get('/api/backup', requireAdmin, (req, res) => {
  const payload = {
    app: 'key-borrow-register-system',
    exportedAt: nowISO(),
    dataVersion: 1,
    users: store.loadUsers(),
    borrows: store.loadBorrows(),
    inventory: store.loadInventory()
  };
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const fileName = `借用系统备份_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(payload, null, 2));
});

/* ================= 物品库存管理（管理员/运行人员） ================= */
app.get('/api/inventory', requireStaff, (req, res) => {
  const type = String(req.query.type || '').trim();
  let list = invWithAvailable();
  if (type) list = list.filter(x => x.itemType === type);
  list.sort((a, b) => a.itemType.localeCompare(b.itemType, 'zh') || a.itemName.localeCompare(b.itemName, 'zh'));
  res.json({ ok: true, list });
});

/* 导入库存（同名同类型覆盖数量，新名称新增） */
app.post('/api/inventory/import', requireStaff, (req, res) => {
  const items = normalizeInventory((req.body || {}).items);
  if (!items.length) return res.status(400).json({ error: '没有可导入的有效数据（需包含：物品类型、物品名称、数量≥1）' });
  const inv = store.loadInventory();
  let added = 0, updated = 0;
  for (const it of items) {
    const found = inv.find(x => x.itemType === it.itemType && x.itemName === it.itemName);
    if (found) { found.total = it.total; updated++; }
    else { inv.push({ id: store.newId('i'), itemType: it.itemType, itemName: it.itemName, total: it.total, createdAt: nowISO() }); added++; }
  }
  store.saveInventory(inv);
  res.json({ ok: true, added, updated });
});

/* 下载导入模板 CSV */
app.get('/api/inventory/template', requireStaff, (req, res) => {
  const csv = '\uFEFF物品类型,物品名称,数量\r\n钥匙,机房大门钥匙,2\r\n工具,数字万用表,3\r\n标识牌,禁止合闸标识牌,1\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('物品导入模板.csv')}`);
  res.send(csv);
});

/* 界面直接新增/更新物品（同名同类型覆盖数量） */
app.post('/api/inventory', requireStaff, (req, res) => {
  const items = normalizeInventory([req.body || {}]);
  if (!items.length) return res.status(400).json({ error: '请填写有效的物品类型、名称和数量（≥1）' });
  const it = items[0];
  const inv = store.loadInventory();
  const found = inv.find(x => x.itemType === it.itemType && x.itemName === it.itemName);
  if (found) { found.total = it.total; store.saveInventory(inv); return res.json({ ok: true, updated: true }); }
  inv.push({ id: store.newId('i'), itemType: it.itemType, itemName: it.itemName, total: it.total, createdAt: nowISO() });
  store.saveInventory(inv);
  res.json({ ok: true, added: true });
});

/* 修改物品库存数量 */
app.put('/api/inventory/:id', requireStaff, (req, res) => {
  const inv = store.loadInventory();
  const it = inv.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '物品不存在' });
  const total = parseInt((req.body || {}).total, 10);
  if (!Number.isInteger(total) || total < 1) return res.status(400).json({ error: '数量必须为不小于 1 的整数' });
  it.total = total;
  store.saveInventory(inv);
  res.json({ ok: true });
});

/* 删除库存物品（管理员） */
app.delete('/api/inventory/:id', requireAdmin, (req, res) => {
  const inv = store.loadInventory();
  const i = inv.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '物品不存在' });
  inv.splice(i, 1);
  store.saveInventory(inv);
  res.json({ ok: true });
});

/* ================= 用户管理（管理员） ================= */
app.get('/api/users', requireAdmin, (req, res) => {
  const users = store.loadUsers();
  res.json({ list: users.map(u => ({
    id: u.id, username: u.username, displayName: u.displayName,
    role: u.role, status: u.status, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt
  })) });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const p = req.body || {};
  const username = String(p.username || '').trim();
  const displayName = String(p.displayName || '').trim();
  const password = String(p.password || '');
  const role = p.role === 'operator' ? 'operator' : 'admin';
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: '用户名需为 2-20 位字母/数字/下划线' });
  if (!displayName) return res.status(400).json({ error: '请填写显示名称' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const users = store.loadUsers();
  if (users.some(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });
  const { salt, hash } = store.hashPassword(password);
  users.push({
    id: store.newId('u'), username, passwordSalt: salt, passwordHash: hash,
    displayName, role, status: 'active', createdAt: nowISO(), lastLoginAt: null
  });
  store.saveUsers(users);
  res.json({ ok: true });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const users = store.loadUsers();
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const p = req.body || {};
  if (p.displayName !== undefined && String(p.displayName).trim()) u.displayName = String(p.displayName).trim();
  if (p.role === 'admin' || p.role === 'operator') u.role = p.role;
  if (p.status === 'active' || p.status === 'disabled') {
    // 不允许禁用自己
    if (!(p.status === 'disabled' && u.id === req.session.user.id)) u.status = p.status;
  }
  store.saveUsers(users);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const users = store.loadUsers();
  const idx = users.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '用户不存在' });
  if (users[idx].id === req.session.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
  users.splice(idx, 1);
  store.saveUsers(users);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  const users = store.loadUsers();
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const password = String((req.body || {}).password || '');
  if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  const { salt, hash } = store.hashPassword(password);
  u.passwordSalt = salt;
  u.passwordHash = hash;
  store.saveUsers(users);
  res.json({ ok: true });
});

/* ================= 兜底：API 404 返回 JSON、统一错误处理 ================= */
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: '请求体格式错误' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求数据过大' });
  }
  console.error('[server] 未处理错误:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: '服务器内部错误' });
});

/* ================= 启动 ================= */
app.listen(PORT, HOST, () => {
  const lanIP = getLanIP();
  console.log('==========================================================');
  console.log('  钥匙/工具/标识牌 借用登记与归还确认系统 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  console.log('  局域网访问: http://' + lanIP + ':' + PORT + '  （手机微信扫码用）');
  console.log('  借用登记二维码页: /borrow');
  console.log('  默认账号: admin / admin123（管理员）；operator1 / 123456（运行人员）');
  console.log('==========================================================');
});

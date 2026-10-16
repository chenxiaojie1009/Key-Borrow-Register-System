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
const { parseDate, isOverdue, validateItems, getItems, itemsSummary, validRecords } = require('./lib/borrow-utils');
const { buildBorrowCsv, esc: csvEsc } = require('./lib/report');
const audit = require('./lib/audit');
const backup = require('./lib/backup');

const PORT = Number(process.env.PORT) || 10800;
const HOST = process.env.HOST || '0.0.0.0'; // 监听所有网卡，允许手机同局域网访问

/* ---------------- 数据目录单实例锁（必须在任何数据读写之前取得） ----------------
 * 两个实例共用同一份 data 时会各自「load 整数组 → 改 → save 整数组」，互相覆盖导致静默丢记录。
 * 抢不到锁（已有活着的实例在用这份数据）就直接拒绝启动，绝不带着风险跑起来。
 */
const instanceLock = store.acquireInstanceLock({ port: PORT });
if (!instanceLock.ok) {
  const hb = instanceLock.heldBy || {};
  console.error(
    '检测到另一个服务实例正在使用同一份数据（PID ' + (hb.pid || '未知') + '，端口 ' + (hb.port || '未知') + '）。' +
    '为避免两个实例同时写 data 导致记录丢失，本次启动已中止：请先停止另一个实例（双击「停止服务.bat」）。'
  );
  console.error('  锁文件：' + store.LOCK_FILE + (hb.startedAt ? '（该实例启动于 ' + hb.startedAt + '）' : ''));
  console.error('  如确认该实例已不存在，可删除上述锁文件后重新启动。');
  process.exit(1);
}

/* 正常退出（Ctrl+C / 停止服务 / SIGTERM / 进程结束）时释放锁，避免留下死锁 */
let shuttingDown = false;
function shutdownServer(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { store.releaseInstanceLock(); } catch (e) { /* 退出路径不抛错 */ }
  console.log(`[server] 收到 ${signal}，已释放数据目录锁并退出`);
  process.exit(0);
}
process.on('SIGINT', () => shutdownServer('SIGINT'));
process.on('SIGTERM', () => shutdownServer('SIGTERM'));
process.on('exit', () => { try { store.releaseInstanceLock(); } catch (e) { /* 退出路径不抛错 */ } });

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
app.use(express.json({ limit: '12mb' })); // 手写签字(≤2MB) + 借用人归还照片(≤6MB)
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

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
const trackReturnLimiter = rateLimit({
  windowMs: 60 * 1000, maxHits: 10,
  keyOf: req => clientIP(req),
  message: '操作过于频繁，请稍后再试'
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

/* ---------------- 操作日志埋点 ----------------
 * actor/username/role 默认取登录用户；借用人侧（submit / borrower_return）由调用处传入 borrower 身份。
 */
function auditLog(req, action, info) {
  const i = info || {};
  const u = (req && req.session && req.session.user) || null;
  return audit.log({
    action,
    target: i.target || '',
    targetId: i.targetId || null,
    detail: i.detail || '',
    actor: i.actor !== undefined ? i.actor : (u ? u.displayName : ''),
    username: i.username !== undefined ? i.username : (u ? u.username : ''),
    role: i.role !== undefined ? i.role : (u ? u.role : ''),
    ip: req ? clientIP(req) : '',
    result: i.result || 'ok'
  });
}

function genBorrowNo(borrows) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const prefix = `BR-${y}${m}${day}-`;
  let max = 0;
  for (const b of borrows) {
    if (b && b.no && b.no.startsWith(prefix)) {
      const n = parseInt(b.no.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
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
    id: b.id, no: b.no, borrowerName: b.borrowerName, borrowReason: b.borrowReason || '', borrowNote: b.borrowNote || '', signature: b.signature || null,
    items,
    itemType: items[0] ? items[0].itemType : b.itemType,
    itemName: items[0] ? items[0].itemName : b.itemName,
    quantity: items[0] ? items[0].quantity : b.quantity,
    borrowTime: b.borrowTime, plannedReturnTime: b.plannedReturnTime,
    status: b.status, operatorNote: b.operatorNote || '',
    confirmedBy: b.confirmedBy || null, confirmedAt: b.confirmedAt || null,
    returnedBy: b.returnedBy || null, returnedAt: b.returnedAt || null,
    borrowerReturn: b.borrowerReturn || null,
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
  const attempted = String(username || '').trim();
  if (!username || !password) {
    auditLog(req, 'auth.login_fail', { actor: attempted, username: attempted, role: '', target: attempted, detail: '登录失败：未填写用户名或密码', result: 'fail' });
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  const users = store.loadUsers();
  const u = users.find(x => x.username === String(username).trim() && x.status === 'active');
  if (!u || !store.verifyPassword(String(password), u.passwordSalt, u.passwordHash)) {
    auditLog(req, 'auth.login_fail', { actor: attempted, username: attempted, role: '', target: attempted, detail: '登录失败：用户名或密码错误', result: 'fail' });
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  u.lastLoginAt = nowISO();
  store.saveUsers(users);
  req.session.user = {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role
  };
  auditLog(req, 'auth.login', { actor: u.displayName, username: u.username, role: u.role, target: u.displayName, targetId: u.id, detail: '登录成功' });
  res.json({
    ok: true,
    user: { id: u.id, username: u.username, displayName: u.displayName, role: u.role },
    mustChangePassword: isDefaultPassword(u) // 仍在使用出厂默认密码时提醒修改
  });
});

app.post('/api/logout', (req, res) => {
  const u = (req.session && req.session.user) || null;
  req.session.destroy(() => {
    if (u) auditLog(req, 'auth.logout', { actor: u.displayName, username: u.username, role: u.role, target: u.displayName, targetId: u.id, detail: '退出登录' });
    res.json({ ok: true });
  });
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
  auditLog(req, 'auth.password_change', { target: u.displayName, targetId: u.id, detail: '修改自己的登录密码' });
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
  const borrowReason = String(b.borrowReason || '').trim();
  const borrowNote = String(b.borrowNote || '').trim();
  const signature = String(b.signature || '').trim();
  const borrowTime = parseDate(b.borrowTime);
  const plannedReturnTime = parseDate(b.plannedReturnTime);

  // 物品清单：优先 items 数组（多物品），兼容旧版单物品字段
  // 数量非法 / 超过 20 件一律 400，不再静默兜底成 1、静默截断或丢掉第 21 件
  let vItems = validateItems(b.items);
  if (!vItems.ok) return res.status(400).json({ error: vItems.error });
  let items = vItems.items;
  if (!items.length) {
    vItems = validateItems({ itemType: b.itemType, itemName: b.itemName, quantity: b.quantity });
    if (!vItems.ok) return res.status(400).json({ error: vItems.error });
    items = vItems.items;
  }

  if (!borrowerName) return res.status(400).json({ error: '请填写借用人姓名' });
  if (borrowerName.length > 30) return res.status(400).json({ error: '借用人姓名最长 30 字' });
  if (!borrowReason) return res.status(400).json({ error: '请填写借用原因' });
  if (borrowReason.length > 100) return res.status(400).json({ error: '借用原因最长 100 字' });
  if (borrowNote.length > 200) return res.status(400).json({ error: '备注最长 200 字' });
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
    borrowReason,
    borrowNote,
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
  auditLog(req, 'borrow.submit', {
    actor: borrowerName, username: '', role: 'borrower',
    target: record.no, targetId: record.id,
    detail: '提交借用申请：' + items.map(it => `${it.itemType}·${it.itemName}×${it.quantity}`).join('；')
  });
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
    borrowReason: b.borrowReason || '',
    borrowNote: b.borrowNote || '',
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
    borrowerReturn: b.borrowerReturn || null,
    queryToken: b.queryToken || null, // 供借用人凭自己的凭证提交“确认归还”
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
  if (token) b = borrows.find(x => x && x.queryToken === token);
  else b = borrows.find(x => x.no === no && x.borrowerName === name);
  if (!b) return res.status(404).json({ error: '未找到对应记录，请核对借用单号与借用人姓名' });
  res.json({ ok: true, record: trackStatus(b) });
});

/* 借用人确认归还（公开，凭专属查询凭证；非强制）
 * 只记录“借用人已声明归还”（含备注/可选照片），不改变最终状态；
 * 最终“已归还”状态仍由运行人员在后台点「归还确认」后确定。
 */
app.post('/api/track/return', trackReturnLimiter, (req, res) => {
  const p = req.body || {};
  const token = String(p.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少查询凭证' });
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.queryToken === token);
  if (!b) return res.status(404).json({ error: '未找到对应记录' });
  if (b.status === 'returned' || b.status === 'cancelled') {
    return res.status(400).json({ error: '该记录已归档，无需再次确认归还' });
  }
  if (b.status === 'pending') {
    return res.status(400).json({ error: '借用申请尚未被运行人员确认，暂不能确认归还' });
  }
  if (b.borrowerReturn && b.borrowerReturn.confirmed) {
    return res.status(400).json({ error: '您已确认过归还，无需重复操作' });
  }
  const note = String(p.note || '').trim().slice(0, 200);
  let photo = String(p.photo || '').trim() || null;
  if (photo) {
    // 仅允许图片 data URL（jpeg/png/webp），≤ 6MB，防止存入任意文本/脚本
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 6 * 1024 * 1024) {
      return res.status(400).json({ error: '归还照片内容无效，请重新拍照' });
    }
  }
  b.borrowerReturn = { confirmed: true, by: b.borrowerName, at: nowISO(), note, photo };
  b.updatedAt = b.borrowerReturn.at;
  b.history = b.history || [];
  b.history.push({
    action: '借用人声明归还', by: b.borrowerName, at: b.borrowerReturn.at,
    note: note || (photo ? '已附归还照片' : '已声明归还，等待运行人员确认')
  });
  store.saveBorrows(borrows);
  auditLog(req, 'borrow.borrower_return', {
    actor: b.borrowerName, username: '', role: 'borrower',
    target: b.no, targetId: b.id,
    detail: note || (photo ? '借用人声明归还（已附归还照片）' : '借用人声明归还，等待运行人员确认')
  });
  res.json({ ok: true, record: trackStatus(b) });
});

app.get('/api/track/qr', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少查询凭证' });
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.queryToken === token);
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
  let borrows = validRecords(store.loadBorrows()); // 忽略手工改坏的非对象条目，避免整表 500
  if (scope === 'active') borrows = borrows.filter(b => !b.archived && (b.status === 'pending' || b.status === 'confirmed'));
  else if (scope === 'archive') borrows = borrows.filter(b => b.archived || b.status === 'returned' || b.status === 'cancelled');
  borrows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ list: borrows.map(publicBorrow) });
});

app.get('/api/borrows/:id', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.id === req.params.id);
  if (!b) return res.status(404).json({ error: '记录不存在' });
  res.json({ record: publicBorrow(b) });
});

/* 运行人员/管理员：修改借用人提交的信息 */
app.put('/api/borrows/:id', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.id === req.params.id);
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
  setStr('borrowerName', '借用人', 30);
  setStr('borrowReason', '借用原因', 100);
  setStr('borrowNote', '借用人备注', 200);
  setStr('operatorNote', '运行人员备注', 200);
  // 多物品清单修改（与 POST 走同一套严格校验：数量非法/超 20 件 → 400，不静默改值）
  if (Array.isArray(p.items)) {
    const v = validateItems(p.items);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const newItems = v.items;
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
    if (p.itemType !== undefined || p.itemName !== undefined || p.quantity !== undefined) {
      // 旧版单物品字段路径：数量非法同样 400（原先 parseInt 失败会被静默忽略）
      const v = validateItems([{
        itemType: b.itemType,
        itemName: b.itemName,
        quantity: p.quantity !== undefined ? p.quantity : b.quantity
      }]);
      if (!v.ok) return res.status(400).json({ error: v.error });
      if (!v.items.length) return res.status(400).json({ error: '至少保留一件有效物品' });
      const next = v.items[0];
      if (b.quantity !== next.quantity) changes.push('数量');
      b.items = v.items;
      b.itemType = next.itemType;
      b.itemName = next.itemName;
      b.quantity = next.quantity;
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
    auditLog(req, 'borrow.update', { target: b.no, targetId: b.id, detail: '修改内容：' + changes.join('、') });
  }
  res.json({ ok: true, record: publicBorrow(b), changes });
});

/* 运行人员/管理员：确认借用（留下确认借用标志） */
app.post('/api/borrows/:id/confirm', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.id === req.params.id);
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
  auditLog(req, 'borrow.confirm', { target: b.no, targetId: b.id, detail: '确认借用申请，放行物品：' + itemsSummary(b) });
  res.json({ ok: true, record: publicBorrow(b) });
});

/* 运行人员/管理员：归还确认 */
app.post('/api/borrows/:id/return', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.id === req.params.id);
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
  b.history.push({
    action: '归还确认', by: req.session.user.displayName, at: b.returnedAt,
    note: (b.borrowerReturn && b.borrowerReturn.confirmed)
      ? '确认物品已归还（借用人已于 ' + b.borrowerReturn.at + ' 声明归还），记录归档'
      : '确认物品已归还，记录归档'
  });
  store.saveBorrows(borrows);
  auditLog(req, 'borrow.return', {
    target: b.no, targetId: b.id,
    detail: (b.borrowerReturn && b.borrowerReturn.confirmed) ? '归还确认：借用人已声明归还，记录归档' : '归还确认：物品已归还，记录归档'
  });
  res.json({ ok: true, record: publicBorrow(b) });
});

/* 运行人员/管理员：取消/驳回（归档） */
app.post('/api/borrows/:id/cancel', requireStaff, (req, res) => {
  const borrows = store.loadBorrows();
  const b = borrows.find(x => x && x.id === req.params.id);
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
  auditLog(req, 'borrow.cancel', { target: b.no, targetId: b.id, detail: '取消/驳回：' + b.cancelReason });
  res.json({ ok: true, record: publicBorrow(b) });
});

/* 管理员：删除归档记录（硬删除，控制台留痕） */
app.delete('/api/borrows/:id', requireAdmin, (req, res) => {
  const borrows = store.loadBorrows();
  const idx = borrows.findIndex(x => x && x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '记录不存在' });
  const [removed] = borrows.splice(idx, 1);
  store.saveBorrows(borrows);
  console.log(`[audit] ${nowISO()} 管理员 ${req.session.user.displayName} 删除归档记录 ${removed.no}（${removed.borrowerName}）`);
  auditLog(req, 'borrow.delete', {
    target: removed.no, targetId: removed.id,
    detail: `删除归档记录（借用人：${removed.borrowerName}，物品：${itemsSummary(removed)}）`
  });
  res.json({ ok: true, removed: removed.id });
});

/* ================= 统计 ================= */
app.get('/api/stats', requireStaff, (req, res) => {
  const borrows = validRecords(store.loadBorrows()); // 忽略手工改坏的非对象条目
  const active = borrows.filter(b => !b.archived && (b.status === 'pending' || b.status === 'confirmed'));
  const pending = borrows.filter(b => b.status === 'pending' && !b.archived);
  const confirmed = borrows.filter(b => b.status === 'confirmed' && !b.archived);
  const overdue = active.filter(isOverdue);
  const archive = borrows.filter(b => b.archived || b.status === 'returned' || b.status === 'cancelled');
  const health = store.dataHealth();
  let bs = backup.defaultSettings();
  try { bs = backup.loadSettings(); } catch (e) { /* 设置读取失败不影响统计 */ }
  res.json({
    pending: pending.length,
    active: active.length,
    confirmed: confirmed.length,
    overdue: overdue.length,
    archived: archive.length,
    overdueList: overdue.map(publicBorrow),
    total: borrows.length,
    lastBackupAt: bs.lastRunAt || null,
    lastBackupOk: !!(bs.lastResult && bs.lastResult.ok),
    dataHealth: {
      borrowsBytes: health.borrowsBytes,
      borrowsMtime: health.borrowsMtime,
      quarantineCount: health.quarantine.length
    }
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
  let borrows = validRecords(store.loadBorrows()); // 忽略手工改坏的非对象条目：导出必须永远可用
  if (scope === 'active') borrows = borrows.filter(b => !b.archived && (b.status === 'pending' || b.status === 'confirmed'));
  else if (scope === 'archive') borrows = borrows.filter(b => b.archived || b.status === 'returned' || b.status === 'cancelled');
  borrows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  // CSV 生成已抽到 lib/report.js（buildBorrowCsv），列顺序/格式/公式注入防护与改造前完全一致
  const csv = buildBorrowCsv(borrows);
  const scopeName = { all: '全部', active: '借用中', archive: '归档' }[scope] || scope;
  const fileName = `借用记录_${scopeName}_${new Date().toISOString().slice(0, 10)}.csv`;
  auditLog(req, 'data.export', { target: scopeName, detail: `导出借用记录CSV（${scopeName}）共 ${borrows.length} 条` });
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

/* ================= 数据还原（管理员）：从备份 JSON 恢复全部业务数据 =================
 * 支持「数据导出」页备份按钮下载的 JSON 备份文件。
 * 还原前会自动把当前数据备份到 data/restore-backup-<时间戳>/，防止误操作丢失现有数据。
 */
app.post('/api/restore', requireAdmin, (req, res) => {
  const p = req.body || {};
  if (p.app && p.app !== 'key-borrow-register-system') {
    return res.status(400).json({ error: '该文件不是本系统导出的备份文件' });
  }
  if (!Array.isArray(p.users) || !Array.isArray(p.borrows) || !Array.isArray(p.inventory)) {
    return res.status(400).json({ error: '备份文件格式不正确：缺少 users/borrows/inventory 数据' });
  }
  // 数据规模上限保护，防止异常超大文件
  if (p.users.length > 10000 || p.borrows.length > 100000 || p.inventory.length > 50000) {
    return res.status(400).json({ error: '备份数据量超出系统可接受范围' });
  }
  // 用户数据完整性校验
  for (const u of p.users) {
    if (!u || typeof u !== 'object' || !u.id || !u.username || !u.passwordSalt || !u.passwordHash) {
      return res.status(400).json({ error: '备份中的用户数据不完整（缺少 id/用户名/密码字段）' });
    }
    if (!['admin', 'operator'].includes(u.role)) return res.status(400).json({ error: '备份中的用户角色无效' });
    if (!['active', 'disabled'].includes(u.status)) u.status = 'active';
  }
  // 借用记录结构校验：任何一条不合法就整体拒绝，一个字节都不写
  // （status 缺失仍兜底为 pending 以兼容老备份；但给了非法值必须 400，不得静默改写）
  for (const b of p.borrows) {
    if (!b || typeof b !== 'object' || Array.isArray(b) || !b.id) return res.status(400).json({ error: '备份中的借用记录缺少 id' });
    const tag = b.no || b.id;
    if (b.status === undefined || b.status === null || b.status === '') b.status = 'pending';
    else if (!['pending', 'confirmed', 'returned', 'cancelled'].includes(b.status)) {
      return res.status(400).json({ error: `备份中的借用记录 ${tag} 状态无效（${String(b.status).slice(0, 20)}）` });
    }
    // items 必须是数组且每项都是对象：坏 items 落盘后会同时搞崩导出与备份（导出 500 / 备份永久失败）
    if (b.items !== undefined && b.items !== null) {
      if (!Array.isArray(b.items)) return res.status(400).json({ error: `备份中的借用记录 ${tag} 的 items 必须是数组` });
      for (const it of b.items) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) {
          return res.status(400).json({ error: `备份中的借用记录 ${tag} 的物品项格式不正确（不能为 null 或非对象）` });
        }
      }
    }
  }
  // 库存数据基本校验
  for (const it of p.inventory) {
    if (!it || typeof it !== 'object' || !it.id || !it.itemType || !it.itemName) {
      return res.status(400).json({ error: '备份中的库存数据不完整' });
    }
  }

  // 还原前将当前数据备份一份，防止误操作丢失现有数据
  let bakDir = null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    bakDir = path.join(store.DATA_DIR, 'restore-backup-' + ts);
    fs.mkdirSync(bakDir, { recursive: true });
    fs.writeFileSync(path.join(bakDir, 'users.json'), JSON.stringify(store.loadUsers(), null, 2), 'utf8');
    fs.writeFileSync(path.join(bakDir, 'borrows.json'), JSON.stringify(store.loadBorrows(), null, 2), 'utf8');
    fs.writeFileSync(path.join(bakDir, 'inventory.json'), JSON.stringify(store.loadInventory(), null, 2), 'utf8');
  } catch (e) {
    console.error('[restore] 还原前备份当前数据失败:', e.message);
  }

  store.saveUsers(p.users);
  store.saveBorrows(p.borrows);
  store.saveInventory(p.inventory);
  console.log(`[audit] ${nowISO()} 管理员 ${req.session.user.displayName} 完成数据还原：用户 ${p.users.length}、借用记录 ${p.borrows.length}、库存 ${p.inventory.length}${bakDir ? '（还原前备份：' + bakDir + '）' : ''}`);
  auditLog(req, 'data.restore', {
    target: '数据还原',
    detail: `还原全部数据：用户 ${p.users.length}、借用记录 ${p.borrows.length}、库存 ${p.inventory.length}`
  });
  res.json({
    ok: true,
    restored: { users: p.users.length, borrows: p.borrows.length, inventory: p.inventory.length },
    message: '数据还原成功，请重新登录后查看'
  });
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
  auditLog(req, 'inventory.import', {
    target: '库存导入',
    detail: `导入库存共 ${items.length} 项（新增 ${added}、更新 ${updated}）`
  });
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
  const target = `${it.itemType}·${it.itemName}`;
  if (found) {
    const old = found.total;
    found.total = it.total;
    store.saveInventory(inv);
    auditLog(req, 'inventory.update', { target, targetId: found.id, detail: `库存数量 ${old} → ${it.total}` });
    return res.json({ ok: true, updated: true });
  }
  const rec = { id: store.newId('i'), itemType: it.itemType, itemName: it.itemName, total: it.total, createdAt: nowISO() };
  inv.push(rec);
  store.saveInventory(inv);
  auditLog(req, 'inventory.add', { target, targetId: rec.id, detail: `新增物品，库存数量 ${it.total}` });
  res.json({ ok: true, added: true });
});

/* 修改物品库存数量 */
app.put('/api/inventory/:id', requireStaff, (req, res) => {
  const inv = store.loadInventory();
  const it = inv.find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: '物品不存在' });
  const total = parseInt((req.body || {}).total, 10);
  if (!Number.isInteger(total) || total < 1) return res.status(400).json({ error: '数量必须为不小于 1 的整数' });
  const old = it.total;
  it.total = total;
  store.saveInventory(inv);
  auditLog(req, 'inventory.update', { target: `${it.itemType}·${it.itemName}`, targetId: it.id, detail: `库存数量 ${old} → ${total}` });
  res.json({ ok: true });
});

/* 删除库存物品（管理员） */
app.delete('/api/inventory/:id', requireAdmin, (req, res) => {
  const inv = store.loadInventory();
  const i = inv.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: '物品不存在' });
  const removed = inv[i];
  inv.splice(i, 1);
  store.saveInventory(inv);
  auditLog(req, 'inventory.delete', { target: `${removed.itemType}·${removed.itemName}`, targetId: removed.id, detail: `删除物品（原库存数量 ${removed.total}）` });
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
  auditLog(req, 'user.add', {
    target: displayName,
    detail: `新增用户 ${username}（${role === 'admin' ? '管理员' : '运行人员'}）`
  });
  res.json({ ok: true });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const users = store.loadUsers();
  const u = users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const p = req.body || {};
  const changes = [];
  if (p.displayName !== undefined && String(p.displayName).trim() && u.displayName !== String(p.displayName).trim()) {
    u.displayName = String(p.displayName).trim(); changes.push('显示名称');
  }
  if ((p.role === 'admin' || p.role === 'operator') && u.role !== p.role) {
    u.role = p.role; changes.push('角色');
  }
  if (p.status === 'active' || p.status === 'disabled') {
    // 不允许禁用自己
    if (!(p.status === 'disabled' && u.id === req.session.user.id) && u.status !== p.status) {
      u.status = p.status; changes.push('状态');
    }
  }
  store.saveUsers(users);
  auditLog(req, 'user.update', {
    target: u.displayName, targetId: u.id,
    detail: changes.length ? `修改用户 ${u.username}：${changes.join('、')}` : `修改用户 ${u.username}（无字段变化）`
  });
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const users = store.loadUsers();
  const idx = users.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '用户不存在' });
  if (users[idx].id === req.session.user.id) return res.status(400).json({ error: '不能删除当前登录账号' });
  const removed = users[idx];
  users.splice(idx, 1);
  store.saveUsers(users);
  auditLog(req, 'user.delete', { target: removed.displayName, targetId: removed.id, detail: `删除用户 ${removed.username}` });
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
  auditLog(req, 'user.reset_password', { target: u.displayName, targetId: u.id, detail: `重置用户 ${u.username} 的密码` });
  res.json({ ok: true });
});

/* ================= 操作日志（管理员）：查询 / 导出 ================= */
app.get('/api/logs', requireAdmin, (req, res) => {
  const r = audit.query(req.query || {});
  res.json({ ok: true, total: r.total, page: r.page, pageSize: r.pageSize, list: r.list });
});

app.get('/api/logs/export', requireAdmin, (req, res) => {
  const list = audit.queryAll(req.query || {}, 20000);
  const fmtAt = v => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '');
  const rows = [['时间', '成员', '账号', '角色', '操作', '对象', '详情', 'IP', '结果']];
  for (const e of list) {
    rows.push([
      fmtAt(e.at), e.actor || '', e.username || '', e.role || '',
      e.label || e.action || '', e.target || '', e.detail || '', e.ip || '', e.result || ''
    ]);
  }
  const csv = '\uFEFF' + rows.map(r => r.map(csvEsc).join(',')).join('\r\n');
  const fileName = `操作日志_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(csv);
});

/* ================= 自动备份（管理员） ================= */
app.get('/api/backup/settings', requireAdmin, (req, res) => {
  res.json({ settings: backup.loadSettings(), files: backup.listBackups(), scheduler: backup.schedulerStatus() });
});

app.put('/api/backup/settings', requireAdmin, (req, res) => {
  let settings;
  try {
    settings = backup.saveSettings(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const hh = String(settings.hour).padStart(2, '0');
  const mm = String(settings.minute).padStart(2, '0');
  auditLog(req, 'backup.settings_update', {
    target: '自动备份设置',
    detail: `启用=${settings.enabled ? '是' : '否'}，备份时间=${backup.WEEK_LABELS[settings.weekday]} ${hh}:${mm}，保留 ${settings.keep} 份`
  });
  res.json({ ok: true, settings });
});

app.post('/api/backup/run', requireAdmin, (req, res) => {
  const result = backup.runBackup({ trigger: 'manual', by: req.session.user.displayName });
  auditLog(req, 'data.backup_manual', {
    target: result.jsonName || '手动备份',
    detail: result.ok
      ? `手动备份完成：${result.jsonName}、${result.csvName}（借用记录 ${result.counts.borrows} 条）`
      : ('手动备份失败：' + result.error),
    result: result.ok ? 'ok' : 'fail'
  });
  res.json({ ok: result.ok, result });
});

app.get('/api/backup/list', requireAdmin, (req, res) => {
  res.json({ list: backup.listBackups() });
});

app.get('/api/backup/download/:name', requireAdmin, (req, res) => {
  const name = String(req.params.name || '');
  const file = backup.resolveBackupFile(name);
  if (!file) return res.status(404).json({ error: '备份文件不存在' });
  res.setHeader('Content-Type', /\.csv$/i.test(name) ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(fs.readFileSync(file));
});

/* ================= 兜底：API 404 返回 JSON、统一错误处理 ================= */
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // 数据文件损坏（已隔离到 data/quarantine 并尝试从 .bak 恢复）→ 503，绝不 500、绝不让写接口把历史覆盖掉
  if (err && (err instanceof store.DataError || err.code === 'DATA_UNREADABLE')) {
    console.error('[server] 数据文件不可读:', err.file || '', err.message);
    if (res.headersSent) return;
    return res.status(503).json({ error: '数据文件损坏：已隔离到 data/quarantine 并尝试自动恢复，请检查该目录后重启服务；若仍无法自动恢复，请用 data/backups 里的备份（或手工下载的 JSON 备份）人工还原' });
  }
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
/* 启动自检：清理遗留 tmp → 数据文件自检 → 清理超期日志（数据异常只提示不阻断启动） */
console.log('[启动自检] 已取得数据目录单实例锁:', instanceLock.lockFile);
const tmpCleaned = store.cleanupTmp();
const startup = store.selfCheck();
console.log(`[启动自检] 清理遗留临时文件 ${tmpCleaned} 个；数据文件 users=${startup.users} borrows=${startup.borrows} inventory=${startup.inventory}`);
// 自动恢复必须显式可见：不能出现「日志平静打印 borrows=0、实际历史被清空」的情况
for (const r of startup.recoveries) console.warn('[启动自检] 发生自动恢复:', r);
if (!startup.ok) {
  for (const e of startup.errors) console.error('[启动自检] 数据文件异常:', e);
  console.error('[启动自检] 损坏文件已隔离到 data/quarantine；可从 data/backups 或同名 .bak 恢复后重启服务');
}
console.log(`[启动自检] 清理超期操作日志 ${audit.cleanup(180)} 个`);

app.listen(PORT, HOST, () => {
  const lanIP = getLanIP();
  console.log('==========================================================');
  console.log('  钥匙/工具/标识牌 借用登记与归还确认系统 已启动');
  console.log('  本机访问:   http://localhost:' + PORT);
  console.log('  局域网访问: http://' + lanIP + ':' + PORT + '  （手机微信扫码用）');
  console.log('  借用登记二维码页: /borrow');
  console.log('  默认账号: admin / admin123（管理员）；operator1 / 123456（运行人员）');
  console.log('==========================================================');
  // 自动备份调度器：启动立即检查一次（补做错过的计划），之后每分钟检查
  const st = backup.startScheduler({
    onRun: r => {
      audit.log({
        action: 'data.backup_auto',
        target: r.jsonName || '自动备份',
        actor: '系统', username: '', role: 'system',
        detail: r.ok
          ? `自动备份完成：${r.jsonName}、${r.csvName}（借用记录 ${r.counts.borrows} 条）`
          : ('自动备份失败：' + r.error),
        result: r.ok ? 'ok' : 'fail'
      });
      console.log('[自动备份]', r.ok ? `${r.jsonName} / ${r.csvName}` : ('失败：' + r.error));
    }
  });
  console.log('[自动备份] 调度器已启动，下次计划:', st.nextRunAt);
});

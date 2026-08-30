/**
 * 数据持久化层：JSON 文件存储（原子写入）
 * 数据目录：项目根目录 /data
 *  - users.json   用户账号
 *  - borrows.json 借用记录（含归档）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BORROWS_FILE = path.join(DATA_DIR, 'borrows.json');
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  try {
    if (!fs.existsSync(file)) {
      writeJson(file, fallback);
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[store] 读取数据文件失败:', file, e.message);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------------- 密码哈希（scrypt + salt） ---------------- */
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
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
  DATA_DIR
};

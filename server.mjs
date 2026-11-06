/**
 * Trae + WorkBuddy + Qoder 每日签到 —— Node.js/Docker 宿主
 *
 * worker.js 是为 Cloudflare Workers 写的，但全部业务逻辑都基于 Web 标准 API
 * （fetch / WebCrypto / Request / Response），只有三处依赖平台：
 *
 *   1. KV 存储         → 本文件用「磁盘 JSON 文件」实现，挂 Docker volume 持久化
 *   2. export default 入口 → 本文件起一个 HTTP 服务，把请求翻译成 Request 喂进去
 *   3. Cron Triggers   → 本文件内置一个极简 cron 调度器（北京时间）
 *
 * worker.js 一行不改，直接 import。
 *
 * 环境变量：
 *   MASTER_KEY       必填  32 字节随机值的 base64（44 字符，= 结尾），加密所有令牌
 *   ADMIN_TOKEN      必填  控制台登录密码
 *   CRON_SECRET      可选  /cron 独立口令，缺省回落到 ADMIN_TOKEN
 *   CRON_SCHEDULES   可选  cron 表达式（北京时间），多条用 ; 分隔
 *                          只是「出厂默认」：控制台顶栏「定时」保存后会覆盖它（存 KV）
 *                          缺省 "10 8 * * *;20 10 * * *"（08:10 + 补签 10:20）
 *   PORT             可选  监听端口，缺省 3009
 *   DATA_DIR         可选  数据目录，缺省 ./data（Docker 里是 /app/data）
 *
 *   可选通知/风控变量（与 Cloudflare 版一致）：
 *   TG_BOT_TOKEN TG_CHAT_ID QQ_APP_ID QQ_APP_SECRET QQ_OPENID QQ_SANDBOX
 *   QODER_MACHINE_TOKEN QODER_MACHINE_CODE QODER_MACHINE_TYPE
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import worker from './worker.js';

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 3009);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const KV_FILE = path.join(DATA_DIR, 'kv.json');

const log = (...args) => {
  const ts = new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts} +08:00]`, ...args);
};

/* ------------------------------------------------------------------ */
/* KV：磁盘 JSON 文件实现（get/put/delete/list + expirationTtl）          */
/* ------------------------------------------------------------------ */

fs.mkdirSync(DATA_DIR, { recursive: true });

const store = fs.existsSync(KV_FILE) ? JSON.parse(fs.readFileSync(KV_FILE, 'utf8')) : {};

function persist() {
  // 写临时文件再 rename，避免写一半断电把整个库弄坏
  const tmp = KV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, KV_FILE);
}

const fileKV = {
  async get(k) {
    const e = store[k];
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) {
      delete store[k];
      persist();
      return null;
    }
    return e.v;
  },
  async put(k, v, o = {}) {
    if (v === undefined || v === null) return this.delete(k);
    const ttl = Number(o.expirationTtl || 0);
    store[k] = { v: String(v), exp: ttl > 0 ? Date.now() + ttl * 1000 : 0 };
    persist();
  },
  async delete(k) {
    if (k in store) {
      delete store[k];
      persist();
    }
  },
  async list(o = {}) {
    const prefix = o.prefix || '';
    const now = Date.now();
    const keys = Object.keys(store)
      .filter((k) => k.startsWith(prefix))
      .filter((k) => !store[k].exp || store[k].exp > now)
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  },
};

/* ------------------------------------------------------------------ */
/* env：worker.js 期望的绑定形态                                        */
/* ------------------------------------------------------------------ */

const env = {
  KV: fileKV,
  MASTER_KEY: process.env.MASTER_KEY || '',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',
  CRON_SECRET: process.env.CRON_SECRET || '',
  CRON_SCHEDULES: process.env.CRON_SCHEDULES || '',
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',
  QQ_APP_ID: process.env.QQ_APP_ID || '',
  QQ_APP_SECRET: process.env.QQ_APP_SECRET || '',
  QQ_OPENID: process.env.QQ_OPENID || '',
  QQ_SANDBOX: process.env.QQ_SANDBOX || '',
  QODER_MACHINE_TOKEN: process.env.QODER_MACHINE_TOKEN || '',
  QODER_MACHINE_CODE: process.env.QODER_MACHINE_CODE || '',
  QODER_MACHINE_TYPE: process.env.QODER_MACHINE_TYPE || '',
};

/* 启动自检：把配置错误提前暴露，而不是等到第一次请求才发现 */
function preflight() {
  let fail = false;
  if (!env.ADMIN_TOKEN) {
    console.error('✗ 未配置 ADMIN_TOKEN：控制台没法登录，请在环境变量里设置');
    fail = true;
  }
  if (!env.MASTER_KEY) {
    console.error('✗ 未配置 MASTER_KEY：账号令牌没有加密密钥，无法添加账号');
    fail = true;
  } else {
    try {
      const raw = Buffer.from(env.MASTER_KEY.trim(), 'base64');
      if (raw.length !== 32) {
        console.error(`✗ MASTER_KEY 必须是 32 字节（base64 后 44 字符），当前解码为 ${raw.length} 字节`);
        fail = true;
      }
    } catch {
      console.error('✗ MASTER_KEY 不是合法 base64');
      fail = true;
    }
  }
  if (fail) {
    console.error('');
    console.error('  生成主密钥：');
    console.error('    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    console.error('  或：openssl rand -base64 32');
    console.error('');
  }
  return !fail;
}

/* ------------------------------------------------------------------ */
/* HTTP 服务：Node req/res ↔ undici Request/Response                    */
/* ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection']);

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    const url = new URL(req.url, `http://${host}`);
    const method = (req.method || 'GET').toUpperCase();

    // 容器健康检查，不进 worker，也不用登录
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
      return;
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      const name = k.toLowerCase();
      if (HOP_BY_HOP.has(name) || name === 'content-length' || name === 'host') continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }

    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length) body = new Uint8Array(buf);
    }

    const request = new Request(url, { method, headers, body, duplex: body ? 'half' : undefined });
    const resp = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });

    const outHeaders = {};
    resp.headers.forEach((v, k) => {
      // Node 不允许手动写这些
      if (k === 'set-cookie') { res.setHeader('set-cookie', resp.headers.getSetCookie?.() ?? v); return; }
      if (!['transfer-encoding', 'connection', 'keep-alive'].includes(k)) outHeaders[k] = v;
    });

    const buf = Buffer.from(await resp.arrayBuffer());
    if (!outHeaders['content-type'] && !outHeaders['Content-Type']) {
      outHeaders['content-type'] = 'text/plain; charset=utf-8';
    }
    res.writeHead(resp.status, outHeaders);
    res.end(method === 'HEAD' ? undefined : buf);
  } catch (e) {
    log('请求处理异常：', e.message || e);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
});

/* ------------------------------------------------------------------ */
/* Cron：极简 5 字段调度器（北京时间）                                    */
/* ------------------------------------------------------------------ */

/* 支持的字段语法：星号、数字、a-b、a-b 加斜杠 n、逗号列表。够用即可。 */
function parseField(spec, min, max) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = Number(stepRaw || 1);
    let a;
    let b;
    if (rangeRaw === '*' || rangeRaw === '') {
      a = min;
      b = max;
    } else if (rangeRaw.includes('-')) {
      [a, b] = rangeRaw.split('-').map(Number);
    } else {
      a = b = Number(rangeRaw);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(step) || step < 1) continue;
    for (let i = a; i <= b; i += step) if (i >= min && i <= max) set.add(i);
  }
  return set;
}

/** d 是「北京时间」：用 UTC+8 后的 Date 的 getUTC* 读数 */
function cronMatches(expr, d) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return false;
  const mins = parseField(f[0], 0, 59);
  const hours = parseField(f[1], 0, 23);
  const doms = parseField(f[2], 1, 31);
  const mons = parseField(f[3], 1, 12);
  const dows = parseField(f[4], 0, 7);
  if (!mins.has(d.getUTCMinutes()) || !hours.has(d.getUTCHours()) || !mons.has(d.getUTCMonth() + 1)) {
    return false;
  }
  const domOk = doms.has(d.getUTCDate());
  const dowVal = d.getUTCDay(); // 0=周日
  const dowOk = dows.has(dowVal) || (dowVal === 0 && dows.has(7));
  // 标准 cron 语义：dom 和 dow 都受限时取并集，否则取交集
  const domRestricted = f[2] !== '*';
  const dowRestricted = f[4] !== '*';
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/* 时间表优先级：控制台保存的 KV 配置 > 环境变量 CRON_SCHEDULES > 内置默认值。
   每次都现读，控制台改完不用重启容器（本函数每 20 秒被调用一次）。 */
const CRON_KEY = 'cron:config';
const DEFAULT_CRON = '10 8 * * *;20 10 * * *';

function normHHMM(v) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

const hhmmToCron = (t) => {
  const [h, mi] = String(t).split(':');
  return `${Number(mi)} ${Number(h)} * * *`;
};

/** 从内存里的 KV 同步读控制台存的时间表 */
function kvTimes() {
  const e = store[CRON_KEY];
  if (!e || (e.exp && e.exp <= Date.now())) return null;
  try {
    const j = JSON.parse(String(e.v || ''));
    const ts = (Array.isArray(j?.times) ? j.times : []).map(normHHMM).filter(Boolean);
    return ts.length ? ts : null;
  } catch {
    return null;
  }
}

/** 当前生效的 cron 表达式列表 */
function effectiveSchedules() {
  const fromKv = kvTimes();
  if (fromKv) return fromKv.map(hhmmToCron);
  return String(process.env.CRON_SCHEDULES || DEFAULT_CRON)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const scheduleLabel = (expr) => {
  const f = String(expr).trim().split(/\s+/);
  return f.length === 5 ? `${String(f[1]).padStart(2, '0')}:${String(f[0]).padStart(2, '0')}` : expr;
};

let lastFiredMinute = '';
let lastScheduleSig = '';

async function runCronOnce(trigger) {
  const sink = { promises: [], waitUntil(p) { this.promises.push(p); } };
  const started = Date.now();
  log(`定时签到开始（${trigger}）`);
  try {
    // 必须走 /cron 端点（runAll：签到 + 通知）。
    // 之前直接调 worker.scheduled 只做签到，notifyRun 永远不会执行，
    // 导致定时签到成功但 QQ/Telegram 不推送。
    const secret = env.CRON_SECRET || env.ADMIN_TOKEN;
    const req = new Request(`http://127.0.0.1:${PORT}/cron`, {
      method: 'GET',
      headers: { 'X-Cron-Secret': secret },
    });
    const resp = await worker.fetch(req, env, sink);
    const body = await resp.json().catch(() => null);
    log('签到结果：', JSON.stringify(body));
  } catch (e) {
    log('定时任务异常：', e.message || e);
  }
  await Promise.allSettled(sink.promises);
  log(`定时签到结束，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** 每 20 秒看一眼：当前北京时间的分钟是否命中任一条 cron */
function startScheduler() {
  setInterval(() => {
    const list = effectiveSchedules();
    const sig = list.join(';');
    if (sig !== lastScheduleSig) {
      lastScheduleSig = sig;
      log(`定时任务时间表（北京时间）：${list.map(scheduleLabel).join(' / ')}${kvTimes() ? '（来自控制台）' : ''}`);
    }
    const bj = new Date(Date.now() + 8 * 3600e3);
    const minuteKey = bj.toISOString().slice(0, 16); // 精确到分钟
    if (minuteKey === lastFiredMinute) return;
    const hit = list.find((s) => cronMatches(s, bj));
    if (hit) {
      lastFiredMinute = minuteKey;
      runCronOnce(scheduleLabel(hit));
    }
  }, 20000);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

if (!preflight()) {
  process.exit(1);
}

server.listen(PORT, () => {
  log(`签到服务已启动：http://0.0.0.0:${PORT}`);
  log(`数据目录：${DATA_DIR}`);
  log(`定时任务（北京时间）：${effectiveSchedules().map(scheduleLabel).join(' / ')}（控制台可改，无需重启）`);
  if (!env.CRON_SECRET) log('提示：未单独配置 CRON_SECRET，/cron 将回落使用 ADMIN_TOKEN');

  // 真正启动定时调度器（漏掉这行会导致定时任务永不触发）
  startScheduler();
  log('定时调度器已启动，每 20 秒检查一次是否命中时间表');
});

/* 优雅退出：把 KV 落一次盘 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`收到 ${sig}，正在退出…`);
    try { persist(); } catch { /* 退出时尽力而为 */ }
    process.exit(0);
  });
}

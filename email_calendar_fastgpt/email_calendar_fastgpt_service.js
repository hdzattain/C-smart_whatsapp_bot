/**
 * FastGPT 定时任务服务
 * 可独立运行的服务，支持定时调用 FastGPT
 */

require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const Lark = require('@larksuiteoapi/node-sdk');
const FastGPTClient = require('../email_calendar_fastgpt/fastgpt_client');

// ========== 配置 ==========
const FASTGPT_URL = process.env.FASTGPT_URL || '';
const FASTGPT_API_KEY = process.env.FASTGPT_API_KEY || '';
// 邮件摘要流水线可使用独立的 FastGPT key/url（不影响定时自动总结/强制添加日程）
const FASTGPT_MAIL_URL = process.env.FASTGPT_MAIL_URL || '';
const FASTGPT_MAIL_API_KEY = process.env.FASTGPT_MAIL_API_KEY || '';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';
const API_BASE_URL = process.env.API_BASE_URL || '';
// credentials 接口可能部署在不同网关/路径下：允许单独配置
const CREDENTIALS_API_BASE_URL = process.env.CREDENTIALS_API_BASE_URL || API_BASE_URL;

// ========== 邮件落盘/预处理配置 ==========
// 目录结构：
//   <EMAIL_DATA_DIR>/<email>/<YYYY-MM-DD>/{json,txt_result,final_result}/
// 默认放到项目根目录下的 ./emails/data
const EMAIL_DATA_DIR = process.env.EMAIL_DATA_DIR
  ? path.resolve(process.env.EMAIL_DATA_DIR)
  : path.resolve(__dirname, '..', 'emails', 'data');
const EMAIL_PULL_CRON = process.env.EMAIL_PULL_CRON || '*/5 * * * *';
const EMAIL_PROCESS_CRON = process.env.EMAIL_PROCESS_CRON || '*/5 * * * *';
const EMAIL_BUILD_CRON = process.env.EMAIL_BUILD_CRON || '*/5 * * * *';
const EMAIL_SUMMARY_SEND_CRON = process.env.EMAIL_SUMMARY_SEND_CRON || '*/15 * * * *'; // 每天12点和18点
const EMAIL_PULL_RECEIVE_NUMBER = Number.parseInt(process.env.EMAIL_PULL_RECEIVE_NUMBER || '50', 10);
const EMAIL_PULL_UNREAD_ONLY = (process.env.EMAIL_PULL_UNREAD_ONLY || 'true').toLowerCase() !== 'false';
const EMAIL_PULL_TODAY_ONLY = (process.env.EMAIL_PULL_TODAY_ONLY || 'true').toLowerCase() !== 'false';
const EMAIL_MAILBOX = process.env.EMAIL_MAILBOX || 'inbox';
const EMAIL_FINAL_MAX_BYTES = Number.parseInt(process.env.EMAIL_FINAL_MAX_BYTES || String(140 * 1024), 10); // 140KB
const EMAIL_PULL_USER_DELAY_MS = Number.parseInt(process.env.EMAIL_PULL_USER_DELAY_MS || '800', 10);

// txt_result 生成并发（参考 fastgpt_client.py 的 MAX_WORKERS 思路）
const EMAIL_FASTGPT_MAX_WORKERS = (() => {
  const v = Number.parseInt(process.env.EMAIL_FASTGPT_MAX_WORKERS || '6', 10);
  // 兜底范围：1~50
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > 50) return 50;
  return v;
})();

// 用于解密 email_accounts.encrypted_password（Python 端用 cryptography.Fernet）
const EMAIL_ENCRYPTION_KEY = process.env.EMAIL_ENCRYPTION_KEY || '';
// 可选：内部接口 token（Python 端：EMAIL_ACCOUNTS_CREDENTIALS_TOKEN）
const EMAIL_ACCOUNTS_CREDENTIALS_TOKEN = process.env.EMAIL_ACCOUNTS_CREDENTIALS_TOKEN || '';
// 可选：明文密码接口 token（Python 端：EMAIL_ACCOUNTS_PLAINTEXT_TOKEN）
const EMAIL_ACCOUNTS_PLAINTEXT_TOKEN = process.env.EMAIL_ACCOUNTS_PLAINTEXT_TOKEN || '';
const EMAIL_USE_PLAINTEXT_PASSWORD = (process.env.EMAIL_USE_PLAINTEXT_PASSWORD || 'false').toLowerCase() === 'true';
// IMAP 连接参数（Node 端直连 IMAP，不再依赖 /mail/receive 接口）
const IMAP_SERVER = process.env.IMAP_SERVER || process.env.DEFAULT_IMAP_SERVER || 'owahk.cohl.com';
const IMAP_PORT = Number.parseInt(process.env.IMAP_PORT || process.env.DEFAULT_IMAP_PORT || '993', 10);
const IMAP_SECURE = (process.env.IMAP_SECURE || 'true').toLowerCase() !== 'false';

let emailPullRunning = false;
let emailProcessRunning = false;
let emailBuildRunning = false;
let emailSummarySendRunning = false;

function _safeStr(x) {
  return (x === null || x === undefined) ? '' : String(x);
}

function _ensureDirSync(dirPath) {
  if (!dirPath) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function _emailDirName(emailAccount) {
  return _safeStr(emailAccount).replace(/[\/\\]/g, '_');
}

function _sanitizeFilenameComponent(name, maxLen = 80) {
  let s = _safeStr(name).replace(/[\r\n\t]/g, ' ');
  // Windows / macOS 常见非法字符
  s = s.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = 'no_subject';
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function _hkDateStr(dateObj = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TASK_TIMEZONE || 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(dateObj); // YYYY-MM-DD
}

function _hkMidnightDate(dateObj = new Date()) {
  // 返回 “香港当天 00:00:00” 对应的 Date（用于 IMAP SEARCH SINCE）
  // 通过格式化 YYYY-MM-DD 再拼回 Date，避免手写时区换算
  const dateStr = _hkDateStr(dateObj); // YYYY-MM-DD
  const [y, m, d] = dateStr.split('-').map(x => Number.parseInt(x, 10));
  // 这里构造的是本地时区 Date，但后续只是用于 IMAP 的 “日期” 搜索（无时分秒），已足够
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
}

function _hkTimeHHmm0(dateObj = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TASK_TIMEZONE || 'Asia/Hong_Kong',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(dateObj);
  const hh = parts.find(p => p.type === 'hour')?.value || '00';
  const mm = parts.find(p => p.type === 'minute')?.value || '00';
  // 兼容你现有样例：08300（HH + mm + '0'）
  return `${hh}${mm}0`;
}

function _parseMailDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function _byteLenUtf8(s) {
  return Buffer.byteLength(_safeStr(s), 'utf8');
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function _asyncPool(limit, items, iteratorFn) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const concurrency = Math.max(1, Number.isFinite(limit) ? limit : 1);
  const ret = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        ret[i] = await iteratorFn(items[i], i);
      } catch (e) {
        ret[i] = { __error: e };
      }
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return ret;
}

function _b64urlToBuf(s) {
  const raw = _safeStr(s).replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (raw.length % 4)) % 4;
  const padded = raw + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

function _normalizeFernetKeyTo32Bytes(keyStr) {
  if (!keyStr) throw new Error('缺少配置：EMAIL_ENCRYPTION_KEY（用于解密 encrypted_password）');
  // Python 端支持两种：本身是 base64url key；或是 raw string（会先 base64url encode）
  // 这里按 Fernet 规范：最终必须是 32 bytes key material（base64url decode 后长度为 32）
  try {
    const buf = _b64urlToBuf(keyStr);
    if (buf.length === 32) return buf;
  } catch (_) {}
  // 退一步：把字符串当作 raw bytes，再 base64url encode 再 decode（等价于 Python 的兜底）
  const rawBytes = Buffer.from(String(keyStr), 'utf8');
  const b64 = rawBytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const buf2 = _b64urlToBuf(b64);
  if (buf2.length !== 32) {
    throw new Error('EMAIL_ENCRYPTION_KEY 格式不正确（Fernet key 解码后必须是 32 bytes）');
  }
  return buf2;
}

function _fernetDecrypt(token, keyStr) {
  const key = _normalizeFernetKeyTo32Bytes(keyStr);
  const signingKey = key.subarray(0, 16);
  const encryptionKey = key.subarray(16, 32);

  const data = _b64urlToBuf(token);
  if (data.length < 1 + 8 + 16 + 32) throw new Error('Fernet token 太短');
  const version = data[0];
  if (version !== 0x80) throw new Error('Fernet token 版本不支持');

  // 结构：0x80 | ts(8) | iv(16) | ciphertext(...) | hmac(32)
  const hmacStart = data.length - 32;
  const signed = data.subarray(0, hmacStart);
  const mac = data.subarray(hmacStart);

  const mac2 = crypto.createHmac('sha256', signingKey).update(signed).digest();
  if (mac.length !== mac2.length || !crypto.timingSafeEqual(mac, mac2)) {
    throw new Error('Fernet HMAC 校验失败（密钥不匹配或数据损坏）');
  }

  const iv = data.subarray(1 + 8, 1 + 8 + 16);
  const ciphertext = data.subarray(1 + 8 + 16, hmacStart);
  const decipher = crypto.createDecipheriv('aes-128-cbc', encryptionKey, iv);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

function _makeContentLineFromText(partText) {
  const contentString = JSON.stringify({ text: partText }, null, 0);
  // 输出只保留 `"content": "..."`，不包含外层 `{ }`
  return `"content": ${JSON.stringify(contentString)}`;
}

// 简单的飞书文本告警（例如 IMAP 登录失败时通知管理员）
async function _sendFeishuAlertToAdmin(text) {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    console.warn('[飞书告警] 未配置 FEISHU_APP_ID/FEISHU_APP_SECRET，跳过发送');
    return;
  }
  const emailsEnv =
    process.env.EMAIL_ALERT_FEISHU_EMAIL ||
    process.env.EMAIL_SUMMARY_FEISHU_EMAIL ||
    'yilin.wu02@cohl.com';
  const targetEmails = emailsEnv
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (targetEmails.length === 0) {
    console.warn('[飞书告警] 未找到任何有效告警邮箱，跳过发送');
    return;
  }

  const client = new Lark.Client({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    disableTokenCache: false
  });

  const content = JSON.stringify({ text });
  for (const targetEmail of targetEmails) {
    try {
      await client.im.v1.message.create({
        params: { receive_id_type: 'email' },
        data: {
          receive_id: targetEmail,
          msg_type: 'text',
          content
        }
      });
      console.log('[飞书告警] 已发送:', targetEmail, text);
    } catch (e) {
      console.error('[飞书告警] 发送失败:', targetEmail, e && e.message ? e.message : e);
    }
  }
}

// 发送每日摘要到飞书：每个 part 一条消息，按 part_1, part_2... 顺序
async function _sendFeishuSummaryParts(emailAccount, dateStr, parts) {
  if (!Array.isArray(parts) || parts.length === 0) return;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    console.warn('[飞书] 未配置 FEISHU_APP_ID/FEISHU_APP_SECRET，跳过发送每日摘要');
    return;
  }
  // const targetEmail = emailAccount;
  const targetEmail = process.env.EMAIL_SUMMARY_FEISHU_EMAIL || 'yilin.wu02@cohl.com';

  // 为发送摘要单独创建一个客户端（自动管理 token）
  const client = new Lark.Client({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    disableTokenCache: false
  });

  let idx = 1;
  for (const text of parts) {
    if (!text || typeof text !== 'string') {
      idx += 1;
      continue;
    }
    const content = JSON.stringify({ text });
    try {
      await client.im.v1.message.create({
        params: {
          receive_id_type: 'email'
        },
        data: {
          receive_id: targetEmail,
          msg_type: 'text',
          content
        }
      });
      console.log(`[飞书] 已发送每日摘要 part_${idx} 给 ${targetEmail}（用户: ${emailAccount}, 日期: ${dateStr}）`);
    } catch (e) {
      console.error('[飞书] 发送每日摘要失败:', emailAccount, dateStr, `part_${idx}`, e && e.message ? e.message : e);
    }
    idx += 1;
  }
}

// 从 final_result/part_*.txt 文件读取并发送每日摘要
async function _sendFeishuSummaryFromFiles(emailAccount, dateStr) {
  const { finalDir } = _getUserDateDirs(emailAccount, dateStr);
  if (!fs.existsSync(finalDir)) {
    console.log(`[飞书发送] 目录不存在，跳过: ${finalDir}`);
    return;
  }

  // 读取所有 part_*.txt 文件，按数字排序
  const partFiles = [];
  try {
    for (const fn of fs.readdirSync(finalDir)) {
      const m = fn.match(/^part_(\d+)\.txt$/i);
      if (m) {
        const num = Number.parseInt(m[1], 10);
        partFiles.push({ num, path: path.join(finalDir, fn) });
      }
    }
  } catch (e) {
    console.error('[飞书发送] 读取 finalDir 失败:', finalDir, e && e.message ? e.message : e);
    return;
  }

  if (partFiles.length === 0) {
    console.log(`[飞书发送] 未找到 part_*.txt 文件: ${finalDir}`);
    return;
  }

  partFiles.sort((a, b) => a.num - b.num);

  // 解析每个文件，提取文本内容
  const parts = [];
  for (const { num, path: filePath } of partFiles) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      // part_*.txt 格式: "content": "{\"text\":\"...\"}"
      // 需要解析出实际的文本内容
      if (raw.startsWith('"content":')) {
        const jsonStr = raw.replace(/^"content":\s*/, '').trim();
        const contentObj = JSON.parse(jsonStr);
        if (contentObj && typeof contentObj.text === 'string') {
          parts.push(contentObj.text);
        } else {
          console.warn(`[飞书发送] part_${num}.txt 格式异常，跳过: ${filePath}`);
        }
      } else {
        // 兜底：直接当作纯文本
        parts.push(raw);
      }
    } catch (e) {
      console.error(`[飞书发送] 读取/解析 part_${num}.txt 失败:`, filePath, e && e.message ? e.message : e);
    }
  }

  if (parts.length === 0) {
    console.log(`[飞书发送] 未解析到有效内容: ${finalDir}`);
    return;
  }

  // 调用发送函数
  await _sendFeishuSummaryParts(emailAccount, dateStr, parts);
}

function _extractPluginOutputFromFastGPTContent(rawText) {
  // 兼容：rawText 可能是 JSON（含 responseData/pluginOutput），也可能是纯文本
  try {
    const data = JSON.parse(rawText);
    const resp = data && data.responseData;
    if (Array.isArray(resp)) {
      for (let i = resp.length - 1; i >= 0; i--) {
        const item = resp[i];
        if (item && item.pluginOutput && typeof item.pluginOutput.output === 'string') {
          return item.pluginOutput.output;
        }
      }
    }
  } catch (_) {
    // ignore
  }
  return rawText;
}

function _getUserDateDirs(emailAccount, dateStr) {
  const userDir = path.join(EMAIL_DATA_DIR, _emailDirName(emailAccount), dateStr);
  return {
    userDir,
    jsonDir: path.join(userDir, 'json'),
    txtDir: path.join(userDir, 'txt_result'),
    finalDir: path.join(userDir, 'final_result')
  };
}

async function _fetchEmailsFromMailApi(emailAccount) {
  if (!API_BASE_URL) throw new Error('缺少配置：API_BASE_URL');
  throw new Error('_fetchEmailsFromMailApi 已废弃：请使用 _fetchEmailsFromMailApiWithPassword');
}

async function _fetchEmailsFromMailApiWithPassword(emailAccount, emailPassword) {
  // 已不再使用：需求改为 Node 直连 IMAP（不靠 /mail/receive 接口）
  throw new Error('_fetchEmailsFromMailApiWithPassword 已废弃：请使用 _fetchEmailsViaImap');
}

async function loadUsersWithCredentialsFromAPI() {
  if (!CREDENTIALS_API_BASE_URL) throw new Error('缺少配置：CREDENTIALS_API_BASE_URL 或 API_BASE_URL');
  const url = EMAIL_USE_PLAINTEXT_PASSWORD
    ? `${CREDENTIALS_API_BASE_URL}/email_accounts/plain_credentials`
    : `${CREDENTIALS_API_BASE_URL}/email_accounts/credentials`;
  const headers = {};
  if (EMAIL_USE_PLAINTEXT_PASSWORD) {
    if (EMAIL_ACCOUNTS_PLAINTEXT_TOKEN) headers['Authorization'] = `Bearer ${EMAIL_ACCOUNTS_PLAINTEXT_TOKEN}`;
  } else {
    if (EMAIL_ACCOUNTS_CREDENTIALS_TOKEN) headers['Authorization'] = `Bearer ${EMAIL_ACCOUNTS_CREDENTIALS_TOKEN}`;
  }
  let resp;
  try {
    resp = await axios.post(url, {}, { timeout: 30000, headers });
  } catch (e) {
    const status = e?.response?.status;
    if (status === 404) {
      throw new Error(
        `credentials 接口 404：${url}。说明网关未转发或后端未部署新增接口 /email_accounts/credentials。` +
        `请把 C-smart-epermit 的 crud_sql_apiserver.py 更新并重启，或在 .env 设置正确的 CREDENTIALS_API_BASE_URL 指向该服务。`
      );
    }
    throw e;
  }
  const data = resp.data || {};
  const rows = Array.isArray(data.results) ? data.results : [];

  const out = [];
  for (const r of rows) {
    const acc = _safeStr(r?.email_account).trim();
    if (!acc) continue;
    // 明文模式：直接使用 password
    if (EMAIL_USE_PLAINTEXT_PASSWORD) {
      const pwd = _safeStr(r?.password).trim();
      if (!pwd) {
        console.error('[配置][plaintext] 缺少 password 或解密失败:', acc, _safeStr(r?.decrypt_error));
        continue;
      }
      out.push({ email_account: acc, email_password: pwd });
      continue;
    }
    // 默认模式：使用 encrypted_password + EMAIL_ENCRYPTION_KEY 解密
    const enc = _safeStr(r?.encrypted_password).trim();
    if (!enc) continue;
    try {
      const pwd = _fernetDecrypt(enc, EMAIL_ENCRYPTION_KEY);
      out.push({ email_account: acc, email_password: pwd });
    } catch (e) {
      console.error('[配置][credentials] 解密失败:', acc, e && e.message ? e.message : e);
    }
  }
  console.log(`[配置] 从 credentials API 加载了 ${out.length} 个可用账号（解密成功）`);
  return out;
}

async function _fetchEmailsViaImap(emailAccount, emailPassword) {
  if (!emailAccount) throw new Error('缺少参数：emailAccount');
  if (!emailPassword) throw new Error('缺少参数：emailPassword');
  if (!IMAP_SERVER) throw new Error('缺少配置：IMAP_SERVER');
  if (!IMAP_PORT) throw new Error('缺少配置：IMAP_PORT');

  let ImapFlow, simpleParser;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch (e) {
    throw new Error('缺少依赖：请安装 imapflow 与 mailparser（在启动目录执行 npm i imapflow mailparser）');
  }

  const client = new ImapFlow({
    host: IMAP_SERVER,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: {
      user: emailAccount,
      pass: emailPassword
    }
  });

  const receiveNumber = Number.isFinite(EMAIL_PULL_RECEIVE_NUMBER) ? EMAIL_PULL_RECEIVE_NUMBER : 50;
  const mailbox = EMAIL_MAILBOX || 'inbox';

  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try {
    // Exchange + imapflow：优先使用 object 查询（更稳定），必要时 fallback 到数组语法
    const hk0 = EMAIL_PULL_TODAY_ONLY ? _hkMidnightDate(new Date()) : null;
    const queryObj = {};
    if (EMAIL_PULL_UNREAD_ONLY) {
      // 未读：seen=false
      queryObj.seen = false;
    } else {
      // 全部：imapflow 里可以用 all=true
      queryObj.all = true;
    }
    if (hk0) queryObj.since = hk0;

    let uids;
    try {
      uids = await client.search(queryObj);
    } catch (e) {
      // fallback：部分版本可能更偏好数组语法
      const searchArr = [];
      searchArr.push(EMAIL_PULL_UNREAD_ONLY ? 'UNSEEN' : 'ALL');
      if (hk0) searchArr.push(['SINCE', hk0]);
      uids = await client.search(searchArr);
    }
    if (!Array.isArray(uids) || uids.length === 0) return [];
    uids.sort((a, b) => a - b);
    const picked = uids.slice(-receiveNumber);

    const out = [];
    for await (const msg of client.fetch(picked, { uid: true, envelope: true, internalDate: true, source: true })) {
      let parsed;
      try {
        parsed = await simpleParser(msg.source);
      } catch (_) {
        parsed = null;
      }

      const subject = _safeStr(parsed?.subject || msg?.envelope?.subject || '');
      const from = _safeStr(parsed?.from?.text || '');
      const dt = parsed?.date instanceof Date ? parsed.date : (msg?.internalDate instanceof Date ? msg.internalDate : new Date());
      const dateIso = dt.toISOString();
      const body = _safeStr(parsed?.text || parsed?.html || '');

      // today_only 二次过滤（香港日期）
      if (EMAIL_PULL_TODAY_ONLY) {
        const d1 = _hkDateStr(dt);
        const d0 = _hkDateStr(new Date());
        if (d1 !== d0) continue;
      }

      out.push({
        id: String(msg.uid),
        subject,
        from,
        date: dateIso,
        body
      });
    }

    // 返回按 UID 倒序（新→旧），更贴近“最新 50 封”
    out.sort((a, b) => (Number.parseInt(b.id, 10) || 0) - (Number.parseInt(a.id, 10) || 0));
    return out;
  } finally {
    try { lock.release(); } catch (_) {}
    try { await client.logout(); } catch (_) {}
  }
}

async function pullEmailsToDiskForUser(emailAccount, emailPassword) {
  const mails = await _fetchEmailsViaImap(emailAccount, emailPassword);
  if (!mails || mails.length === 0) return { saved: 0, skipped: 0 };

  let saved = 0;
  let skipped = 0;

  // 先按（香港）日期分桶
  const byDate = new Map(); // dateStr -> mails[]
  for (const m of mails) {
    const dt = _parseMailDate(m?.date) || new Date();
    const dateStr = _hkDateStr(dt);
    if (!byDate.has(dateStr)) byDate.set(dateStr, []);
    byDate.get(dateStr).push(m);
  }

  for (const [dateStr, mailList] of byDate.entries()) {
    const { jsonDir } = _getUserDateDirs(emailAccount, dateStr);
    _ensureDirSync(jsonDir);

    const existing = new Set();
    try {
      for (const fn of fs.readdirSync(jsonDir)) {
        const m = fn.match(/^(\d+)_/);
        if (m) existing.add(m[1]);
      }
    } catch (_) {}

    for (const mail of mailList) {
      const id = _safeStr(mail?.id).trim();
      if (!id) continue;
      if (existing.has(id)) {
        skipped += 1;
        continue;
      }

      const dt = _parseMailDate(mail?.date) || new Date();
      const subjectPart = _sanitizeFilenameComponent(mail?.subject || 'no_subject', 80);
      const timePart = _hkTimeHHmm0(dt);
      const baseName = `${id}_${subjectPart} --- ${dateStr} ${timePart}`;
      const filePath = path.join(jsonDir, `${baseName}.json`);

      const payload = {
        id,
        subject: mail?.subject || '',
        from: mail?.from || '',
        date: mail?.date || '',
        body: mail?.body || ''
      };

      try {
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
        existing.add(id);
        saved += 1;
      } catch (e) {
        // 已存在/并发写入等，视为跳过
        skipped += 1;
      }
    }
  }

  return { saved, skipped };
}

async function generateTxtResultsForUserDate(emailAccount, dateStr) {
  const { jsonDir, txtDir } = _getUserDateDirs(emailAccount, dateStr);
  _ensureDirSync(txtDir);
  if (!fs.existsSync(jsonDir)) return { generated: 0, skipped: 0 };

  // txt_result 已处理 id 集合
  const doneIds = new Set();
  try {
    for (const fn of fs.readdirSync(txtDir)) {
      const m = fn.match(/^(\d+)_/);
      if (m) doneIds.add(m[1]);
    }
  } catch (_) {}

  // json 文件按 id 去重：同一 id 取最新的一个
  const chosen = new Map(); // id -> {filePath, mtimeMs, baseName}
  for (const fn of fs.readdirSync(jsonDir)) {
    if (!fn.toLowerCase().endsWith('.json')) continue;
    const m = fn.match(/^(\d+)_/);
    if (!m) continue;
    const id = m[1];
    const fp = path.join(jsonDir, fn);
    let stat;
    try {
      stat = fs.statSync(fp);
    } catch (_) {
      continue;
    }
    const prev = chosen.get(id);
    if (!prev || stat.mtimeMs > prev.mtimeMs) {
      chosen.set(id, { filePath: fp, mtimeMs: stat.mtimeMs, baseName: fn.replace(/\.json$/i, '') });
    }
  }

  let generated = 0;
  let skipped = 0;

  const tasks = [];
  for (const [id, meta] of chosen.entries()) {
    if (doneIds.has(id)) {
      skipped += 1;
      continue;
    }
    tasks.push({ id, meta });
  }

  if (tasks.length === 0) return { generated, skipped };

  console.log(`[txt_result] 并发生成：user=${emailAccount}, date=${dateStr}, tasks=${tasks.length}, workers=${EMAIL_FASTGPT_MAX_WORKERS}`);

  const results = await _asyncPool(EMAIL_FASTGPT_MAX_WORKERS, tasks, async (t) => {
    const { id, meta } = t;

    let mailObj;
    try {
      const raw = fs.readFileSync(meta.filePath, 'utf8');
      mailObj = JSON.parse(raw);
    } catch (e) {
      console.error('[txt_result] 读取/解析 JSON 失败:', meta.filePath, e && e.message ? e.message : e);
      return { id, ok: false, reason: 'json_parse' };
    }

    const randomChatId = generateRandomChatId();
    const client = createMailClient(randomChatId);
    const mailJsonText = JSON.stringify({
      id: _safeStr(mailObj?.id || id),
      subject: _safeStr(mailObj?.subject),
      from: _safeStr(mailObj?.from),
      date: _safeStr(mailObj?.date),
      body: _safeStr(mailObj?.body)
    });

    try {
      const content = await client.sendToFastGPT({
        // 这里的 query 仅作为触发文本；真正输入放在 variables.input（对齐 fastgpt_client.py 的变量结构）
        query: process.env.FASTGPT_MAIL_QUERY || '单封邮件摘要',
        user: emailAccount,
        variables: {
          uid: process.env.FASTGPT_VAR_UID || 'asdfadsfasfd2323',
          name: process.env.FASTGPT_VAR_NAME || 'elias',
          input: mailJsonText
        }
      });
      const outPath = path.join(txtDir, `${meta.baseName}.txt`);
      fs.writeFileSync(outPath, content, { encoding: 'utf8' });
      return { id, ok: true };
    } catch (e) {
      console.error('[txt_result] FastGPT 调用失败:', emailAccount, id, e && e.message ? e.message : e);
      return { id, ok: false, reason: 'fastgpt_call' };
    }
  });

  for (const r of results) {
    if (r && r.ok) {
      doneIds.add(String(r.id));
      generated += 1;
    }
  }

  return { generated, skipped };
}

async function buildFinalPartsForUserDate(emailAccount, dateStr) {
  const { txtDir, finalDir } = _getUserDateDirs(emailAccount, dateStr);
  _ensureDirSync(finalDir);
  if (!fs.existsSync(txtDir)) return { parts: 0, mails: 0 };

  // 读取所有 txt_result，按 id 倒序
  const pairs = []; // {idInt, outputText}
  for (const fn of fs.readdirSync(txtDir)) {
    if (!fn.toLowerCase().endsWith('.txt')) continue;
    const m = fn.match(/^(\d+)_/);
    if (!m) continue;
    const idInt = Number.parseInt(m[1], 10);
    const fp = path.join(txtDir, fn);
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      const out = _extractPluginOutputFromFastGPTContent(raw);
      if (typeof out === 'string' && out.trim()) {
        pairs.push({ idInt: Number.isFinite(idInt) ? idInt : 0, out });
      }
    } catch (e) {
      console.error('[final_result] 读取 txt 失败:', fp, e && e.message ? e.message : e);
    }
  }
  pairs.sort((a, b) => (b.idInt || 0) - (a.idInt || 0));

  const header = `<b>今日摘要报告（${dateStr}）</b>`;
  const blocks = pairs.map((p, idx) => `<b>${idx + 1}.</b> ${p.out}`);

  const parts = [];
  let cur = [];

  const flush = () => {
    const body = cur.length ? `\n${cur.join('\n\n')}` : '';
    parts.push(header + body);
    cur = [];
  };

  for (const block of blocks) {
    // 试探加入当前 part
    const candidateBlocks = cur.concat([block]);
    const candidateText = header + '\n' + candidateBlocks.join('\n\n');
    const candidateLine = _makeContentLineFromText(candidateText);
    if (_byteLenUtf8(candidateLine) <= EMAIL_FINAL_MAX_BYTES) {
      cur.push(block);
      continue;
    }

    // 当前 part 放不下这个 block：先把已有的 flush，再尝试单独放
    if (cur.length) flush();

    const singleText = header + '\n' + block;
    const singleLine = _makeContentLineFromText(singleText);
    if (_byteLenUtf8(singleLine) <= EMAIL_FINAL_MAX_BYTES) {
      cur.push(block);
      continue;
    }

    // 兜底：单封邮件也超过 140KB，只能截断（尽量不破坏 UTF-8）
    console.warn('[final_result] 单封邮件摘要过大，触发截断:', emailAccount, dateStr);
    let truncated = singleText;
    // 保留末尾提示
    const suffix = '\n...（内容过长已截断）';
    while (_byteLenUtf8(_makeContentLineFromText(truncated + suffix)) > EMAIL_FINAL_MAX_BYTES && truncated.length > 1000) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
    }
    parts.push(truncated + suffix);
  }

  if (cur.length || parts.length === 0) {
    flush();
  }

  // 写出 part_1.txt, part_2.txt...
  // 先清理旧文件
  try {
    for (const fn of fs.readdirSync(finalDir)) {
      if (/^part_\d+\.txt$/i.test(fn)) {
        fs.unlinkSync(path.join(finalDir, fn));
      }
    }
  } catch (_) {}

  let idx = 1;
  for (const text of parts) {
    const line = _makeContentLineFromText(text);
    const outPath = path.join(finalDir, `part_${idx}.txt`);
    fs.writeFileSync(outPath, line + '\n', { encoding: 'utf8' });
    idx += 1;
  }

  return { parts: parts.length, mails: pairs.length };
}

async function runEmailPipelinePull() {
  if (emailPullRunning) {
    console.warn('[emails][pull] 上一次仍在运行，跳过本轮');
    return;
  }
  emailPullRunning = true;
  try {
    const users = await loadUsersWithCredentialsFromAPI();
    if (!users || users.length === 0) return;

    // “慢慢读取”：按用户串行执行，避免并发 IMAP 抢占/触发服务端限流
    let totalSaved = 0;
    for (const u of users) {
      try {
        const r = await pullEmailsToDiskForUser(u.email_account, u.email_password);
        totalSaved += (r.saved || 0);
      } catch (e) {
        console.error('[emails][pull] 用户失败:', u.email_account, e && e.message ? e.message : e);
        // IMAP 登录或拉取失败时，给管理员发一条飞书告警
        const msg = `[邮箱拉取失败]\n用户: ${u.email_account}\n错误: ${e && e.message ? e.message : String(e)}`;
        try {
          await _sendFeishuAlertToAdmin(msg);
        } catch (_) {}
      }
      await _sleep(EMAIL_PULL_USER_DELAY_MS);
    }
    console.log(`[emails][pull] 完成：写入 ${totalSaved} 封（去重跳过不计入）`);
  } finally {
    emailPullRunning = false;
  }
}

async function runEmailPipelineProcessTxt() {
  if (emailProcessRunning) {
    console.warn('[emails][txt_result] 上一次仍在运行，跳过本轮');
    return;
  }
  emailProcessRunning = true;
  try {
    const users = await loadUsersFromAPI();
    if (!users || users.length === 0) return;
    const dateStr = _hkDateStr(new Date());
    for (const u of users) {
      await generateTxtResultsForUserDate(u.email_account, dateStr);
    }
    console.log(`[emails][txt_result] 完成（日期: ${dateStr}）`);
  } finally {
    emailProcessRunning = false;
  }
}

async function runEmailPipelineBuildFinal() {
  if (emailBuildRunning) {
    console.warn('[emails][final_result] 上一次仍在运行，跳过本轮');
    return;
  }
  emailBuildRunning = true;
  try {
    const users = await loadUsersFromAPI();
    if (!users || users.length === 0) return;
    const dateStr = _hkDateStr(new Date());
    for (const u of users) {
      await buildFinalPartsForUserDate(u.email_account, dateStr);
    }
    console.log(`[emails][final_result] 完成（日期: ${dateStr}）`);
  } finally {
    emailBuildRunning = false;
  }
}

async function runEmailPipelineSendSummary() {
  if (emailSummarySendRunning) {
    console.warn('[emails][summary_send] 上一次仍在运行，跳过本轮');
    return;
  }
  emailSummarySendRunning = true;
  try {
    const users = await loadUsersFromAPI();
    if (!users || users.length === 0) return;
    const dateStr = _hkDateStr(new Date());
    for (const u of users) {
      try {
        await _sendFeishuSummaryFromFiles(u.email_account, dateStr);
      } catch (e) {
        console.error('[emails][summary_send] 用户失败:', u.email_account, e && e.message ? e.message : e);
      }
    }
    console.log(`[emails][summary_send] 完成（日期: ${dateStr}）`);
  } finally {
    emailSummarySendRunning = false;
  }
}

function startEmailPipelineTasks() {
  console.log('[emails] 启动邮件前置任务...');
  console.log(`[emails] EMAIL_DATA_DIR=${EMAIL_DATA_DIR}`);
  console.log(`[emails] pull cron=${EMAIL_PULL_CRON}, process cron=${EMAIL_PROCESS_CRON}, build cron=${EMAIL_BUILD_CRON}`);
  console.log(`[emails] summary send cron=${EMAIL_SUMMARY_SEND_CRON}`);
  console.log(`[emails] final max bytes=${EMAIL_FINAL_MAX_BYTES}`);

  const options = TASK_TIMEZONE ? { timezone: TASK_TIMEZONE } : {};

  cron.schedule(EMAIL_PULL_CRON, async () => {
    await runEmailPipelinePull();
  }, options);

  cron.schedule(EMAIL_PROCESS_CRON, async () => {
    await runEmailPipelineProcessTxt();
  }, options);

  cron.schedule(EMAIL_BUILD_CRON, async () => {
    await runEmailPipelineBuildFinal();
  }, options);

  cron.schedule(EMAIL_SUMMARY_SEND_CRON, async () => {
    await runEmailPipelineSendSummary();
  }, options);

  console.log('[emails] 邮件前置任务已注册');
}

// 从 API 接口加载用户配置
async function loadUsersFromAPI() {
  try {
    const response = await axios.get(`${API_BASE_URL}/email_accounts`);
    if (!Array.isArray(response.data)) {
      console.warn('[配置] API 返回格式异常（不是数组）');
      return [];
    }
    const users = response.data.map(account => ({
      email_account: account.email_account
    }));
    console.log(`[配置] 从 API 加载了 ${users.length} 个用户配置`);
    return users;
  } catch (err) {
    console.error(`[ERR] 从 API 加载用户配置失败:`, err.message);
    if (err.response) {
      console.error(`[ERR] API 响应状态: ${err.response.status}, 数据:`, err.response.data);
    }
    throw err;
  }
}

// 从 API 接口读取用户配置
async function getUserFromConfig(emailAccount) {
  if (!emailAccount) return null;
  try {
    const response = await axios.get(`${API_BASE_URL}/email_accounts`, {
      params: { email_account: emailAccount }
    });
    if (!Array.isArray(response.data) || response.data.length === 0) {
      console.warn('[配置] API 未找到用户:', emailAccount);
      return null;
    }
    const account = response.data[0];
    return {
      email_account: account.email_account
    };
  } catch (err) {
    console.error('[配置] 从 API 读取用户配置失败（getUserFromConfig）:', err.message);
    return null;
  }
}

// 定时任务配置（cron 表达式）
// 格式：分钟 小时 日 月 星期
// 例如：'0 * * * *' 表示每小时的第0分钟执行
const TASK_TIMEZONE = process.env.FASTGPT_TIMEZONE || 'Asia/Hong_Kong';

// 任务类型配置
const TASK_TYPES = [
  // {
  //   name: '定时自动加日程',
  //   // 加日程任务1：8-11点、13-17点、19-22点每小时执行（排除12点和18点，因为这两个时间点会在总结任务中先执行加日程）
  //   schedule: process.env.FASTGPT_CRON_SCHEDULE || '0 8-11,13-17,19-22 * * *',
  //   query: process.env.FASTGPT_QUERY_SCHEDULE || '定时自动加日程'
  // },
  // {
  //   name: '定时自动加日程（提前10分钟）',
  //   // 加日程任务2：11:50 和 17:50 执行
  //   schedule: process.env.FASTGPT_CRON_SCHEDULE_EARLY || '50 11,17 * * *',
  //   query: process.env.FASTGPT_QUERY_SCHEDULE || '定时自动加日程'
  // },
  // {
  //   name: '定时自动总结',
  //   // 总结任务：12点和18点执行
  //   schedule: process.env.FASTGPT_CRON_SUMMARY || '59 13,17 * * *',
  //   query: process.env.FASTGPT_QUERY_SUMMARY || '定时自动总结'
  // }
];

// 为单个用户执行任务
async function executeTaskForUser(emailAccount, taskType) {
  const taskConfig = TASK_TYPES[taskType];
  if (!taskConfig) {
    console.error(`[ERR] 无效的任务类型: ${taskType}`);
    return;
  }

  const task = {
    name: `${taskConfig.name}-${emailAccount}`,
    query: taskConfig.query,
    user: emailAccount,
    email_account: emailAccount,
    taskType: taskConfig.name.includes('总结') ? 'summary' : 'schedule'
  };

  await executeTask(task);
}

// 执行定时任务（会先获取所有用户，然后为每个用户执行）
async function executeScheduledTask(taskTypeIndex) {
  try {
    console.log(`[定时任务] 开始执行任务类型: ${TASK_TYPES[taskTypeIndex].name}`);
    
    // 从 API 获取最新的用户列表
    const users = await loadUsersFromAPI();
    if (!users || users.length === 0) {
      console.warn('[定时任务] 未找到任何用户，跳过本次执行');
      return;
    }

    console.log(`[定时任务] 找到 ${users.length} 个用户，开始为每个用户执行任务`);
    
    // 为每个用户执行任务（并行执行）
    const promises = users.map(user => 
      executeTaskForUser(user.email_account, taskTypeIndex).catch(err => {
        console.error(`[ERR] 用户 ${user.email_account} 的任务执行失败:`, err.message);
      })
    );
    
    await Promise.all(promises);
    console.log(`[定时任务] ${TASK_TYPES[taskTypeIndex].name} 执行完成`);
  } catch (err) {
    console.error(`[ERR] 定时任务 ${TASK_TYPES[taskTypeIndex].name} 执行失败:`, err.message);
  }
}

// ========== 初始化客户端（每个任务使用自己的客户端） ==========
if (!FASTGPT_URL || !FASTGPT_API_KEY) {
  console.error('[ERR] 缺少配置：FASTGPT_URL 或 FASTGPT_API_KEY');
  process.exit(1);
}

// 生成随机 chatId
function generateRandomChatId() {
  return crypto.randomBytes(16).toString('hex');
}

// 创建客户端工厂函数
function createClient(chatId) {
  return new FastGPTClient({
    apiKey: FASTGPT_API_KEY,
    url: FASTGPT_URL,
    chatId: chatId,
    logger: (user, message) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${user}] ${message}`);
    }
  });
}

// 邮件摘要流水线专用客户端（可使用独立 key/url）
function createMailClient(chatId) {
  const apiKey = FASTGPT_MAIL_API_KEY || "";
  const url = FASTGPT_MAIL_URL || FASTGPT_URL;
  return new FastGPTClient({
    apiKey,
    url,
    chatId,
    logger: (user, message) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${user}] ${message}`);
    }
  });
}

// ========== 执行任务函数 ==========
async function executeTask(task) {
  try {
    console.log(`[定时任务] 开始执行: ${task.name} (用户: ${task.email_account})`);
    
    // 每次执行时生成随机 chatId
    const randomChatId = generateRandomChatId();
    console.log(`[定时任务] 使用随机 chatId: ${randomChatId}`);
    
    // 为每个任务创建独立的客户端（使用随机 chatId）
    const client = createClient(randomChatId);
    
    // 构建 variables
    const variables = {
      email_account: task.email_account
    };
    
    const result = await client.sendToFastGPT({
      query: task.query,
      user: task.user,
      variables: variables
    });
    
    console.log(`[定时任务] ${task.name} 执行成功，结果: ${result.substring(0, 100)}...`);
    return result;
  } catch (err) {
    console.error(`[ERR] 定时任务 ${task.name} 执行失败:`, err.message);
    throw err;
  }
}

// ========== 启动定时任务 ==========
function startScheduledTasks() {
  console.log('[服务] 开始启动定时任务...');
  
  // 为每个任务类型注册定时任务
  TASK_TYPES.forEach((taskType, index) => {
    const options = TASK_TIMEZONE ? { timezone: TASK_TIMEZONE } : {};
    
    cron.schedule(taskType.schedule, async () => {
      await executeScheduledTask(index);
    }, options);
    
    console.log(`[服务] 已注册定时任务: ${taskType.name}, 计划: ${taskType.schedule}${TASK_TIMEZONE ? ` (时区: ${TASK_TIMEZONE})` : ''}`);
  });
  
  console.log('[服务] 所有定时任务已启动（每次执行时会从 API 获取最新的用户列表）');
}

// ========== 飞书 card.action.trigger 处理函数，可复用 ==========
async function handleFeishuCardActionTrigger(data) {

  
  // 超时保护：确保 3 秒内一定返回
  const TIMEOUT_FLAG = '__TIMEOUT__';
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(TIMEOUT_FLAG);
    }, 3000);
  });

  const handlerPromise = (async () => {
    try {
    // 确保 data 是对象
    if (!data || typeof data !== 'object') {
      console.warn('[飞书回调] data 不是有效对象');
      return {
        toast: {
          type: 'error',
          content: '回调数据格式错误',
          i18n: {
            zh_cn: '回调数据格式错误',
            en_us: 'invalid callback data format'
          }
        }
      };
    }


    // 兼容两种结构：
    // 1) 文档中的 behaviors[ { type: 'callback', value: {...} } ]
    // 2) 实际 WS 返回的 data.action.value
    let payload = null;

    try {
      if (Array.isArray(data.behaviors)) {
        const behaviors = data.behaviors;
        const firstCallback = behaviors.find(
          (b) => b && b.type === 'callback' && b.value && typeof b.value === 'object'
        );
        if (firstCallback) {
          payload = firstCallback.value;
        }
      }

      if (!payload && data.action && data.action.value && typeof data.action.value === 'object') {
        payload = data.action.value;
      }
    } catch (parseErr) {
      console.error('[飞书回调] 解析 payload 失败:', parseErr && parseErr.message ? parseErr.message : parseErr);
      return {
        toast: {
          type: 'error',
          content: '解析回调参数失败',
          i18n: {
            zh_cn: '解析回调参数失败',
            en_us: 'failed to parse callback payload'
          }
        }
      };
    }

    if (!payload) {
      console.warn('[飞书回调] 未找到有效的 callback/action.value，忽略本次回调');
      return {
        toast: {
          type: 'warning',
          content: '未找到有效的卡片参数',
          i18n: {
            zh_cn: '未找到有效的卡片参数',
            en_us: 'no valid card payload'
          }
        }
      };
    }

    let force_add_schedule_json_body, email_account;
    try {
      ({ force_add_schedule_json_body, email_account } = payload || {});
    } catch (destructErr) {
      console.error('[飞书回调] 解构 payload 失败:', destructErr && destructErr.message ? destructErr.message : destructErr);
      return {
        toast: {
          type: 'error',
          content: '解析回调参数失败',
          i18n: {
            zh_cn: '解析回调参数失败',
            en_us: 'failed to parse callback payload'
          }
        }
      };
    }

    if (!email_account) {
      console.warn('[飞书回调] 缺少 email_account，无法匹配用户');
      return {
        toast: {
          type: 'warning',
          content: '缺少邮箱账号，无法处理',
          i18n: {
            zh_cn: '缺少邮箱账号，无法处理',
            en_us: 'missing email_account'
          }
        }
      };
    }

    // 从 users_config.json 读取用户配置
    let user;
    try {
      user = await getUserFromConfig(email_account);
    } catch (getUserErr) {
      console.error('[飞书回调] 获取用户配置失败:', getUserErr && getUserErr.message ? getUserErr.message : getUserErr);
      return {
        toast: {
          type: 'error',
          content: '获取用户配置失败',
          i18n: {
            zh_cn: '获取用户配置失败',
            en_us: 'failed to get user config'
          }
        }
      };
    }

    if (!user) {
      console.warn('[飞书回调] 未在 users_config.json 找到对应用户:', email_account);
      return {
        toast: {
          type: 'warning',
          content: '未找到对应用户',
          i18n: {
            zh_cn: '未找到对应用户',
            en_us: 'user not found'
          }
        }
      };
    }

    // 为保证 3 秒内返回，这里异步调用 FastGPT，不阻塞 toast 返回
    (async () => {
      try {
        const randomChatId = generateRandomChatId();
        const client = createClient(randomChatId);

        const variables = {
          force_add_schedule_json_body,
          email_account
        };

        console.log('[飞书回调] 异步调用 FastGPT 强制添加日程, email_account:', email_account);

        const result = await client.sendToFastGPT({
          query: '强制添加日程',
          user: email_account,
          variables
        });

        console.log('[飞书回调] FastGPT 调用成功，结果前 100 字符:', typeof result === 'string' ? result.substring(0, 100) : '');
      } catch (err) {
        console.error('[飞书回调] 异步调用 FastGPT 失败:', err && err.message ? err.message : err);
      }
    })();

    // 立即返回 toast，避免超过 3 秒超时
    return {
      toast: {
        type: 'success',
        content: '已接收请求，正在添加日程',
        i18n: {
          zh_cn: '已接收请求，正在添加日程',
          en_us: 'request received, adding schedule'
        }
      }
    };
    } catch (err) {
      // 最后的兜底 catch，确保任何未预料的异常都不会导致 handler 返回 undefined
      console.error('[飞书回调] 处理 card.action.trigger 失败（外层 catch）:', err && err.message ? err.message : err);
      console.error('[飞书回调] 错误堆栈:', err && err.stack ? err.stack : 'no stack');
      return {
        toast: {
          type: 'error',
          content: '处理失败，请稍后重试',
          i18n: {
            zh_cn: '处理失败，请稍后重试',
            en_us: 'process failed, please try again later'
          }
        }
      };
    }
  })();

  // 使用 Promise.race 确保 3 秒内一定返回
  const result = await Promise.race([handlerPromise, timeoutPromise]);

  if (result === TIMEOUT_FLAG) {
    console.warn('[飞书回调] 处理超时（3秒），强制返回 toast');
    return {
      toast: {
        type: 'error',
        content: '处理超时，请稍后重试',
        i18n: {
          zh_cn: '处理超时，请稍后重试',
          en_us: 'process timeout, please try again later'
        }
      }
    };
  }

  // 正常在 3 秒内返回结果，清理定时器
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}

// ========== 建立飞书长连接处理回调 ==========
let wsClientStarted = false;

function startFeishuWsClient() {
  if (wsClientStarted) return;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    console.warn('[飞书] 未配置 FEISHU_APP_ID/FEISHU_APP_SECRET，跳过长连接回调处理');
    return;
  }

  const wsClient = new Lark.WSClient({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': (data) => {
      return handleFeishuCardActionTrigger(data);
    }
  });

  wsClient
    .start({ eventDispatcher })
    .then(() => {
      wsClientStarted = true;
      console.log('[飞书] WS 长连接已建立，开始接收回调事件');
    })
    .catch((err) => {
      console.error('[飞书] 启动 WS 长连接失败:', err && err.message ? err.message : err);
    });
}

// ========== 手动执行任务（用于测试） ==========
async function runTaskManually(taskName) {
  // 从 API 获取最新的用户列表
  const users = await loadUsersFromAPI();
  if (!users || users.length === 0) {
    console.error('[ERR] 未找到任何用户');
    return;
  }

  // 解析任务名称，找到对应的任务类型
  const taskTypeIndex = TASK_TYPES.findIndex(t => t && typeof t.name === 'string' && taskName.includes(t.name));

  if (taskTypeIndex === -1) {
    console.error(`[ERR] 无法识别任务类型: ${taskName}`);
    console.log('[提示] 支持的任务名称格式: "<任务名>-<email>" 或 "<任务名>"');
    console.log('[提示] 当前可用任务名:', TASK_TYPES.map(t => t.name).join(' / '));
    return;
  }

  // 如果任务名包含 email_account，只为该用户执行；否则为所有用户执行
  const emailMatch = taskName.match(/-([^-\s]+)$/);
  if (emailMatch) {
    const emailAccount = emailMatch[1];
    await executeTaskForUser(emailAccount, taskTypeIndex);
  } else {
    // 为所有用户执行
    console.log(`[手动任务] 为所有 ${users.length} 个用户执行: ${TASK_TYPES[taskTypeIndex].name}`);
    const promises = users.map(user => 
      executeTaskForUser(user.email_account, taskTypeIndex).catch(err => {
        console.error(`[ERR] 用户 ${user.email_account} 的任务执行失败:`, err.message);
      })
    );
    await Promise.all(promises);
  }
}

// ========== 主程序 ==========
if (require.main === module) {
  (async () => {
    console.log('[服务] FastGPT 定时任务服务启动中...');
    console.log(`[配置] FastGPT URL: ${FASTGPT_URL}`);
    console.log(`[配置] API Base URL: ${API_BASE_URL}`);
    
    // 测试 API 连接（可选，用于启动时验证）
    try {
      const users = await loadUsersFromAPI();
      console.log(`[配置] API 连接正常，当前有 ${users.length} 个用户`);
      if (users.length > 0) {
        console.log(`[配置] 用户列表: ${users.map(u => u.email_account).join(', ')}`);
      }
    } catch (err) {
      console.warn('[警告] 启动时无法连接 API，但服务仍会启动（定时任务执行时会重试）');
    }
    
    // 处理命令行参数
    const args = process.argv.slice(2);
    
    // 手动执行任务: node email_calendar_fastgpt_service.js run <任务名>
    if (args[0] === 'run' && args[1]) {
      console.log('[服务] 以 run 模式启动，立即建立飞书长连接...');
      // 先启动飞书长连接，防止回调过早到达
      startFeishuWsClient();

      // 保持进程运行，等待回调
      console.log('[提示] 长连接已启动，稍后将执行一次手动任务');
      console.log('[提示] 现在就可以在飞书里点击卡片，回调会在这里显示');
      console.log('[提示] 使用 Ctrl+C 停止服务');

      // 优雅退出
      process.on('SIGINT', () => {
        console.log('\n[服务] 收到退出信号，正在关闭...');
        process.exit(0);
      });
      
      process.on('SIGTERM', () => {
        console.log('\n[服务] 收到终止信号，正在关闭...');
        process.exit(0);
      });

      // 执行指定任务
      runTaskManually(args[1]).then(() => {
        console.log('[服务] 手动任务执行完成（长连接仍在运行，等待飞书回调）');
      }).catch(err => {
        console.error('[ERR] 手动任务执行失败:', err);
        process.exit(1);
      });
      return;
    }
    
    // 启动定时任务（每次执行时会从 API 获取最新用户列表）
    startScheduledTasks();
    // 启动邮件拉取/预处理/拼接任务
    startEmailPipelineTasks();

    // 启动飞书长连接回调处理
    startFeishuWsClient();
    // 保持进程运行
    console.log('[服务] 服务已启动，等待定时任务执行...');
    console.log('[提示] 每次定时任务执行时会自动从 API 获取最新的用户列表');
    console.log('[提示] 使用 Ctrl+C 停止服务');
    console.log('[提示] 手动执行任务: node email_calendar_fastgpt_service.js run <任务名>');
    
    // 优雅退出
    process.on('SIGINT', () => {
      console.log('\n[服务] 收到退出信号，正在关闭...');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.log('\n[服务] 收到终止信号，正在关闭...');
      process.exit(0);
    });
  })();
}

// ========== 导出 ==========
module.exports = {
  createClient,
  executeTask,
  startScheduledTasks,
  startEmailPipelineTasks,
  runTaskManually
};

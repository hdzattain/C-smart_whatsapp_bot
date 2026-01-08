/**
 * WhatsApp 多功能机器人
 * 功能：
 * 1. 日志老化（按日期分文件存储、自动清理过期日志）
 * 2. 多功能路由（不同群可绑定不同 bot 功能）
 * 3. 调用 Dify（支持 Agent / Workflow，不同 API_KEY 可配置）
 * 4. 未知群组自动加入配置文件
 * 5. 每天 18:00 定时任务：输出 xiaban==0 列表
 * 6. 全部接口安全处理，防止 undefined / null 报错
 * 7. insp-bot 仅处理图文混合格式消息，否则提示用户
 * 8. 生成终端二维码用于 WhatsApp 登录
 * 
 * Refactored for @wppconnect-team/whatsapp
 */

// 环境与核心模块
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fsPromises = fs.promises;
let jsonMappingsCache = null;  // 全局缓存，减少重复加载

// HTTP 与请求模块
const axios = require('axios');
const fetch = require('node-fetch');  // 用于兼容性请求

// WhatsApp 集成模块
const wppconnect = require('@wppconnect-team/wppconnect');
const qrcode = require('qrcode-terminal');  // QR 码终端显示

// 文件与媒体处理模块
const FormData = require('form-data');
const mime = require('mime');  // 统一使用 mime（兼容 mime-types）；若需扩展，改回 mime-types
const rimraf = require('rimraf');  // 异步版本：使用 rimraf.promises 或 fsPromises.rm

// 工具与实用模块
const cron = require('node-cron');  // 定时任务
const { v4: uuidv4 } = require('uuid');  // UUID 生成

// === 常量 & 配置加载 ===
const LOG_DIR = path.join(__dirname, 'logs');
const TMP_DIR = path.join(__dirname, 'tmp');
const GROUP_CONFIG_FILE = path.join(__dirname, 'group_config.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');
// 定义 JSON 文件路径（与 insp_bot.js 同文件夹）
const LID_MAP_FILE = path.join(__dirname, 'lid2number.json');
// === SummaryBot 任务存储 ===
const TASKS_FILE = path.join(__dirname, 'tasks.json');
// 结构：{ [groupId]: Array<Task> }，Task 见下方 handleSummaryBot 注释
let tasksStore = loadJSON(TASKS_FILE, {});
const saveTasks = () => saveJSON(TASKS_FILE, tasksStore);

let groupConfig = loadJSON(GROUP_CONFIG_FILE, { groups: {}, default: {} });
let subscriptions = loadJSON(SUBSCRIPTIONS_FILE, {});

const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const DEFAULT_DIFY_API_KEY = process.env.DIFY_API_KEY || 'app-s2bwyQ0UQ9DJ5pUZXuUeDPyS';
const BOT_NAME = '@bot';
const LOG_WHATSAPP_MSGS = true;
const LOG_FILE = path.join(__dirname, 'whatsapp_logs.txt');
const BITABLE_API_URL = 'https://c-smart-gatwey.csmart-test.com/llm-system/open/api/biTableRecordAdd';
const WIKI_TOKEN = 'U4i4wXTLSi0fyfkeMbScNAAJnLf';
const WIKI_TABLE_ID = 'tblyXhKKu9y3AALG';
const PLAN_FASTGPT_URL = 'https://rgamhdso.sealoshzh.site/api/v1/chat/completions';
const PLAN_FASTGPT_API_KEY = process.env.PLAN_FASTGPT_API_KEY || '';
const CED_FASTGPT_API_KEY = process.env.CED_FASTGPT_API_KEY || '';

// 确保 TMP_DIR 存在
ensureDir(TMP_DIR);

// === 工具函数 ===
// 记录任务进展（同时更新 latestProgress、progress 数组、responded、history）
function addProgress(task, text, by, messageId) {
  const clean = (text || '').trim();
  if (!clean) return false;
  const nowISO = new Date().toISOString();

  task.latestProgress = { text: clean.slice(0, 300), by, at: nowISO, messageId };
  task.progress = task.progress || [];
  task.progress.push({ text: clean, by, at: nowISO, messageId });

  task.responded = true;
  task.history = task.history || [];
  task.history.push({ at: nowISO, by, action: 'progress' });
  return true;
}

function loadJSON(file, defaultValue) {
  try {
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf-8'))
      : defaultValue;
  } catch (err) {
    console.error(`[ERR] 读取 JSON 文件失败: ${file}`, err);
    return defaultValue;
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[ERR] 保存 JSON 文件失败: ${file}`, err);
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// === 日志记录 & 老化 ===
function appendLog(groupId, message) {
  const groupDir = path.join(LOG_DIR, groupId || 'default');
  ensureDir(groupDir);
  const dateStr = new Date().toISOString().slice(0, 10);
  const logFile = path.join(groupDir, `${dateStr}.log`);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

// 统一 JID
function toJid(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (s.includes('@')) return s.replace('@s.whatsapp.net', '@c.us');
  return `${s.replace('+', '')}@c.us`;
}

// 统一转成 WhatsApp Web 可接受的 JID（@c.us）
function toCUsJid(id) {
  if (!id) return null;
  let s = String(id).trim();
  // 允许传 Contact.id/_serialized/@s.whatsapp.net/纯号/带+
  if (s.includes('@')) s = s.replace(/@s\.whatsapp\.net$/i, '@c.us').replace(/@whatsapp\.net$/i, '@c.us');
  else s = s.replace(/^\+/, '') + '@c.us';
  return s;
}

// 把一组 id 清洗为去重后的 JID 数组
function sanitizeJids(ids = []) {
  const out = [];
  const seen = new Set();
  for (const x of (Array.isArray(ids) ? ids : [ids])) {
    const j = toCUsJid(x);
    if (j && !seen.has(j)) { seen.add(j); out.push(j); }
  }
  return out;
}

// 根据 JIDs 生成与之对应的文本里的 @ 标签串
function atTextFromJids(jids = []) {
  return sanitizeJids(jids).map(j => '@' + j.split('@')[0]).join(' ');
}

// 安全发送：优先带 mentions；失败则自动无 mentions 重试，避免整条消息丢失
async function safeSendWithMentions(client, chatId, text, jids = []) {
  const mentions = sanitizeJids(jids);
  const needMentions = mentions.length > 0;

  // 如果需要 @，确保文本里出现了对应的 @86188... 标签
  const ensureText = needMentions
    ? text + (/\B@\d{5,}/.test(text) ? '' : (' ' + atTextFromJids(mentions)))
    : text;

  try {
    if (needMentions) {
      return await client.sendText(chatId, ensureText, { mentionedJidList: mentions });
    }
    return await client.sendText(chatId, ensureText);
  } catch (e) {
    console.error('[SummaryBot] sendMessage 带 mentions 失败，降级重试：', e?.message || e);
    // 降级：不带 mentions 再发一遍，至少不影响使用
    return await client.sendText(chatId, text);
  }
}

// @文本：@86188...
function mentionTextFromIds(ids = []) {
  const arr = Array.isArray(ids) ? ids : [ids];
  return arr.map(id => '@' + String(id).replace(/@.*/, '')).join(' ');
}

// 从本条消息 @ 中取负责人（JID 字符串数组）
async function ownersFromMentions(client, msg) {
  // WPPConnect msg.mentionedJidList
  return (msg.mentionedJidList || [])
    .map(id => toJid(id))
    .filter(Boolean);
}

// 发送任务详情
async function sendTaskDetail(client, chat, task) {
  const owners = mentionTextFromIds(task.owners || []);
  const prog = (task.progress || []).slice(-3).map(p => {
    const who = '@' + String(p.by).split('@')[0];
    const tstr = new Date(p.at).toLocaleString();
    return `- ${tstr} ${who}: ${p.text}`;
  }).join('\n') || '（暂无进展）';

  const text = `📌 任务 *${task.id}*\n` +
    `内容：${task.text}\n` +
    `状态：${task.status === 'done' ? '✅ 已完成' : '进行中'}\n` +
    (task.due ? `截止：${task.due}\n` : '') +
    `负责人：${owners || '未指定'}\n` +
    `最近进展：\n${prog}`;

  // chat can be object or id, handle both
  const chatId = chat.id?._serialized || chat.id || chat;
  return client.sendText(chatId, text);
}

function buildTasksContext(groupId) {
  const list = (tasksStore[groupId] || []).slice(-200);
  const light = list.map(t => ({
    id: t.id,
    status: t.status,
    text: t.text,
    owners: (t.owners || []).map(x => String(x).split('@')[0]),
    due: t.due || null,
    latestProgress: t.latestProgress?.text || null,
    createdAt: t.createdAt
  }));
  return JSON.stringify(light);
}

function nextTaskId() {
  return 'T' + Date.now().toString().slice(-6);
}

function parseDueDate(str = '') {
  const m = str.match(/(?:截止|due)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/i);
  if (m) return m[1];

  const now = new Date();
  const toISO = (d) => d.toISOString().slice(0, 10);

  if (/今天|today/i.test(str)) return toISO(now);
  if (/明天|tomorrow/i.test(str)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return toISO(d);
  }
  const wkMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0 };
  const m2 = str.match(/下周([一二三四五六日天])/);
  if (m2) {
    const target = wkMap[m2[1]];
    const d = new Date(now);
    const add = ((7 - d.getDay()) + target) % 7 || 7;
    d.setDate(d.getDate() + add);
    return toISO(d);
  }
  return null;
}

// 问题1修复: 增强的@人名解析函数
async function parseTaskMentions(client, msg, body) {
  const mentions = [];

  try {
    // 方法1: 从WhatsApp API获取mentions (WPPConnect: mentionedJidList)
    const mentionJids = (msg.mentionedJidList || [])
      .map(id => toJid(id))
      .filter(Boolean);
    mentions.push(...mentionJids);
  } catch (e) {
    console.error('[parseTaskMentions] WhatsApp API mentions failed:', e);
  }

  try {
    // 方法2: 从文本中解析@mentions
    const textMentions = (body.match(/@\d{5,}/g) || [])
      .map(m => toCUsJid(m.substring(1)))
      .filter(Boolean);
    mentions.push(...textMentions);
  } catch (e) {
    console.error('[parseTaskMentions] Text parsing failed:', e);
  }

  // 去重并返回
  return Array.from(new Set(mentions.filter(Boolean)));
}

function stripTaskDecorations(body = '') {
  let text = body.replace(/^\s*(?:任务|待办|TODO)\s*[:：]\s*/i, '');
  text = text.replace(/(?:截止|due)\s*[:：]?\s*(?:\d{4}-\d{2}-\d{2}|今天|明天|下周[一二三四五六日天]|today|tomorrow)/ig, '');
  return text.trim();
}

async function handleDecisionCreate(client, chat, msg, groupId, senderId, fields, body) {
  const ownersInput = (fields.owners || []).filter(x => !String(x).startsWith('raw:'));
  const owners = Array.from(new Set(ownersInput.map(toJid).filter(Boolean)));
  const ownersJids = sanitizeJids(owners);

  const due = fields.due || parseDueDate(body);
  const text = fields.text || stripTaskDecorations(body);

  const task = {
    id: nextTaskId(),
    groupId,
    messageId: msg.id || '',
    creator: senderId,
    owners: ownersJids,
    text,
    due: due || null,
    status: fields.done ? 'done' : 'open',
    createdAt: new Date().toISOString(),
    responded: false,
    latestProgress: null,
    progress: [],
    history: [{ at: new Date().toISOString(), by: senderId, action: 'create(by-dify)' }]
  };
  tasksStore[groupId].push(task); saveTasks();

  const header = `✅ 已创建任务 *${task.id}*`;
  const bodyText = `内容：${task.text}\n` + (task.due ? `截止：${task.due}\n` : '');
  const ownersText = ownersJids.length ? `负责人：${atTextFromJids(ownersJids)}\n` : '负责人：未指定\n';

  const chatId = chat.id?._serialized || chat.id || chat;
  await safeSendWithMentions(client, chatId, `${header}\n${bodyText}${ownersText}`, ownersJids);
  return true;
}

async function handleDecisionProgressOrDone(client, chat, msg, groupId, senderId, decision, body) {
  const { matched_task_id: mid, fields } = decision;
  const target = tasksStore[groupId].find(t => t.id === mid)
    || tasksStore[groupId].slice().reverse().find(t => t.status === 'open');
  const chatId = chat.id?._serialized || chat.id || chat;

  if (!target) { await client.sendText(chatId, '未找到可更新的任务。'); return true; }

  const progressText = fields?.progress || body;
  addProgress(target, progressText, senderId, msg.id);
  if (fields?.done || /(完成|已处理|已解决|done)\b/i.test(body)) {
    target.status = 'done';
    target.history.push({ at: new Date().toISOString(), by: senderId, action: 'done(by-dify)' });
  }
  saveTasks();
  await client.sendText(chatId, `📝 已更新 *${target.id}* 的进展。` + (target.status === 'done' ? `\n状态：✅ 已完成` : ''));
  return true;
}

async function handleDecisionAssign(client, chat, groupId, senderId, decision) {
  const { matched_task_id: mid, fields } = decision;
  const target = tasksStore[groupId].find(t => t.id === mid);
  const chatId = chat.id?._serialized || chat.id || chat;

  const ownersInput = (fields?.owners || []).filter(x => !String(x).startsWith('raw:'));
  const owners = Array.from(new Set(ownersInput.map(toJid).filter(Boolean)));
  const ownersJids = sanitizeJids(owners);

  if (!target || !ownersJids.length) {
    await client.sendText(chatId, '未识别到任务或负责人。');
    return true;
  }

  target.owners = Array.from(new Set([...(target.owners || []), ...ownersJids]));
  target.history.push({ at: new Date().toISOString(), by: senderId, action: 'assign(by-dify)', owners: target.owners });
  saveTasks();

  await safeSendWithMentions(
    client,
    chatId,
    `✅ 已为 *${target.id}* 指派负责人：${atTextFromJids(target.owners)}`,
    target.owners
  );
  return true;
}

async function handleDecisionListOrQuery(client, chat, groupId, decision) {
  const chatId = chat.id?._serialized || chat.id || chat;
  try {
    const mid = decision?.matched_task_id || null;

    if (mid) {
      const task = (tasksStore[groupId] || []).find(t => t.id === mid);
      if (task) {
        await sendTaskDetail(client, chatId, task);
        return true;
      }
    }

    const list = (tasksStore[groupId] || []).filter(t => t.status === 'open');
    if (!list.length) {
      await client.sendText(chatId, '当前没有未完成任务。');
      return true;
    }

    const top = list.slice(0, 30);
    const ownerSet = new Set();
    const lines = top.map(t => {
      (t.owners || []).forEach(j => ownerSet.add(j));
      const due = t.due ? ` (截止:${t.due})` : '';
      const mark = t.latestProgress ? ' 📝' : (t.responded ? ' 💬' : '');
      const ownersTxt = (t.owners && t.owners.length) ? ` ${atTextFromJids(t.owners)}` : '';
      return `• *${t.id}* ${t.text}${due}${ownersTxt}${mark}`;
    }).join('\n');

    const header = `🗒 未完成任务（最多30条）`;
    const jids = sanitizeJids(Array.from(ownerSet));
    await safeSendWithMentions(client, chatId, `${header}\n${lines}`, jids);
    return true;
  } catch (e) {
    console.error('[SummaryBot] handleDecisionListOrQuery error:', e?.message || e);
    await client.sendText(chatId, '查询任务时出现异常，请稍后再试。');
    return true;
  }
}

async function processNaturalLanguage(client, msg, groupId, body, senderId) {
  const chat = await client.getChatById(msg.from);
  const decision = await extractTaskWithDify(body, groupId, senderId).catch(() => null);
  if (!decision) return false;

  const intent = decision.intent || 'other';
  if (intent === 'create_task') return await handleDecisionCreate(client, chat, msg, groupId, senderId, decision.fields || {}, body);
  if (intent === 'update_progress' || intent === 'mark_done')
    return await handleDecisionProgressOrDone(client, chat, msg, groupId, senderId, decision, body);
  if (intent === 'assign_owner') return await handleDecisionAssign(client, chat, groupId, senderId, decision);
  if (intent === 'list_or_query') return await handleDecisionListOrQuery(client, chat, groupId, decision);

  return false;
}

async function explicitCreateFromMessage(client, msg, groupId, body, senderId) {
  const chat = await client.getChatById(msg.from);
  let structured = null;

  try {
    structured = await extractTaskWithDify(body, groupId, senderId);
  } catch (e) {
    console.log('[explicitCreateFromMessage] Dify extraction failed, using fallback');
  }

  const due = structured?.fields?.due || parseDueDate(body);
  const text = structured?.fields?.text || stripTaskDecorations(body);

  // 使用增强的mention解析
  const ownersFromMsg = await parseTaskMentions(client, msg, body);
  const ownersCandidate = (structured?.fields?.owners && structured.fields.owners.length)
    ? structured.fields.owners
    : ownersFromMsg;

  const ownersJids = sanitizeJids(
    (ownersCandidate || [])
      .filter(x => !String(x).startsWith('raw:'))
      .map(toJid)
      .filter(Boolean)
  );

  const task = {
    id: 'T' + Date.now().toString().slice(-6),
    groupId,
    messageId: msg.id || '',
    creator: senderId,
    owners: ownersJids,
    text,
    due: due || null,
    status: structured?.fields?.done ? 'done' : 'open',
    createdAt: new Date().toISOString(),
    responded: false,
    latestProgress: null,
    progress: [],
    history: [{ at: new Date().toISOString(), by: senderId, action: 'create' }]
  };

  tasksStore[groupId] = tasksStore[groupId] || [];
  tasksStore[groupId].push(task);
  saveTasks();

  const header = `✅ 已創建任務 *${task.id}*`;
  const bodyText = `內容：${task.text}\n` + (task.due ? `截止：${task.due}\n` : '');
  const ownersText = ownersJids.length ? `負責人：${atTextFromJids(ownersJids)}\n` : '負責人：未指定\n';
  const tips = `指令：!tasks | !mine | !done ${task.id} | !assign ${task.id} @負責人 | !note ${task.id} 進展 | !detail ${task.id}`;

  await safeSendWithMentions(client, chat.id._serialized, `${header}\n${bodyText}${ownersText}${tips}`, ownersJids);
  return true;
}

async function extractTaskWithDify(inputText, groupId, userJid) {
  const gConf = (groupConfig && (groupConfig.groups[groupId] || groupConfig.default)) || {};
  const wf = (gConf.dify && gConf.dify.workflow) || {};

  const apiKey = wf.apiKey || process.env.DIFY_API_KEY || '';
  const workflowId = wf.id || process.env.DIFY_WORKFLOW_ID || '';
  const user = userJid || 'whatsapp-bot';

  if (!apiKey) {
    console.warn('[Dify] 未配置 DIFY_API_KEY，extractTaskWithDify 返回 null');
    return null;
  }

  const queryPayload = {
    message: inputText || '',
    tasks_context: buildTasksContext(groupId),
    user_id: user
  };
  const query = JSON.stringify(queryPayload);

  try {
    const outputs = await sendToDifyWorkflow({
      query,
      user,
      files: [],
      apiKey,
      workflowId,
      groupId
    });
    return outputs || null;
  } catch (err) {
    console.error('[Dify] extractTaskWithDify 调用 sendToDifyWorkflow 失败：', err?.message || err);
    return null;
  }
}

function ensureGroupConfig(groupId) {
  if (!groupConfig.groups[groupId]) {
    groupConfig.groups[groupId] = {
      ...groupConfig.default,
      botType: 'insp-bot',
      dify: {
        mode: 'workflow',
        agent: {
          apiKey: DEFAULT_DIFY_API_KEY,
          appId: '2cf7a289-1c7d-41fe-a892-fe8b2e4f8c64'
        },
        workflow: {
          workflowId: "6c9eec51-e5f0-4c42-9956-350daca42471",
          apiKey: "app-rq3awuokzQJKGiXwaIMMR4wg",
          appId: "1bf6a168-9b6c-40fd-b319-fe7b1e3d9e53"
        }
      }
    };
    saveJSON(GROUP_CONFIG_FILE, groupConfig);
    console.log(`[LOG] 已新增群組配置: ${groupId}`);
  }
}

// ========== 公共 POST + 重试函数 ==========
async function _postToFastGPT(data, gConfig, user) {
  const apiKey = gConfig.fastGPT?.apiKey || '';
  const url = gConfig.fastGPT?.url || '';

  if (!apiKey) throw new Error(`未找到 FastGPT API key`);

  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.post(url, data, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 100000 // 100s 超时
      });
      console.log(`[LOG] FastGPT 返回数据: ${JSON.stringify(res.data)}`);
      const content = res.data.choices[0]?.message?.content;
      if (!content) throw new Error('FastGPT 返回数据中缺少 content 字段');
      return content;
    } catch (err) {
      lastErr = err;
      const msg = (err.message || '') + (err.code ? ' ' + err.code : '');
      console.log('[ERR] FastGPT 请求失败:', msg);
      if (
        (msg.includes('aborted') || msg.includes('stream') || msg.includes('ECONNRESET') || msg.includes('ERR_BAD_RESPONSE')) &&
        i < 2
      ) {
        console.log(`FastGPT 请求断流，正在第${i + 1}次重试...`);
        appendLog(user, `FastGPT 请求断流，正在第${i + 1}次重试...`);
        await new Promise(res => setTimeout(res, 1200 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ========== Messages 构建 Helper（支持文本 + 多图） ==========
function buildMessages(contentParts, chatId) {
  const content = contentParts.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') return { type: 'image_url', image_url: { url: part.url } };
    throw new Error(`不支持的 type: ${part.type}`);
  });
  return {
    chatId,
    stream: false,
    detail: false,
    messages: [{ role: 'user', content }]
  };
}

// ========== 原函数：纯文本 ==========
async function sendToFastGPT({ query, user, group_id }) {
  const gConfig = groupConfig.groups[group_id] || groupConfig.default;
  if (!gConfig) throw new Error('未找到群組或默認配置');

  const contentParts = [{ type: 'text', text: query }];
  const data = buildMessages(contentParts, group_id);
  return _postToFastGPT(data, gConfig, user);
}

// ========== 新函数：图文（query + images[]） ==========
async function sendToFastGPTWithMedia({ query, images = [], user, group_id }) {
  const gConfig = groupConfig.groups[group_id] || groupConfig.default;
  if (!gConfig) throw new Error('未找到群組或默認配置');

  const contentParts = [{ type: 'text', text: query }];
  images.forEach(url => contentParts.push({ type: 'image_url', url }));
  const data = buildMessages(contentParts, group_id);
  return _postToFastGPT(data, gConfig, user);
}

async function sendToDify({ query, user, files, groupId }) {
  const gConfig = groupConfig.groups[groupId] || groupConfig.default;
  if (!gConfig) {
    throw new Error('未找到群組或默認配置');
  }

  const mode = gConfig.dify?.mode || 'agent';
  const apiKey = mode === 'agent' ? gConfig.dify?.agent?.apiKey : gConfig.dify?.workflow?.apiKey;
  const appId = mode === 'agent' ? gConfig.dify?.agent?.appId : gConfig.dify?.workflow?.appId;
  const workflowId = gConfig.dify?.workflow?.workflowId || '';

  if (!apiKey) {
    throw new Error(`未找到 ${mode} 模式的 API key`);
  }

  try {
    if (mode === 'agent') {
      return await sendToDifyAgent({ query, user, files, apiKey, appId });
    } else if (mode === 'workflow') {
      return await sendToDifyWorkflow({ query, user, files, apiKey, workflowId, appId, groupId });
    } else {
      throw new Error(`不支持的 Dify 模式: ${mode}`);
    }
  } catch (err) {
    console.error(`[ERR] Dify API 調用失敗 (group: ${groupId}): ${err.message}`, err.response?.data || err);
    throw new Error(`Dify 調用失敗: ${err.message}`);
  }
}

async function sendToDifyAgent({ query, user, files, apiKey, appId }) {
  const url = `${DIFY_BASE_URL}/chat-messages`;
  const token = apiKey || DEFAULT_DIFY_API_KEY;

  try {
    const res = await axios.post(
      url,
      {
        inputs: {},
        query: query || '',
        response_mode: 'streaming',
        user: user || 'whatsapp-bot',
        files: files || [],
        app_id: appId || '2cf7a289-1c7d-41fe-a892-fe8b2e4f8c64'
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        responseType: 'text'
      }
    );

    const result = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return extractAgentAnswer(result);
  } catch (err) {
    console.error(
      `[ERR] Dify Agent API 調用失敗: ${err.response?.status} ${err.response?.statusText}`,
      err.response?.data || err.message
    );
    throw new Error(`Dify Agent 調用失敗: ${err.message}`);
  }
}

async function sendToDifyWorkflow({ query, user, files, apiKey, workflowId, appId, groupId }) {
  const url = `${DIFY_BASE_URL}/workflows/run`;
  const token = apiKey || DEFAULT_DIFY_API_KEY;
  console.log(`[LOG] 開始走flow, workflowId: ${workflowId}, appId: ${appId}`);

  try {
    const res = await axios.post(
      url,
      {
        inputs: {
          Input_content: query || '',
          'sys.files': files || [],
          'sys.user_id': user || 'whatsapp-bot',
          'sys.app_id': appId || '1bf6a168-9b6c-40fd-b319-fe7b1e3d9e53',
          'sys.workflow_id': workflowId,
          'sys.workflow_run_id': `run-${Date.now()}`
        },
        user: user || 'whatsapp-bot',
        response_mode: 'streaming'
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        responseType: 'text'
      }
    );

    const result = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return extractWorkflowAnswer(result);
  } catch (err) {
    console.error(
      `[ERR] Dify Workflow API 調用失敗: ${err.response?.status} ${err.response?.statusText}`,
      err.response?.data || err.message
    );
    throw new Error(`Dify Workflow 調用失敗: ${err.message}`);
  }
}

function robustParseDecision(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && (raw.intent || raw.fields || raw.outputs)) {
    if (raw.outputs && typeof raw.outputs === 'object') return raw.outputs;
    return raw;
  }

  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    try { return JSON.parse(inner); } catch { }
  }

  s = s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    try { return JSON.parse(s); } catch { }
  }

  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = s.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch { }
    let end = lastBrace;
    for (let i = 0; i < 5 && end > firstBrace; i++) {
      end = s.lastIndexOf('}', end - 1);
      if (end <= firstBrace) break;
      try { return JSON.parse(s.slice(firstBrace, end + 1)); } catch { }
    }
  }

  return null;
}

function extractWorkflowAnswer(sseOrJson) {
  try {
    if (typeof sseOrJson === 'object' && sseOrJson !== null) {
      const maybeOutputs = sseOrJson.data?.outputs ?? sseOrJson.outputs ?? sseOrJson;
      if (typeof maybeOutputs === 'object') {
        if (maybeOutputs.text) {
          const parsed = robustParseDecision(maybeOutputs.text);
          if (parsed) return parsed;
        }
        return maybeOutputs;
      }
      if (typeof maybeOutputs === 'string') {
        const parsed = robustParseDecision(maybeOutputs);
        if (parsed) return parsed;
      }
    }

    if (typeof sseOrJson === 'string') {
      const lines = sseOrJson.split(/\r?\n/).filter(l => l.startsWith('data: '));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i].slice(6));
          if (ev.event === 'workflow_finished') {
            const out = ev.data?.outputs ?? ev.data ?? null;
            if (!out) continue;
            if (typeof out === 'object') {
              if (out.text) {
                const parsed = robustParseDecision(out.text);
                if (parsed) return parsed;
              }
              return out;
            }
            if (typeof out === 'string') {
              const parsed = robustParseDecision(out);
              if (parsed) return parsed;
            }
          }
        } catch { }
      }

      const parsed = robustParseDecision(sseOrJson);
      if (parsed) return parsed;
    }

    throw new Error('无法从响应中解析出决策 JSON');
  } catch (e) {
    console.error('[ERR] 解析 outputs 失败:', e);
    throw e;
  }
}

async function sendToBiTableRecordAdd(output, outputPic = '') {
  try {
    const response = await axios.post(
      BITABLE_API_URL,
      {
        output: JSON.stringify(output),
        outputPic: outputPic || '',
        wikiToken: WIKI_TOKEN,
        wikiTableId: WIKI_TABLE_ID
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );
    console.log(`[LOG] biTableRecordAdd 调用成功: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (err) {
    console.error(
      `[ERR] biTableRecordAdd 调用失败: ${err.response?.status} ${err.response?.statusText}`,
      err.response?.data || err.message
    );
    throw new Error(`biTableRecordAdd 调用失败: ${err.message}`);
  }
}

async function uploadImageToFeishu(filepath) {
  const IMG_UPLOAD_API_URL = 'https://c-smart-gatwey.csmart-test.com/llm-system/open/api/imgUpload';
  const form = new FormData();
  form.append('file', fs.createReadStream(filepath), {
    filename: path.basename(filepath),
    contentType: mime.getType(filepath) || 'application/octet-stream'
  });

  try {
    console.log('[DEBUG] fetch:', typeof fetch);
    const response = await fetch(IMG_UPLOAD_API_URL, {
      method: 'POST',
      body: form
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();
    console.log(`[LOG] 图片上传成功: ${JSON.stringify(data)}`);

    const imageUrl = data.data;
    if (imageUrl && typeof imageUrl === 'string') {
      return imageUrl;
    } else {
      throw new Error('未找到有效的图片超链接');
    }
  } catch (err) {
    console.error(`[ERR] 图片上传失败: ${err.message}`, err.response?.data || err);
    throw new Error(`图片上传失败: ${err.message}`);
  }
}

function containsSummaryKeyword(text) {
  const keywords = [
    '总结', '概括', '总结一下', '整理情况', '汇总', '回顾',
    '總結', '概括', '總結一下', '整理情況', '彙總', '回顧'
  ];
  return keywords.some(k => text.includes(k));
}

function parseDate(dtStr) {
  const d = new Date(dtStr);
  if (!isNaN(d)) {
    return d.toISOString().slice(0, 10);
  }
  return dtStr.slice(0, 10);
}

function safeVal(val) {
  if (val === 1) return '✅';
  if (val === 0) return '❎';
  return String(val);
}

function xiabanText(xiaban, part_leave_number, num) {
  if (parseInt(xiaban) === 1 || parseInt(part_leave_number) >= 1) {
    if (parseInt(xiaban) === 1 || parseInt(part_leave_number) >= parseInt(num)) {
      return ` ——＞已全部撤離`;
    } else {
      return ` ——＞已撤離${part_leave_number}/${num}人`;
    }
  }
  return '';
}

function formatSummary(data) {
  if (!Array.isArray(data) || data.length === 0) return "今日無工地記錄";
  const dateStr = parseDate(data[0].bstudio_create_time || '');
  const contrs = [];
  const seen = new Set();
  for (const rec of data) {
    const sub = rec.subcontrator || rec.subcontractor || '';
    if (sub && !seen.has(sub)) {
      contrs.push(sub);
      seen.add(sub);
    }
  }
  const mainContr = contrs.join('、');

  const details = data.map((rec, i) => {
    const loc = rec.location || '';
    const sub = rec.subcontrator || rec.subcontractor || '';
    const num = rec.number || '';
    const floor = rec.floor || '';
    const m = safeVal(rec.morning);
    const a = safeVal(rec.afternoon);
    const xiaban = rec.xiaban;
    const part_leave = rec.part_leave_number || 0;
    return `${i + 1}. ${loc} ${sub} 共 ${num} 人 樓層 ${floor}\n【安全相: 上午 ${m}，下午 ${a}】${xiabanText(xiaban, part_leave, num)}`;
  });

  return (
    `----LiftShaft (Permit to Work)------\n` +
    `日期: ${dateStr}\n` +
    `主要分判：${mainContr}\n\n` +
    `⚠指引\n` +
    `- 升降機槽工作許可證填妥及齊簽名視為開工\n` +
    `- ✅❎為安全部有冇影安全相，⭕❌為分判有冇影安全相\n` +
    `- 收工影鎖門和撤銷許可證才視為工人完全撤離及交回安全部\n\n` +
    `以下爲申請位置\n` +
    details.join('\n')
  );
}

async function replyMessage(client, msg, text, needReply) {
  if (!needReply) return;
  await client.reply(msg.from, text, msg.id);
}

async function handleEpermitBot(client, msg, groupId, needReply) {
  const content = msg.body || '';
  appendLog(groupId, `收到消息: ${content}`);

  if (containsSummaryKeyword(content)) {
    console.log('[LOG] 检测到总结关键词，调用后端获取汇总数据...');
    try {
      const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
        params: { group_id: groupId }
      });
      const summaryText = formatSummary(resp.data || []);
      await client.reply(msg.from, summaryText, msg.id);
    } catch (err) {
      console.error('[ERR] 获取汇总数据失败:', err);
      await client.reply(msg.from, '获取汇总数据失败，请稍后再试。', msg.id);
    }
    return;
  }

  try {
    const response = await sendToDify({
      query: content,
      user: msg.from,
      files: [],
      groupId
    });
    if (needReply) {
      await client.reply(msg.from, response, msg.id);
    }
  } catch (err) {
    await client.reply(msg.from, 'Dify 处理失败，请稍后再试。', msg.id);
  }
}

async function handleInspBot(client, msg, groupId, needReply) {
  let content = msg.body || '';
  let files = [];
  let outputPic = '';
  const senderId = msg.author || msg.from;
  const newOwners = [toJid(senderId)];
  const chat = await client.getChatById(msg.from);

  const mentionText = mentionTextFromIds(newOwners);

  const isImage = msg.type === 'image' || msg.type === 'album';
  const hasText = (msg.body || msg.caption || '').trim().length > 0;

  if (!isImage || !hasText) {
    console.log(`[LOG] insp-bot 消息不符合图文混合格式，isImage: ${isImage}, hasText: ${hasText}, body: ${msg.body}, caption: ${msg.caption}`);
    await replyMessage(client, msg, '目前没有记录到表格，请按照图文混合格式发送（需包含图片和文字描述）。', needReply);
    return;
  }

  // WPPConnect downloadMedia returns base64 string
  const mediaData = await client.downloadMedia(msg);
  if (mediaData) {
    const ext = mime.extension(msg.mimetype) || 'jpg';
    const filename = `img_${Date.now()}.${ext}`;
    const groupImgPath = path.join(TMP_DIR, groupId);
    if (!fs.existsSync(groupImgPath)) {
      fs.mkdirSync(groupImgPath, { recursive: true });
    }
    const filepath = path.join(groupImgPath, filename);
    // mediaData is base64 string, remove prefix if present
    const base64Data = mediaData.replace(/^data:.*;base64,/, '');
    await fsPromises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
    console.log(`[LOG] 图片已保存: ${filepath}`);

    const apiKey = groupConfig.groups[groupId]?.dify?.workflow?.apiKey || DEFAULT_DIFY_API_KEY;
    const file_id = await uploadFileToDify(filepath, msg.from, 'image', apiKey);
    console.log(`[LOG] 图片已上传到Dify，file_id: ${file_id}`);
    files.push({
      type: 'image',
      transfer_method: 'local_file',
      upload_file_id: file_id
    });

    outputPic = await uploadImageToFeishu(filepath);
    console.log(`[LOG] 图片已上传到飞书，URL: ${outputPic}`);

    const caption = msg.caption || msg.body || '';
    content = `[图片] ${caption}`;
    console.log('[LOG] 图文消息内容:', content);

    await fsPromises.unlink(filepath);
    console.log(`[LOG] 临时图片文件已删除: ${filepath}`);
  } else {
    console.log('[ERR] 下载图片失败');
    await replyMessage(client, msg, '图片下载失败，请重新发送。', needReply);
    return;
  }
  console.log(`[LOG] 处理前的消息内容: ${content}`);
  const processedBody = await parseMessageMentions(client, msg, content);
  console.log(`[LOG] 处理后的消息内容: ${processedBody}`);

  try {
    const response = await sendToDify({
      query: processedBody,
      user: msg.from,
      files,
      groupId
    });

    if (response && typeof response === 'object') {
      const replyText = `检查记录：人员：${response.person || '未知'}，日期：${response.insp_date || ''} ，时间点：${response.insp_time || ''}，地点：${response.insp_location || '未知'}，内容：${response.insp_content || '未知'}`;
      if (0) {
        console.error(`[ERR] 未写入多维表格，因为某些信息未知: ${replyText}`);
        appendLog(groupId, `未写入多维表格，因为某些信息未知: ${replyText}`);
        await replyMessage(client, msg, `[ERR] 未写入多维表格，因为某些信息未知: ${replyText}`, needReply);
        await safeSendWithMentions(
          client,
          chat.id._serialized,
          `已指派负责人：${mentionText}`,
          newOwners
        );
      } else {
        await sendToBiTableRecordAdd(response, outputPic);
        const mentionJids = (replyText.match(/@\d{5,}/g) || []).map(m => toCUsJid(m.substring(1)));
        if (needReply) {
          await safeSendWithMentions(client, chat.id._serialized, replyText, mentionJids);
        }
      }
    } else {
      await replyMessage(client, msg, 'InspBot 处理完成，但未生成有效记录。', needReply);
    }
  } catch (err) {
    console.error('[ERR] InspBot 处理失败:', err);
    await replyMessage(client, msg, 'InspBot 处理失败，请稍后再试。', needReply);
  }
}

async function handleSummaryBot(client, msg, groupId) {
  const chat = await client.getChatById(msg.from);
  if (!chat.isGroup) return;

  let body = (msg.body || '').trim();
  console.log(`[LOG] 原始消息内容: ${body}`);
  body = await parseMessageMentionsNumber(client, msg, body, chat.isGroup);
  console.log(`[LOG] parseMessageMentionsNumber处理后的消息内容: ${body}`);
  const senderId = msg.author || msg.from;

  tasksStore[groupId] = tasksStore[groupId] || [];

  if (msg.quotedMsgId) {
    const acted = await handleQuotedReply(client, msg, groupId, senderId, body);
    if (acted) return;
  }

  const isCommand = /^!/.test(body);
  const isExplicitCreate = /^\s*(?:任务|待办|TODO)\s*[:：]/i.test(body);

  if (!isCommand && !isExplicitCreate) {
    const acted = await processNaturalLanguage(client, msg, groupId, body, senderId);
    if (acted) return;
  }

  if (isExplicitCreate) {
    const created = await explicitCreateFromMessage(client, msg, groupId, body, senderId);
    if (created) return;
  }

  const isOwnerOrCreator = (task, uid) =>
    (task.creator === uid) || (Array.isArray(task.owners) && task.owners.includes(uid));

  const isAutoDone = (text) => /(完成|已处理|已解決|已解决|done)\b/i.test(text || '');

  try {
    if (msg.quotedMsgId) {
      const quoted = await client.getMessageById(msg.quotedMsgId);
      const qid = quoted?.id || ''; // WPPConnect id is string
      if (qid) {
        let task = tasksStore[groupId].find(t => t.messageId === qid);
        if (!task) {
          const quotedBody = (quoted.body || '').trim();
          const taskIdMatch = quotedBody.match(/\*T\d{6,}\*/);
          if (taskIdMatch) {
            const taskId = taskIdMatch[0].replace(/\*/g, '');
            task = tasksStore[groupId].find(t => t.id === taskId);
          }
        }

        if (task && isOwnerOrCreator(task, senderId)) {
          const added = addProgress(task, body, senderId, msg.id);

          if (isAutoDone(body)) {
            if (task.status === 'done') {
              await client.reply(msg.from, `任务 *${task.id}* 已是完成状态。`, msg.id);
              return true;
            }
            task.status = 'done';
            task.history.push({ at: new Date().toISOString(), by: senderId, action: 'auto-done' });
            saveTasks();
            await client.reply(msg.from, `✅ 任务 *${task.id}* 已更新为【已完成】`, msg.id);
            return true;
          }

          if (added) {
            saveTasks();
            await client.reply(msg.from, `📝 已记录 *${task.id}* 的最新进展。`, msg.id);
            return true;
          }
        }
      }
    }
  } catch (e) {
    console.error('[SummaryBot] 处理引用回复失败：', e);
  }

  if (/^!help\b/i.test(body)) {
    return client.sendText(msg.from,
      'SummaryBot 用法：\n' +
      '• 创建：任务: 任务内容 @负责人1 @负责人2 截止: 2025-08-31\n' +
      '• 列表：!tasks（未完成） | !tasks all（全部）\n' +
      '• 我的：!mine（我负责的未完成）\n' +
      '• 完成：!done T123456\n' +
      '• 指派：!assign T123456 @某人1 @某人2\n' +
      '• 进展：!note T123456 这里填写最新进展\n' +
      '• 详情：!detail T123456\n' +
      '说明：负责人/创建者回复任务消息会自动记录“最新进展”；含“完成/已处理/done”将自动结单'
    );
  }

  if (/^!done\s+T\d{6,}$/i.test(body)) {
    const taskId = body.split(/\s+/)[1];
    const task = tasksStore[groupId].find(t => t.id === taskId);
    if (!task) return client.sendText(msg.from, `未找到任务 ${taskId}`);
    if (!isOwnerOrCreator(task, senderId)) return client.sendText(msg.from, `只有负责人或创建者可完成 ${taskId}`);
    if (task.status === 'done') return client.sendText(msg.from, `任务 ${taskId} 已是完成状态。`);
    task.status = 'done';
    task.history.push({ at: new Date().toISOString(), by: senderId, action: 'done' });
    saveTasks();
    return client.sendText(msg.from, `🎉 任务 *${task.id}* 已完成：${task.text}`);
  }

  if (/^!assign\s+T\d{6,}\b/i.test(body)) {
    const parts = body.split(/\s+/);
    const taskId = parts[1];
    const task = tasksStore[groupId].find(t => t.id === taskId);
    if (!task) return client.sendText(msg.from, `未找到任务 ${taskId}`);
    if (!isOwnerOrCreator(task, senderId)) return client.sendText(msg.from, `只有负责人或创建者可指派 ${taskId}`);

    const ownerJidsFromMentions = await ownersFromMentions(client, msg);

    if (!ownerJidsFromMentions.length) return client.sendText(msg.from, '请 @ 至少一位负责人。');

    task.owners = Array.from(new Set([...(task.owners || []).map(toJid), ...ownerJidsFromMentions]));
    task.history.push({ at: new Date().toISOString(), by: senderId, action: 'assign', owners: task.owners });
    saveTasks();

    const mentionText = mentionTextFromIds(task.owners);

    return client.sendText(
      msg.from,
      `✅ 已为 *${task.id}* 指派负责人：${mentionText}`,
      { mentionedJidList: task.owners }
    );
  }

  if (/^!note\s+T\d{6,}\b/i.test(body)) {
    const [_, tid, ...rest] = body.split(/\s+/);
    const text = rest.join(' ').trim();
    const task = tasksStore[groupId].find(t => t.id === tid);
    if (!task) return client.sendText(msg.from, `未找到任务 ${tid}`);
    if (!isOwnerOrCreator(task, senderId)) return client.sendText(msg.from, `只有负责人或创建者可提交进展：${tid}`);
    if (!text) return client.sendText(msg.from, '请在 !note 后填写进展内容');

    addProgress(task, text, senderId, msg.id);
    if (isAutoDone(text)) {
      task.status = 'done';
      task.history.push({ at: new Date().toISOString(), by: senderId, action: 'auto-done' });
    }
    saveTasks();
    return client.reply(msg.from, `📝 已记录 *${tid}* 的最新进展。`, msg.id);
  }

  if (/^!detail\s+T\d{6,}\b/i.test(body)) {
    const tid = body.split(/\s+/)[1];
    const task = tasksStore[groupId].find(t => t.id === tid);
    if (!task) return client.sendText(msg.from, `未找到任务 ${tid}`);

    const owners = mentionTextFromIds(task.owners || []);
    const prog = (task.progress || []).slice(-3).map(p => {
      const who = '@' + String(p.by).split('@')[0];
      const tstr = new Date(p.at).toLocaleString();
      return `- ${tstr} ${who}: ${p.text}`;
    }).join('\n') || '（暂无进展）';

    return client.sendText(
      msg.from,
      `📌 任务 *${task.id}*\n` +
      `内容：${task.text}\n` +
      `状态：${task.status === 'done' ? '✅ 已完成' : '进行中'}\n` +
      (task.due ? `截止：${task.due}\n` : '') +
      `负责人：${owners || '未指定'}\n` +
      `创建：${new Date(task.createdAt).toLocaleString()}\n` +
      `最近进展：\n${prog}`
    );
  }

  if (/^!tasks\b/i.test(body)) {
    const showAll = /\ball\b/i.test(body);
    const list = tasksStore[groupId]
      .filter(t => (showAll ? true : t.status === 'open'))
      .slice(-50);

    if (!list.length) {
      return client.sendText(msg.from, showAll ? '当前没有任务。' : '当前没有未完成任务。');
    }

    const ownerJidSet = new Set();
    const lines = list.map(t => {
      (t.owners || []).forEach(raw => {
        const jid = toJid(raw);
        if (jid) ownerJidSet.add(jid);
      });

      const ownersTxt = mentionTextFromIds(t.owners || []);
      const mark = t.status === 'done' ? ' ✅' : (t.latestProgress ? ' 📝' : (t.responded ? ' 💬' : ''));
      const due = t.due ? ` (截止:${t.due})` : '';
      return `• *${t.id}* ${t.text}${due} ${ownersTxt}${mark}`;
    }).join('\n');

    const mentionJids = Array.from(ownerJidSet);

    const header = showAll ? '📋 全部任务（最多50条）' : '🗒 未完成任务（最多50条）';
    return client.sendText(msg.from, `${header}\n${lines}`, {
      mentionedJidList: mentionJids
    });
  }

  if (/^!mine\b/i.test(body)) {
    const me = senderId;
    const mine = tasksStore[groupId].filter(t => t.status === 'open' && (t.owners || []).includes(me));
    if (!mine.length) return client.sendText(msg.from, '你名下暂无未完成任务。');
    const lines = mine.map(t => {
      const mark = t.latestProgress ? ' 📝' : (t.responded ? ' 💬' : '');
      return `• *${t.id}* ${t.text} ${t.due ? `(截止:${t.due})` : ''}${mark}`;
    }).join('\n');
    return client.sendText(msg.from, `👤 你的未完成任务：\n${lines}`);
  }

  if (/^\s*(?:任务|待办|TODO)\s*[:：]/i.test(body)) {
    let structured = null;
    try { structured = await extractTaskWithDify(body, groupId, senderId); } catch { }

    const due = structured?.fields?.due || parseDueDate(body);
    const text = structured?.fields?.text || stripTaskDecorations(body);

    const ownersFromMsg = await ownersFromMentions(client, msg);
    const ownersInput = (structured?.owners && structured.owners.length)
      ? structured.owners
      : ownersFromMsg;

    const ownersJids = Array.from(new Set((ownersInput || []).map(toJid).filter(Boolean)));

    const task = {
      id: 'T' + Date.now().toString().slice(-6),
      groupId,
      messageId: msg.id || '',
      creator: senderId,
      owners: ownersJids,
      text,
      due: due || null,
      status: 'open',
      createdAt: new Date().toISOString(),
      responded: false,
      latestProgress: null,
      progress: [],
      history: [{ at: new Date().toISOString(), by: senderId, action: 'create' }]
    };

    tasksStore[groupId].push(task);
    saveTasks();

    const header = `✅ 已创建任务 *${task.id}*`;
    const bodyText = `内容：${task.text}\n` + (task.due ? `截止：${task.due}\n` : '');
    const ownersText = ownersJids.length ? `负责人：${atTextFromJids(ownersJids)}\n` : '负责人：未指定\n';
    const tips = `指令：!tasks | !mine | !done ${task.id} | !assign ${task.id} @负责人 | !note ${task.id} 进展 | !detail ${task.id}`;

    return safeSendWithMentions(client, msg.from, `${header}\n${bodyText}${ownersText}${tips}`, ownersJids);
  }

  const idHit = body.match(/\bT\d{6,}\b/);
  if (idHit) {
    const task = tasksStore[groupId].find(t => t.id === idHit[0]);
    if (task && isOwnerOrCreator(task, senderId) && !/^!/.test(body)) {
      const added = addProgress(task, body, senderId, msg.id);
      if (isAutoDone(body)) {
        task.status = 'done';
        task.history.push({ at: new Date().toISOString(), by: senderId, action: 'auto-done' });
      }
      if (added || isAutoDone(body)) {
        saveTasks();
      }
    }
  }
}

async function handleEmailBot(client, msg, groupId) {
  await client.reply(msg.from, 'EmailBot 功能开发中...', msg.id);
}

async function handlePlanBot(client, msg, groupId, isGroup) {
  try {
    // 步骤1: 提取发送人信息（缓存以避免重复调用）
    const senderId = msg.author || msg.from;
    const SenderContact = await client.getContact(senderId);
    let contactPhone = await getSenderPhoneNumber(client, senderId);
    const senderInfo = `发送人number: ${contactPhone || 'undefined'} name: ${SenderContact.name || 'undefined'}, pushname: ${SenderContact.pushname || 'undefined'}`;
    console.log('[DEBUG 发送人的number, name, pushname分别是]', contactPhone, SenderContact.name, SenderContact.pushname);

    // 获取群组名称
    const chat = await client.getChatById(msg.from);
    const groupName = isGroup ? (chat.name || chat.contact?.name || chat.groupMetadata?.subject || chat.formattedTitle || '未知群組') : '非群組';

    // 步骤2: 根据消息类型提取纯文本 query（避免 Base64 污染）
    let query = await extractMessageText(client, msg);
    if (!query) {
      query = '[未识别内容]';
    }
    console.log(`[LOG] 原始消息内容: ${query}`);

    // 步骤3: 处理引用消息
    if (msg.quotedMsgId) {
      const quoted = await client.getMessageById(msg.quotedMsgId);
      const qid = quoted?.id || '';
      if (qid) {
        const quotedText = await extractMessageText(client, quoted);  // 使用提取函数确保纯文本
        const quotedMsg = await parseMessageMentionsNumber(client, quoted, quotedText || '', isGroup);
        query += ` 引用消息: ${quotedMsg} qid: ${qid}`;
      }
    }

    // 步骤4: 处理 mentions 和映射替换
    query = await parseMessageMentionsNumber(client, msg, query, isGroup);
    console.log(`[LOG] parseMessageMentionsNumber 处理后消息内容: ${query}`);

    // 步骤5: 追加发送人信息和群组 ID
    query += ` ${senderInfo} [group_id:${groupId}] [group_name:${groupName}]`;

    // 步骤6: 检查是否为空或无效；早返回
    const isImage = msg.type === 'image' || msg.type === 'album';
    const isMedia = isImage || msg.type === 'document';  // 可扩展其他媒体
    if (!query.trim() || query === '[未识别内容]') {
      if (!isGroup || shouldReply(msg, BOT_NAME)) {
        await client.reply(msg.from, '未识别到有效内容。', msg.id);
        console.log('未识别到有效内容，已回复用户');
        appendLog(groupId, '未识别到有效内容，已回复用户');
      }
      if (!isMedia) {
        console.log('当前的消息类型是 直接返回', msg.type);
        return;
      }
    }

    console.log('收到消息类型是msg.type', msg.type);

    // 步骤7: 处理媒体上传（仅媒体类型）
    const images = [];
    if (isMedia) {
      console.log('当前的消息类型是msg.type', msg.type);
      const mediaData = await client.downloadMedia(msg);
      if (!mediaData) {
        throw new Error(`无法下载媒体: ${msg.type}`);
      }

      const groupImgPath = path.join(TMP_DIR, groupId);
      await fsPromises.mkdir(groupImgPath, { recursive: true });

      let tempFilePath;
      let ext = 'jpg';  // 默认图像
      if (msg.type === 'document') {
        ext = mime.extension(msg.mimetype) || 'pdf';
      }
      tempFilePath = path.join(groupImgPath, `temp-${msg.type}-${Date.now()}.${ext}`);

      // 处理 Base64（假设 mediaData 为 base64 字符串）
      const base64Data = typeof mediaData === 'string' ? mediaData.replace(/^data:.*;base64,/, '') : mediaData;
      await fsPromises.writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));

      // 上传逻辑（图像/文档通用；若文档需特殊处理，可扩展）
      const imageUrl = await uploadImageToFeishu(tempFilePath);  // 假设支持文档
      console.log(`[LOG] 媒体已上传到飞书，URL: ${imageUrl}`);
      images.push(imageUrl);

      // 清理临时文件
      await fsPromises.unlink(tempFilePath).catch(() => { });  // 忽略删除错误
    }

    // 步骤8: 决定是否回复
    const needReply = isGroup && shouldReply(msg, BOT_NAME);
    console.log(`是否需要AI回复: ${needReply}`);
    appendLog(groupId, `是否需要AI回复: ${needReply}`);

    // 步骤9: 调用 FastGPT
    let replyStr;
    try {
      console.log(`开始调用FastGPT，query: ${query}`);
      appendLog(groupId, `开始调用FastGPT，query: ${query}`);
      if (images.length > 0) {
        replyStr = await sendToFastGPTWithMedia({
          query,
          images,
          user: msg.from,
          group_id: msg.from
        });
      } else {
        replyStr = await sendToFastGPT({ query, user: msg.from, group_id: groupId });
      }
      console.log(`FastGPT response content: ${replyStr}`);
      appendLog(groupId, `FastGPT 调用完成，content: ${replyStr}`);
    } catch (e) {
      console.log(`FastGPT 调用失败: ${e.message}`);
      appendLog(groupId, `FastGPT 调用失败: ${e.message}`);
      if (needReply) {
        await client.reply(msg.from, '调用 FastGPT 失败，请稍后再试。', msg.id);
      }
      return;
    }

    // 步骤10: 执行回复
    if (needReply) {
      try {
        console.log(`尝试回复用户: ${replyStr}`);
        appendLog(groupId, `尝试回复用户: ${replyStr}`);
        await client.reply(msg.from, replyStr, msg.id);
        console.log('已回复用户');
        appendLog(groupId, '已回复用户');
      } catch (e) {
        console.log(`回复用户失败: ${e.message}`);
        appendLog(groupId, `回复用户失败: ${e.message}`);
      }
    } else {
      console.log('群聊未触发关键词，不回复，仅上传FastGPT');
      appendLog(groupId, '群聊未触发关键词，不回复，仅上传FastGPT');
    }

  } catch (err) {
    console.log(`处理消息出错: ${err.message}`);
    appendLog(msg.from || groupId, `处理消息出错: ${err.message}`);
    console.log('处理消息时发生异常');
    appendLog(msg.from || groupId, '处理消息时发生异常');
  }
}

// 辅助函数：提取消息纯文本（新引入，避免污染）
async function extractMessageText(client, msg) {
  switch (msg.type) {
    case 'chat':
      return (msg.body || '').trim();
    case 'image':
    case 'album':
      return (msg.caption || '[图片消息]').trim();
    case 'document':
      return (msg.caption || msg.body?.toString().trim() || `[文档: ${msg.mimetype}]`).trim();
    case 'ptt':
    case 'audio':
      // 若需转文字，可异步调用 audioToText；此处假设预处理
      return '[语音消息]';  // 或 await audioToText(...) 若集成
    default:
      return (msg.caption || msg.body || '[未知消息]').trim();
  }
}

async function handleWatchBot(client, msg, groupId, isGroup) {
  try {
    query = (msg.body || '').trim();
    console.log(`[LOG] 原始消息内容: ${query}`);
    appendLog(groupId, `[LOG] 原始消息内容: ${query}`);
    const SenderContact = await client.getContact(msg.author || msg.from);
    let contactPhone = await getSenderPhoneNumber(client, msg.author || msg.from);
    console.log('[DEBUG 发送人的number, name, pushname分别是]', contactPhone, SenderContact.name, SenderContact.pushname);
    appendLog(groupId, '[DEBUG 发送人的number, name, pushname分别是]', contactPhone, SenderContact.name, SenderContact.pushname);

    if (!query) {
      if (!isGroup || shouldReply(msg, BOT_NAME)) {
        await client.reply(msg.from, '未识别到有效内容。', msg.id);
        console.log('未识别到有效内容，已回复用户');
        appendLog(groupId, '未识别到有效内容，已回复用户');
      }
    }
    console.log('收到消息类型是msg.type', msg.type);
    // —— 是否触发AI回复？只在群聊中检测 @机器人 或 /ai ——
    const needReply = isGroup && shouldReply(msg, BOT_NAME);
    console.log(`是否需要AI回复: ${needReply}`);
    appendLog(groupId, `是否需要AI回复: ${needReply}`);

    // —— 调用 FastGPT，拿到返回的 JSON 数据 ——
    let replyStr;
    try {
      replyStr = await sendToFastGPT({ query, user: msg.from, group_id: groupId});
      console.log(`FastGPT response content: ${replyStr}`);
      appendLog(groupId, `FastGPT 调用完成，content: ${replyStr}`);
    } catch (e) {
      console.log(`FastGPT 调用失败: ${e.message}`);
      appendLog(groupId, `FastGPT 调用失败: ${e.message}`);
      if (needReply) await client.reply(msg.from, '调用 FastGPT 失败，请稍后再试。', msg.id);
      return;
    }

    // —— 回复用户 ——
    if (needReply) {
      try {
        console.log(`尝试回复用户: ${replyStr}`);
        appendLog(groupId, `尝试回复用户: ${replyStr}`);
        await client.reply(msg.from, replyStr, msg.id);
        console.log('已回复用户');
        appendLog(groupId, '已回复用户');
      } catch (e) {
        console.log(`回复用户失败: ${e.message}`);
        appendLog(groupId, `回复用户失败: ${e.message}`);
      }
    } else {
      console.log('群聊未触发关键词，不回复，仅上传FastGPT');
      appendLog(groupId, '群聊未触发关键词，不回复，仅上传FastGPT');
    }

  } catch (err) {
    console.log(`处理消息出错: ${err.message}`);
    appendLog(msg.from, `处理消息出错: ${err.message}`);
    // try { await msg.reply('机器人处理消息时出错，请稍后再试。'); } catch { }
    console.log('处理消息时发生异常');
    appendLog(msg.from, '处理消息时发生异常');
  }
}

// AI 进度更新函数
async function handleProgressUpdate(client, groupId) {
  try {
    console.log(`[定时任务] 开始执行 AI 进度更新，群组: ${groupId}`);
    appendLog(groupId, `[定时任务] 开始执行 AI 进度更新`);

    // 获取群组信息
    const chat = await client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      console.log(`[定时任务] 群组 ${groupId} 不存在或不是群组，跳过`);
      return;
    }

    const groupName = chat.name || chat.contact?.name || chat.groupMetadata?.subject || '未知群組';
    const query = 'ai 進度更新';

    // 构造模拟消息对象
    const mockMsg = {
      from: groupId,
      author: groupId,
      body: query,
      type: 'chat',
      quotedMsgId: null,
      mentionedJidList: [],
      mentions: []
    };

    // 调用 handlePlanBot 处理
    await handlePlanBot(client, mockMsg, groupId, true);
    console.log(`[定时任务] 群组 ${groupId} AI 进度更新已发送`);
    appendLog(groupId, `[定时任务] AI 进度更新已发送`);
  } catch (err) {
    console.error(`[ERR] 群组 ${groupId} 发送 AI 进度更新失败:`, err);
    appendLog(groupId, `[ERR] 发送 AI 进度更新失败: ${err.message}`);
  }
}

// AI 进度总结函数
async function handleProgressSummary(client, groupId) {
  try {
    console.log(`[定时任务] 开始执行 AI 进度总结，群组: ${groupId}`);
    appendLog(groupId, `[定时任务] 开始执行 AI 进度总结`);

    // 获取群组信息
    const chat = await client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      console.log(`[定时任务] 群组 ${groupId} 不存在或不是群组，跳过`);
      return;
    }

    const groupName = chat.name || chat.contact?.name || chat.groupMetadata?.subject || '未知群組';
    const query = 'ai 進度總結';

    // 构造模拟消息对象
    const mockMsg = {
      from: groupId,
      author: groupId,
      body: query,
      type: 'chat',
      quotedMsgId: null,
      mentionedJidList: [],
      mentions: []
    };

    // 调用 handlePlanBot 处理
    await handlePlanBot(client, mockMsg, groupId, true);
    console.log(`[定时任务] 群组 ${groupId} AI 进度总结已发送`);
    appendLog(groupId, `[定时任务] AI 进度总结已发送`);
  } catch (err) {
    console.error(`[ERR] 群组 ${groupId} 发送 AI 进度总结失败:`, err);
    appendLog(groupId, `[ERR] 发送 AI 进度总结失败: ${err.message}`);
  }
}

async function uploadFileToDify(filepath, user, type = 'image', apiKey) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filepath));
  form.append('user', user);
  const res = await axios.post(
    `${DIFY_BASE_URL}/files/upload`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiKey}`
      }
    }
  );
  return res.data.id;
}

// 解析消息中的 @ 标签，合法 WhatsApp ID 转换为纯数字，不合法保持原样
async function parseMessageMentions(client, msg, body = '') {
  if (!msg || !body) {
    console.error('[ERR] Message or body is not available');
    return body || '';
  }

  // WPPConnect: mentionedJidList
  const mentions = msg.mentionedJidList || [];
  if (!mentions || mentions.length === 0) {
    console.log('[DEBUG] 没有找到 mentions');
    return body;
  }

  console.log('[DEBUG] 获取到的 mentions:', JSON.stringify(mentions, null, 2));

  // Fetch contacts to get pushnames
  const contacts = [];
  for (const jid of mentions) {
    contacts.push(await client.getContact(jid));
  }

  const pushnames = contacts.map(contact => contact.pushname || contact.name || contact.id.user);
  console.log('[DEBUG] 映射的 pushnames:', pushnames);

  let result = body;
  const mentionRegex = /@(\d+)/g;
  let mentionIndex = 0;

  result = result.replace(mentionRegex, (match, id) => {
    console.log(`[DEBUG] 处理匹配: ${match}, ID: ${id}, 索引: ${mentionIndex}`);
    if (mentionIndex < pushnames.length) {
      const replacement = `@${pushnames[mentionIndex]}`;
      console.log(`[DEBUG] 替换: ${match} -> ${replacement}`);
      mentionIndex++;
      return replacement;
    } else {
      console.log(`[DEBUG] 跳过: 索引 ${mentionIndex} 超出 pushnames 长度`);
      return match;
    }
  });

  console.log(`[DEBUG] 处理后的结果: ${result}`);
  return result;
}

function loadLidMap() {
  if (fs.existsSync(LID_MAP_FILE)) {
    try {
      const data = fs.readFileSync(LID_MAP_FILE, 'utf8');
      return JSON.parse(data);
    } catch (e) {
      console.error('加载 lid2number.json 失败:', e.message);
      return {};
    }
  }
  return {};
}

function saveLidMap(lid, number) {
  const lidMap = loadLidMap();
  if (lid && number) {
    lidMap[lid] = number;
    try {
      fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidMap, null, 2), 'utf8');
      console.log(`保存 LID: ${lid} -> ${number}`);
    } catch (e) {
      console.error('保存 lid2number.json 失败:', e.message);
    }
  }
}

// 优化后：parseMessageMentionsNumber 函数
async function parseMessageMentionsNumber(client, msg, inputQuery, isGroup = false) {
  try {
    console.log('[DEBUG] parseMessageMentionsNumber 输入 query:', inputQuery);

    // 步骤1: 强制净化输入 query（确保为纯文本，避免 Base64）
    let query = await extractMessageText(client, msg);
    if (inputQuery && inputQuery.trim() && !inputQuery.startsWith('/9j/')) {
      query = inputQuery.trim();
    }
    // 处理多行 caption：连接为单行以便日志和替换
    if (query.includes('\n')) {
      query = query.replace(/\n/g, ' ').trim();
    }
    console.log('[DEBUG] parseMessageMentionsNumber 净化后 query:', query);

    // 步骤2: 检查 mentions（原有逻辑，基于净化 query）
    const mentions = msg.mentions || [];
    if (mentions.length > 0) {
      for (const mention of mentions) {
        const mapping = await getMentionMapping(mention);
        const regex = new RegExp(`@${mention.replace('@c.us', '')}`, 'gi');
        query = query.replace(regex, mapping || mention);
      }
      console.log('[LOG] Mentions 处理后消息内容:', query);
      return query;
    }

    // 步骤3: 无 mentions 时，使用 JSON 文件映射替换
    console.log('[DEBUG] 没有找到 mentions，使用 JSON 文件映射进行替换');

    // 加载 JSON 映射（使用缓存）
    if (!jsonMappingsCache) {
      const mappingsPath = './mappings.json';  // 调整为实际路径
      try {
        const data = await fs.readFile(mappingsPath, 'utf8');
        jsonMappingsCache = JSON.parse(data);
        console.log('[DEBUG] JSON 映射加载成功，键数:', Object.keys(jsonMappingsCache).length);
      } catch (error) {
        console.warn('[WARN] JSON 映射文件加载失败，使用空映射:', error.message);
        jsonMappingsCache = {};
      }
    }

    // 仅对非媒体/非 Base64 字符串应用替换
    if (msg.type === 'image' || msg.type === 'document' || msg.type === 'video' || query.startsWith('/9j/')) {
      query = (msg.caption || query || '[媒体消息]').replace(/\n/g, ' ').trim();
      console.log('[DEBUG] 媒体类型，强制使用 caption 作为 query:', query);
    } else {
      // 通用文本替换
      for (const [key, value] of Object.entries(jsonMappingsCache)) {
        const regex = new RegExp(key, 'gi');
        query = query.replace(regex, value);
      }
    }

    // 步骤4: 附加发送人信息（优化解析，兼容 WPPConnect）
    const senderId = msg.author || msg.from;
    let SenderContact = { number: 'unknown', name: 'unknown', pushname: 'unknown' };
    try {
      SenderContact = await client.getContact(senderId);
      let contactPhone = await getSenderPhoneNumber(client, senderId);
      SenderContact.number = contactPhone || SenderContact.number;
      // 若仍 undefined，尝试群聊成员匹配（WPPConnect 标准 API）
      if (!SenderContact.number && isGroup && msg.from.endsWith('@g.us')) {
        const groupMembers = await client.getGroupMembers(msg.from);  // 返回参与者数组
        const matchingMember = groupMembers.find(member => member.id._serialized === senderId);
        if (matchingMember) {
          SenderContact = {
            number: matchingMember.id.user || 'unknown',
            name: matchingMember.name || 'unknown',
            pushname: matchingMember.pushname || SenderContact.pushname
          };
        }
      }
    } catch (error) {
      console.warn('[WARN] 获取发送人信息失败:', error.message);
    }
    // 回退到 pushname 若可用
    if (SenderContact.pushname && (!SenderContact.name || SenderContact.name === 'undefined')) {
      SenderContact.name = SenderContact.pushname;
    }
    const senderInfo = `发送人number: ${SenderContact.number} name: ${SenderContact.name}, pushname: ${SenderContact.pushname}`;
    query += ` ${senderInfo}`;

    console.log(`[LOG] parseMessageMentionsNumber 处理后消息内容: ${query}`);
    return query;

  } catch (error) {
    console.error('[ERROR] parseMessageMentionsNumber 失败:', error);
    return inputQuery || '[处理失败]';
  }
}

// 辅助函数：获取 mention 映射（示例；根据实际实现调整）
async function getMentionMapping(mention) {
  // 示例：从缓存或文件查询
  return jsonMappingsCache?.[mention] || mention;
}

function shouldReply(msg, botName) {
  const body = msg.body || '';
  return body.includes(botName) || body.startsWith('/ai') || body.startsWith('ai ');
}

async function audioToText(filepath, user) {
  return '语音转文字结果（占位）';
}

async function handleQuotedReply(client, msg, groupId, senderId, body) {
  try {
    const isOwnerOrCreator = (task, uid) =>
      (task.creator === uid) || (Array.isArray(task.owners) && task.owners.includes(uid));

    const isAutoDone = (text) => /(完成|已处理|已解決|已解决|done)\b/i.test(text || '');

    // WPPConnect: get quoted message by ID
    if (!msg.quotedMsgId) return false;
    const quoted = await client.getMessageById(msg.quotedMsgId);
    const qid = quoted?.id || ''; // WPPConnect IDs are strings
    if (!qid) return false;

    let task = tasksStore[groupId].find(t => t.messageId === qid);
    if (!task) {
      const quotedBody = (quoted.body || '').trim();
      const taskIdMatch = quotedBody.match(/\*T\d{6,}\*/);
      if (taskIdMatch) {
        const taskId = taskIdMatch[0].replace(/\*/g, '');
        task = tasksStore[groupId].find(t => t.id === taskId);
      }
    }

    if (!task || !isOwnerOrCreator(task, senderId)) return false;

    const added = addProgress(task, body, senderId, msg.id);

    if (isAutoDone(body)) {
      if (task.status === 'done') {
        await client.reply(msg.from, `任务 *${task.id}* 已是完成状态。`, msg.id);
        return true;
      }
      task.status = 'done';
      task.history.push({ at: new Date().toISOString(), by: senderId, action: 'auto-done' });
      saveTasks();
      await client.reply(msg.from, `✅ 任务 *${task.id}* 已更新为【已完成】`, msg.id);
      return true;
    }

    if (added) {
      saveTasks();
      await client.reply(msg.from, `📝 已记录 *${task.id}* 的最新进展。`, msg.id);
      return true;
    }

    return false;
  } catch (e) {
    console.error('[SummaryBot] handleQuotedReply error:', e);
    return false;
  }
}

/**
 * 尝试从客户端获取发送者的电话号码
 * @param {Object} client - WPPConnect 客户端实例
 * @param {string} authorId - 消息作者的 ID (通常是 JID)
 * @returns {Promise<string>} 解析后的电话号码，如果获取失败则返回空字符串
 */
async function getSenderPhoneNumber(client, authorId) {
  let contactPhone = '';
  try {
    // 尝试调用 getPnLidEntry 方法获取信息
    const info = await client.getPnLidEntry(authorId);

    if (info && info.phoneNumber) {
      console.log(`发送人通讯数据: ${JSON.stringify(info)}`);
      // 从 phoneNumber 对象中提取实际的电话号码
      contactPhone = info.phoneNumber.id ? info.phoneNumber.id.replace('@c.us', '') : '';
    }
  } catch (contactError) {
    console.log('获取发送人联系信息失败:', contactError.message);
  }
  return contactPhone;
}


// Main Start Function
function start(client) {
  console.log('WhatsApp Bot 已启动 (WPPConnect)');

  client.onMessage(async msg => {
    try {
      const user = msg.from;
      let query = content = msg.body || '';
      let files = [];

      const chat = await client.getChatById(msg.from);
      const isGroup = chat.isGroup;
      const groupName = isGroup ? chat.name : '非群組';
      console.log(`收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}`);
      appendLog(user, `收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}`);

      const SenderContact = await client.getContact(msg.author || msg.from);
      let contactPhone = await getSenderPhoneNumber(client, msg.author || msg.from);
      console.log('[DEBUG 发送人的number, name, pushname分别是]',contactPhone, SenderContact.name, SenderContact.pushname);
      appendLog(user, '[DEBUG 发送人的number, name, pushname分别是]',contactPhone, SenderContact.name, SenderContact.pushname);

      if (!isGroup) {
        console.log('[LOG] 不是群聊消息，不回复用户');
        return;
      }
      ensureGroupConfig(user);

      const botType = groupConfig.groups[user]?.botType || 'epermit-bot';
      const groupId = msg.from;
      console.log('[LOG] :机器人启动类型', botType);

      if (msg.type === 'chat') {
        query = msg.body.trim();
        console.log('[LOG] 文本消息内容:', query);
      } else if (msg.type === 'image') {
        query = msg.caption || msg.body || '[图片]';
        console.log('[LOG] 图文消息内容:', query);
      } else if (['ptt', 'audio'].includes(msg.type)) {
        const mediaData = await client.downloadMedia(msg);
        if (mediaData) {
          const ext = mime.extension(msg.mimetype) || 'ogg';
          const filename = `audio_${Date.now()}.${ext}`;
          const filepath = path.join(TMP_DIR, filename);
          const base64Data = mediaData.replace(/^data:.*;base64,/, '');
          await fsPromises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          console.log(`[LOG] 语音已保存: ${filepath}`);
          query = await audioToText(filepath, user);
          console.log(`[LOG] 语音转文字结果: ${query}`);
          await fsPromises.unlink(filepath);
          console.log(`[LOG] 临时语音文件已删除: ${filepath}`);
        }
      } else if (msg.type === 'document') {  // 新增：处理文档消息
        console.log('[LOG] 收到文档消息，MIME 类型:', msg.mimetype);
        console.log('[LOG] 文档文件名:', msg.body || msg.filename || '[无文件名]');
        const mediaData = await client.downloadMedia(msg);
        if (mediaData) {
          const ext = mime.extension(msg.mimetype) || 'bin';  // 根据 MIME 类型获取扩展名
          const filename = `document_${Date.now()}.${ext}`;
          const filepath = path.join(TMP_DIR, filename);
          // mediaData 为 Buffer 或 Blob，根据库返回类型处理（此处假设 Buffer）
          await fsPromises.writeFile(filepath, mediaData);
          console.log(`[LOG] 文档已保存: ${filepath}`);

          // 可选：进一步处理文档内容（如提取 PDF 文本）
          // query = await extractDocumentText(filepath, user);  // 自定义函数示例

          query = `[文档: ${msg.body || filename}]`;  // 设置查询为文档描述
          console.log(`[LOG] 文档处理结果: ${query}`);

          // 可选：保留文件至 files 数组，或立即删除临时文件
          files.push(filepath);  // 若需后续使用
          // await fsPromises.unlink(filepath);  // 如仅日志则删除
        } else {
          console.log('[LOG] 文档下载失败');
          query = '[文档下载失败]';
        }
      } else {  // 原有不支持类型分支
        query = '[暂不支持的消息类型]';
        console.log('[LOG] 收到暂不支持的消息类型:', msg.type);
      }

      if (LOG_WHATSAPP_MSGS) {
        const logEntry = `[${new Date().toISOString()}] ${msg.from} (${msg.type}): ${msg.body || ''}\n`;
        await fsPromises.appendFile(LOG_FILE, logEntry);
        console.log('[LOG] 消息已写入日志文件');
      }

      if (!query) {
        if (!isGroup || shouldReply(msg, BOT_NAME)) {
          await client.reply(msg.from, '未识别到有效内容。', msg.id);
          console.log('[LOG] 未识别到有效内容，已回复用户');
        }
        return;
      }

      const needReply = isGroup && shouldReply(msg, BOT_NAME);
      console.log(`[LOG] 是否需要AI回复: ${needReply}`);
      if (!needReply) {
        console.log('[LOG] 群聊未触发关键词，不回复，仅上传Dify');
      }

      switch (botType) {
        case 'epermit-bot':
          await handleEpermitBot(client, msg, groupId, needReply);
          break;
        case 'insp-bot':
          await handleInspBot(client, msg, groupId, needReply);
          break;
        case 'summary-bot':
          await handleSummaryBot(client, msg, groupId);
          break;
        case 'email-bot':
          await handleEmailBot(client, msg, groupId);
          break;
        case 'ced-bot':
          await handlePlanBot(client, msg, groupId, isGroup);
          break;
        case 'plan-bot':
          await handlePlanBot(client, msg, groupId, isGroup);
          break;
        case 'watch-bot':
          await handleWatchBot(client, msg, groupId, isGroup);
          break;
        case 'process-bot':
          await handlePlanBot(client, msg, groupId, isGroup);
          break;
        default:
          await client.reply(msg.from, '未知 Bot 类型', msg.id);
      }

    } catch (err) {
      console.error('处理消息出错:', err);
      console.log('[LOG] 处理消息时发生异常');
    }
  });

  // Cron Jobs
  const GROUP_ID = '120363418441024423@g.us';
  cron.schedule('0 18 * * *', async () => {
    console.log('[定时任务] 开始执行 18:00 未撤离分判检查');
    const today = new Date().toISOString().slice(0, 10);

    for (const groupId in groupConfig.groups) {
      if (groupConfig.groups[groupId].botType !== 'epermit-bot') continue;
      try {
        const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
          params: { group_id: groupId }
        });
        const epermitData = resp.data || [];
        const notLeft = epermitData.filter(rec => parseInt(rec.xiaban) === 0);

        if (notLeft.length === 0) {
          console.log(`[定时任务] 群组 ${groupId} 今日全部撤离`);
          continue;
        }

        const lines = notLeft.map((rec, idx) => {
          const loc = rec.location || '';
          const sub = rec.subcontrator || rec.subcontractor || '';
          const num = rec.number || '';
          const floor = rec.floor || '';
          return `${idx + 1}、${loc}，${sub} ${num}人，${floor}`;
        });

        const output = `未撤離分判\n${today}\n\n${lines.join('\n')}`;
        console.log(`[LOG] 群组 ${groupId} 未撤离列表:\n${output}`);
        await client.sendText(groupId, output);
      } catch (err) {
        console.error(`[ERR] 群组 ${groupId} 获取未撤离数据失败:`, err);
        await client.sendText(groupId, '获取未撤离数据失败，请稍后再试。');
      }
    }
  });

  cron.schedule('0 * * * *', async () => {
    try {
      const now = Date.now();

      for (const gid of Object.keys(tasksStore)) {
        const list = (tasksStore[gid] || []).filter(t => t.status === 'open' && t.due);

        for (const t of list) {
          const ms = new Date(t.due + 'T23:59:59').getTime() - now;
          if (ms > 0 && ms < 24 * 3600 * 1000 && !t._reminded24h) {
            const ownerJids = Array.from(new Set((t.owners || []).map(toJid).filter(Boolean)));
            const ownersText = ownerJids.length ? `\n负责人：${mentionTextFromIds(ownerJids)}` : '';

            const text =
              `⏰ 任务 *${t.id}* 将在 24h 内到期：${t.text}\n` +
              `请尽快处理或在群里回复：!done ${t.id}${ownersText}`;

            await client.sendText(
              gid,
              text,
              ownerJids.length ? { mentionedJidList: ownerJids } : {}
            );

            t._reminded24h = true;
            saveTasks();
          }
        }
      }
    } catch (e) {
      console.error('[SummaryBot] 定时提醒失败：', e);
    }
  });

  // 定时任务：对指定群组发送 AI 进度更新和总结
  const targetGroups = ['120363268268186143@g.us', '120363422955145686@g.us'];

  // AI 进度更新：每天下午5点（香港时区 UTC+8）
  // 如果服务器是 UTC，17:00 HKT = 09:00 UTC；如果服务器是 HKT，直接使用 17:00
  cron.schedule('0 17 * * *', async () => {
    console.log('[定时任务] 开始执行 17:00 AI 进度更新（香港时区）');
    for (const groupId of targetGroups) {
      await handleProgressUpdate(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  // AI 进度总结：每天18:30（香港时区 UTC+8）
  // 如果服务器是 UTC，18:30 HKT = 10:30 UTC；如果服务器是 HKT，直接使用 18:30

  cron.schedule('00 22 * * *', async () => {
    console.log('[定时任务] 开始执行 22:00 AI 进度总结（香港时区）');
    for (const groupId of targetGroups) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  cron.schedule('00 20 * * *', async () => {
    console.log('[定时任务] 开始执行 20:00 AI 进度总结（香港时区）');
    for (const groupId of targetGroups) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  cron.schedule('30 18 * * *', async () => {
    console.log('[定时任务] 开始执行 18:30 AI 进度总结（香港时区）');
    for (const groupId of targetGroups) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  // 今天特殊定时任务：下午3点 AI 进度更新，下午4点 AI 进度总结
  cron.schedule('0 15 * * *', async () => {
    console.log('[特殊定时任务] 今天 15:00 AI 进度更新（香港时区）');
    for (const groupId of targetGroups) {
      await handleProgressUpdate(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  cron.schedule('0 16 * * *', async () => {
    console.log('[特殊定时任务] 今天 16:00 AI 进度总结（香港时区）');
    for (const groupId of targetGroups) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  // 下午2:30定时任务：针对特定群组，先执行 AI 进度更新，然后执行 AI 进度总结
}

wppconnect.create({
  session: 'whatsapp-bot-session',
  catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
    console.log('请扫描以下二维码登录 WhatsApp:');
    qrcode.generate(urlCode, { small: true });
  },
  logQR: false,
  headless: true,
  puppeteerOptions: {
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
})
  .then(client => start(client))
  .catch(error => console.log(error));



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
const express = require('express');  // 健康检查服务器

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

// 飞书 SDK
const lark = require('@larksuiteoapi/node-sdk');

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
const GROUP_FILES_API_URL = process.env.GROUP_FILES_API_URL || '';

// AdminGroups：避免 cron 叠加并发（上一轮未结束下一轮又启动）
let _adminGroupsDownloadRunning = false;
// SafetyBot 控制标志
const SAFETYBOT_LOG_ONLY = process.env.SAFETYBOT_LOG_ONLY === 'true'; // 只执行日志，不发送text或reaction
const SAFETYBOT_REACTION_ONLY = process.env.SAFETYBOT_REACTION_ONLY === 'true'; // 只发reaction，不发text

// 特定群组覆盖配置：这些群组将临时禁用 SafetyBot 标志（从环境变量读取，逗号分隔）
const SAFETYBOT_OVERRIDE_GROUPS = process.env.SAFETYBOT_OVERRIDE_GROUPS
  ? process.env.SAFETYBOT_OVERRIDE_GROUPS.split(',').map(g => g.trim())
  : []; // 从环境变量读取，未配置则为空数组

// 根据群组ID获取 SafetyBot 标志值（支持群组级别的覆盖）
function getSafetyBotLogOnly(groupId) {
  if (SAFETYBOT_OVERRIDE_GROUPS.includes(groupId)) {
    return false; // 特定群组强制禁用 LOG_ONLY
  }
  return SAFETYBOT_LOG_ONLY;
}

function getSafetyBotReactionOnly(groupId) {
  if (SAFETYBOT_OVERRIDE_GROUPS.includes(groupId)) {
    return false; // 特定群组强制禁用 REACTION_ONLY
  }
  return SAFETYBOT_REACTION_ONLY;
}
// Lark 事件回调配置
// const LARK_WEBHOOK_PORT = process.env.LARK_WEBHOOK_PORT || 3001;
const LARK_TARGET_GROUPS = process.env.LARK_TARGET_GROUPS
  ? process.env.LARK_TARGET_GROUPS.split(',').map(g => g.trim())
  : []; // 从环境变量读取，未配置则为空数组

// 飞书 SDK 客户端初始化
const LARK_APP_ID = process.env.LARK_APP_ID || 'app id';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || 'app secret';
const larkClient = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false  // SDK 自动管理租户 token 的获取与刷新
});

// === 健康检查状态 ===
let state = { status: 'STARTING' };

// === 健康检查监控配置 ===
const HEALTH_CHECK_CONFIG = {
  WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/79b4d6ce-02c2-4254-8bef-27e52e753b01',
  KEYWORD: 'WA状态报警'
};
let lastHealthStatus = '';  // 记录上次健康状态

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

  // 1. 获取当前时间并手动偏移 8 小时处理文件名
  const now = new Date();
  const utc8Time = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const dateStr = utc8Time.toISOString().slice(0, 10);

  // 2. 格式化日志内容的时间戳
  // 使用 'sv-SE' (瑞典语) 是一种小技巧，它能直接得到 YYYY-MM-DD HH:mm:ss 格式，非常整齐
  const timestamp = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });

  const logFile = path.join(groupDir, `${dateStr}.log`);

  try {
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (err) {
    console.error('Failed to write log:', err);
  }
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

// ========== Messages 构建 Helper（支持文本 + 多图 + variables） ==========
function buildMessages(contentParts, chatId, variables = {}) {
  const content = contentParts.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') return { type: 'image_url', image_url: { url: part.url } };
    throw new Error(`不支持的 type: ${part.type}`);
  });
  const data = {
    chatId,
    stream: false,
    detail: false,
    messages: [{ role: 'user', content }]
  };
  // 如果有 variables，添加到请求中
  if (Object.keys(variables).length > 0) {
    data.variables = variables;
  }
  return data;
}

// ========== 原函数：纯文本 ==========
async function sendToFastGPT({ query, user, group_id, variables = {} }) {
  const gConfig = groupConfig.groups[group_id] || groupConfig.default;
  if (!gConfig) throw new Error('未找到群組或默認配置');

  const contentParts = [{ type: 'text', text: query }];
  const data = buildMessages(contentParts, group_id, variables);
  return _postToFastGPT(data, gConfig, user);
}

// ========== 新函数：图文（query + images[]） ==========
async function sendToFastGPTWithMedia({ query, images = [], user, group_id, variables = {} }) {
  const gConfig = groupConfig.groups[group_id] || groupConfig.default;
  if (!gConfig) throw new Error('未找到群組或默認配置');

  const contentParts = [{ type: 'text', text: query }];
  images.forEach(url => contentParts.push({ type: 'image_url', url }));
  const data = buildMessages(contentParts, group_id, variables);
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

// 使用飞书 node-sdk 上传文件
async function uploadFileToFeishuWithSDK(filepath, options = {}) {
  try {
    // 获取文件信息
    const stats = fs.statSync(filepath);
    const fileSize = stats.size;
    const fileName = options.fileName || path.basename(filepath);

    // 判断是否为多维表格上传场景
    // 如果明确指定 isBitable 为 true，或者 parentType 包含 bitable，则认为是多维表格场景
    const isBitable = options.isBitable === true || options.parentType?.includes('bitable');

    // 确定 parent_type 和 parent_node
    let parentType = options.parentType;
    let parentNode = options.parentNode;

    if (isBitable) {
      // 多维表格场景：使用多维表格 token
      const bitableToken = options.parentNode || options.driveRouteToken || process.env.LARK_DRIVE_ROUTE_TOKEN || process.env.LARK_PARENT_NODE;
      if (!bitableToken) {
        throw new Error('多维表格上传需要配置 LARK_DRIVE_ROUTE_TOKEN 环境变量，或通过 options.parentNode/options.driveRouteToken 提供');
      }
      parentType = parentType || 'bitable_image'; // 多维表格上传图片使用 bitable_image
      parentNode = bitableToken; // 多维表格场景下，parent_node 就是多维表格的 token
    } else {
      // 其他场景
      parentType = parentType || 'docx_image';
      parentNode = parentNode || process.env.LARK_PARENT_NODE || '';
    }

    if (!parentNode) {
      throw new Error('parent_node 参数必需，请通过 options.parentNode 或环境变量提供');
    }

    // 构建 extra 参数（用于上传素材至云文档场景）
    // extra 格式: {"drive_route_token":"素材所在云文档的 token"}
    let extra = options.extra;
    if (!extra) {
      const driveRouteToken = options.driveRouteToken || process.env.LARK_DRIVE_ROUTE_TOKEN;
      if (driveRouteToken) {
        extra = JSON.stringify({ drive_route_token: driveRouteToken });
      }
    }

    // 使用流而不是 Buffer
    const fileStream = fs.createReadStream(filepath);

    const requestData = {
      file_name: fileName,
      parent_type: parentType,
      parent_node: parentNode,
      size: fileSize,
      file: fileStream,
    };

    // 如果提供了 extra 参数，添加到请求中
    if (extra) {
      requestData.extra = extra;
    }

    const res = await larkClient.drive.v1.media.uploadAll({
      data: requestData,
    });

    console.log(`[LOG] 飞书 SDK 上传响应: ${JSON.stringify(res)}`);

    // 根据飞书 SDK 返回的数据结构获取 file token
    // 标准格式: {code: 0, msg: "success", data: {file_token: "..."}}
    // 如果 code !== 0，表示上传失败
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(`上传失败: code=${res.code}, msg=${res.msg || '未知错误'}, 返回数据: ${JSON.stringify(res)}`);
    }

    // 支持多种返回格式：
    // 1. {code: 0, data: {file_token: "..."}} - 标准格式
    // 2. {data: {file_token: "..."}} - 没有 code 字段
    // 3. {file_token: "..."} - 直接返回（SDK 可能已解析）
    let fileToken = null;
    if (res.data && res.data.file_token) {
      fileToken = res.data.file_token;
    } else if (res.file_token) {
      fileToken = res.file_token;
    }

    if (fileToken) {
      console.log(`[LOG] 成功获取 file_token: ${fileToken}`);
      return fileToken;
    } else {
      throw new Error(`上传失败: 未找到 file_token，返回数据: ${JSON.stringify(res)}`);
    }
  } catch (err) {
    console.error(`[ERR] 飞书 SDK 上传失败: ${err.message}`, err);
    throw new Error(`飞书 SDK 上传失败: ${err.message}`);
  }
}

// ========== AdminGroups: 拉群文件并下载为本地图片 ==========
// tenant_access_token (internal) 缓存
let _tenantTokenCache = { token: null, expireAt: 0 };

async function getTenantAccessTokenInternalCached() {
  const now = Date.now();
  if (_tenantTokenCache.token && _tenantTokenCache.expireAt && now < _tenantTokenCache.expireAt) {
    return _tenantTokenCache.token;
  }

  const appId = process.env.LARK_APP_ID || LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET || LARK_APP_SECRET;
  if (!appId || !appSecret || appId === 'app id' || appSecret === 'app secret') {
    throw new Error('未配置 LARK_APP_ID / LARK_APP_SECRET，无法获取 tenant_access_token');
  }

  const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/';
  const res = await axios.post(
    url,
    { app_id: appId, app_secret: appSecret },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );

  const data = res?.data || {};
  const token = data.tenant_access_token;
  const expire = Number(data.expire || 0);
  if (!token) {
    throw new Error(`获取 tenant_access_token 失败: ${JSON.stringify(data)}`);
  }

  // 提前 60s 过期，避免临界时间出错
  _tenantTokenCache = {
    token,
    expireAt: Date.now() + Math.max(0, expire - 60) * 1000
  };
  return token;
}

function isoDateInTZ(tz = 'Asia/Hong_Kong', d = new Date()) {
  // en-CA 输出 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

function safeFilename(name = '') {
  const s = String(name || '').trim() || 'file';
  // 替换不安全字符
  return s.replace(/[\\/:*?"<>|\r\n\t]/g, '_');
}

function parseContentDispositionFilename(disposition = '') {
  const cd = String(disposition || '');
  // RFC5987: filename*=UTF-8''xxx
  const mStar = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (mStar && mStar[1]) {
    try {
      return decodeURIComponent(mStar[1].trim().replace(/^"(.*)"$/, '$1'));
    } catch {
      return mStar[1].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  const m = cd.match(/filename\s*=\s*("?)([^";]+)\1/i);
  if (m && m[2]) return m[2].trim();
  return '';
}

async function fetchLatestGroupFileRecord(groupId, dateISO) {
  // 配置兜底：未配置时直接给出明确错误，避免 axios 报 "Invalid URL" 刷屏
  if (!GROUP_FILES_API_URL || !/^https?:\/\//i.test(String(GROUP_FILES_API_URL).trim())) {
    throw new Error(
      `GROUP_FILES_API_URL 未配置或不是有效 http(s) URL：${JSON.stringify(GROUP_FILES_API_URL)}`
    );
  }

  // 后端支持 GET JSON body；bstudio_create_time 传 YYYY-MM-DD 会按当天范围查
  const payload = {
    group_id: groupId,
    bstudio_create_time: dateISO
  };

  const resp = await axios.request({
    method: 'GET',
    url: GROUP_FILES_API_URL,
    headers: { 'Content-Type': 'application/json' },
    data: payload,
    timeout: 20000
  });

  const rows = resp?.data;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // 后端已按 id DESC 排序；这里仍做一次兜底排序
  const sorted = rows.slice().sort((a, b) => {
    const ta = new Date(a?.bstudio_create_time || 0).getTime() || 0;
    const tb = new Date(b?.bstudio_create_time || 0).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return (Number(b?.id || 0) - Number(a?.id || 0));
  });

  return sorted[0] || null;
}

async function downloadFeishuMediaToLocal({ fileToken, suggestedFileName, saveDir }) {
  if (!fileToken) throw new Error('fileToken 为空');
  ensureDir(saveDir);

  const token = await getTenantAccessTokenInternalCached();
  const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`;

  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: { Authorization: `Bearer ${token}` }
  });

  const contentType = String(res.headers?.['content-type'] || '').toLowerCase();
  const cd = String(res.headers?.['content-disposition'] || '');
  const filenameFromHeader = parseContentDispositionFilename(cd);

  let filename = safeFilename(filenameFromHeader || suggestedFileName || `media_${Date.now()}`);
  // 补扩展名
  if (!/\.[a-z0-9]{2,8}$/i.test(filename)) {
    const ext = mime.extension(contentType) || 'bin';
    filename = `${filename}.${ext}`;
  }

  const outPath = path.join(saveDir, filename);
  await fsPromises.writeFile(outPath, Buffer.from(res.data));
  return { outPath, filename, contentType, bytes: Buffer.byteLength(res.data) };
}

async function handleAdminGroupDailyFileDownload(client, adminGroupId, whenLabel = '') {
  const dateISO = isoDateInTZ('Asia/Hong_Kong');
  appendLog(adminGroupId, `[AdminGroupFiles] 开始处理 ${whenLabel} 日期=${dateISO}`);
  const t0 = Date.now();
  console.log(`[AdminGroupFiles] step=begin group=${adminGroupId} label=${whenLabel} date=${dateISO}`);
  appendLog(adminGroupId, `[AdminGroupFiles] step=begin group=${adminGroupId} label=${whenLabel} date=${dateISO}`);

  // 配置缺失时直接跳过，避免定时任务持续报错刷屏
  if (!GROUP_FILES_API_URL || !/^https?:\/\//i.test(String(GROUP_FILES_API_URL).trim())) {
    const tip = `[AdminGroupFiles] 跳过：未配置 GROUP_FILES_API_URL（需要 http(s) URL），当前=${JSON.stringify(GROUP_FILES_API_URL)}`;
    console.warn(tip);
    appendLog(adminGroupId, tip);
    return null;
  }

  console.log(`[AdminGroupFiles] step=fetchLatestRecord group=${adminGroupId}`);
  appendLog(adminGroupId, `[AdminGroupFiles] step=fetchLatestRecord group=${adminGroupId}`);
  const rec = await fetchLatestGroupFileRecord(adminGroupId, dateISO);
  if (!rec) {
    appendLog(adminGroupId, `[AdminGroupFiles] 未找到当日文件: group_id=${adminGroupId}, date=${dateISO}`);
    console.log(`[AdminGroupFiles] step=noRecord group=${adminGroupId} ms=${Date.now() - t0}`);
    appendLog(adminGroupId, `[AdminGroupFiles] step=noRecord group=${adminGroupId} ms=${Date.now() - t0}`);
    return null;
  }

  const fileToken = rec.file_url;
  const fileName = rec.file_name;
  const createdAt = rec.bstudio_create_time;

  if (!fileToken) {
    appendLog(adminGroupId, `[AdminGroupFiles] 记录缺少 file_url(file_token): ${JSON.stringify(rec)}`);
    console.log(`[AdminGroupFiles] step=badRecordMissingToken group=${adminGroupId} ms=${Date.now() - t0}`);
    appendLog(adminGroupId, `[AdminGroupFiles] step=badRecordMissingToken group=${adminGroupId} ms=${Date.now() - t0}`);
    return null;
  }

  console.log(`[AdminGroupFiles] step=downloadFromFeishu group=${adminGroupId} token=${String(fileToken).slice(0, 12)}...`);
  appendLog(adminGroupId, `[AdminGroupFiles] step=downloadFromFeishu group=${adminGroupId} token=${String(fileToken).slice(0, 12)}...`);
  const saveDir = path.join(TMP_DIR, 'admin_group_files', safeFilename(adminGroupId), dateISO);
  const dl = await downloadFeishuMediaToLocal({
    fileToken,
    suggestedFileName: fileName,
    saveDir
  });

  appendLog(
    adminGroupId,
    `[AdminGroupFiles] 下载成功: token=${fileToken}, createdAt=${createdAt}, name=${fileName} => ${dl.outPath} (${dl.bytes} bytes, ${dl.contentType})`
  );
  console.log('[AdminGroupFiles] 下载成功:', { adminGroupId, dateISO, fileToken, fileName, outPath: dl.outPath });
  appendLog(adminGroupId, `[AdminGroupFiles] 下载成功: outPath=${dl.outPath} bytes=${dl.bytes} contentType=${dl.contentType}`);

  // === 发送图片到指定 WhatsApp 群 ===
  try {
    const targetGroupId = '120363405248038757@g.us';
    const isImage = /^image\//i.test(dl.contentType) || /\.(jpg|jpeg|png|gif|webp)$/i.test(dl.filename);

    if (isImage) {
      await client.sendImage(
        targetGroupId,
        dl.outPath,
        dl.filename,
        ''
      );
      console.log(`[AdminGroupFiles] 已发送图片到群 ${targetGroupId}: ${dl.outPath}`);
      appendLog(adminGroupId, `[AdminGroupFiles] 已发送图片到群 ${targetGroupId}: ${dl.outPath}`);
    } else {
      console.log(`[AdminGroupFiles] 文件不是图片类型，跳过发送: contentType=${dl.contentType}, filename=${dl.filename}`);
      appendLog(adminGroupId, `[AdminGroupFiles] 文件不是图片类型，跳过发送: contentType=${dl.contentType}`);
    }
  } catch (e) {
    console.error('[AdminGroupFiles] 发送图片到 WhatsApp 群失败:', e);
    appendLog(adminGroupId, `[AdminGroupFiles] 发送图片到 WhatsApp 群失败: ${e.message || e}`);
  }

  console.log(`[AdminGroupFiles] step=done group=${adminGroupId} ms=${Date.now() - t0}`);
  appendLog(adminGroupId, `[AdminGroupFiles] step=done group=${adminGroupId} ms=${Date.now() - t0}`);
  return { record: rec, download: dl };
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

async function handleSafetyBot(client, msg, groupId, isGroup) {
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
    const logOnly = getSafetyBotLogOnly(groupId);
    if (!query.trim() || query === '[未识别内容]') {
      if (!logOnly && (!isGroup || shouldReply(msg, BOT_NAME))) {
        await client.reply(msg.from, '未识别到有效内容。', msg.id);
        console.log('未识别到有效内容，已回复用户');
        appendLog(groupId, '未识别到有效内容，已回复用户');
      } else if (logOnly) {
        console.log('[LOG_ONLY模式] 跳过发送"未识别到有效内容"回复');
        appendLog(groupId, '[LOG_ONLY模式] 未识别到有效内容，跳过回复');
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

      // 支持相册场景：如果是 album，并且存在 medias 数组，则对每一张图片单独处理
      const mediaMessages =
        msg.type === 'album' && Array.isArray(msg.medias) && msg.medias.length
          ? msg.medias
          : [msg];

      const groupImgPath = path.join(TMP_DIR, groupId);
      await fsPromises.mkdir(groupImgPath, { recursive: true });

      for (const mediaMsg of mediaMessages) {
        const mediaData = await client.downloadMedia(mediaMsg);
        if (!mediaData) {
          throw new Error(`无法下载媒体: ${mediaMsg.type}`);
        }

        let tempFilePath;
        let ext = 'jpg'; // 默认图像
        if (mediaMsg.type === 'document') {
          ext = mime.extension(mediaMsg.mimetype) || 'pdf';
        }
        tempFilePath = path.join(groupImgPath, `temp-${mediaMsg.type}-${Date.now()}.${ext}`);

        // 处理 Base64（假设 mediaData 为 base64 字符串）
        const base64Data =
          typeof mediaData === 'string' ? mediaData.replace(/^data:.*;base64,/, '') : mediaData;
        await fsPromises.writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));

        // 上传逻辑（图像/文档通用；若文档需特殊处理，可扩展）
        // 使用多维表格上传（自动从环境变量读取 LARK_DRIVE_ROUTE_TOKEN）
        const image_token = await uploadFileToFeishuWithSDK(tempFilePath, { isBitable: true });
        console.log(`[LOG] 媒体已上传到飞书，ID: ${image_token}`);
        images.push(image_token);

        // 将图片URL添加到query中
        if (image_token) {
          query += ` [图片ID: ${image_token}]`;
        }

        // 清理临时文件
        await fsPromises.unlink(tempFilePath).catch(() => { }); // 忽略删除错误
      }
    }

    // 步骤8: 决定是否回复
    const needReply = isGroup;
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
      const logOnly = getSafetyBotLogOnly(groupId);
      if (needReply && !logOnly) {
        await client.reply(msg.from, '调用 FastGPT 失败，请稍后再试。', msg.id);
      } else if (needReply && logOnly) {
        console.log('[LOG_ONLY模式] 跳过发送"调用 FastGPT 失败"回复');
        appendLog(groupId, '[LOG_ONLY模式] FastGPT 调用失败，跳过回复');
      }
      return;
    }

    // 步骤10: 执行回复或反应
    if (needReply) {
      try {
        // 如果设置了 LOG_ONLY flag，只记录日志，不发送任何消息
        const logOnly = getSafetyBotLogOnly(groupId);
        const reactionOnly = getSafetyBotReactionOnly(groupId);
        if (logOnly) {
          console.log('[LOG_ONLY模式] 跳过发送，仅记录日志');
          appendLog(groupId, `[LOG_ONLY模式] FastGPT响应: ${replyStr}`);
          return;
        }

        // 1. 如果是闲聊消息，直接返回（优先级高）
        if (replyStr && (replyStr.includes('闲聊消息') || replyStr.includes('閑聊消息') || replyStr.trim() === '闲聊消息' || replyStr.trim() === '閑聊消息')) {
          console.log('[SafetyBot] 检测到闲聊消息，跳过回复/反应');
          appendLog(groupId, `[SafetyBot] 检测到闲聊消息，跳过回复/反应: ${replyStr}`);
          return;
        }

        // 2. 特殊消息处理：如果包含失败提示，则回复括号内的内容并发送 reaction
        const failureMatch = replyStr && replyStr.match(/[失失][败敗]\s*[（(]([\s\S]+?)[）)]/u);
        if (failureMatch && failureMatch[1]) {
          const errorReply = failureMatch[1].trim();
          if (errorReply) {
            console.log(`[SafetyBot] 匹配到失败消息，回复: ${errorReply}`);
            appendLog(groupId, `[SafetyBot] 匹配到失败消息，回复: ${errorReply}`);
            if (!reactionOnly) {
              await client.reply(msg.from, errorReply, msg.id);
            }
            await client.sendReactionToMessage(msg.id, '❌');
            return;
          }
        } else if (replyStr && (replyStr.includes('失败') || replyStr.includes('失敗')) && (replyStr.includes('（') || replyStr.includes('('))) {
          // 兜底逻辑：如果包含失败和括号，但正则没匹配上，记录一下原因
          console.log(`[SafetyBot] 检测到可能的失败消息但正则匹配失败: "${replyStr}"`);
          appendLog(groupId, `[SafetyBot] 检测到可能的失败消息但正则匹配失败: "${replyStr}"`);
        }

        // 检查是否包含日期分段标记
        const hasDateSegments = replyStr.includes('<<今日>>') ||
          replyStr.includes('<<昨日>>') ||
          replyStr.includes('<<前日>>');

        if (hasDateSegments) {
          // 按照 <<今日>>、<<昨日>>、<<前日>> 的顺序分割并发送
          const segments = [];
          const markers = ['<<今日>>', '<<昨日>>', '<<前日>>'];

          for (let i = 0; i < markers.length; i++) {
            const marker = markers[i];
            if (replyStr.includes(marker)) {
              const startIndex = replyStr.indexOf(marker);
              const endIndex = i < markers.length - 1
                ? replyStr.indexOf(markers[i + 1], startIndex + marker.length)
                : replyStr.length;

              let segment = '';
              if (endIndex === -1) {
                segment = replyStr.substring(startIndex);
              } else {
                segment = replyStr.substring(startIndex, endIndex);
              }

              // 去掉标记 <<今日>>、<<昨日>>、<<前日>>
              segment = segment.replace(/<<今日>>|<<昨日>>|<<前日>>/g, '').trim();
              segments.push(segment);
            }
          }

          // 如果设置了 REACTION_ONLY flag，不发送分段消息
          if (!reactionOnly) {
            // 按顺序发送每条消息
            for (const segment of segments) {
              console.log(`尝试发送分段消息: ${segment.substring(0, 50)}...`);
              appendLog(groupId, `尝试发送分段消息`);
              await client.reply(msg.from, segment, msg.id);
              console.log('已发送分段消息');
              appendLog(groupId, '已发送分段消息');
              // 添加短暂延迟，避免消息发送过快
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          } else {
            console.log('[REACTION_ONLY模式] 跳过发送分段消息');
            appendLog(groupId, '[REACTION_ONLY模式] 跳过发送分段消息');
          }
        } else {
          // 原有的逻辑：检查 FastGPT 返回内容是否包含"成功"或"失败"
          let reactionEmoji = null;
          const hasCreateSuccess = replyStr.includes('創建成功') || replyStr.includes('创建成功');
          if (replyStr.includes('成功')) {
            reactionEmoji = '✅';
          } else if (replyStr.includes('失败') || replyStr.includes('失敗')) {
            reactionEmoji = '❌';
          }

          if (reactionEmoji === '✅') {
            // 包含"成功"：发送 reaction
            console.log(`尝试发送反应: ${reactionEmoji}`);
            appendLog(groupId, `尝试发送反应: ${reactionEmoji}`);
            await client.sendReactionToMessage(msg.id, reactionEmoji);
            console.log('已发送反应');
            appendLog(groupId, `已发送反应: ${reactionEmoji}`);

            // 只有包含"創建成功"时才发送 reply（如果未设置 REACTION_ONLY）
            if (hasCreateSuccess && !reactionOnly) {
              console.log(`尝试回复用户: ${replyStr}`);
              appendLog(groupId, `尝试回复用户: ${replyStr}`);
              await client.reply(msg.from, replyStr, msg.id);
              console.log('已回复用户');
              appendLog(groupId, '已回复用户');
            } else if (hasCreateSuccess && reactionOnly) {
              console.log('[REACTION_ONLY模式] 跳过发送文本回复');
              appendLog(groupId, '[REACTION_ONLY模式] 跳过发送文本回复');
            }
          } else if (reactionEmoji === '❌') {
            // 包含"失败"：发送 reaction
            console.log(`尝试发送反应: ${reactionEmoji}`);
            appendLog(groupId, `尝试发送反应: ${reactionEmoji}`);
            await client.sendReactionToMessage(msg.id, reactionEmoji);
            console.log('已发送反应');
            appendLog(groupId, `已发送反应: ${reactionEmoji}`);
            // 之前已在特殊消息处理中处理过不一致逻辑
          } else {
            // 其他情况使用 reply（如果未设置 REACTION_ONLY）
            if (!reactionOnly) {
              console.log(`尝试回复用户: ${replyStr}`);
              appendLog(groupId, `尝试回复用户: ${replyStr}`);
              await client.reply(msg.from, replyStr, msg.id);
              console.log('已回复用户');
              appendLog(groupId, '已回复用户');
            } else {
              console.log('[REACTION_ONLY模式] 跳过发送文本回复');
              appendLog(groupId, '[REACTION_ONLY模式] 跳过发送文本回复');
            }
          }
        }
      } catch (e) {
        console.log(`回复/反应失败: ${e.message}`);
        appendLog(groupId, `回复/反应失败: ${e.message}`);
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
      replyStr = await sendToFastGPT({ query, user: msg.from, group_id: groupId });
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
// 往日总结函数（昨日總結 + 往日總結）
async function handlePastSummary(client, groupId) {
  try {
    console.log(`[定时任务] 开始执行往日总结，群组: ${groupId}`);
    appendLog(groupId, `[定时任务] 开始执行往日总结`);

    // 获取群组信息
    const chat = await client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      console.log(`[定时任务] 群组 ${groupId} 不存在或不是群组，跳过`);
      return;
    }

    const groupName = chat.name || chat.contact?.name || chat.groupMetadata?.subject || '未知群組';

    // 调用 FastGPT - 總結（与 handleTodaySummary 相同）
    let replyStr = null;
    try {
      console.log(`[定时任务] 开始调用 FastGPT - 總結`);
      appendLog(groupId, `[定时任务] 开始调用 FastGPT - 總結`);
      replyStr = await sendToFastGPT({
        query: '總結',
        user: groupId,
        group_id: groupId,
        variables: { group_id: groupId }
      });
      console.log(`[定时任务] FastGPT 總結 response: ${replyStr}`);
      appendLog(groupId, `[定时任务] FastGPT 總結 response: ${replyStr}`);
    } catch (e) {
      console.error(`[ERR] 调用總結失败: ${e.message}`);
      appendLog(groupId, `[ERR] 调用總結失败: ${e.message}`);
      return;
    }

    // 发送消息（只发送昨日和前日，跳过今日）
    if (replyStr) {
      try {
        // 如果设置了 LOG_ONLY flag，只记录日志，不发送任何消息
        const logOnly = getSafetyBotLogOnly(groupId);
        if (logOnly) {
          console.log('[LOG_ONLY模式] 跳过发送往日總結，仅记录日志');
          appendLog(groupId, `[LOG_ONLY模式] 往日總結内容: ${replyStr}`);
          return;
        }

        // 检查是否包含日期分段标记
        const hasDateSegments = replyStr.includes('<<今日>>') ||
          replyStr.includes('<<昨日>>') ||
          replyStr.includes('<<前日>>');

        if (hasDateSegments) {
          // 提取 <<昨日>> 和 <<前日>> 的部分，跳过 <<今日>>
          const segments = [];
          const markers = ['<<昨日>>', '<<前日>>']; // 只处理昨日和前日

          for (let i = 0; i < markers.length; i++) {
            const marker = markers[i];
            if (replyStr.includes(marker)) {
              const startIndex = replyStr.indexOf(marker);
              // 查找下一个标记（可能是 <<今日>>、<<昨日>> 或 <<前日>>）
              const nextMarkers = ['<<今日>>', '<<昨日>>', '<<前日>>'];
              let endIndex = replyStr.length;

              for (const nextMarker of nextMarkers) {
                const nextIndex = replyStr.indexOf(nextMarker, startIndex + marker.length);
                if (nextIndex !== -1 && nextIndex < endIndex) {
                  endIndex = nextIndex;
                }
              }

              let segment = replyStr.substring(startIndex, endIndex);

              // 去掉标记 <<今日>>、<<昨日>>、<<前日>>
              segment = segment.replace(/<<今日>>|<<昨日>>|<<前日>>/g, '').trim();

              if (segment) {
                segments.push(segment);
              }
            }
          }

          // 按顺序发送每条消息（昨日在前，前日在后）
          for (const segment of segments) {
            console.log(`尝试发送分段消息: ${segment.substring(0, 50)}...`);
            appendLog(groupId, `尝试发送分段消息`);
            await client.sendText(groupId, segment);
            console.log('已发送分段消息');
            appendLog(groupId, '已发送分段消息');
            // 添加短暂延迟，避免消息发送过快
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else {
          // 没有日期分段标记，不发送（因为这是往日总结，需要分段标记）
          console.log(`[定时任务] 返回结果没有日期分段标记，跳过发送`);
          appendLog(groupId, `[定时任务] 返回结果没有日期分段标记，跳过发送`);
        }
      } catch (e) {
        console.error(`[ERR] 发送往日總結失败: ${e.message}`);
        appendLog(groupId, `[ERR] 发送往日總結失败: ${e.message}`);
      }
    }

    console.log(`[定时任务] 群组 ${groupId} 往日总结已发送`);
    appendLog(groupId, `[定时任务] 往日总结已发送`);
  } catch (err) {
    console.error(`[ERR] 群组 ${groupId} 发送往日总结失败:`, err);
    appendLog(groupId, `[ERR] 发送往日总结失败: ${err.message}`);
  }
}

// 今日总结函数
async function handleTodaySummary(client, groupId) {
  try {
    console.log(`[定时任务] 开始执行今日总结，群组: ${groupId}`);
    appendLog(groupId, `[定时任务] 开始执行今日总结`);

    // 获取群组信息
    const chat = await client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      console.log(`[定时任务] 群组 ${groupId} 不存在或不是群组，跳过`);
      return;
    }

    const groupName = chat.name || chat.contact?.name || chat.groupMetadata?.subject || '未知群組';

    // 调用 FastGPT - 總結
    let replyStr = null;
    try {
      console.log(`[定时任务] 开始调用 FastGPT - 總結`);
      appendLog(groupId, `[定时任务] 开始调用 FastGPT - 總結`);
      replyStr = await sendToFastGPT({
        query: '總結',
        user: groupId,
        group_id: groupId,
        variables: { group_id: groupId }
      });
      console.log(`[定时任务] FastGPT 總結 response: ${replyStr}`);
      appendLog(groupId, `[定时任务] FastGPT 總結 response: ${replyStr}`);
    } catch (e) {
      console.error(`[ERR] 调用總結失败: ${e.message}`);
      appendLog(groupId, `[ERR] 调用總結失败: ${e.message}`);
      return;
    }

    // 发送消息
    if (replyStr) {
      try {
        // 如果设置了 LOG_ONLY flag，只记录日志，不发送任何消息
        const logOnly = getSafetyBotLogOnly(groupId);
        if (logOnly) {
          console.log('[LOG_ONLY模式] 跳过发送今日總結，仅记录日志');
          appendLog(groupId, `[LOG_ONLY模式] 今日總結内容: ${replyStr}`);
          return;
        }

        // 检查是否包含日期分段标记
        const hasDateSegments = replyStr.includes('<<今日>>') ||
          replyStr.includes('<<昨日>>') ||
          replyStr.includes('<<前日>>');

        if (hasDateSegments) {
          // 按照 <<今日>>、<<昨日>>、<<前日>> 的顺序分割并发送
          const segments = [];
          const markers = ['<<今日>>', '<<昨日>>', '<<前日>>'];

          for (let i = 0; i < markers.length; i++) {
            const marker = markers[i];
            if (replyStr.includes(marker)) {
              const startIndex = replyStr.indexOf(marker);
              const endIndex = i < markers.length - 1
                ? replyStr.indexOf(markers[i + 1], startIndex + marker.length)
                : replyStr.length;

              let segment = '';
              if (endIndex === -1) {
                segment = replyStr.substring(startIndex);
              } else {
                segment = replyStr.substring(startIndex, endIndex);
              }

              // 去掉标记 <<今日>>、<<昨日>>、<<前日>>
              segment = segment.replace(/<<今日>>|<<昨日>>|<<前日>>/g, '').trim();
              segments.push(segment);
            }
          }

          // 按顺序发送每条消息
          for (const segment of segments) {
            console.log(`尝试发送分段消息: ${segment.substring(0, 50)}...`);
            appendLog(groupId, `尝试发送分段消息`);
            await client.sendText(groupId, segment);
            console.log('已发送分段消息');
            appendLog(groupId, '已发送分段消息');
            // 添加短暂延迟，避免消息发送过快
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        } else {
          // 没有日期分段标记，直接发送
          await client.sendText(groupId, replyStr);
          console.log(`[定时任务] 已发送今日總結`);
          appendLog(groupId, `[定时任务] 已发送今日總結`);
        }
      } catch (e) {
        console.error(`[ERR] 发送今日總結失败: ${e.message}`);
        appendLog(groupId, `[ERR] 发送今日總結失败: ${e.message}`);
      }
    }

    console.log(`[定时任务] 群组 ${groupId} 今日总结已发送`);
    appendLog(groupId, `[定时任务] 今日总结已发送`);
  } catch (err) {
    console.error(`[ERR] 群组 ${groupId} 发送今日总结失败:`, err);
    appendLog(groupId, `[ERR] 发送今日总结失败: ${err.message}`);
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
        const data = await fsPromises.readFile(mappingsPath, 'utf8');
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

// === 健康检查监控函数 ===
async function sendFeishu(text) {
  try {
    await axios.post(HEALTH_CHECK_CONFIG.WEBHOOK, {
      msg_type: "text",
      content: { text: `${HEALTH_CHECK_CONFIG.KEYWORD}: ${text}` }
    });
  } catch (e) {
    console.error('飞书发送失败', e.message);
  }
}

// 启动健康检查服务器
function startHealthCheckServer() {
  const app = express();
  app.get('/health', (req, res) => res.json(state));
  app.listen(3080, () => {
    console.log('[健康检查] 服务器已启动在端口 3080');
  });
}

// 监控状态变化并发送报警
function checkStatusChange() {
  const current = state.status;

  // 状态从 READY 切换到 QR_NEEDED 时报警
  if (current === 'QR_NEEDED' && lastHealthStatus !== 'QR_NEEDED') {
    sendFeishu("WPPConnect 检测到登录失效，请登录服务器扫码。命令: journalctl -u insp-bot -f");
  }

  lastHealthStatus = current;
}

// ========== Lark 事件处理（文件监听模式） ==========
let whatsappClient = null;  // 存储 WhatsApp 客户端引用
const LARK_LOG_DIR = '/root/lark_server/logs/tblpuG3THQpAjkE7';
let lastReadPosition = {};  // 记录每个文件的已读取位置 { '2026-01-08.log': 1024 }
let processedEventIds = new Set();  // 记录已处理的事件ID，用于去重
const SERVICE_START_TIME = Date.now();  // 记录服务启动时间（毫秒时间戳）

// 生成合并后的格式化消息（处理多条记录）
function formatMergedLarkEventMessage(recordAddedActions) {
  if (!recordAddedActions || recordAddedActions.length === 0) {
    return '';
  }

  // 按分區和樓層分组
  const grouped = {};
  for (const actionItem of recordAddedActions) {
    const translatedFields = actionItem.translated_fields || {};
    const 分區 = (translatedFields['位置分區'] || translatedFields['分區'] || '').replace(/\s+/g, '');
    const 樓層 = translatedFields['樓層'] || '';
    const 工序 = translatedFields['工序'] || '';
    const 當日進度 = translatedFields['當日進度'] || '';
    const 當日進度百分比 = 當日進度 ? `${(parseFloat(當日進度) * 100).toFixed(0)}%` : '';
    const 填寫人 =
      translatedFields['填寫人']?.users?.[0]?.name ||
      translatedFields['填寫人']?.users?.[0]?.en_name ||
      '';

    const key = `${分區}|${樓層}`;
    if (!grouped[key]) {
      grouped[key] = {
        分區: 分區,
        樓層: 樓層,
        工序列表: [],
        填寫人列表: new Set()
      };
    }

    if (工序) {
      if (當日進度百分比) {
        grouped[key].工序列表.push(`${工序}：${當日進度百分比}`);
      } else {
        grouped[key].工序列表.push(工序);
      }
    }

    if (填寫人) {
      grouped[key].填寫人列表.add(填寫人);
    }
  }

  // 构建合并后的消息
  let message = '✅已收到進度填報\n';

  const groups = Object.values(grouped);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    if (group.分區) {
      message += `分區：${group.分區}\n`;
    }

    if (group.樓層) {
      message += `樓層：${group.樓層}\n`;
    }

    if (group.工序列表.length > 0) {
      message += `工序：\n`;
      for (const 工序項 of group.工序列表) {
        message += `-${工序項}\n`;
      }
    }

    const 填寫人們 = Array.from(group.填寫人列表 || []);
    if (填寫人們.length > 0) {
      message += `填寫人：${填寫人們.join('、')}\n`;
    }

    // 如果有多组，在组之间添加分隔（可选）
    if (i < groups.length - 1) {
      message += '\n';
    }
  }

  return message.trim();
}

// 处理 Lark 多维表格变更事件
async function handleLarkBitableEvent(eventData, isTranslated = false) {
  try {
    // 检查事件时间，只处理服务启动后的新事件
    const eventCreateTime = eventData?.header?.create_time;
    if (eventCreateTime) {
      const eventTime = parseInt(eventCreateTime, 10);
      if (eventTime < SERVICE_START_TIME) {
        console.log(`[Lark] 事件时间 ${eventCreateTime} 早于服务启动时间 ${SERVICE_START_TIME}，跳过处理`);
        return;
      }
    }

    // 提取事件ID用于去重
    const eventId = eventData?.header?.event_id || eventData?.event_id || null;

    if (eventId) {
      // 检查是否已处理过
      if (processedEventIds.has(eventId)) {
        console.log(`[Lark] 事件已处理过，跳过: ${eventId}`);
        return;
      }

      // 标记为已处理
      processedEventIds.add(eventId);

      // 限制去重集合大小，避免内存无限增长（保留最近1000个）
      if (processedEventIds.size > 1000) {
        const firstId = processedEventIds.values().next().value;
        processedEventIds.delete(firstId);
      }
    }

    // 记录接收到的数据
    const dataStr = JSON.stringify(eventData, null, 2);
    console.log(`[Lark] 收到新事件${eventId ? ` (ID: ${eventId})` : ''}${isTranslated ? ' (翻译版)' : ''}`);
    appendLog('lark-events', `收到数据${isTranslated ? ' (翻译版)' : ''}: ${dataStr}`);

    // 如果是翻译版数据，处理并发送消息
    if (isTranslated && eventData?.event?.action_list) {
      const actionList = eventData.event.action_list;
      const recordAddedActions = actionList.filter(item => item.action === 'record_added' && item.translated_fields);

      console.log(`[Lark] 找到 ${recordAddedActions.length} 个 record_added 记录（共 ${actionList.length} 个 action）`);
      appendLog('lark-events', `找到 ${recordAddedActions.length} 个 record_added 记录`);

      if (recordAddedActions.length === 0) {
        return;
      }

      // 合并所有记录生成一条消息
      const mergedMessage = formatMergedLarkEventMessage(recordAddedActions);

      if (!mergedMessage) {
        console.log('[Lark] 合并后的消息为空，跳过发送');
        return;
      }

      console.log(`[Lark] 生成合并后的格式化消息（包含 ${recordAddedActions.length} 个记录）:\n${mergedMessage}`);
      appendLog('lark-events', `生成合并后的格式化消息（包含 ${recordAddedActions.length} 个记录）:\n${mergedMessage}`);

      // 发送合并后的消息到配置的目标群组
      if (whatsappClient && LARK_TARGET_GROUPS.length > 0) {
        for (const groupId of LARK_TARGET_GROUPS) {
          try {
            await whatsappClient.sendText(groupId.trim(), mergedMessage);
            console.log(`[Lark] 已发送合并消息（${recordAddedActions.length} 个记录）到群组: ${groupId}`);
            appendLog('lark-events', `已发送合并消息（${recordAddedActions.length} 个记录）到群组: ${groupId}`);
          } catch (err) {
            console.error(`[Lark] 发送合并消息到群组 ${groupId} 失败:`, err.message);
            appendLog('lark-events', `发送合并消息到群组 ${groupId} 失败: ${err.message}`);
          }
        }
      } else {
        if (!whatsappClient) {
          console.warn('[Lark] WhatsApp 客户端未初始化，无法发送消息');
        }
        if (LARK_TARGET_GROUPS.length === 0) {
          console.log('[Lark] 未配置目标群组，仅记录日志');
        }
      }

      console.log(`[Lark] 完成处理，已发送 1 条合并消息（包含 ${recordAddedActions.length} 个记录）`);
      appendLog('lark-events', `完成处理，已发送 1 条合并消息（包含 ${recordAddedActions.length} 个记录）`);
    }
  } catch (err) {
    console.error('[Lark] 处理事件失败:', err);
    appendLog('lark-events', `处理事件失败: ${err.message}`);
  }
}

// 从内容中提取完整的 JSON 对象（跨多行）
function extractJsonFromContent(content, startIndex) {
  try {
    // 优先查找翻译版数据 "[翻译版] 事件数据:"
    let dataStart = content.indexOf('[翻译版] 事件数据:', startIndex);
    let isTranslated = true;

    // 如果没找到翻译版，查找原始数据 "事件数据:"
    if (dataStart === -1) {
      dataStart = content.indexOf('事件数据:', startIndex);
      isTranslated = false;
    }

    if (dataStart === -1) {
      return { json: null, endIndex: startIndex, isTranslated: false };
    }

    // 找到 JSON 开始的 { 位置
    let jsonStart = content.indexOf('{', dataStart);
    if (jsonStart === -1) {
      return { json: null, endIndex: dataStart, isTranslated };
    }

    // 从 { 开始，匹配完整的 JSON 对象（通过括号匹配）
    let braceCount = 0;
    let jsonEnd = jsonStart;
    let inString = false;
    let escapeNext = false;

    for (let i = jsonStart; i < content.length; i++) {
      const char = content[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\') {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }

    if (braceCount !== 0) {
      // JSON 不完整，可能被截断了
      return { json: null, endIndex: startIndex, isTranslated };
    }

    // 提取 JSON 字符串
    const jsonStr = content.substring(jsonStart, jsonEnd);
    const jsonData = JSON.parse(jsonStr);

    return { json: jsonData, endIndex: jsonEnd, isTranslated };
  } catch (err) {
    console.error('[Lark] 解析 JSON 失败:', err.message);
    return { json: null, endIndex: startIndex, isTranslated: false };
  }
}

// 读取日志文件的新增内容
async function readNewLogContent(logFilePath) {
  try {
    if (!fs.existsSync(logFilePath)) {
      // 文件不存在时也记录一次（避免日志刷屏）
      const filename = path.basename(logFilePath);
      if (!lastReadPosition[filename + '_notfound']) {
        console.log(`[Lark] 日志文件不存在: ${logFilePath}`);
        lastReadPosition[filename + '_notfound'] = true;
      }
      return;
    }

    const stats = fs.statSync(logFilePath);
    const filename = path.basename(logFilePath);
    const lastPos = lastReadPosition[filename] || 0;

    // 如果文件大小没有变化，跳过
    if (stats.size <= lastPos) {
      return;
    }

    console.log(`[Lark] 检测到文件变化: ${filename}, 大小: ${stats.size}, 上次位置: ${lastPos}, 新增: ${stats.size - lastPos} bytes`);

    // 读取新增内容
    const fd = fs.openSync(logFilePath, 'r');
    const buffer = Buffer.alloc(stats.size - lastPos);
    fs.readSync(fd, buffer, 0, buffer.length, lastPos);
    fs.closeSync(fd);

    const newContent = buffer.toString('utf-8');
    console.log(`[Lark] 读取到新增内容 (${newContent.length} 字符)`);

    // 从新增内容中查找所有完整的事件数据
    let searchIndex = 0;
    let eventCount = 0;

    while (true) {
      const result = extractJsonFromContent(newContent, searchIndex);

      if (result.json) {
        eventCount++;
        console.log(`[Lark] 成功解析事件数据 #${eventCount}${result.isTranslated ? ' (翻译版)' : ''}`);
        await handleLarkBitableEvent(result.json, result.isTranslated);
        searchIndex = result.endIndex;
      } else {
        // 没有找到更多事件，退出循环
        break;
      }
    }

    if (eventCount > 0) {
      console.log(`[Lark] 本次处理了 ${eventCount} 个事件`);
    } else {
      console.log(`[Lark] 未找到完整的事件数据（可能 JSON 被截断，等待下次读取）`);
    }

    // 更新已读取位置
    lastReadPosition[filename] = stats.size;
    console.log(`[Lark] 已更新读取位置: ${filename} -> ${stats.size}`);
  } catch (err) {
    console.error('[Lark] 读取日志文件失败:', err.message);
    console.error('[Lark] 错误堆栈:', err.stack);
    appendLog('lark-events', `读取日志文件失败: ${err.message}`);
  }
}

// 启动日志文件监听
function startLarkLogWatcher() {
  console.log(`[Lark] 启动日志文件监听: ${LARK_LOG_DIR}`);
  console.log(`[Lark] 服务启动时间: ${new Date(SERVICE_START_TIME).toISOString()} (${SERVICE_START_TIME})`);
  console.log(`[Lark] 只处理启动时间之后的新事件`);
  appendLog('lark-events', `服务启动时间: ${new Date(SERVICE_START_TIME).toISOString()} (${SERVICE_START_TIME})`);

  // 检查目录是否存在
  if (!fs.existsSync(LARK_LOG_DIR)) {
    console.error(`[Lark] 错误: 日志目录不存在: ${LARK_LOG_DIR}`);
    appendLog('lark-events', `错误: 日志目录不存在: ${LARK_LOG_DIR}`);
    return;
  }

  console.log(`[Lark] 日志目录存在，开始监听`);

  // 每秒检查一次日志文件
  setInterval(() => {
    try {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const logFilePath = path.join(LARK_LOG_DIR, `${today}.log`);

      readNewLogContent(logFilePath).catch(err => {
        console.error('[Lark] 检查日志文件失败:', err.message);
        console.error('[Lark] 错误堆栈:', err.stack);
      });
    } catch (err) {
      console.error('[Lark] 日志监听循环错误:', err.message);
      console.error('[Lark] 错误堆栈:', err.stack);
    }
  }, 1000); // 每秒检查一次

  console.log('[Lark] 日志文件监听已启动，每秒检查一次');

  // 立即检查一次
  const today = new Date().toISOString().slice(0, 10);
  const logFilePath = path.join(LARK_LOG_DIR, `${today}.log`);
  console.log(`[Lark] 立即检查日志文件: ${logFilePath}`);
  readNewLogContent(logFilePath).catch(err => {
    console.error('[Lark] 初始检查失败:', err.message);
  });
}


// Main Start Function
function start(client) {
  console.log('WhatsApp Bot 已启动 (WPPConnect)');

  // 保存客户端引用供 Lark 事件处理使用
  whatsappClient = client;

  // 更新状态为 READY
  state.status = 'READY';
  checkStatusChange();

  // 启动 Lark 日志文件监听
  startLarkLogWatcher();

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
      console.log('[DEBUG 发送人的number, name, pushname分别是]', contactPhone, SenderContact.name, SenderContact.pushname);
      appendLog(user, '[DEBUG 发送人的number, name, pushname分别是]', contactPhone, SenderContact.name, SenderContact.pushname);

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
        case 'safety-bot':
          await handleSafetyBot(client, msg, groupId, isGroup);
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
  const targetGroups = process.env.AI_ANDACHEN_TARGET_GROUPS
    ? process.env.AI_ANDACHEN_TARGET_GROUPS.split(',').map(g => g.trim())
    : [];
  const adminGroups = process.env.AI_ANDACHEN_ADMIN_GROUPS
    ? process.env.AI_ANDACHEN_ADMIN_GROUPS.split(',').map(g => g.trim())
    : [];

  // AI 进度更新：每天下午5点（香港时区 UTC+8）
  // 如果服务器是 UTC，17:00 HKT = 09:00 UTC；如果服务器是 HKT，直接使用 17:00
  cron.schedule('0 17 * * *', async () => {
    console.log('[定时任务] 开始执行 17:00 AI 进度更新（香港时区）');
    const groupsToProcess = targetGroups.filter(g => !adminGroups.includes(g));
    for (const groupId of groupsToProcess) {
      await handleProgressUpdate(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  // AI 进度总结：每天18:30, 20:00, 22:00（香港时区 UTC+8）
  // 如果服务器是 UTC，18:30 HKT = 10:30 UTC；如果服务器是 HKT，直接使用 18:30

  cron.schedule('00 22 * * *', async () => {
    console.log('[定时任务] 开始执行 22:00 AI 进度总结（香港时区）');
    const groupsToProcess = targetGroups.filter(g => !adminGroups.includes(g));
    for (const groupId of groupsToProcess) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  cron.schedule('00 20 * * *', async () => {
    console.log('[定时任务] 开始执行 20:00 AI 进度总结（香港时区）');
    const groupsToProcess = targetGroups.filter(g => !adminGroups.includes(g));
    for (const groupId of groupsToProcess) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  cron.schedule('30 18 * * *', async () => {
    console.log('[定时任务] 开始执行 18:30 AI 进度总结（香港时区）');
    const groupsToProcess = targetGroups.filter(g => !adminGroups.includes(g));
    for (const groupId of groupsToProcess) {
      await handleProgressSummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });


  // 总结目标群组（往日总结和今日总结共用）
  const summaryGroups = process.env.SAFETYBOT_GROUPS
    ? process.env.SAFETYBOT_GROUPS.split(',').map(g => g.trim())
    : [];

  // 往日总结：每天早上8:30（香港时区）
  cron.schedule('30 8 * * *', async () => {
    console.log('[定时任务] 开始执行 8:30 往日总结（香港时区）');
    for (const groupId of summaryGroups) {
      await handleTodaySummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  // 今日总结：每天晚上18:30（香港时区）
  cron.schedule('30 18 * * *', async () => {
    console.log('[定时任务] 开始执行 18:30 今日总结（香港时区）');
    for (const groupId of summaryGroups) {
      await handleTodaySummary(client, groupId);
    }
  }, {
    timezone: 'Asia/Hong_Kong'
  });

  // AdminGroups：每天 08:00、10:00 拉取当日最新群文件并下载到本地 tmp（香港时区）
  // 先只做“拉取+下载+日志”，后续处理你说等下再碰
  const runAdminGroupsDownload = async (whenLabel) => {
    // whenLabel 只是“本次任务标签”（例如原计划 08:00/10:00），不代表当前触发时间
    if (!adminGroups.length) {
      console.log(`[AdminGroupFiles] 跳过本次 ${whenLabel}：AI_ANDACHEN_ADMIN_GROUPS 为空或未配置`);
      return;
    }
    if (!GROUP_FILES_API_URL || !/^https?:\/\//i.test(String(GROUP_FILES_API_URL).trim())) {
      const tip = `[AdminGroupFiles] 跳过本次 ${whenLabel}：未配置 GROUP_FILES_API_URL（需要 http(s) URL），当前=${JSON.stringify(GROUP_FILES_API_URL)}`;
      console.warn(tip);
      // 这里没有具体 gid，写一条全局日志即可
      appendLog('admin-groups', tip);
      return;
    }
    for (const gid of adminGroups) {
      if (!gid) continue;
      try {
        console.log(`[AdminGroupFiles] 开始处理群=${gid} 标签=${whenLabel}`);
        await handleAdminGroupDailyFileDownload(client, gid, whenLabel);
      } catch (e) {
        const msg = e?.message || String(e);
        console.error('[AdminGroupFiles] 处理失败:', gid, msg);
        appendLog(gid, `[AdminGroupFiles] 处理失败: ${msg}`);
      }
    }
  };

  cron.schedule('50 21 * * *', async () => {
    console.log('[定时任务] 21:50 AdminGroups 群文件拉取+下载（香港时区）');
    await runAdminGroupsDownload('21:50');
  }, { timezone: 'Asia/Hong_Kong' });

  // cron.schedule('0 22 * * *', async () => {
  //   console.log('[定时任务] 22:00 AdminGroups 群文件拉取+下载（香港时区）');
  //   await runAdminGroupsDownload('10:00');
  // }, { timezone: 'Asia/Hong_Kong' });

  // 下午2:30定时任务：针对特定群组，先执行 AI 进度更新，然后执行 AI 进度总结
}

// 启动健康检查服务器
startHealthCheckServer();

wppconnect.create({
  session: 'whatsapp-bot-session',
  catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
    state.status = 'QR_NEEDED';
    checkStatusChange();
    console.log('请扫描以下二维码登录 WhatsApp:');
    qrcode.generate(urlCode, { small: true });
  },
  logQR: false,
  headless: true,
  autoClose: false,  // 掉线时不自动关闭进程
  puppeteerOptions: {
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
})
  .then(client => start(client))
  .catch(error => {
    console.error(error);
    state.status = 'ERROR';
    checkStatusChange();
  });



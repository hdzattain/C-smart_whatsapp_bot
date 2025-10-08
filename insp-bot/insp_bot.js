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
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const FormData = require('form-data');
const mime = require('mime-types');
const fsPromises = fs.promises;
const rimraf = require('rimraf').sync;
const qrcode = require('qrcode-terminal');
const fetch = require('node-fetch');

// === 常量 & 配置加载 ===
const LOG_DIR = path.join(__dirname, 'logs');
const TMP_DIR = path.join(__dirname, 'tmp');
const GROUP_CONFIG_FILE = path.join(__dirname, 'group_config.json');
const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');
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
  return `${s.replace('+','')}@c.us`;
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
async function safeSendWithMentions(chat, text, jids = []) {
  const mentions = sanitizeJids(jids);
  const needMentions = mentions.length > 0;

  // 如果需要 @，确保文本里出现了对应的 @86188... 标签
  const ensureText = needMentions
    ? text + (/\B@\d{5,}/.test(text) ? '' : (' ' + atTextFromJids(mentions)))
    : text;

  try {
    if (needMentions) {
      return await chat.sendMessage(ensureText, { mentions });
    }
    return await chat.sendMessage(ensureText);
  } catch (e) {
    console.error('[SummaryBot] sendMessage 带 mentions 失败，降级重试：', e?.message || e);
    // 降级：不带 mentions 再发一遍，至少不影响使用
    return await chat.sendMessage(text);
  }
}

// @文本：@86188...
function mentionTextFromIds(ids = []) {
  const arr = Array.isArray(ids) ? ids : [ids];
  return arr.map(id => '@' + String(id).replace(/@.*/, '')).join(' ');
}

// 从本条消息 @ 中取负责人（JID 字符串数组）
async function ownersFromMentions(msg) {
  const mlist = await msg.getMentions().catch(() => []);
  return (mlist || [])
    .map(c => toJid(c?.id?._serialized || c?._serialized))
    .filter(Boolean);
}

// 发送任务详情
async function sendTaskDetail(chat, task) {
  const owners = mentionTextFromIds(task.owners || []);
  const prog = (task.progress || []).slice(-3).map(p => {
    const who = '@' + String(p.by).split('@')[0];
    const tstr = new Date(p.at).toLocaleString();
    return `- ${tstr} ${who}: ${p.text}`;
  }).join('\n') || '（暂无进展）';

  return chat.sendMessage(
    `📌 任务 *${task.id}*\n` +
    `内容：${task.text}\n` +
    `状态：${task.status === 'done' ? '✅ 已完成' : '进行中'}\n` +
    (task.due ? `截止：${task.due}\n` : '') +
    `负责人：${owners || '未指定'}\n` +
    `最近进展：\n${prog}`
  );
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
  const toISO = (d) => d.toISOString().slice(0,10);

  if (/今天|today/i.test(str)) return toISO(now);
  if (/明天|tomorrow/i.test(str)) {
    const d = new Date(now); d.setDate(d.getDate()+1); return toISO(d);
  }
  const wkMap = { '一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'日':0,'天':0 };
  const m2 = str.match(/下周([一二三四五六日天])/);
  if (m2) {
    const target = wkMap[m2[1]];
    const d = new Date(now);
    const add = ((7 - d.getDay()) + target) % 7 || 7;
    d.setDate(d.getDate()+add);
    return toISO(d);
  }
  return null;
}

// 问题1修复: 增强的@人名解析函数
async function parseTaskMentions(msg, body) {
  const mentions = [];
  
  try {
    // 方法1: 从WhatsApp API获取mentions
    const msgMentions = await msg.getMentions().catch(() => []);
    const mentionJids = msgMentions
      .map(c => toJid(c?.id?._serialized || c?._serialized))
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

async function handleDecisionCreate(chat, msg, groupId, senderId, fields, body) {
  const ownersInput = (fields.owners || []).filter(x => !String(x).startsWith('raw:'));
  const owners = Array.from(new Set(ownersInput.map(toJid).filter(Boolean)));
  const ownersJids = sanitizeJids(owners);

  const due = fields.due || parseDueDate(body);
  const text = fields.text || stripTaskDecorations(body);

  const task = {
    id: nextTaskId(),
    groupId,
    messageId: msg.id?._serialized || '',
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

  await safeSendWithMentions(chat, `${header}\n${bodyText}${ownersText}`, ownersJids);
  return true;
}

async function handleDecisionProgressOrDone(chat, msg, groupId, senderId, decision, body) {
  const { matched_task_id: mid, fields } = decision;
  const target = tasksStore[groupId].find(t => t.id === mid)
    || tasksStore[groupId].slice().reverse().find(t => t.status === 'open');
  if (!target) { await chat.sendMessage('未找到可更新的任务。'); return true; }

  const progressText = fields?.progress || body;
  addProgress(target, progressText, senderId, msg.id?._serialized);
  if (fields?.done || /(完成|已处理|已解决|done)\b/i.test(body)) {
    target.status = 'done';
    target.history.push({ at: new Date().toISOString(), by: senderId, action: 'done(by-dify)' });
  }
  saveTasks();
  await chat.sendMessage(`📝 已更新 *${target.id}* 的进展。` + (target.status === 'done' ? `\n状态：✅ 已完成` : ''));
  return true;
}

async function handleDecisionAssign(chat, groupId, senderId, decision) {
  const { matched_task_id: mid, fields } = decision;
  const target = tasksStore[groupId].find(t => t.id === mid);

  const ownersInput = (fields?.owners || []).filter(x => !String(x).startsWith('raw:'));
  const owners = Array.from(new Set(ownersInput.map(toJid).filter(Boolean)));
  const ownersJids = sanitizeJids(owners);

  if (!target || !ownersJids.length) {
    await chat.sendMessage('未识别到任务或负责人。');
    return true;
  }

  target.owners = Array.from(new Set([...(target.owners || []), ...ownersJids]));
  target.history.push({ at: new Date().toISOString(), by: senderId, action: 'assign(by-dify)', owners: target.owners });
  saveTasks();

  await safeSendWithMentions(
    chat,
    `✅ 已为 *${target.id}* 指派负责人：${atTextFromJids(target.owners)}`,
    target.owners
  );
  return true;
}

async function handleDecisionListOrQuery(chat, groupId, decision) {
  try {
    const mid = decision?.matched_task_id || null;

    if (mid) {
      const task = (tasksStore[groupId] || []).find(t => t.id === mid);
      if (task) {
        await sendTaskDetail(chat, task);
        return true;
      }
    }

    const list = (tasksStore[groupId] || []).filter(t => t.status === 'open');
    if (!list.length) {
      await chat.sendMessage('当前没有未完成任务。');
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
    await safeSendWithMentions(chat, `${header}\n${lines}`, jids);
    return true;
  } catch (e) {
    console.error('[SummaryBot] handleDecisionListOrQuery error:', e?.message || e);
    await chat.sendMessage('查询任务时出现异常，请稍后再试。');
    return true;
  }
}

async function processNaturalLanguage(msg, groupId, body, senderId) {
  const chat = await msg.getChat();
  const decision = await extractTaskWithDify(body, groupId, senderId).catch(() => null);
  if (!decision) return false;

  const intent = decision.intent || 'other';
  if (intent === 'create_task')    return await handleDecisionCreate(chat, msg, groupId, senderId, decision.fields || {}, body);
  if (intent === 'update_progress' || intent === 'mark_done')
                                   return await handleDecisionProgressOrDone(chat, msg, groupId, senderId, decision, body);
  if (intent === 'assign_owner')   return await handleDecisionAssign(chat, groupId, senderId, decision);
  if (intent === 'list_or_query')  return await handleDecisionListOrQuery(chat, groupId, decision);

  return false;
}

async function explicitCreateFromMessage(msg, groupId, body, senderId) {
  const chat = await msg.getChat();
  let structured = null;
  
  try { 
    structured = await extractTaskWithDify(body, groupId, senderId); 
  } catch (e) {
    console.log('[explicitCreateFromMessage] Dify extraction failed, using fallback');
  }

  const due = structured?.fields?.due || parseDueDate(body);
  const text = structured?.fields?.text || stripTaskDecorations(body);

  // 使用增强的mention解析
  const ownersFromMsg = await parseTaskMentions(msg, body);
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
    messageId: msg.id?._serialized || '',
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

  await safeSendWithMentions(chat, `${header}\n${bodyText}${ownersText}${tips}`, ownersJids);
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


async function extractTaskWithDify(inputText, groupId, userJid) {
  const gConf = (groupConfig && (groupConfig.groups[groupId] || groupConfig.default)) || {};
  const wf = (gConf.dify && gConf.dify.workflow) || {};

  const apiKey = wf.apiKey || process.env.DIFY_API_KEY || '';
  const workflowId = wf.workflowId || process.env.DIFY_WORKFLOW_ID || '';
  const appId = wf.appId || process.env.DIFY_APP_ID || '';
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
      appId,
      groupId
    });
    return outputs || null;
  } catch (err) {
    console.error('[Dify] extractTaskWithDify 調用 sendToDifyWorkflow 失敗：', err?.message || err);
    return null;
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
    try { return JSON.parse(inner); } catch {}
  }

  s = s.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  if (s.startsWith('{') && s.endsWith('}')) {
    try { return JSON.parse(s); } catch {}
  }

  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = s.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(candidate); } catch {}
    let end = lastBrace;
    for (let i = 0; i < 5 && end > firstBrace; i++) {
      end = s.lastIndexOf('}', end - 1);
      if (end <= firstBrace) break;
      try { return JSON.parse(s.slice(firstBrace, end + 1)); } catch {}
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
        } catch {}
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
    contentType: mime.lookup(filepath) || 'application/octet-stream'
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


async function replyMessage(msg, text, needReply) {
  if (!needReply) return;
  await msg.reply(text);
}

async function handleEpermitBot(msg, groupId, needReply) {
  const content = msg.body || '';
  appendLog(groupId, `收到消息: ${content}`);

  if (containsSummaryKeyword(content)) {
    console.log('[LOG] 检测到总结关键词，调用后端获取汇总数据...');
    try {
      const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
        params: { group_id: groupId }
      });
      const summaryText = formatSummary(resp.data || []);
      await msg.reply(summaryText);
    } catch (err) {
      console.error('[ERR] 获取汇总数据失败:', err);
      await msg.reply('获取汇总数据失败，请稍后再试。');
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
      await msg.reply(response);
    }
  } catch (err) {
    await msg.reply('Dify 处理失败，请稍后再试。');
  }
}

async function handleInspBot(msg, groupId, needReply) {
  let content = msg.body || '';
  let files = [];
  let outputPic = '';
  const senderId = msg.author || msg.from;
  const newOwners = [toJid(senderId)];
  const chat = await msg.getChat();

  const mentionText = mentionTextFromIds(newOwners);

  const isImage = msg.type === 'image' || msg.type === 'album'; 
  const hasText = (msg.body || msg.caption || '').trim().length > 0;

  if (!isImage || !hasText) {
    console.log(`[LOG] insp-bot 消息不符合图文混合格式，isImage: ${isImage}, hasText: ${hasText}, body: ${msg.body}, caption: ${msg.caption}`);
    await replyMessage(msg, '目前没有记录到表格，请按照图文混合格式发送（需包含图片和文字描述）。', needReply);
    return;
  }

  const media = await msg.downloadMedia();
  if (media) {
    const ext = mime.extension(media.mimetype) || 'jpg';
    const filename = `img_${Date.now()}.${ext}`;
    const filepath = path.join(TMP_DIR, filename);
    await fsPromises.writeFile(filepath, Buffer.from(media.data, 'base64'));
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
    await replyMessage(msg, '图片下载失败，请重新发送。', needReply);
    return;
  }
  console.log(`[LOG] 处理前的消息内容: ${content}`);
  const processedBody = await parseMessageMentions(msg, content);
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
      // if (replyText.includes('未知')) {
      if (0) {
        console.error(`[ERR] 未写入多维表格，因为某些信息未知: ${replyText}`);
        appendLog(groupId, `未写入多维表格，因为某些信息未知: ${replyText}`); 
        await replyMessage(msg, `[ERR] 未写入多维表格，因为某些信息未知: ${replyText}`, needReply);
        await safeSendWithMentions(
          chat,
          `已指派负责人：${mentionText}`,
          newOwners
        ); 
      } else {
        await sendToBiTableRecordAdd(response, outputPic);
        const mentionJids = (replyText.match(/@\d{5,}/g) || []).map(m => toCUsJid(m.substring(1)));
        if (needReply) {
          await safeSendWithMentions(chat, replyText, mentionJids);
        }
      }
    } else {
      await replyMessage(msg, 'InspBot 处理完成，但未生成有效记录。', needReply);
    }
  } catch (err) {
    console.error('[ERR] InspBot 处理失败:', err);
    await replyMessage(msg, 'InspBot 处理失败，请稍后再试。', needReply);
  }
}

async function handleSummaryBot(msg, groupId) {
  const chat = await msg.getChat();
  if (!chat.isGroup) return;

  body = (msg.body || '').trim();
  console.log(`[LOG] 原始消息内容: ${body}`);
  body = await parseMessageMentionsNumber(msg, body);
  console.log(`[LOG] parseMessageMentionsNumber处理后的消息内容: ${body}`);
  const senderId = msg.author || msg.from;

  tasksStore[groupId] = tasksStore[groupId] || [];

  if (msg.hasQuotedMsg) {
      const acted = await handleQuotedReply(msg, groupId, senderId, body);
      if (acted) return;
  }

  const isCommand = /^!/.test(body);
  const isExplicitCreate = /^\s*(?:任务|待办|TODO)\s*[:：]/i.test(body);

  if (!isCommand && !isExplicitCreate) {
    const acted = await processNaturalLanguage(msg, groupId, body, senderId);
    if (acted) return;
  }

  if (isExplicitCreate) {
    const created = await explicitCreateFromMessage(msg, groupId, body, senderId);
    if (created) return;
  }

  const isOwnerOrCreator = (task, uid) =>
    (task.creator === uid) || (Array.isArray(task.owners) && task.owners.includes(uid));

  const isAutoDone = (text) => /(完成|已处理|已解決|已解决|done)\b/i.test(text || '');

  try {
    if (msg.hasQuotedMsg) {
      const quoted = await msg.getQuotedMessage();
      const qid = quoted?.id?._serialized || '';
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
          const added = addProgress(task, body, senderId, msg.id?._serialized);
          
          if (isAutoDone(body)) {
            if (task.status === 'done') {
                await msg.reply(`任务 *${task.id}* 已是完成状态。`);
                return true;
            }
            task.status = 'done';
            task.history.push({ at: new Date().toISOString(), by: senderId, action: 'auto-done' });
            saveTasks();
            await msg.reply(`✅ 任务 *${task.id}* 已更新为【已完成】`);
            return true;
          }
          
          if (added) {
            saveTasks();
            await msg.reply(`📝 已记录 *${task.id}* 的最新进展。`);
            return true;
          }
        }
      }
    }
  } catch (e) {
    console.error('[SummaryBot] 处理引用回复失败：', e);
  }

  if (/^!help\b/i.test(body)) {
    return chat.sendMessage(
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
    if (!task) return chat.sendMessage(`未找到任务 ${taskId}`);
    if (!isOwnerOrCreator(task, senderId)) return chat.sendMessage(`只有负责人或创建者可完成 ${taskId}`);
    if (task.status === 'done') return chat.sendMessage(`任务 ${taskId} 已是完成状态。`);
    task.status = 'done';
    task.history.push({ at: new Date().toISOString(), by: senderId, action: 'done' });
    saveTasks();
    return chat.sendMessage(`🎉 任务 *${task.id}* 已完成：${task.text}`);
  }

  if (/^!assign\s+T\d{6,}\b/i.test(body)) {
    const parts = body.split(/\s+/);
    const taskId = parts[1];
    const task = tasksStore[groupId].find(t => t.id === taskId);
    if (!task) return chat.sendMessage(`未找到任务 ${taskId}`);
    if (!isOwnerOrCreator(task, senderId)) return chat.sendMessage(`只有负责人或创建者可指派 ${taskId}`);

    const mentions = await msg.getMentions().catch(() => []);
    const ownerJidsFromMentions = (mentions || [])
      .map(c => toJid(c?.id?._serialized || c?._serialized))
      .filter(Boolean);

    if (!ownerJidsFromMentions.length) return chat.sendMessage('请 @ 至少一位负责人。');

    task.owners = Array.from(new Set([...(task.owners || []).map(toJid), ...ownerJidsFromMentions]));
    task.history.push({ at: new Date().toISOString(), by: senderId, action: 'assign', owners: task.owners });
    saveTasks();

    const mentionText = mentionTextFromIds(task.owners);

    return chat.sendMessage(
      `✅ 已为 *${task.id}* 指派负责人：${mentionText}`,
      { mentions: task.owners }
    );
  }

  if (/^!note\s+T\d{6,}\b/i.test(body)) {
    const [_, tid, ...rest] = body.split(/\s+/);
    const text = rest.join(' ').trim();
    const task = tasksStore[groupId].find(t => t.id === tid);
    if (!task) return chat.sendMessage(`未找到任务 ${tid}`);
    if (!isOwnerOrCreator(task, senderId)) return chat.sendMessage(`只有负责人或创建者可提交进展：${tid}`);
    if (!text) return chat.sendMessage('请在 !note 后填写进展内容');

    addProgress(task, text, senderId, msg.id?._serialized);
    if (isAutoDone(text)) {
      task.status = 'done';
      task.history.push({ at: new Date().toISOString(), by: senderId, action: 'auto-done' });
    }
    saveTasks();
    return chat.sendMessage(`📝 已记录 *${tid}* 的最新进展。`);
  }

  if (/^!detail\s+T\d{6,}\b/i.test(body)) {
    const tid = body.split(/\s+/)[1];
    const task = tasksStore[groupId].find(t => t.id === tid);
    if (!task) return chat.sendMessage(`未找到任务 ${tid}`);

    const owners = mentionTextFromIds(task.owners || []);
    const prog = (task.progress || []).slice(-3).map(p => {
      const who = '@' + String(p.by).split('@')[0];
      const tstr = new Date(p.at).toLocaleString();
      return `- ${tstr} ${who}: ${p.text}`;
    }).join('\n') || '（暂无进展）';

    return chat.sendMessage(
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
      return chat.sendMessage(showAll ? '当前没有任务。' : '当前没有未完成任务。');
    }

    const toJid = (id) => {
      if (!id) return null;
      if (id.includes('@')) {
        return id.replace('@s.whatsapp.net', '@c.us');
      }
      return `${String(id).replace('+','')}@c.us`;
    };

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
    return chat.sendMessage(`${header}\n${lines}`, {
      mentions: mentionJids
    });
  }

  if (/^!mine\b/i.test(body)) {
    const me = senderId;
    const mine = tasksStore[groupId].filter(t => t.status === 'open' && (t.owners || []).includes(me));
    if (!mine.length) return chat.sendMessage('你名下暂无未完成任务。');
    const lines = mine.map(t => {
      const mark = t.latestProgress ? ' 📝' : (t.responded ? ' 💬' : '');
      return `• *${t.id}* ${t.text} ${t.due ? `(截止:${t.due})` : ''}${mark}`;
    }).join('\n');
    return chat.sendMessage(`👤 你的未完成任务：\n${lines}`);
  }

  if (/^\s*(?:任务|待办|TODO)\s*[:：]/i.test(body)) {
    let structured = null;
    try { structured = await extractTaskWithDify(body, groupId, senderId); } catch {}

    const toJid = (id) => {
      if (!id) return null;
      const s = String(id).trim();
      if (s.includes('@')) return s.replace('@s.whatsapp.net', '@c.us');
      return `${s.replace('+','')}@c.us`;
    };

    const due = structured?.fields?.due || parseDueDate(body);
    const text = structured?.fields?.text || stripTaskDecorations(body);

    const mentions = await msg.getMentions().catch(() => []);
    const ownerJidsFromMentions = (mentions || [])
      .map(c => toJid(c?.id?._serialized || c?._serialized))
      .filter(Boolean);

    const ownersInput = (structured?.owners && structured.owners.length)
      ? structured.owners
      : ownerJidsFromMentions;

    const ownersJids = Array.from(new Set((ownersInput || []).map(toJid).filter(Boolean)));

    const task = {
      id: 'T' + Date.now().toString().slice(-6),
      groupId,
      messageId: msg.id?._serialized || '',
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

    return safeSendWithMentions(chat, `${header}\n${bodyText}${ownersText}${tips}`, ownersJids);
  }

  const idHit = body.match(/\bT\d{6,}\b/);
  if (idHit) {
    const task = tasksStore[groupId].find(t => t.id === idHit[0]);
    if (task && isOwnerOrCreator(task, senderId) && !/^!/.test(body)) {
      const added = addProgress(task, body, senderId, msg.id?._serialized);
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

async function handleEmailBot(msg, groupId) {
  await msg.reply('EmailBot 功能开发中...');
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

function cleanSessionDir() {
  const sessionDir = path.join(__dirname, '.wwebjs_auth/session/whatsapp-bot-session');
  try {
    if (fs.existsSync(sessionDir)) {
      rimraf(sessionDir);
      console.log(`[LOG] 已清理旧会话目录: ${sessionDir}`);
    }
  } catch (err) {
    console.error(`[ERR] 清理会话目录失败: ${err.message}`);
  }
}

// 解析消息中的 @ 标签，合法 WhatsApp ID 转换为纯数字，不合法保持原样
async function parseMessageMentions(msg, body = '') {
  // 安全检查
  if (!msg || !body) {
    console.error('[ERR] Message or body is not available');
    return body || '';
  }

  // 获取提到的用户列表
  const mentions = await msg.getMentions();
  if (!mentions || mentions.length === 0) {
    console.log('[DEBUG] 没有找到 mentions');
    return body;
  }

  // 调试 mentions 数据
  console.log('[DEBUG] 获取到的 mentions:', JSON.stringify(mentions, null, 2));

  // 构建 pushname 列表，按 mentions 顺序排列
  const pushnames = mentions.map(contact => contact.pushname || contact.id.user);
  console.log('[DEBUG] 映射的 pushnames:', pushnames);

  // 替换所有 @数字，按顺序匹配
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

// 解析消息中的 @ 标签，合法 WhatsApp ID 转换为纯数字，不合法保持原样
async function parseMessageMentionsNumber(msg, body = '') {
  // 安全检查
  if (!msg || !body) {
    console.error('[ERR] Message or body is not available');
    return body || '';
  }

  // 获取提到的用户列表
  const mentions = await msg.getMentions();
  if (!mentions || mentions.length === 0) {
    console.log('[DEBUG] 没有找到 mentions');
    return body;
  }

  // 调试 mentions 数据
  console.log('[DEBUG] 获取到的 mentions:', JSON.stringify(mentions, null, 2));

  // 构建 number 列表，按 mentions 顺序排列
  const numbers = mentions.map(contact => contact.number || contact.id.user);
  console.log('[DEBUG] 映射的 numbers:', numbers);

  // 替换所有 @数字，按顺序匹配
  let result = body;
  const mentionRegex = /@(\d+)/g;
  let mentionIndex = 0;

  result = result.replace(mentionRegex, (match, id) => {
    console.log(`[DEBUG] 处理匹配: ${match}, ID: ${id}, 索引: ${mentionIndex}`);
    if (mentionIndex < numbers.length) {
      const replacement = `@${numbers[mentionIndex]}`;
      console.log(`[DEBUG] 替换: ${match} -> ${replacement}`);
      mentionIndex++;
      return replacement;
    } else {
      console.log(`[DEBUG] 跳过: 索引 ${mentionIndex} 超出 numbers 长度`);
      return match;
    }
  });

  console.log(`[DEBUG] 处理后的结果: ${result}`);
  return result;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'whatsapp-bot-session',
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => {
  console.log('请扫描以下二维码登录 WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp Bot 已启动');
});

client.on('message', async msg => {
  try {
    const user = msg.from;
    let query = content = msg.body || '';
    let files = [];

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const groupName = isGroup ? chat.name : '非群組';
    console.log(`收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}`);
    appendLog(user, `收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}`);
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
      const media = await msg.downloadMedia();
      if (media) {
        const ext = mime.extension(media.mimetype) || 'ogg';
        const filename = `audio_${Date.now()}.${ext}`;
        const filepath = path.join(TMP_DIR, filename);
        await fsPromises.writeFile(filepath, Buffer.from(media.data, 'base64'));
        console.log(`[LOG] 语音已保存: ${filepath}`);
        query = await audioToText(filepath, user);
        console.log(`[LOG] 语音转文字结果: ${query}`);
        await fsPromises.unlink(filepath);
        console.log(`[LOG] 临时语音文件已删除: ${filepath}`);
      }
    } else {
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
        await msg.reply('未识别到有效内容。');
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
        await handleEpermitBot(msg, groupId, needReply);
        break;
      case 'insp-bot':
        await handleInspBot(msg, groupId, needReply);
        break;
      case 'summary-bot':
        await handleSummaryBot(msg, groupId);
        break;
      case 'email-bot':
        await handleEmailBot(msg, groupId);
        break;
      default:
        await msg.reply('未知 Bot 类型');
    }

  } catch (err) {
    console.error('处理消息出错:', err);
    try { await msg.reply('机器人处理消息时出错，请稍后再试。'); } catch {}
    console.log('[LOG] 处理消息时发生异常');
  }
});

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
      await client.sendMessage(groupId, output);
    } catch (err) {
      console.error(`[ERR] 群组 ${groupId} 获取未撤离数据失败:`, err);
      await client.sendMessage(groupId, '获取未撤离数据失败，请稍后再试。');
    }
  }
});

async function sendTodaySummary() {
  try {
    const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
      params: { group_id: GROUP_ID }
    });
    const data = resp.data;
    const summary = formatSummary(data);
    await client.sendMessage(GROUP_ID, summary);
    console.log('定时推送已发送');
  } catch (err) {
    console.error('调用 records/today 失败：', err);
    await client.sendMessage(GROUP_ID, '获取今日记录失败，请稍后重试。');
  }
}

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

          await client.sendMessage(
            gid,
            text,
            ownerJids.length ? { mentions: ownerJids } : {}
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

cleanSessionDir();
client.initialize();

function shouldReply(msg, botName) {
  const body = msg.body || '';
  return body.includes(botName) || body.startsWith('/ai') || body.startsWith('ai ');
}

async function audioToText(filepath, user) {
  return '语音转文字结果（占位）';
}

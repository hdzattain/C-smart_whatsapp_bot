const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const mime = require('mime-types');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

// client对象（假定已全局初始化）
const GROUP_ID = '120363418441024423@g.us'; // 替换成目标群聊ID
const GROUP_ID_2 = '120363400601106571@g.us'; // 替换成目标群聊ID
const GROUP_ID_3 = '120363030675916527@g.us';

const DIFY_API_KEY  = 'app-A18jsyMNjlX3rhCDJ9P4xl6z';
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const FASTGPT_API_URL = 'https://rgamhdso.sealoshzh.site/api/v1/chat/completions';
const FASTGPT_API_KEY = 'openapi-ziUjnlzVwlIvEITHVZ9M4XXmMLBtyjbgTBZbybRS3xI5HtNyuSOKIlIZl9Qb';
const BOT_NAME      = process.env.BOT_NAME || 'C-SMART'; // 机器人昵称

const TIME_SEGMENTS = [
  { name: '上午', start: 300, end: 780, field: 'morning' }, // 06:00-13:00
  { name: '下午', start: 780, end: 1380, field: 'afternoon' } // 13:00-23:00
];

/**
 * 群組格式配置，支持不同群組的摘要格式。
 */
const GROUP_FORMATS = {
  [GROUP_ID]: {
    title: 'LiftShaft (Permit to Work)',
    guidelines: [
      '升降機槽工作許可證填妥及齊簽名視為開工',
      '✅❎為中建影安全相，⭕❌為分判影安全相',
      '收工影鎖門和撤銷許可證才視為工人完全撤離及交回安全部'
    ],
    showFields: ['location', 'subcontractor', 'number', 'floor', 'safetyStatus', 'xiaban'],
    timeSegments: [
      { name: '上午', start: 300, end: 780, field: 'morning' }, // 06:00-13:00
      { name: '下午', start: 780, end: 1380, field: 'afternoon' } // 13:00-23:00
    ]
  },
  [GROUP_ID_2]: {
    title: 'External Scaffolding Work(Permit to work)',
    guidelines: [
      '外牆棚工作許可證填妥及齊簽名視為開工',
      '✅❎為中建影安全相，⭕❌為分判影安全相',
      '收工影工作位置和撤銷許可證才視為工人完全撤離及交回安全部'
    ],
    showFields: ['location', 'subcontractor', 'number', 'floor', 'safetyStatus', 'xiaban'],
    timeSegments: [
      { name: '上午', start: 360, end: 660, field: 'morning' }, // 06:00-11:00
      { name: '飯前', start: 660, end: 720, field: 'morning' }, // 11:00-12:00
      { name: '飯後', start: 720, end: 840, field: 'afternoon' }, // 12:00-14:00
      { name: '下午', start: 840, end: 1320, field: 'afternoon' } // 14:00-22:00
    ]
  },
  // 未來群組可在此添加自定義格式
  default: {
    title: 'LiftShaft (Permit to Work)',
    guidelines: [
      '升降機槽工作許可證填妥及齊簽名視為開工',
      '✅❎為中建影安全相，⭕❌為分判影安全相',
      '收工影鎖門和撤銷許可證才視為工人完全撤離及交回安全部'
    ],
    showFields: ['location', 'subcontractor', 'number', 'floor', 'safetyStatus', 'xiaban'],
    timeSegments: [
      { name: '上午', start: 300, end: 780, field: 'morning' }, // 06:00-13:00
      { name: '下午', start: 780, end: 1380, field: 'afternoon' } // 13:00-23:00
    ]
  }
};

const TMP_DIR  = path.join(__dirname, 'tmp');
fs.ensureDirSync(TMP_DIR);

const LOG_WHATSAPP_MSGS = process.env.LOG_WHATSAPP_MSGS === 'true';
const LOG_DIR  = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'whatsapp.log');
fs.ensureDirSync(LOG_DIR);

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'whatsapp-bot-session',
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('请扫描二维码登录 WhatsApp');
  appendLog('default', '请扫描二维码登录 WhatsApp');
});

client.on('ready', () => {
  console.log('WhatsApp 机器人已启动');
  appendLog('default', 'WhatsApp 机器人已启动');
});

// —— 关键词检测 ——  
function containsSummaryKeyword(text) {
  const keywords = [
    '总结', '概括', '总结一下', '整理情况', '汇总', '回顾',
    '總結', '概括', '總結一下', '整理情況', '彙總', '回顧'
  ];
  return keywords.some(k => text.includes(k));
}

/**
 * 解析 bstudio_create_time 的日期。
 * @param {string} timeStr - 時間字符串，格式為 "Tue, 12 Aug 2025 09:53:39 GMT"
 * @returns {string} - 格式化日期字符串 (YYYY-MM-DD)
 */
function parseDate(timeStr) {
  if (!timeStr) return '未知';
  try {
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return '未知';
    return date.toISOString().split('T')[0];
  } catch (e) {
    return '未知';
  }
}


/**
 * 安全轉換布爾值或數字為 ✅ 或 ❎。
 * @param {boolean|number|string} val - 要轉換的值
 * @returns {string} - ✅ 或 ❎
 */
function safeVal(val) {
  return val === true || val === 1 || val === 'true' ? '✅' : '❎';
}

// 撤离描述
function xiabanText(xiaban, part_leave_number, num) {
  if (parseInt(xiaban) === 1 || (parseInt(part_leave_number) >= 1)) {
    // 全部撤离
    if (parseInt(xiaban) === 1 || parseInt(part_leave_number) >= parseInt(num)) {
      return ` ——＞已全部撤離`;
    } else {
      return ` ——＞已撤離${part_leave_number}/${num}人`;
    }
  }
  return '';
}

/**
 * 解析 bstudio_create_time 的時間並映射到時間段。
 * @param {string} timeStr - 時間字符串，格式為 "Tue, 12 Aug 2025 09:53:39 GMT"
 * @returns {string} - 時間段名稱（上午、飯前、飯後、下午）
 */
function parseTimeSegment(timeStr, groupId = 'default') {
  if (!timeStr) return '未知';
  
  try {
    const date = new Date(timeStr);
    if (isNaN(date.getTime())) return '未知';
    
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const timeInMinutes = hours * 60 + minutes;

    // 使用群组特定的时间段配置
    const formatConfig = GROUP_FORMATS[groupId] || GROUP_FORMATS.default;
    const timeSegments = formatConfig.timeSegments || TIME_SEGMENTS;

    for (const segment of timeSegments) {
      if (timeInMinutes >= segment.start && timeInMinutes < segment.end) {
        return segment.name;
      }
    }
    return '未知';
  } catch (e) {
    return '未知';
  }
}


/**
 * 格式化工作許可證記錄摘要。
 * @param {Array} data - 許可證記錄數組
 * @param {string} groupId - 群組 ID
 * @returns {string} - 格式化摘要字符串
 */
function formatSummary(data, groupId = 'default') {
  if (!Array.isArray(data) || data.length === 0) return "今日無工地記錄";
  
  // 獲取群組格式配置，默認為 default
  const formatConfig = GROUP_FORMATS[groupId] || GROUP_FORMATS.default;
  
  // 解析日期
  const dateStr = parseDate(data[0].bstudio_create_time || '');
  
  // 聚合分判商
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

  // 生成記錄詳情
  const details = data.map((rec, i) => {
    const fields = {
      location: rec.location || '',
      subcontractor: rec.subcontrator || rec.subcontractor || '',
      number: rec.number || '',
      floor: rec.floor || '',
      // 修改：使用群组特定的时间段配置
      safetyStatus: formatConfig.timeSegments.map(segment => {
        const isCurrentSegment = parseTimeSegment(rec.bstudio_create_time, groupId) === segment.name;
        const fieldValue = rec[segment.field];
        return `${segment.name} ${isCurrentSegment ? '✅' : '❎'}`;
      }).join('，'),
      xiaban: xiabanText(rec.xiaban, rec.part_leave_number || 0, rec.number || 0)
    };

    // 根據群組配置動態選擇顯示字段
    const output = [];
    if (formatConfig.showFields.includes('location')) {
      output.push(`${i + 1}. ${fields.location} ${fields.subcontractor} 共 ${fields.number} 人 樓層 ${fields.floor}\n`);
    }
    if (formatConfig.showFields.includes('safetyStatus')) {
      output.push(`【安全相: ${fields.safetyStatus}】`);
    }
    if (formatConfig.showFields.includes('xiaban')) {
      output.push(fields.xiaban);
    }
    return output.join('\n');
  });

  // 組裝最終輸出
  return (
    `------${formatConfig.title}------\n` +
    `日期: ${dateStr}\n` +
    `主要分判: ${mainContr}\n\n` +
    `⚠指引\n` +
    formatConfig.guidelines.map(line => `- ${line}`).join('\n') + '\n\n' +
    `以下為申請位置\n` +
    details.join('\n')
  );
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

function formatOTSummary(data) {
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

  // 过滤满足条件的记录，并保持序号从1到n
  const details = data
    .filter(rec => parseInt(rec.xiaban) === 0 && parseInt(rec.part_leave_number || 0) < parseInt(rec.number || 0))
    .map((rec, i) => {
      const loc = rec.location || '';
      const sub = rec.subcontrator || rec.subcontractor || '';
      const num = rec.number || '';
      const floor = rec.floor || '';
      return `${i + 1}. ${loc} ${sub} 共 ${num} 人 樓層 ${floor}\n`;
    });

  if (details.length === 0) return "今日無未撤離分判記錄";

  return (
    `未撤離分判\n` +
    `日期: ${dateStr}\n` +
    details.join('\n')
  );
}

function extractAgentAnswer(logString) {
  // 逐行解析所有 events
  const events = logString
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('data: '))
    .map(line => {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        return null;
      }
    })
    .filter(evt => !!evt && evt.event === 'agent_message');

  // 取最后一个有内容的 answer
  for (let i = events.length - 1; i >= 0; i--) {
    const answer = events[i].answer;
    if (typeof answer === 'string' && answer.trim()) {
      // 直接返回字符串，避免 JSON.parse 控制字符报错
      return answer;
    }
  }

  // 没找到有效 answer
  throw new Error('未找到有效的 agent_message answer');
}

// —— 封装：是否需要AI回复的判定逻辑 ——
function shouldReply(msg, botName) {
  // 只对群聊做判定，私聊永远回复
  if (!msg.from || msg.from.endsWith('@g.us')) {
    // 群聊消息
    const text = (msg.body || '').trim();
    // WhatsApp 群聊 @ 机器人的格式为 @昵称 或带群内 mention
    const mention = msg.mentionedIds && msg.mentionedIds.includes(msg.to); // @机器人id
    const atName  = text.includes(`@${botName}`); // @昵称
    const withAi  = text.startsWith('/ai') || text.startsWith('ai ');

    return mention || atName || withAi;
  }
  return true; // 私聊，默认都回复
}
client.on('message', async msg => {
  try {
    const user = msg.from;
    let query = '';
    let files = [];

    // 判断是否群聊
    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const groupName = isGroup ? chat.name : '非群組';
    console.log(`收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}`);
    appendLog(user, `收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}`);
    if (!isGroup) {
      console.log('不是群聊消息，不回复用户');
      appendLog(user, '不是群聊消息，不回复用户');
      return;
    }
    // 在发送到API前，记录 group_id
    const groupId = msg.from; // 这就是 WhatsApp 的群ID
    console.log(msg.body);
    appendLog(groupId, msg.body);

    // —— 处理不同类型的 WhatsApp 消息 ——
    if (msg.type === 'chat') {
      query = msg.body.trim();
      console.log(`文本消息内容: ${query}`);
      appendLog(groupId, `文本消息内容: ${query}`);
      // 如果用户输入包含「总结」等关键词，直接调用接口并返回结果
      if (containsSummaryKeyword(query)) {
        try {
          const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
            params: {
              group_id: groupId // 替换为实际的群组ID
            }
          });
          // 假定接口返回的是一个 JSON 数组
          const data = resp.data;
          const summary = formatSummary(data, groupId);
          await msg.reply(summary);
        } catch (err) {
          console.log(`调用 records/today 失败：${err.message}`);
          appendLog(groupId, `调用 records/today 失败：${err.message}`);
          await msg.reply('获取今日记录失败，请稍后重试。');
        }
        return;  // 拦截后不再往下走 FastGPT 流程
      }
    } else if (msg.type === 'image') {
      // 图片（可能带有文字 caption）
      const media = await msg.downloadMedia();
      if (media) {
        const ext = mime.extension(media.mimetype) || 'jpg';
        const filename = `img_${Date.now()}.${ext}`;
        const filepath = path.join(TMP_DIR, filename);
        await fs.writeFile(filepath, media.data, 'base64');
        console.log(`图片已保存: ${filepath}`);
        appendLog(groupId, `图片已保存: ${filepath}`);

        // 上传到 Dify
        // // const file_id = await uploadFileToDify(filepath, user, 'image');
        // console.log(`图片已上传到Dify，file_id: ${file_id}`);
        // appendLog(groupId, `图片已上传到Dify，file_id: ${file_id}`);
        // files.push({
        //   type: 'image',
        //   transfer_method: 'local_file',
        //   upload_file_id: file_id
        // });

        // 支持图文混合：读取 caption 或 body
        const caption = msg.caption || msg.body || '';
        query = caption ? `[图片] ${caption}` : '[图片]';
        console.log(`图文消息内容: ${query}`);
        appendLog(groupId, `图文消息内容: ${query}`);

        // 删除临时文件
        // await fs.remove(filepath);
        // console.log(`临时图片文件已删除: ${filepath}`);
        // appendLog(groupId, `临时图片文件已删除: ${filepath}`);
      }
    } else if (['ptt', 'audio'].includes(msg.type)) {
      const media = await msg.downloadMedia();
      if (media) {
        const ext = mime.extension(media.mimetype) || 'ogg';
        const filename = `audio_${Date.now()}.${ext}`;
        const filepath = path.join(TMP_DIR, filename);
        await fs.writeFile(filepath, media.data, 'base64');
        console.log(`语音已保存: ${filepath}`);
        appendLog(groupId, `语音已保存: ${filepath}`);
        query = await audioToText(filepath, user);
        console.log(`语音转文字结果: ${query}`);
        appendLog(groupId, `语音转文字结果: ${query}`);
        await fs.remove(filepath);
        console.log(`临时语音文件已删除: ${filepath}`);
        appendLog(groupId, `临时语音文件已删除: ${filepath}`);
      }
    } else {
      query = '[暂不支持的消息类型]';
      console.log(`收到暂不支持的消息类型: ${msg.type}`);
      appendLog(groupId, `收到暂不支持的消息类型: ${msg.type}`);
    }

    // —— 可选：记录收到的 WhatsApp 消息 ——
    if (LOG_WHATSAPP_MSGS) {
      const logEntry = `[${new Date().toISOString()}] ${msg.from} (${msg.type}): ${msg.body || ''}\n`;
      await fs.appendFile(LOG_FILE, logEntry);
      console.log('消息已写入日志文件');
      appendLog(groupId, '消息已写入日志文件');
    }

    if (!query) {
      if (!isGroup || shouldReply(msg, BOT_NAME)) {
        await msg.reply('未识别到有效内容。');
        console.log('未识别到有效内容，已回复用户');
        appendLog(groupId, '未识别到有效内容，已回复用户');
      }
      return;
    }

    // —— 是否触发AI回复？只在群聊中检测 @机器人 或 /ai ——
    const needReply = isGroup && shouldReply(msg, BOT_NAME);
    console.log(`是否需要AI回复: ${needReply}`);
    appendLog(groupId, `是否需要AI回复: ${needReply}`);

    // —— 调用 FastGPT，拿到返回的 JSON 数据 ——
    let replyStr;
    try {
      query = `${query} [group_id:${groupId}]`;
      console.log(`开始调用FastGPT，query: ${query}, files: ${JSON.stringify(files)}`);
      appendLog(groupId, `开始调用FastGPT，query: ${query}, files: ${JSON.stringify(files)}`);
      replyStr = await sendToFastGPT({ query, user, msg });
      console.log(`FastGPT response content: ${replyStr}`);
      appendLog(groupId, `FastGPT 调用完成，content: ${replyStr}`);
    } catch (e) {
      console.log(`FastGPT 调用失败: ${e.message}`);
      appendLog(groupId, `FastGPT 调用失败: ${e.message}`);
      if (needReply) await msg.reply('调用 FastGPT 失败，请稍后再试。');
      return;
    }

    // —— 回复用户 ——
    if (needReply || replyStr.includes('缺少')) {
      try {
        console.log(`尝试回复用户: ${replyStr}`);
        appendLog(groupId, `尝试回复用户: ${replyStr}`);
        await msg.reply(replyStr);
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
    try { await msg.reply('机器人处理消息时出错，请稍后再试。'); } catch {}
    console.log('处理消息时发生异常');
    appendLog(msg.from, '处理消息时发生异常');
  }
});

client.initialize();

// — 上传图片/文件到 Dify — 
async function uploadFileToDify(filepath, user, type = 'image') {
  const form = new FormData();
  form.append('file', fs.createReadStream(filepath));
  form.append('user', user);
  const res = await axios.post(
    `${DIFY_BASE_URL}/files/upload`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${DIFY_API_KEY}`
      }
    }
  );
  return res.data.id;
}

// — 语音转文字 — 
async function audioToText(filepath, user) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filepath));
  form.append('user', user);
  const res = await axios.post(
    `${DIFY_BASE_URL}/audio-to-text`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${DIFY_API_KEY}`
      }
    }
  );
  return res.data.text || '[语音转文字失败]';
}

// — 发送消息到 FastGPT，返回 content 字段 —
async function sendToFastGPT({ query, user, msg }) {
  const chatId = uuidv4(); // 生成随机 chatId
  const data = {
    chatId: chatId,
    stream: false,
    detail: false,
    messages: [
      {
        content: query,
        role: 'user'
      }
    ]
  };

  let lastErr;
  for (let i = 0; i < 3; i++) {  // 最多重试3次
    try {
      const res = await axios.post(
        FASTGPT_API_URL,
        data,
        {
          headers: {
            'Authorization': `Bearer ${FASTGPT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 25000 // 25秒超时，防止僵死
        }
      );
      // 提取 choices[0].message.content
      const content = res.data.choices[0]?.message?.content;
      if (!content) {
        throw new Error('FastGPT 返回数据中缺少 content 字段');
      }
      return content;
    } catch (err) {
      lastErr = err;
      // 只对“断流”类重试
      const msg = (err.message || '') + (err.code ? ' ' + err.code : '');
      if (
        (msg.includes('aborted') || msg.includes('stream') || msg.includes('ECONNRESET') || msg.includes('ERR_BAD_RESPONSE')) &&
        i < 2 // 只重试前两次
      ) {
        console.log(`FastGPT 请求断流，正在第${i+1}次重试...`);
        appendLog(user, `FastGPT 请求断流，正在第${i+1}次重试...`);
        await new Promise(res => setTimeout(res, 1200 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  // 彻底失败
  throw lastErr;
}

// — 发送消息到 Dify，返回原始 SSE 文本 — 
async function sendToDify({ query, user, files = [], response_mode = 'streaming', inputs = {} }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const uniqueQuery = `${query} @${now}`;
  const data = { query: uniqueQuery, user, files, response_mode, inputs };

  let lastErr;
  for (let i = 0; i < 3; i++) {  // 最多重试3次
    try {
      const res = await axios.post(
        `${DIFY_BASE_URL}/chat-messages`,
        data,
        {
          headers: {
            'Authorization': `Bearer ${DIFY_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'text',
          timeout: 25000 // 25秒超时，防止僵死
        }
      );
      return res.data;
    } catch (err) {
      lastErr = err;
      // 只对“断流”类重试
      const msg = (err.message || '') + (err.code ? ' ' + err.code : '');
      if (
        (msg.includes('aborted') || msg.includes('stream') || msg.includes('ECONNRESET') || msg.includes('ERR_BAD_RESPONSE')) &&
        i < 2 // 只重试前两次
      ) {
        appendLog(user, `Dify stream断流，正在第${i+1}次重试...`);
        await new Promise(res => setTimeout(res, 1200 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  // 彻底失败
  throw lastErr;
}

async function getSummary(group_id) {
  const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
    params: {
      group_id: group_id // 替换为实际的群组ID
    }
  });
  const data = resp.data;
  const summary = formatSummary(data, group_id); 
  await client.sendMessage(group_id, summary); // 主动发到群聊
}

async function getOTSummary(group_id) {
  const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
    params: {
      group_id: group_id // 替换为实际的群组ID
    }
  });
  const data = resp.data;
  const summary = formatOTSummary(data); 
  await client.sendMessage(group_id, summary); // 主动发到群聊
}

// 汇总生成函数
async function sendTodaySummary() {
  try {
    getSummary(GROUP_ID);
    getSummary(GROUP_ID_2);
    getSummary(GROUP_ID_3);
    appendLog('default', '定时推送已发送');
  } catch (err) {
    appendLog('default', `调用 records/today 失败：${err.message}`);
    await client.sendMessage(GROUP_ID, '获取今日记录失败，请稍后重试。');
    await client.sendMessage(GROUP_ID_2, '获取今日记录失败，请稍后重试。');
    await client.sendMessage(GROUP_ID_3, '获取今日记录失败，请稍后重试。');
  }
}

// 汇总生成函数
async function sendOTSummary() {
  try {
    getOTSummary(GROUP_ID_2);
    getOTSummary(GROUP_ID_3);
    appendLog('default', '定时推送已发送');
  } catch (err) {
    appendLog('default', `调用 records/today 失败：${err.message}`);
    await client.sendMessage(GROUP_ID_2, '获取今日记录失败，请稍后重试。');
    await client.sendMessage(GROUP_ID_3, '获取今日记录失败，请稍后重试。');
  }
}

// node-cron语法: '分 时 日 月 周'，以下每个时间点都定一次
cron.schedule('0 10 * * *', sendTodaySummary);  // 10:00
cron.schedule('0 12 * * *', sendTodaySummary);  // 12:00
cron.schedule('0 14 * * *', sendTodaySummary);  // 14:00
cron.schedule('0 16 * * *', sendTodaySummary);  // 16:00
cron.schedule('0 18 * * *', sendTodaySummary);  // 18:00
cron.schedule('0 18 * * *', sendOTSummary);  // 18:00

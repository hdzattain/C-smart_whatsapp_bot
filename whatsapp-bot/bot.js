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
const GROUP_ID_4 = '120363372181860061@g.us'; // 啟德醫院 Site 🅰 外牆棚架工作
const GROUP_ID_5 = '120363401312839305@g.us'; // 啟德醫院🅰️Core/打窿工序通知群組
const GROUP_ID_6 = '120363162893788546@g.us'; // 啓德醫院BLW🅰️熱工序及巡火匯報群組

// 外墙棚架群组定义
const EXTERNAL_SCAFFOLDING_GROUPS = [
    GROUP_ID_2,
    GROUP_ID_4,
    GROUP_ID_5,
    GROUP_ID_6
]

// 完全静默群组配置
const BLACKLIST_GROUPS = [
  GROUP_ID_4,
  GROUP_ID_5,
  GROUP_ID_6
];

const DIFY_API_KEY  = 'app-A18jsyMNjlX3rhCDJ9P4xl6z';
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const FASTGPT_API_URL = 'http://43.154.37.138:3008/api/v1/chat/completions';
const FASTGPT_API_KEY = 'fastgpt-uhlgWY5Lsti1X4msKMzDHheQ4AAEH4hfzr7fczsBA5nA14HEwF7AZ2Nua234Khai';
const BOT_NAME      = process.env.BOT_NAME || 'C-SMART'; // 机器人昵称

const TIME_SEGMENTS = [
  { name: '上午', start: 300, end: 780, field: 'morning' }, // 06:00-13:00
  { name: '下午', start: 780, end: 1380, field: 'afternoon' } // 13:00-23:00
];

const EXTERNAL_SCAFFOLDING_FORMAT = {
  title: 'External Scaffolding Work(Permit to work)',
  guidelines: [
    '外牆棚工作許可證填妥及齊簽名視為開工',
    '✅❎為中建影安全相，⭕❌為分判影安全相',
    '收工影工作位置和撤銷許可證才視為工人完全撤離及交回安全部'
  ],
  showFields: ['location', 'subcontractor', 'number', 'floor', 'safetyStatus', 'xiaban', 'process', 'timeRange', ''],
  timeSegments: [
    { name: '上午', start: 360, end: 660, field: 'morning' },
    { name: '飯前', start: 660, end: 720, field: 'morning' },
    { name: '飯後', start: 720, end: 840, field: 'afternoon' },
    { name: '下午', start: 840, end: 1320, field: 'afternoon' }
  ],
  detailGenerator: generateExternalSummaryDetails
};

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
    ],
    detailGenerator: generateSummaryDetails
  },
  [GROUP_ID_2]: EXTERNAL_SCAFFOLDING_FORMAT,
  [GROUP_ID_4]: EXTERNAL_SCAFFOLDING_FORMAT,
  [GROUP_ID_5]: EXTERNAL_SCAFFOLDING_FORMAT,
  [GROUP_ID_6]: EXTERNAL_SCAFFOLDING_FORMAT,
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
    ],
    detailGenerator: generateSummaryDetails
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

// 检查群组是否在黑名单中（使用包含检查）
function isBlacklistedGroup(msgFrom) {
  if (!msgFrom) return false;
  return BLACKLIST_GROUPS.some(blacklistId => msgFrom.includes(blacklistId));
}


// —— 后端返回数据的处理函数 ——
// function parseDate(dtStr) {
//   // 尝试用 Date 解析，否则截取前 10 个字符
//   const d = new Date(dtStr);
//   if (!isNaN(d)) {
//     return d.toISOString().slice(0, 10);
//   }
//   return dtStr.slice(0, 10);
// }

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
  const details = formatConfig.detailGenerator(data, formatConfig, groupId);

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

// 生成Summary详情方法（普通群组）
function generateSummaryDetails(data, formatConfig, groupId) {
  const details = data.map((rec, i) => {
    let updateHistory = [];
    try {
      if (typeof rec.update_history === 'string' && rec.update_history.trim() !== '') {
        try {
          updateHistory = JSON.parse(rec.update_history);
          // 确保解析结果是数组
          if (!Array.isArray(updateHistory)) {
            updateHistory = [];
          }
        } catch (jsonError) {
          console.warn(`解析update_history失败: ${jsonError.message}`);
          updateHistory = [];
        }
      } else if (Array.isArray(rec.update_history)) {
        updateHistory = rec.update_history;
      }
    } catch (e) {
      console.error(`处理update_history时出错: ${e.message}`);
      updateHistory = [];
    }

    const fields = {
      location: rec.location || '',
      subcontractor: rec.subcontrator || rec.subcontractor || '',
      number: rec.number || '',
      floor: rec.floor || '',
      safetyStatus: formatConfig.timeSegments.map(segment => {
        // 检查是否有任何时间戳落在当前时间段内
        const hasTimeInSegment = updateHistory.some(timestamp => {
          try {
            return parseTimeSegment(timestamp, groupId) === segment.name;
          } catch (e) {
            return false;
          }
        });

        return `${segment.name} ${hasTimeInSegment ? '✅' : '❎'}`;
      }).join('，'),
      xiaban: xiabanText(rec.xiaban, rec.part_leave_number || 0, rec.number || 0)
    };
    console.log('update_history:', updateHistory);

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

  return details;
}

// 生成Summary详情方法（外墙群组）
function generateExternalSummaryDetails(data, formatConfig, groupId) {
    // 外墙群组：按 building 分组
    const byBuilding = data.reduce((acc, rec) => {
      const building = rec.building || '未知';
      if (!acc[building]) acc[building] = [];
      acc[building].push(rec);
      return acc;
    }, {});

    const details = Object.keys(byBuilding).sort().map(building => {
      const records = byBuilding[building];

      // 按ID排序
      const sortedRecords = records.sort((a, b) => (a.id || 0) - (b.id || 0));
      // 提取楼栋字母（A座 -> A, B座 -> B, 未知 -> 空字符串）
      const buildingLetter = building === '未知' ? '' : building.replace('座', '');

      const buildingDetails = sortedRecords.map((rec, index) => {
        let updateHistory = [];
        try {
          if (typeof rec.update_history === 'string' && rec.update_history.trim()) {
            updateHistory = JSON.parse(rec.update_history);
            if (!Array.isArray(updateHistory)) updateHistory = [];
          } else if (Array.isArray(rec.update_history)) {
            updateHistory = rec.update_history;
          }
        } catch (e) {
          console.warn(`处理update_history失败: ${e.message}`);
          updateHistory = [];
        }

        // 生成前缀（A01-, A02-, B01-, B02- 等）
        const prefix = `${buildingLetter}${String(index + 1).padStart(2, '0')}-`;

        const fields = {
          location: `${prefix}${rec.location || ''}`,
          floor: rec.floor || '',
          subcontractor: rec.subcontractor || '',
          number: rec.number || 0,
          process: rec.process || '',
          time_range: rec.time_range || '',
          safetyStatus: formatConfig.timeSegments.map(segment => {
            const hasTimeInSegment = updateHistory.some(timestamp => parseTimeSegment(timestamp, groupId) === segment.name);

            const now = new Date();
            const nowMinutes = (now.getUTCHours() + 8) * 60 + now.getUTCMinutes();

            return hasTimeInSegment
            ? `${segment.name}⭕`
            : (nowMinutes < segment.end ? `${segment.name}` : `${segment.name}❌`);
          }).join('，'),
          xiaban: xiabanText(rec.xiaban, rec.part_leave_number || 0, rec.number || 0)
        };

        const recordLine = `${fields.location}，${fields.floor}，${fields.subcontractor}，${fields.number}人，工序:${fields.process}，時間:${fields.time_range}`;
        const safetyLine = `【安全相：${fields.safetyStatus}】${fields.xiaban}`;
        return `${recordLine}\n${safetyLine}`;
      });
      return `${building}\n${buildingDetails.join('\n')}`;
    });

    return details;
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
    if (isBlacklistedGroup(msg.from)) {
      return false;
    }

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
    if (!isGroup || msg.body.includes('Permit') || msg.body.includes('提示') || msg.body.includes('留意')) {
      console.log('不是群聊消息，不回复用户');
      appendLog(user, '不是群聊消息，属于用户自行总结，不回复用户');
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
        if (isBlacklistedGroup(groupId)) {
          console.log(`群组 ${groupId} 在黑名单中，禁止使用总结功能`);
          appendLog(groupId, `群组在黑名单中，禁止使用总结功能`);
          return; // 直接返回，不执行总结功能
        }

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

    // —— 调用 FastGPT，拿到返回的 JSON 数据 —— 临时注释掉有幻觉的agent调用，直接调用工作流
    // let replyStr;
    // try {
    //   query = `${query} [group_id:${groupId}]`;
    //   console.log(`开始调用FastGPT，query: ${query}, files: ${JSON.stringify(files)}`);
    //   appendLog(groupId, `开始调用FastGPT，query: ${query}, files: ${JSON.stringify(files)}`);
    //   replyStr = await sendToFastGPT({ query, user, msg });
    //   console.log(`FastGPT response content: ${replyStr}`);
    //   appendLog(groupId, `FastGPT 调用完成，content: ${replyStr}`);
    // } catch (e) {
    //   console.log(`FastGPT 调用失败: ${e.message}`);
    //   appendLog(groupId, `FastGPT 调用失败: ${e.message}`);
    //   if (needReply) await msg.reply('调用 FastGPT 失败，请稍后再试。');
    //   return;
    // }
    // API key 常量，命名清晰且具可讀性
    const API_KEYS = {
      EPERMIT_UPDATE: 'fastgpt-j3A7GuAA7imPLdKBdt1YSE92nRlYTVIfrn43XoJAcz0sq81jUtZyEpTvPZYFBk0Ow',
      EPERMIT_RECORD: 'fastgpt-ac2n964yZB9iX1utRBxtJAyIAbXG08OvDPF451tDqsa8sE3BQKAQP',
      EPERMIT_DELETE: 'fastgpt-rP1hrMsmSZlNEo3RFEsLurtNYRBiqSICxUz3xTYGSU1VYO86jRD9v60P1ViyqNkIK',
      EPERMIT_ADD: 'fastgpt-jTBG55WM2xEXe06biuAg4WWgq4aqyrWvqiQKZ4uvRvLXgGaastDJ9CzKBgN'
    };

    // 處理查詢的主函數
    async function processQuery(query, groupId, user) {
      query = `${query} [group_id:${groupId}]`;

      const conditions = [
        {
          test: query => /申請|申報|以下為申請位置|申请|申报|以下为申请位置/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_RECORD })
        },
        {
          test: query => /現場安全|照明良好|安全設備齊全|安全檢查完成|安全帶|出棚|扣带|返回室内/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_UPDATE })
        },
        {
          test: query => /(撤離|已撤離|人走晒|收工|撤离|已撤离|人走完)/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_UPDATE })
        },
        {
          test: query => /刪除|撤回|刪除某天申請|刪除某位置記錄|删除|撤回|删除某天申请|删除某位置记录/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_DELETE })
        }
      ];

      // 外墙棚架群组不走增加分支逻辑
      if (!EXTERNAL_SCAFFOLDING_GROUPS.includes(groupId)) {
        conditions.push({
          test: query => /增加/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_ADD })
        });
      }

      const matchedCondition = conditions.find(c => c.test(query));
      return matchedCondition ? await matchedCondition.action() : null;
    }

    // 替換後的模組代碼
    let replyStr;
    try {
      console.log(`開始處理查詢，query: ${query}, files: ${JSON.stringify(files)}`);
      appendLog(groupId, `開始處理查詢，query: ${query}, files: ${JSON.stringify(files)}`);
      replyStr = await processQuery(query, groupId, user);
      if (replyStr === null) {
        console.log('無匹配條件，無法處理查詢');
        appendLog(groupId, '無匹配條件，無法處理查詢');
        if (needReply) await msg.reply('無法處理您的請求，請檢查輸入內容。');
        return;
      }
      console.log(`查詢處理完成，結果: ${replyStr}`);
      appendLog(groupId, `查詢處理完成，結果: ${replyStr}`);
    } catch (e) {
      console.log(`查詢處理失敗: ${e.message}`);
      appendLog(groupId, `查詢處理失敗: ${e.message}`);
      if (needReply) await msg.reply('處理請求失敗，請稍後再試。');
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
    if (!isBlacklistedGroup(msg.from)) {
      try {
        await msg.reply('机器人处理消息时出错，请稍后再试。');
      } catch (replyErr) {
        console.log(`发送错误回复失败: ${replyErr.message}`);
      }
    } else {
      console.log(`群组 ${msg.from} 在黑名单中，不发送错误回复`);
      appendLog(msg.from, '群组在黑名单中，不发送错误回复');
    }
    console.log('处理消息时发生异常');
    appendLog(msg.from, '处理消息时发生异常');
  }
});
// client.on('message', async msg => {
//   try {
//     const user = msg.from;
//     let query = '';
//     let files = [];

//     // 判断是否群聊
//     const chat = await msg.getChat();
//     const isGroup = chat.isGroup;
//     appendLog(user, `收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}`);
//     if (!isGroup) {
//       appendLog(user, '不是群聊消息，不回复用户');
//       return;
//     }
//     // 在发送到API前，记录 group_id
//     const groupId = msg.from; // 这就是 WhatsApp 的群ID
//     appendLog(groupId, msg.body);

//     // —— 处理不同类型的 WhatsApp 消息 ——
//     if (msg.type === 'chat') {
//       query = msg.body.trim();
//       appendLog(groupId, `文本消息内容: ${query}`);
//       // 如果用户输入包含「总结」等关键词，直接调用接口并返回结果
//       if (containsSummaryKeyword(query)) {
//         try {
//           const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
//             params: {
//               group_id: groupId // 替换为实际的群组ID
//             }
//           });
//           // 假定接口返回的是一个 JSON 数组
//           const data = resp.data;
//           const summary = formatSummary(data);
//           await msg.reply(summary);
//         } catch (err) {
//           appendLog(groupId, `调用 records/today 失败：${err.message}`);
//           await msg.reply('获取今日记录失败，请稍后重试。');
//         }
//         return;  // 拦截后不再往下走 Dify 流程
//       }
//     } else if (msg.type === 'image') {
//       // 图片（可能带有文字 caption）
//       const media = await msg.downloadMedia();
//       if (media) {
//         const ext = mime.extension(media.mimetype) || 'jpg';
//         const filename = `img_${Date.now()}.${ext}`;
//         const filepath = path.join(TMP_DIR, filename);
//         await fs.writeFile(filepath, media.data, 'base64');
//         appendLog(groupId, `图片已保存: ${filepath}`);

//         // 上传到 Dify
//         const file_id = await uploadFileToDify(filepath, user, 'image');
//         appendLog(groupId, `图片已上传到Dify，file_id: ${file_id}`);
//         files.push({
//           type: 'image',
//           transfer_method: 'local_file',
//           upload_file_id: file_id
//         });

//         // 支持图文混合：读取 caption 或 body
//         const caption = msg.caption || msg.body || '';
//         query = caption ? `[图片] ${caption}` : '[图片]';
//         appendLog(groupId, `图文消息内容: ${query}`);

//         // 删除临时文件
//         await fs.remove(filepath);
//         appendLog(groupId, `临时图片文件已删除: ${filepath}`);
//       }
//     } else if (['ptt', 'audio'].includes(msg.type)) {
//       const media = await msg.downloadMedia();
//       if (media) {
//         const ext = mime.extension(media.mimetype) || 'ogg';
//         const filename = `audio_${Date.now()}.${ext}`;
//         const filepath = path.join(TMP_DIR, filename);
//         await fs.writeFile(filepath, media.data, 'base64');
//         appendLog(groupId, `语音已保存: ${filepath}`);
//         query = await audioToText(filepath, user);
//         appendLog(groupId, `语音转文字结果: ${query}`);
//         await fs.remove(filepath);
//         appendLog(groupId, `临时语音文件已删除: ${filepath}`);
//       }
//     } else {
//       query = '[暂不支持的消息类型]';
//       appendLog(groupId, `收到暂不支持的消息类型: ${msg.type}`);
//     }

//     // —— 可选：记录收到的 WhatsApp 消息 ——
//     if (LOG_WHATSAPP_MSGS) {
//       const logEntry = `[${new Date().toISOString()}] ${msg.from} (${msg.type}): ${msg.body || ''}\n`;
//       await fs.appendFile(LOG_FILE, logEntry);
//       appendLog(groupId, '消息已写入日志文件');
//     }

//     if (!query) {
//       if (!isGroup || shouldReply(msg, BOT_NAME)) {
//         await msg.reply('未识别到有效内容。');
//         appendLog(groupId, '未识别到有效内容，已回复用户');
//       }
//       return;
//     }

//     // —— 是否触发AI回复？只在群聊中检测 @机器人 或 /ai ——
//     const needReply = isGroup && shouldReply(msg, BOT_NAME);
//     appendLog(groupId, `是否需要AI回复: ${needReply}`);

//     // —— 调用 Dify，拿到原始 SSE 日志文本 ——
//     // 无论是否需要AI回复，都上传Dify，可用于埋点或业务分析
//     let difyLogString = '';
//     try {
//       query = `${query} [group_id:${groupId}]`;
//       appendLog(groupId, `开始调用Dify，query: ${query}, files: ${JSON.stringify(files)}`);
//       difyLogString = await sendToDify({ query, user, files });
//       appendLog(groupId, 'Dify 调用完成');
//     } catch (e) {
//       appendLog(groupId, `Dify 调用失败: ${e.message}`);
//       if (needReply) await msg.reply('调用 Dify 失败，请稍后再试。');
//       return;
//     }

//     appendLog(groupId, `Dify 原始返回：${difyLogString}`);

//     // —— 解析并回复 ——
//     let replyStr;
//     try {
//       appendLog(groupId, '开始解析Dify响应');
//       replyStr = extractAgentAnswer(difyLogString);
//       if (typeof replyStr !== 'string') {
//         replyStr = String(replyStr);
//       }
//       appendLog(groupId, `Final agent answer: ${replyStr}`);
//       if (!needReply && !replyStr.includes('缺少')) {
//         // 群聊未触发关键词，不回复，仅上传
//         appendLog(groupId, '群聊未触发关键词，不回复，仅上传Dify');
//         return;
//       }
//       try {
//         appendLog(groupId, `尝试回复用户: ${replyStr}`);
//         await msg.reply(replyStr);
//         appendLog(groupId, '已回复用户');
//       } catch (e) {
//         appendLog(groupId, `回复用户失败: ${e.message}`);
//       }
//     } catch (err) {
//       appendLog(groupId, `处理 Dify 回复失败：${err.message}`);
//       replyStr = `处理失败：${err.message}`;
//       try {
//         await msg.reply(replyStr);
//         appendLog(groupId, '已回复用户');
//       } catch (e) {
//         appendLog(groupId, `回复用户失败: ${e.message}`);
//       }
//     }

//   } catch (err) {
//     appendLog(msg.from, `处理消息出错: ${err.message}`);
//     try { await msg.reply('机器人处理消息时出错，请稍后再试。'); } catch {}
//     appendLog(msg.from, '处理消息时发生异常');
//   }
// });

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
async function sendToFastGPT({ query, user, apikey }) {
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
            'Authorization': `Bearer ${apikey}`,
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


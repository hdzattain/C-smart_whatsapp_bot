const wppconnect = require('@wppconnect-team/wppconnect');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const fs = require('fs-extra');
const fs_2 = require('fs');
const fsPromises = fs_2.promises
const path = require('path');
const FormData = require('form-data');
const mime = require('mime-types');
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const OpenCC = require('opencc-js');
const converter = OpenCC.Converter({ from: 'cn', to: 'hk' });
const { processScaffoldingQuery } = require('./group_process/scaffolding_process');
const { processDrillingQuery } = require('./group_process/drill_hole_process');
const { generateApplicationId: genHotworkId, getShortCode: getHotworkShortCode } = require('./heatwork_util');
const {
  GROUP_ID,
  GROUP_ID_2,
  GROUP_ID_3,
  GROUP_ID_4,
  GROUP_ID_5,
  GROUP_ID_6,
  GROUP_ID_7,
  GROUP_ID_8,
  GROUP_ID_9,
  DRILL_GROUPS,
  EXTERNAL_SCAFFOLDING_GROUPS,
  BLACKLIST_GROUPS,
  ERROR_REPLY_GROUPS,
  HEAT_WORK_GROUPS
} = require('./group_constants');


const DIFY_API_KEY = 'app-A18jsyMNjlX3rhCDJ9P4xl6z';
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || 'https://api.dify.ai/v1';
const FASTGPT_API_URL = 'http://43.154.37.138:3008/api/v1/chat/completions';
const FASTGPT_API_KEY = 'fastgpt-uhlgWY5Lsti1X4msKMzDHheQ4AAEH4hfzr7fczsBA5nA14HEwF7AZ2Nua234Khai';
const BOT_NAME = process.env.BOT_NAME || 'C-SMART'; // 机器人昵称

const TIME_SEGMENTS = [
  { name: '上午', start: 300, end: 780, field: 'morning' }, // 06:00-13:00
  { name: '下午', start: 780, end: 1380, field: 'afternoon' } // 13:00-23:00
];


const DRILL_FORMAT = {
  title: '------Core drill hole Summary------',
  guidelines: [
    '-開工前先到安環部交底，並說明詳細開工位置(E.G. 邊座幾樓邊個窿)',
    '✅❎為中建安全部，✔️✖️為中建施工部，⭕❌為分判影安全相',
    '-收工影撤離及圍封相並發出此群組，才視為工人完全撤離'
  ],
  showFields: ['location', 'subcontractor', 'floor', 'safetyStatus', 'xiaban', 'process', 'timeRange'],
  timeSegments: [
    { name: '上午', start: 300, end: 780, field: 'morning' }, // 06:00-13:00
    { name: '下午', start: 780, end: 1380, field: 'afternoon' } // 13:00-23:00
  ],
  detailGenerator: generateDrillSummaryDetails
};


const EXTERNAL_SCAFFOLDING_FORMAT = {
  title: 'External Scaffolding Work(Permit to work)',
  guidelines: [
    '外牆棚工作許可證填妥及齊簽名視為開工',
    '✅❎為中建安全部，✔️✖️為中建施工部，⭕❌為分判影安全相',
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

const NORMAL_FORMAT = {
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
};

/**
 * 群組格式配置，支持不同群組的摘要格式。
 */
const GROUP_FORMATS = {
  [GROUP_ID]: NORMAL_FORMAT,
  [GROUP_ID_2]: EXTERNAL_SCAFFOLDING_FORMAT,
  [GROUP_ID_4]: EXTERNAL_SCAFFOLDING_FORMAT,
  [GROUP_ID_5]: DRILL_FORMAT,
  [GROUP_ID_6]: EXTERNAL_SCAFFOLDING_FORMAT,
  [GROUP_ID_7]: NORMAL_FORMAT,
  [GROUP_ID_8]: DRILL_FORMAT,
  [GROUP_ID_9]: EXTERNAL_SCAFFOLDING_FORMAT,
  // 未來群組可在此添加自定義格式
  default: NORMAL_FORMAT
};


const TMP_DIR = path.join(__dirname, 'tmp');
fs.ensureDirSync(TMP_DIR);

// === 健康检查状态 ===
let state = { status: 'STARTING' };

// 状态查询接口
const app = express();
app.get('/health', (req, res) => res.json(state));
app.listen(3060, () => {
  console.log('[健康检查] 服务器已启动在端口 3060');
});

// --- 火纸操作 Webhook (独立端口 3333) ---
const webhookApp = express();
webhookApp.use(express.json());

webhookApp.post('/webhook/fire-paper', async (req, res) => {
  console.log(`[Webhook] 收到火纸请求:`, JSON.stringify(req.body, null, 2));
  const {
    status,
    hotwork_apply_id,
    subcontractor,
    location,
    floor,
    process,
    date,
    time_range,
    apply_name,
    number,
    worker_name,
    approver_name
  } = req.body;

  if (!client || state.status !== 'READY') {
    return res.status(503).json({ error: 'WhatsApp 机器人未就绪' });
  }

  const STATUS_CONFIG = {
    'submit': { title: '🔥 火紙已提交 (待批核)', icon: '📝' },
    'approved': { title: '🔥 火紙已批核 (待簽收)', icon: '✅' },
    'received_wait_cancel': { title: '🔥 火紙已簽收 (許可證生效)', icon: '🔓' },
    'wait_cancel_confirm': { title: '🔥 火紙申請注銷 (待確認)', icon: '⏳' },
    'cancel_success': { title: '🔥 火紙注銷完成', icon: '🔒' }
  };

  const config = STATUS_CONFIG[status] || { title: `🔥 火紙狀態更新: ${status}`, icon: '🔔' };

  // 1. 以 GROUP_ID_6 作为唯一基准生成消息内容，确保所有群收到的编号一致
  const refGid = GROUP_ID_6;
  let message = '';

  if (status === 'received_wait_cancel') {
    const generatedId = genHotworkId(`位置：${location}`, refGid, hotwork_apply_id);
    message = `Permit申請成功✅\n`;
    message += `申請編號：${generatedId}\n`;
    message += `日期：${date || 'N/A'}\n`;
    message += `分判商：${subcontractor || 'N/A'}\n`;
    message += `位置：${location || 'N/A'}\n`;
    message += `樓層：${floor || 'N/A'}\n`;
    message += `工序：${process || 'N/A'}\n`;
    message += `時間：${time_range || 'N/A'}`;
  } else if (status === 'cancel_success') {
    const shortCode = getHotworkShortCode(hotwork_apply_id, refGid);
    message = `Permit注銷成功✅\n`;
    if (shortCode) {
      message += `申請編號：${shortCode}\n`;
    }
    message += `日期：${date || 'N/A'}\n`;
    message += `分判商：${subcontractor || 'N/A'}\n`;
    message += `位置：${location || 'N/A'}\n`;
    message += `樓層：${floor || 'N/A'}\n`;
    message += `工序：${process || 'N/A'}\n`;
    message += `時間：${time_range || 'N/A'}`;
  } else {
    message = `${config.icon} *${config.title}*\n\n`;
    message += `🔹 *E-permit編號*: ${hotwork_apply_id || 'N/A'}\n`;
    message += `🔹 *分判商*: ${subcontractor || 'N/A'}\n`;
    message += `🔹 *施工位置*: ${location || 'N/A'} (${floor || 'N/A'})\n`;
    message += `🔹 *工作類別*: ${process || 'N/A'}\n`;
    message += `🔹 *日期時間*: ${date || 'N/A'} | ${time_range || 'N/A'}\n`;
    message += `🔹 *申請人*: ${apply_name || 'N/A'} (${number || 'N/A'})\n`;
    message += `🔹 *工人姓名*: ${worker_name || 'N/A'}\n`;

    if (approver_name) {
      message += `🔹 *批核人*: ${approver_name}\n`;
    }
    message += `\n⏰ *通知時間*: ${new Date().toLocaleString('zh-HK')}`;
  }

  // 2. 遍历群组进行“镜像”发送
  for (const gid of HEAT_WORK_GROUPS) {
    if (isBlacklistedGroup(gid)) {
      console.log(`[Webhook] 跳过黑名单群组: ${gid}`);
      continue;
    }

    try {
      await client.sendText(gid, message);
      console.log(`[Webhook] 火纸消息已镜像至群组: ${gid}`);
    } catch (error) {
      console.error(`[Webhook] 发送至群组 ${gid} 失败:`, error);
    }
  }

  res.json({ success: true, message: 'Webhook 镜像处理完成' });
});

webhookApp.listen(3333, () => {
  console.log('[Webhook] 火纸服务器启动在端口 3333');
});

const LOG_WHATSAPP_MSGS = process.env.LOG_WHATSAPP_MSGS === 'true';
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'whatsapp.log');
fs.ensureDirSync(LOG_DIR);

// ID 转 Emoji (用于总结: A1 -> A1️⃣)
function toEmojiId(appId) {
  if (!appId) return '';
  // 支持大小写字母，例如 A12 / a12
  const match = appId.match(/^([A-Z])(\d+)$/i);
  if (!match) return appId;

  const letter = match[1].toUpperCase();
  const numStr = match[2];
  const emojiMap = {
    '0': '0️⃣',
    '1': '1️⃣',
    '2': '2️⃣',
    '3': '3️⃣',
    '4': '4️⃣',
    '5': '5️⃣',
    '6': '6️⃣',
    '7': '7️⃣',
    '8': '8️⃣',
    '9': '9️⃣'
  };

  const emojiNum = numStr.split('').map(d => emojiMap[d] || d).join('');
  return `${letter}${emojiNum}`;
}

// —— WPPConnect 初始化 ——
let client;

wppconnect.create({
  session: 'whatsapp-bot-session',
  catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
    console.log('请扫描二维码登录 WhatsApp');
    qrcode.generate(urlCode, { small: true });
    appendLog('default', '请扫描二维码登录 WhatsApp');
    state.status = 'QR_NEEDED';
  },
  logQR: false,
  headless: true,
  puppeteerOptions: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
})
  .then((clientInstance) => {
    client = clientInstance;
    state.status = 'READY';
    console.log('WhatsApp 机器人已启动');
    appendLog('default', 'WhatsApp 机器人已启动');

    // 设置消息监听
    client.onMessage(async (msg) => {
      await handleMessage(msg);
    });
  })
  .catch((error) => {
    console.error('初始化失败:', error);
    state.status = 'DISCONNECTED';
    appendLog('default', `初始化失败: ${error.message}`);
  });

// 监听断开连接事件
process.on('SIGINT', () => {
  if (client) {
    client.close();
  }
  process.exit(0);
});

// —— 关键词检测 ——
function containsSummaryKeyword(text) {
  const keywords = [
    '总结', '概括', '总结一下', '整理情况', '汇总', '回顾',
    '總結', '概括', '總結一下', '整理情況', '彙總', '回顧'
  ];
  return keywords.some(k => text.includes(k));
}

function containsOTSummaryKeyword(text) {
  const keywords = [
    '未撤離分判', '未撤离分判'
  ];
  return keywords.some(k => text.includes(k));
}

// 检查群组是否在黑名单中（使用包含检查）
function isBlacklistedGroup(msgFrom) {
  if (!msgFrom) return false;
  return BLACKLIST_GROUPS.some(blacklistId => msgFrom.includes(blacklistId));
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

// 公共函数：解析 update_history
function parseUpdateHistory(update_history) {
  let history = [];
  try {
    if (typeof update_history === 'string' && update_history.trim() !== '') {
      history = JSON.parse(update_history);
      if (!Array.isArray(history)) {
        history = [];
      }
    } else if (Array.isArray(update_history)) {
      history = update_history;
    }
  } catch (e) {
    console.warn(`处理update_history失败: ${e.message}`);
    history = [];
  }
  return history;
}

// 公共函数：生成 safetyStatus
function generateSafetyStatus(updateHistory, timeSegments, groupId, isExternal = false) {
  return timeSegments.map(segment => {
    const hasTimeInSegment = updateHistory.some(timestamp => {
      try {
        return parseTimeSegment(timestamp, groupId) === segment.name;
      } catch (e) {
        return false;
      }
    });

    if (isExternal) {
      const now = new Date();
      const nowMinutes = (now.getUTCHours() + 8) * 60 + now.getUTCMinutes();
      return hasTimeInSegment
        ? `${segment.name}⭕`
        : (nowMinutes < segment.end ? `${segment.name}` : `${segment.name}❌`);
    } else {
      return `${segment.name} ${hasTimeInSegment ? '✅' : '❎'}`;
    }
  }).join('，');
}


/**
 * 公共函数：安全检查时间片段是否存在
 * @param {Array} timestamps - 时间戳数组
 * @param {string} segmentName - 时间段名称
 * @param {string} groupId - 群组ID
 * @returns {boolean} 是否存在该时间段的记录
 */
function hasTimestampInSegment(timestamps, segmentName, groupId) {
  try {
    return timestamps.some(timestamp => parseTimeSegment(timestamp, groupId) === segmentName);
  } catch (e) {
    return false;
  }
}

// 公共函数：按角色生成 safetyStatus
function generateRoleSafetyStatus(updateHistory, updateSafetyHistory, updateConstructHistory, timeSegments, groupId) {
  return timeSegments.map(segment => {
    const hasTimeInSegment = hasTimestampInSegment(updateHistory, segment.name, groupId);
    const hasSafetyUpdateInSegment = hasTimestampInSegment(updateSafetyHistory, segment.name, groupId);
    const hasConstructUpdateInSegment = hasTimestampInSegment(updateConstructHistory, segment.name, groupId);

    const now = new Date();
    const nowMinutes = (now.getUTCHours() + 8) * 60 + now.getUTCMinutes();

    // 通用更新状态
    const generalStatus = hasTimeInSegment
      ? '⭕'
      : (nowMinutes >= segment.end ? '❌' : '');

    // 安全部更新状态
    const safetyStatus = hasSafetyUpdateInSegment
      ? '✅'
      : (nowMinutes >= segment.end ? '❎' : '');

    // 施工部更新状态
    const constructStatus = hasConstructUpdateInSegment
      ? '✔️'
      : (nowMinutes >= segment.end ? '✖️' : '');

    // 组合最终状态
    return `${segment.name} ${safetyStatus}${constructStatus}${generalStatus}`;
  }).join('，');
}


// 生成Summary详情方法（普通群组）
function generateSummaryDetails(data, formatConfig, groupId) {
  const details = data.map((rec, i) => {
    const updateHistory = parseUpdateHistory(rec.update_history);

    const fields = {
      location: rec.location || '',
      subcontractor: rec.subcontrator || rec.subcontractor || '',
      number: rec.number || '',
      floor: rec.floor || '',
      safetyStatus: generateSafetyStatus(updateHistory, formatConfig.timeSegments, groupId),
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
    return output;
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
      const updateHistory = parseUpdateHistory(rec.update_history);
      const updateSafetyHistory = parseUpdateHistory(rec.update_safety_history);
      const updateConstructHistory = parseUpdateHistory(rec.update_construct_history);

      prefix = toEmojiId(rec.application_id || '??') + '-';

      const fields = {
        location: `${prefix}${rec.location || ''}`,
        floor: rec.floor || '',
        subcontractor: rec.subcontractor || '',
        number: rec.number || 0,
        process: rec.process || '',
        time_range: rec.time_range || '',
        safetyStatus: generateRoleSafetyStatus(updateHistory, updateSafetyHistory, updateConstructHistory, formatConfig.timeSegments, groupId),
        xiaban: xiabanText(rec.xiaban, rec.part_leave_number || 0, rec.number || 0)
      };

      const recordLine = `${fields.location}，${fields.floor}，*${fields.subcontractor}*，${fields.number}人，工序:${fields.process}，時間:${fields.time_range}`;
      const safetyLine = `【安全相：${fields.safetyStatus}】${fields.xiaban}`;
      return `${recordLine}\n${safetyLine}`;
    });
    return `\n*${building}*\n\n${buildingDetails.join('\n')}`;
  });

  return details;
}

// 生成Summary详情方法（打窿群组）
function generateDrillSummaryDetails(data, formatConfig, groupId) {
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

    const buildingDetails = sortedRecords.map((rec, index) => {
      const updateHistory = parseUpdateHistory(rec.update_history);
      const updateSafetyHistory = parseUpdateHistory(rec.update_safety_history);
      const updateConstructHistory = parseUpdateHistory(rec.update_construct_history);

      prefix = toEmojiId(rec.application_id || '??') + '-';

      const fields = {
        location: `${prefix}${rec.location || ''}`,
        floor: rec.floor || '',
        subcontractor: rec.subcontractor || '',
        process: rec.process || '',
        time_range: rec.time_range || '',
        safetyStatus: generateRoleSafetyStatus(updateHistory, updateSafetyHistory, updateConstructHistory, formatConfig.timeSegments, groupId),
        xiaban: xiabanText(rec.xiaban, 1, 1)
      };

      const recordLine = `${fields.location}，${fields.floor}，*${fields.subcontractor}*，工序:${fields.process}，時間:${fields.time_range}`;
      const safetyLine = `【安全相：${fields.safetyStatus}】${fields.xiaban}`;
      return `${recordLine}\n${safetyLine}`;
    });
    return `\n*${building}*\n\n${buildingDetails.join('\n')}`;
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

function formatOTSummary(data) {
  if (!Array.isArray(data) || data.length === 0) return "今日無工地記錄";
  const dateStr = parseDate(data[0].bstudio_create_time || '');
  // 过滤满足条件的记录，并保持序号从1到n
  const details = data
    .filter(rec => parseInt(rec.xiaban) === 0 && parseInt(rec.part_leave_number || 0) < parseInt(rec.number || 0))
    .map((rec, i) => {
      const loc = rec.location || '';
      const sub = rec.subcontrator || rec.subcontractor || '';
      const num = rec.number || '';
      const floor = rec.floor || '';
      const proc = rec.process || '';
      const time = rec.time_range || '';

      if (rec.application_id) {
        const prefix = toEmojiId(rec.application_id) + '-';
        return `${prefix}${loc}，${floor}，*${sub}*，${num}人，工序:${proc}，時間:${time}`;
      } else {
        return `${i + 1}. ${loc} ${sub} 共 ${num} 人 樓層 ${floor}`;
      }
    });

  if (details.length === 0) return "今日無未撤離分判記錄";

  return (
    `未撤離分判\n` +
    `${dateStr}\n\n` +
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
    const atName = text.includes(`@${botName}`); // @昵称
    const withAi = text.startsWith('/ai') || text.startsWith('ai ');

    return mention || atName || withAi;
  }
  return true; // 私聊，默认都回复
}

function canBeIgnore(msgBody) {
  return msgBody === '' || msgBody.includes('Permit') || msgBody.includes('提示') || msgBody.includes('留意');
}



/**
 * 尝试从客户端获取发送者的电话号码
 */
async function getSenderPhoneNumber(client, authorId) {
  let contactPhone = '';
  try {
    const info = await client.getPnLidEntry(authorId);
    if (info && info.phoneNumber) {
      contactPhone = info.phoneNumber.id ? info.phoneNumber.id.replace('@c.us', '') : '';
    }
  } catch (contactError) {
    console.log('获取发送人联系信息失败:', contactError.message);
  }
  return contactPhone;
}
async function handleMessage(msg) {
  try {
    const user = msg.from;
    let query = '';
    let files = [];

    if (msg.type !== 'chat') {
      try {
        await new Promise(r => setTimeout(r, 1000));
        const fresh = await client.getMessageById(msg.id);
        if (fresh) msg = fresh;
        console.log(`重新强制获取消息，from: ${msg.from}, type: ${msg.type}, body: ${msg.body}`);
        appendLog(user, `重新强制获取消息，from: ${msg.from}, type: ${msg.type}, body: ${msg.body}`);
      } catch (err) {
        appendLog(user, `获取消息失败，使用原始消息，错误：${err.message}`);
      }
    }

    // 判断是否群聊
    const chat = await client.getChatById(msg.from);
    const isGroup = chat.isGroup;
    const groupName = isGroup ? chat.name : '非群組';
    console.log(`收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}, msg_id: ${msg.id}`);
    appendLog(user, `收到消息，from: ${msg.from}, type: ${msg.type}, isGroup: ${isGroup}, groupName: ${groupName}, msg_id: ${msg.id}`);
    const msgBody = msg.body || '';
    if (!isGroup || canBeIgnore(msgBody)) {
      console.log('不是群聊消息，或为可忽略的语句，不回复用户');
      appendLog(user, '不是群聊消息，或为可忽略的语句，不回复用户');
      return;
    }
    // 在发送到API前，记录 group_id
    const groupId = msg.from; // 这就是 WhatsApp 的群ID
    console.log(msg.body);
    appendLog(groupId, msg.body);

    let contactPhone = '';
    try {
      if (EXTERNAL_SCAFFOLDING_GROUPS.includes(groupId)) {
        contactPhone = await getSenderPhoneNumber(client, msg.author || msg.from);
      }
    } catch (contactError) {
      console.log('获取发送人联系信息失败:', contactError.message);
    }


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
          await client.reply(msg.from, summary, msg.id);
        } catch (err) {
          console.log(`调用 records/today 失败：${err.message}`);
          appendLog(groupId, `调用 records/today 失败：${err.message}`);
          await client.reply(msg.from, '获取今日记录失败，请稍后重试。', msg.id);
        }
        return;  // 拦截后不再往下走 FastGPT 流程
      }
      if (containsOTSummaryKeyword(query)) {
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
          const summary = formatOTSummary(data, groupId);
          await client.reply(msg.from, summary, msg.id);
        } catch (err) {
          console.log(`调用 records/today 失败：${err.message}`);
          appendLog(groupId, `调用 records/today 失败：${err.message}`);
          await client.reply(msg.from, '获取今日记录失败，请稍后重试。', msg.id);
        }
        return;  // 拦截后不再往下走 FastGPT 流程
      }
    } else if (msg.type === 'image' || msg.type === 'album') {
      // 图片或相册（可能带有文字 caption）
      // 支持相册场景：如果是 album，并且存在 medias 数组，则对每一张图片单独处理
      const mediaMessages =
        msg.type === 'album' && Array.isArray(msg.medias) && msg.medias.length
          ? msg.medias
          : [msg];

      const savedFiles = [];
      for (const mediaMsg of mediaMessages) {
        const media = await client.downloadMedia(mediaMsg);
        if (media) {
          const ext = mime.extension(mediaMsg.mimetype) || 'jpg';
          const filename = `img_${Date.now()}_${savedFiles.length}.${ext}`;
          const filepath = path.join(TMP_DIR, filename);
          // media is base64 string, remove prefix if present
          const base64Data = media.replace(/^data:.*;base64,/, '');
          await fsPromises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
          savedFiles.push(filepath);
          console.log(`图片已保存: ${filepath}`);
          appendLog(groupId, `图片已保存: ${filepath}`);
        }
      }

      // 支持图文混合：读取 caption 或 body
      const caption = msg.caption || msg.body || '';
      if (canBeIgnore(caption)) {
        console.log('消息为可忽略的语句');
        appendLog(user, '消息为可忽略的语句');
        return;
      }
      const imageCount = savedFiles.length;
      if (imageCount > 0) {
        query = caption ? `[图片] ${caption}` : '[图片]';
        console.log(`图文消息内容: ${query}`);
        appendLog(groupId, `图文消息内容: ${query}`);
      }
    } else if (['ptt', 'audio'].includes(msg.type)) {
      const media = await client.downloadMedia(msg);
      if (media) {
        const ext = mime.extension(msg.mimetype) || 'ogg';
        const filename = `audio_${Date.now()}.${ext}`;
        const filepath = path.join(TMP_DIR, filename);
        const base64Data = media.replace(/^data:.*;base64,/, '');
        await fsPromises.writeFile(filepath, Buffer.from(base64Data, 'base64'));
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
        await client.reply(msg.from, '未识别到有效内容。', msg.id);
        console.log('未识别到有效内容，已回复用户');
        appendLog(groupId, '未识别到有效内容，已回复用户');
      }
      return;
    }

    // —— 是否触发AI回复？只在群聊中检测 @机器人 或 /ai ——
    const needReply = isGroup && shouldReply(msg, BOT_NAME);
    console.log(`是否需要AI回复: ${needReply}`);
    appendLog(groupId, `是否需要AI回复: ${needReply}`);

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

      try {
        query = converter(query);
      } catch (error) {
        const errMsg = `简繁转换失败: ${error.message}，使用原始输入内容处理工作流`;
        console.log(errMsg);
        appendLog(groupId, errMsg);
      }

      const conditions = [
        {
          test: query => /申請|申報|以下為申請位置|開工|申请|申报|以下为申请位置|开工/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_RECORD })
        },
        {
          test: query => /現場安全|照明良好|安全設備齊全|安全檢查完成|安全帶|出棚|扣帶|圍封|看守|防墮|眼罩|耳塞|返回室内|现场安全|安全设备齐全|安全检查完成|安全带|扣带/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_UPDATE })
        },
        {
          test: query => /(撤離|已撤離|人走晒|撤退|收工|撤离|已撤离|放工)/.test(query),
          action: () => sendToFastGPT({ query, user, apikey: API_KEYS.EPERMIT_UPDATE })
        },
        {
          test: query => /刪除|撤回|刪除某天申請|刪除某位置記錄|删除|删除某天申请|删除某位置记录/.test(query),
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
      if (EXTERNAL_SCAFFOLDING_GROUPS.includes(groupId)) {
        // —— 棚架群组专用逻辑 ——
        replyStr = await processScaffoldingQuery(query, groupId, contactPhone);
      } else if (DRILL_GROUPS.includes(groupId)) {
        // —— 打窿群组专用逻辑 ——
        replyStr = await processDrillingQuery(query, groupId);
      } else {
        // —— 其他群组走原有流程 ——
        replyStr = await processQuery(query, groupId, user);
      }
      if (replyStr === null) {
        console.log('無匹配條件，無法處理查詢');
        appendLog(groupId, '無匹配條件，無法處理查詢');
        if (needReply) await client.reply(msg.from, '無法處理您的請求，請檢查輸入內容。', msg.id);
        return;
      }
      console.log(`查詢處理完成，結果: ${replyStr}`);
      appendLog(groupId, `查詢處理完成，結果: ${replyStr}`);
    } catch (e) {
      console.log(`查詢處理失敗: ${e.message}`);
      appendLog(groupId, `查詢處理失敗: ${e.message}`);
      if (needReply) await client.reply(msg.from, '處理請求失敗，請稍後再試。', msg.id);
      return;
    }

    // —— 回复用户 ——
    if (needReply || replyStr.includes('缺少') || replyStr.includes('找唔到編號') || replyStr.includes('不符合模版') || (replyStr.includes('申請編號') && EXTERNAL_SCAFFOLDING_GROUPS.includes(groupId))) {
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
    if (!isBlacklistedGroup(msg.from)) {
      try {
        await client.reply(msg.from, '机器人处理消息时出错，请稍后再试。', msg.id);
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
}


// client.initialize() 不再需要，由 wppconnect.create 替代

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
    detail: true,
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

      // 遍历responseData，查找nodeId在FASTGPT_HTTP_NODE_IDS中的节点
      const responseData = res.data.responseData || [];
      if (responseData.length > 0) {
        const lastNode = responseData[responseData.length - 1];
        if (lastNode.textOutput) {
          try {
            if (ERROR_REPLY_GROUPS.some(groupId => query.includes(`[group_id:${groupId}]`))) {
              console.log(`FAST GPT HTTP请求响应消息: ${lastNode.textOutput}`);
              // 尝试解析textOutput为JSON数组
              const parsedOutput = JSON.parse(lastNode.textOutput);
              if (Array.isArray(parsedOutput)) {
                // 提取包含"缺少"的error信息
                const errorMessages = parsedOutput
                  .filter(item => item.error && typeof item.error === 'string' && item.error.includes('缺少'))
                  .map(item => item.error);

                // 如果有匹配的错误信息，按格式拼接后返回
                if (errorMessages.length > 0) {
                  if (errorMessages.length === 1) {
                    return errorMessages[0];
                  } else {
                    return `輸入存在以下問題：\n${errorMessages.map((error, index) => `${index + 1}、${error}`).join('\n')}`;
                  }
                }
                // 如果没有符合条件的error，则不处理，继续返回content
              } else if (parsedOutput.error && typeof parsedOutput.error === 'string' && parsedOutput.error.includes('缺少')) {
                return parsedOutput.error;
              }
            } else {
              console.log(`不在错误缺失提醒群组列表中，跳过错误缺失提醒`);
            }
          } catch (parseError) {
            console.log(`FAST GPT HTTP请求响应解析失败: ${parseError.message}`);
          }
        }
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
        console.log(`FastGPT 请求断流，正在第${i + 1}次重试...`);
        appendLog(user, `FastGPT 请求断流，正在第${i + 1}次重试...`);
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
        appendLog(user, `Dify stream断流，正在第${i + 1}次重试...`);
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
  await client.sendText(group_id, summary); // 主动发到群聊
}

async function getOTSummary(group_id) {
  const resp = await axios.get('http://llm-ai.c-smart.hk/records/today', {
    params: {
      group_id: group_id // 替换为实际的群组ID
    }
  });
  const data = resp.data;
  const summary = formatOTSummary(data);
  await client.sendText(group_id, summary); // 主动发到群聊
}

// 汇总生成函数
async function sendTodaySummary() {
  try {
    getSummary(GROUP_ID);
    getSummary(GROUP_ID_2);
    getSummary(GROUP_ID_3);
    getSummary(GROUP_ID_7);
    getSummary(GROUP_ID_8);
    appendLog('default', '定时推送已发送');
  } catch (err) {
    appendLog('default', `调用 records/today 失败：${err.message}`);
    await client.sendText(GROUP_ID, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_2, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_3, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_4, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_7, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_8, '获取今日记录失败，请稍后重试。');
  }
}

// 汇总生成函数
async function sendOTSummary() {
  try {
    getOTSummary(GROUP_ID_2);
    getOTSummary(GROUP_ID_3);
    getOTSummary(GROUP_ID_4);
    getOTSummary(GROUP_ID_7);
    getOTSummary(GROUP_ID_8);
    getOTSummary(GROUP_ID_9);

    appendLog('default', '定时推送已发送');
  } catch (err) {
    appendLog('default', `调用 records/today 失败：${err.message}`);
    await client.sendText(GROUP_ID_2, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_3, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_4, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_7, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_8, '获取今日记录失败，请稍后重试。');
    await client.sendText(GROUP_ID_9, '获取今日记录失败，请稍后重试。');
  }
}

// node-cron语法: '分 时 日 月 周'，以下每个时间点都定一次
cron.schedule('0 10 * * *', sendTodaySummary);  // 10:00
cron.schedule('0 12 * * *', sendTodaySummary);  // 12:00
cron.schedule('0 14 * * *', sendTodaySummary);  // 14:00
cron.schedule('0 16 * * *', sendTodaySummary);  // 16:00
cron.schedule('0 18 * * *', sendTodaySummary);  // 18:00
cron.schedule('0 10-19 * * *', async () => {
  try {
    await getSummary(GROUP_ID_4); // 仅针对 Site A 外墙
    appendLog(GROUP_ID_4, '每小时总结推送成功');
  } catch (e) {
    const errMsg = `每小时总结推送失败: ${e.message}`;
    console.error(e);
    appendLog(GROUP_ID_4, errMsg);
  }
});
cron.schedule('0 10-19 * * *', async () => {
  try {
    await getSummary(GROUP_ID_9); // 仅针对 Site A 外墙
    appendLog(GROUP_ID_9, '每小时总结推送成功');
  } catch (e) {
    const errMsg = `每小时总结推送失败: ${e.message}`;
    console.error(e);
    appendLog(GROUP_ID_9, errMsg);
  }
});
cron.schedule('0 18 * * *', sendOTSummary);  // 18:00

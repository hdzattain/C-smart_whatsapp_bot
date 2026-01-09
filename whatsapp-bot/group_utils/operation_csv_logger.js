// operation_csv_logger.js
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { appendLog } = require('./bot_logger_util');

const CRUD_API_HOST = 'http://llm-ai.c-smart.hk';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const HONG_KONG_TIMEZONE = 'Asia/Hong_Kong';

// 获取香港时区的当前日期时间
function getHongKongDateTime() {
  const now = new Date();
  // 使用 Intl.DateTimeFormat 获取香港时区的日期时间组件
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: HONG_KONG_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type).value;
  
  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
    hour: getPart('hour'),
    minute: getPart('minute'),
    second: getPart('second')
  };
}

// 获取今日CSV文件路径（使用香港时区）
function getTodayCsvPath(groupId) {
  const { year, month, day } = getHongKongDateTime();
  const dateStr = `${year}-${month}-${day}`;
  const groupDir = path.join(LOG_DIR, groupId || 'default');
  const csvsDir = path.join(groupDir, 'csvs');
  const dateDir = path.join(csvsDir, dateStr);
  fs.ensureDirSync(dateDir);
  const csvFile = path.join(dateDir, `${dateStr}.csv`);
  return csvFile;
}

// 初始化CSV文件（如果不存在）
function initCsvFile(csvPath) {
  if (!fs.existsSync(csvPath)) {
    const header = '记录,类别,时间,query是否识别成功,失败原因,短码\n';
    fs.writeFileSync(csvPath, header);
  }
}

// 格式化时间为24小时制date格式（使用香港时区）
function formatDateTime() {
  const { year, month, day, hour, minute, second } = getHongKongDateTime();
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

// 记录操作到CSV
async function logOperationToCsv({
  query,              // 原始查询内容
  category,           // 类别：申请/安全相/撤离/取消
  groupId,            // 群组ID
  success,            // query是否识别成功
  errorMsg,           // 失败原因
  shortcode           // 短码（application_id），仅用于短码操作
}) {
  const csvPath = getTodayCsvPath(groupId);
  initCsvFile(csvPath);
  
  const timeStr = formatDateTime();
  
  // 将"删除"统一改为"取消"
  const normalizedCategory = category === '删除' ? '取消' : category;
  
  const row = [
    query || '',                    // 记录（query）
    normalizedCategory || '',       // 类别
    timeStr,                        // 时间（24小时制date格式）
    success ? '成功' : '失败',      // query是否识别成功
    errorMsg || '',                 // 失败原因
    shortcode || ''                 // 短码
  ].map(field => `"${String(field).replace(/"/g, '""')}"`).join(',') + '\n';
  
  fs.appendFileSync(csvPath, row);
  
  // 同时输出到控制台和日志文件
  const logMessage = `[CSV日志] ${normalizedCategory} - ${success ? '成功' : '失败'} - ${errorMsg || ''} - 短码: ${shortcode || 'N/A'}`;
  console.log(logMessage);
  appendLog(groupId, logMessage);
}

module.exports = { logOperationToCsv };


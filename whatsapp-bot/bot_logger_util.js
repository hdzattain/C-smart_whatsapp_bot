// bot_logger_util.js
const fs = require('fs-extra');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
fs.ensureDirSync(LOG_DIR);

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

module.exports = { appendLog };

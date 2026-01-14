/**
 * FastGPT 定时任务服务
 * 可独立运行的服务，支持定时调用 FastGPT
 */

require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const FastGPTClient = require('../insp-bot/fastgpt_client');

// ========== 配置 ==========
const FASTGPT_URL = process.env.FASTGPT_URL || '';
const FASTGPT_API_KEY = process.env.FASTGPT_API_KEY || '';

// 加载用户配置
const USERS_CONFIG_PATH = path.join(__dirname, 'users_config.json');
let USERS = [];

try {
  if (fs.existsSync(USERS_CONFIG_PATH)) {
    const configContent = fs.readFileSync(USERS_CONFIG_PATH, 'utf8');
    USERS = JSON.parse(configContent);
    console.log(`[配置] 加载了 ${USERS.length} 个用户配置`);
  } else {
    console.warn(`[警告] 未找到用户配置文件: ${USERS_CONFIG_PATH}`);
    console.warn('[提示] 请创建 users_config.json 文件，格式参考 users_config.example.json');
  }
} catch (err) {
  console.error(`[ERR] 加载用户配置失败:`, err.message);
  process.exit(1);
}

// 定时任务配置（cron 表达式）
// 格式：分钟 小时 日 月 星期
// 例如：'0 18 * * *' 表示每天 18:00
const TASK_SCHEDULE = process.env.FASTGPT_CRON || '44 10 * * *';
const TASK_TIMEZONE = process.env.FASTGPT_TIMEZONE || 'Asia/Hong_Kong';
const TASK_QUERY = process.env.FASTGPT_QUERY || '定时自动加日程';

// 为每个用户创建任务
const TASKS = USERS.map(user => ({
  name: `每日任务-${user.email_account}`,
  schedule: TASK_SCHEDULE,
  timezone: TASK_TIMEZONE,
  query: TASK_QUERY,
  user: user.email_account,
  email_account: user.email_account,
  user_access_token: user.user_access_token,
  user_refresh_token: user.user_refresh_token
}));

// ========== 初始化客户端（每个任务使用自己的客户端） ==========
if (!FASTGPT_URL || !FASTGPT_API_KEY) {
  console.error('[ERR] 缺少配置：FASTGPT_URL 或 FASTGPT_API_KEY');
  process.exit(1);
}

if (TASKS.length === 0) {
  console.error('[ERR] 没有配置任何用户，请检查 users_config.json');
  process.exit(1);
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

// ========== 执行任务函数 ==========
async function executeTask(task) {
  try {
    console.log(`[定时任务] 开始执行: ${task.name} (用户: ${task.email_account})`);
    
    // 为每个任务创建独立的客户端（使用用户的 email_account 作为 chatId）
    const client = createClient(task.email_account);
    
    // 构建 variables
    const variables = {
      email_account: task.email_account,
      user_access_token: task.user_access_token,
      user_refresh_token: task.user_refresh_token
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
  
  TASKS.forEach(task => {
    const options = task.timezone ? { timezone: task.timezone } : {};
    
    cron.schedule(task.schedule, async () => {
      await executeTask(task);
    }, options);
    
    console.log(`[服务] 已注册定时任务: ${task.name}, 计划: ${task.schedule}${task.timezone ? ` (时区: ${task.timezone})` : ''}`);
  });
  
  console.log('[服务] 所有定时任务已启动');
}

// ========== 手动执行任务（用于测试） ==========
async function runTaskManually(taskName) {
  const task = TASKS.find(t => t.name === taskName);
  if (!task) {
    console.error(`[ERR] 未找到任务: ${taskName}`);
    return;
  }
  await executeTask(task);
}

// ========== 主程序 ==========
if (require.main === module) {
  console.log('[服务] FastGPT 定时任务服务启动中...');
  console.log(`[配置] URL: ${FASTGPT_URL}`);
  console.log(`[配置] 用户数量: ${USERS.length}`);
  console.log(`[配置] 任务数量: ${TASKS.length}`);
  if (TASKS.length > 0) {
    console.log(`[配置] 用户列表: ${USERS.map(u => u.email_account).join(', ')}`);
  }
  
  // 启动定时任务
  startScheduledTasks();
  
  // 处理命令行参数
  const args = process.argv.slice(2);
  if (args[0] === 'run' && args[1]) {
    // 手动执行任务: node fastgpt_service.js run <任务名>
    runTaskManually(args[1]).then(() => {
      console.log('[服务] 手动任务执行完成');
      process.exit(0);
    }).catch(err => {
      console.error('[ERR] 手动任务执行失败:', err);
      process.exit(1);
    });
    return;
  }
  
  // 保持进程运行
  console.log('[服务] 服务已启动，等待定时任务执行...');
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
}

// ========== 导出 ==========
module.exports = {
  createClient,
  executeTask,
  startScheduledTasks,
  runTaskManually
};

/**
 * FastGPT 定时任务服务
 * 可独立运行的服务，支持定时调用 FastGPT
 */

require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Lark = require('@larksuiteoapi/node-sdk');
const FastGPTClient = require('../email_calendar_fastgpt/fastgpt_client');

// ========== 配置 ==========
const FASTGPT_URL = process.env.FASTGPT_URL || '';
const FASTGPT_API_KEY = process.env.FASTGPT_API_KEY || '';
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || process.env.LARK_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || process.env.LARK_APP_SECRET || '';

// 加载用户配置
const USERS_CONFIG_PATH = path.join(__dirname, 'users_config.json');
let USERS = [];
let USERS_CONFIG_WRITE_QUEUE = Promise.resolve();

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

function extractLastRefreshTokenFromText(text) {
  if (typeof text !== 'string') return '';
  let lastToken = '';

  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        start = -1;
        try {
          const obj = JSON.parse(candidate);
          const token = obj && typeof obj.user_refresh_token === 'string' ? obj.user_refresh_token.trim() : '';
          if (token) lastToken = token;
        } catch (_) {
          // ignore invalid json fragments
        }
      }
    }
  }

  return lastToken;
}

function updateInMemoryRefreshToken(emailAccount, newRefreshToken) {
  if (!emailAccount || !newRefreshToken) return;
  USERS = USERS.map(u =>
    u.email_account === emailAccount ? { ...u, user_refresh_token: newRefreshToken } : u
  );
  // 同步任务内存，确保后续定时执行用新 token
  TASKS.forEach(t => {
    if (t.email_account === emailAccount) t.user_refresh_token = newRefreshToken;
  });
}

async function updateUsersConfigRefreshToken(emailAccount, newRefreshToken) {
  USERS_CONFIG_WRITE_QUEUE = USERS_CONFIG_WRITE_QUEUE.then(async () => {
    if (!emailAccount || !newRefreshToken) return;

    let usersOnDisk = [];
    try {
      const raw = fs.readFileSync(USERS_CONFIG_PATH, 'utf8');
      usersOnDisk = JSON.parse(raw);
      if (!Array.isArray(usersOnDisk)) usersOnDisk = [];
    } catch (err) {
      console.error('[ERR] 读取/解析 users_config.json 失败:', err.message);
      return;
    }

    const idx = usersOnDisk.findIndex(u => u && u.email_account === emailAccount);
    if (idx === -1) {
      console.warn(`[警告] users_config.json 未找到邮箱 ${emailAccount}，跳过刷新 token 更新`);
      return;
    }

    usersOnDisk[idx] = { ...usersOnDisk[idx], user_refresh_token: newRefreshToken };
    try {
      fs.writeFileSync(USERS_CONFIG_PATH, JSON.stringify(usersOnDisk, null, 2) + '\n', 'utf8');
      updateInMemoryRefreshToken(emailAccount, newRefreshToken);
      console.log(`[配置] 已更新 ${emailAccount} 的 user_refresh_token 到 users_config.json`);
    } catch (err) {
      console.error('[ERR] 写入 users_config.json 失败:', err.message);
    }
  });

  return USERS_CONFIG_WRITE_QUEUE;
}

// 每次从 users_config.json 读取最新配置，确保拿到最新的 refresh_token
async function getUserFromConfig(emailAccount) {
  if (!emailAccount) return null;
  try {
    const raw = fs.readFileSync(USERS_CONFIG_PATH, 'utf8');
    const usersOnDisk = JSON.parse(raw);
    if (!Array.isArray(usersOnDisk)) {
      console.warn('[配置] users_config.json 格式异常（不是数组）');
      return null;
    }
    const user = usersOnDisk.find(u => u && u.email_account === emailAccount);
    if (!user) {
      console.warn('[配置] users_config.json 未找到用户:', emailAccount);
      return null;
    }
    // 同步内存中的 USERS/TASKS，方便后续使用
    if (user.user_refresh_token) {
      updateInMemoryRefreshToken(emailAccount, user.user_refresh_token);
    }
    return user;
  } catch (err) {
    console.error('[配置] 读取 users_config.json 失败（getUserFromConfig）:', err.message);
    return null;
  }
}

// 定时任务配置（cron 表达式）
// 格式：分钟 小时 日 月 星期
// 例如：'0 * * * *' 表示每小时的第0分钟执行
const TASK_TIMEZONE = process.env.FASTGPT_TIMEZONE || 'Asia/Hong_Kong';

// 任务类型配置
const TASK_TYPES = [
  {
    name: '定时自动加日程',
    // 8-11点、13-17点、19-22点每小时执行（排除12点和18点，因为这两个时间点会在总结任务中先执行加日程）
    schedule: process.env.FASTGPT_CRON_SCHEDULE || '0 8-11,13-17,19-22 * * *',
    query: process.env.FASTGPT_QUERY_SCHEDULE || '定时自动加日程'
  },
  {
    name: '定时自动加日程',
    // 11:50和17:50执行（确保在12点和18点之前完成加日程）
    schedule: process.env.FASTGPT_CRON_SCHEDULE_EARLY || '50 11,17 * * *',
    query: process.env.FASTGPT_QUERY_SCHEDULE || '定时自动加日程'
  },
  {
    name: '定时自动总结',
    schedule: process.env.FASTGPT_CRON_SUMMARY || '0 12,18 * * *', // 12点和18点执行
    query: process.env.FASTGPT_QUERY_SUMMARY || '定时自动总结'
  }
];

// 为每个用户创建任务
// 加日程任务1：8-11点、13-17点、19-22点每小时执行
// 加日程任务2：11:50和17:50执行
// 总结任务：12点和18点执行（会先执行加日程再执行总结）
const TASKS = USERS.flatMap(user => {
  const scheduleTask1 = {
    name: `定时自动加日程-${user.email_account}`,
    schedule: TASK_TYPES[0].schedule,
    timezone: TASK_TIMEZONE,
    query: TASK_TYPES[0].query,
    user: user.email_account,
    email_account: user.email_account,
    user_refresh_token: user.user_refresh_token,
    taskType: 'schedule'
  };
  
  const scheduleTask2 = {
    name: `定时自动加日程(提前)-${user.email_account}`,
    schedule: TASK_TYPES[1].schedule,
    timezone: TASK_TIMEZONE,
    query: TASK_TYPES[1].query,
    user: user.email_account,
    email_account: user.email_account,
    user_refresh_token: user.user_refresh_token,
    taskType: 'schedule'
  };
  
  const summaryTask = {
    name: `定时自动总结-${user.email_account}`,
    schedule: TASK_TYPES[2].schedule,
    timezone: TASK_TIMEZONE,
    query: TASK_TYPES[2].query,
    user: user.email_account,
    email_account: user.email_account,
    user_refresh_token: user.user_refresh_token,
    taskType: 'summary'
  };
  
  return [scheduleTask1, scheduleTask2, summaryTask];
});

// ========== 初始化客户端（每个任务使用自己的客户端） ==========
if (!FASTGPT_URL || !FASTGPT_API_KEY) {
  console.error('[ERR] 缺少配置：FASTGPT_URL 或 FASTGPT_API_KEY');
  process.exit(1);
}

if (TASKS.length === 0) {
  console.error('[ERR] 没有配置任何用户，请检查 users_config.json');
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
      email_account: task.email_account,
      user_refresh_token: task.user_refresh_token
    };
    
    const result = await client.sendToFastGPT({
      query: task.query,
      user: task.user,
      variables: variables
    });

    // 如果返回内容包含新的 refresh_token（即使前后还有其它输出），则写回 users_config.json
    try {
      const newToken = extractLastRefreshTokenFromText(result);
      if (newToken) {
        await updateUsersConfigRefreshToken(task.email_account, newToken);
      }
    } catch (err) {
      console.error('[ERR] 尝试更新 user_refresh_token 失败:', err.message);
    }
    
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

// ========== 飞书 card.action.trigger 处理函数，可复用 ==========
async function handleFeishuCardActionTrigger(data) {
  // 立即打印，确保函数被调用时能立即看到
  console.log('[飞书回调] ========== handleFeishuCardActionTrigger 被调用 ==========');
  console.log('[飞书回调] 进程 PID:', process.pid);
  console.log('[飞书回调] data 类型:', typeof data);
  
  // 确保即使 JSON.stringify 抛异常也不影响返回
  try {
    console.log('[飞书回调] 收到 card.action.trigger:', JSON.stringify(data, null, 2));
  } catch (logErr) {
    console.log('[飞书回调] 收到 card.action.trigger (无法序列化):', typeof data, data?.event_type || 'unknown');
    console.log('[飞书回调] 序列化错误:', logErr && logErr.message ? logErr.message : logErr);
  }

  // 超时保护：确保 2.5 秒内一定返回（留 0.5 秒缓冲）
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      console.warn('[飞书回调] 处理超时（2.5秒），强制返回 toast');
      const timeoutResponse = {
        toast: {
          type: 'error',
          content: '处理超时，请稍后重试',
          i18n: {
            zh_cn: '处理超时，请稍后重试',
            en_us: 'process timeout, please try again later'
          }
        }
      };
      console.log('[飞书回调] 超时返回 toast 响应:', JSON.stringify(timeoutResponse));
      resolve(timeoutResponse);
    }, 2500);
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

    // 每次回调都从 users_config.json 读取最新 user_refresh_token
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

    if (!user || !user.user_refresh_token) {
      console.warn('[飞书回调] 未在最新 users_config.json 找到对应用户或其 refresh_token:', email_account);
      return {
        toast: {
          type: 'warning',
          content: '未找到对应用户或其 refresh_token',
          i18n: {
            zh_cn: '未找到对应用户或其 refresh_token',
            en_us: 'user or refresh_token not found'
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
          user_refresh_token: user.user_refresh_token
        };

        console.log('[飞书回调] 异步调用 FastGPT 强制添加日程, email_account:', email_account);

        const result = await client.sendToFastGPT({
          query: '强制添加日程',
          user: email_account,
          variables
        });

        console.log('[飞书回调] FastGPT 调用成功，结果前 100 字符:', typeof result === 'string' ? result.substring(0, 100) : '');

        // 尝试从返回中提取新的 refresh_token
        try {
          const newToken = extractLastRefreshTokenFromText(result);
          if (newToken && newToken !== user.user_refresh_token) {
            await updateUsersConfigRefreshToken(email_account, newToken);
          }
        } catch (err) {
          console.error('[飞书回调] 尝试更新 user_refresh_token 失败:', err.message);
        }
      } catch (err) {
        console.error('[飞书回调] 异步调用 FastGPT 失败:', err && err.message ? err.message : err);
      }
    })();

    // 立即返回 toast，避免超过 3 秒超时
    const toastResponse = {
      toast: {
        type: 'success',
        content: '已接收请求，正在添加日程',
        i18n: {
          zh_cn: '已接收请求，正在添加日程',
          en_us: 'request received, adding schedule'
        }
      }
    };
    console.log('[飞书回调] 准备返回 toast 响应:', JSON.stringify(toastResponse));
    return toastResponse;
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

  // 使用 Promise.race 确保 2.5 秒内一定返回
  return Promise.race([handlerPromise, timeoutPromise]);
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

  console.log('[飞书回调] 正在注册回调');
  console.log('[飞书回调] 当前进程 PID:', process.pid);
  console.log('[飞书回调] handleFeishuCardActionTrigger 函数类型:', typeof handleFeishuCardActionTrigger);
  
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': (data) => {
      console.log('[飞书回调] EventDispatcher 收到 card.action.trigger，准备调用 handler');
      return handleFeishuCardActionTrigger(data);
    }
  });
  
  console.log('[飞书回调] EventDispatcher 注册完成');

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

    // 再执行一次指定任务（不会影响长连接）
    runTaskManually(args[1]).then(() => {
      console.log('[服务] 手动任务执行完成（长连接仍在运行，等待飞书回调）');
    }).catch(err => {
      console.error('[ERR] 手动任务执行失败:', err);
      process.exit(1);
    });
    return;
  }
  
  // 启动定时任务
  startScheduledTasks();

  // 启动飞书长连接回调处理
  startFeishuWsClient();
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

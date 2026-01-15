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

// 从 users_config.json 读取用户配置
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
    // 加日程任务1：8-11点、13-17点、19-22点每小时执行（排除12点和18点，因为这两个时间点会在总结任务中先执行加日程）
    schedule: process.env.FASTGPT_CRON_SCHEDULE || '0 8-11,13-17,19-22 * * *',
    query: process.env.FASTGPT_QUERY_SCHEDULE || '定时自动加日程'
  },
  {
    name: '定时自动加日程（提前10分钟）',
    // 加日程任务2：11:50 和 17:50 执行
    schedule: process.env.FASTGPT_CRON_SCHEDULE_EARLY || '50 11,17 * * *',
    query: process.env.FASTGPT_QUERY_SCHEDULE || '定时自动加日程'
  },
  {
    name: '定时自动总结',
    // 总结任务：12点和18点执行
    schedule: process.env.FASTGPT_CRON_SUMMARY || '0 12,18 * * *',
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
    taskType: 'schedule'
  };

  const scheduleTask2 = {
    name: `定时自动加日程（提前10分钟）-${user.email_account}`,
    schedule: TASK_TYPES[1].schedule,
    timezone: TASK_TIMEZONE,
    query: TASK_TYPES[1].query,
    user: user.email_account,
    email_account: user.email_account,
    taskType: 'schedule'
  };
  
  const summaryTask = {
    name: `定时自动总结-${user.email_account}`,
    schedule: TASK_TYPES[2].schedule,
    timezone: TASK_TIMEZONE,
    query: TASK_TYPES[2].query,
    user: user.email_account,
    email_account: user.email_account,
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
      email_account: task.email_account
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

// ========== 飞书 card.action.trigger 处理函数，可复用 ==========
async function handleFeishuCardActionTrigger(data) {

  
  // 超时保护：确保 3 秒内一定返回
  const TIMEOUT_FLAG = '__TIMEOUT__';
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve(TIMEOUT_FLAG);
    }, 3000);
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

    // 从 users_config.json 读取用户配置
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

    if (!user) {
      console.warn('[飞书回调] 未在 users_config.json 找到对应用户:', email_account);
      return {
        toast: {
          type: 'warning',
          content: '未找到对应用户',
          i18n: {
            zh_cn: '未找到对应用户',
            en_us: 'user not found'
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
          email_account
        };

        console.log('[飞书回调] 异步调用 FastGPT 强制添加日程, email_account:', email_account);

        const result = await client.sendToFastGPT({
          query: '强制添加日程',
          user: email_account,
          variables
        });

        console.log('[飞书回调] FastGPT 调用成功，结果前 100 字符:', typeof result === 'string' ? result.substring(0, 100) : '');
      } catch (err) {
        console.error('[飞书回调] 异步调用 FastGPT 失败:', err && err.message ? err.message : err);
      }
    })();

    // 立即返回 toast，避免超过 3 秒超时
    return {
      toast: {
        type: 'success',
        content: '已接收请求，正在添加日程',
        i18n: {
          zh_cn: '已接收请求，正在添加日程',
          en_us: 'request received, adding schedule'
        }
      }
    };
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

  // 使用 Promise.race 确保 3 秒内一定返回
  const result = await Promise.race([handlerPromise, timeoutPromise]);

  if (result === TIMEOUT_FLAG) {
    console.warn('[飞书回调] 处理超时（3秒），强制返回 toast');
    return {
      toast: {
        type: 'error',
        content: '处理超时，请稍后重试',
        i18n: {
          zh_cn: '处理超时，请稍后重试',
          en_us: 'process timeout, please try again later'
        }
      }
    };
  }

  // 正常在 3 秒内返回结果，清理定时器
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
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

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': (data) => {
      return handleFeishuCardActionTrigger(data);
    }
  });

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

const axios = require('axios');
const OpenCC = require('opencc-js');
const converter = OpenCC.Converter({ from: 'cn', to: 'hk' });
const { appendLog } = require('../group_utils/bot_logger_util');
const { getSenderType, SENDER_TYPES } = require('../group_utils/sender_contract_util');
const { logOperationToCsv } = require('../group_utils/operation_csv_logger');

// 获取香港时区的今天日期字符串 (YYYY-MM-DD)
function getTodayDateStr() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(now);
  const getPart = (type) => parts.find(p => p.type === type).value;
  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
}


const CRUD_API_HOST = 'http://llm-ai.c-smart.hk';
const { generateApplicationId, resetDailyIfNeeded } = require('../bot_util.js');
const { EXTERNAL_SCAFFOLDING_GROUPS } = require('../group_constants.js');

// 检查是否是目标群组（外墙棚架群组）
function isTargetGroup(groupId) {
  return EXTERNAL_SCAFFOLDING_GROUPS.includes(groupId);
}

// 仅在目标群组中记录CSV日志（错误不影响主流程）
async function logOperationToCsvIfTargetGroup(params) {
  if (isTargetGroup(params.groupId)) {
    try {
      await logOperationToCsv(params);
    } catch (e) {
      // 日志记录失败不影响主流程，只记录错误
      console.error(`[CSV日志记录失败] ${e.message}`);
      appendLog(params.groupId || 'default', `CSV日志记录失败: ${e.message}`);
    }
  }
}

// 提取前三行用于短码识别
function getFirstThreeLines(text) {
  return text.split('\n').slice(0, 3).join('\n');
}


// 提取申请编号 (A1, B12)
function extractApplicationId(text) {
  // 先把前 3 行中包含「位置：」的内容去掉，再做编号匹配
  const cleanedText = text
    .split(/\r?\n/)
    .filter((line, idx) => !(idx < 3 && line.includes('位置：')))
    .join('\n');
  // 匹配：申请编号:A1 或 直接 A1 // 优化正则：行首或非单词字符后跟随 [Letter][Digit]，支持字母和数字之间有空格（如 B 4）
  const match = cleanedText.match(/(?:申請編號|編號|Code)[:：\s]*([A-Za-z]\s*\d{1,3})\b|\b([A-Za-z]\s*\d{1,3})\b/i);
  return match ? (match[1] || match[2]).replace(/\s+/g, '').toUpperCase() : null;
}

// 解析 update_history JSON 数组
function parseUpdateHistory(update_history) {
  let history = [];
  try {
    // 处理 null 或 undefined
    if (update_history === null || update_history === undefined) {
      return [];
    }
    
    // 处理字符串格式
    if (typeof update_history === 'string') {
      const trimmed = update_history.trim();
      if (trimmed === '' || trimmed === 'null' || trimmed === '[]') {
        return [];
      }
      history = JSON.parse(trimmed);
      if (!Array.isArray(history)) {
        console.warn(`parseUpdateHistory: 解析结果不是数组: ${JSON.stringify(history)}`);
        return [];
      }
    } 
    // 处理数组格式
    else if (Array.isArray(update_history)) {
      history = update_history;
    }
    // 其他类型，尝试转换
    else {
      console.warn(`parseUpdateHistory: 未知类型 ${typeof update_history}, 值: ${JSON.stringify(update_history)}`);
      return [];
    }
    
    // 过滤掉 null 和无效值
    history = history.filter(item => item !== null && item !== undefined && item !== '');
    
  } catch (e) {
    console.warn(`处理update_history失败: ${e.message}, 原始值: ${JSON.stringify(update_history)}`);
    history = [];
  }
  return history;
}

// 验证安全相更新是否成功（通过查询记录验证 update history）
async function verifySafetyUpdate(appId, groupId, senderType, verifyFilters = null) {
  try {
    // 记录更新前的时间，用于对比
    const beforeUpdate = new Date();
    
    // 等待一段时间，确保数据库更新完成（增加到2秒，考虑网络延迟和数据库处理时间）
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 查询记录：如果有 appId 则用 appId 查询，否则用 verifyFilters 查询
    let res;
    let queryParams;
    if (appId) {
      queryParams = { group_id: groupId, application_id: appId };
      console.log(`[验证调试] 通过appId查询: ${JSON.stringify(queryParams)}`);
      res = await axios.get(`${CRUD_API_HOST}/records/today`, { params: queryParams });
    } else if (verifyFilters) {
      // 通过字段查询记录
      queryParams = {
        group_id: groupId,
        ...verifyFilters
      };
      console.log(`[验证调试] 通过verifyFilters查询: ${JSON.stringify(queryParams)}`);
      res = await axios.get(`${CRUD_API_HOST}/records/today`, { params: queryParams });
    } else {
      return { success: false, detail: '缺少查询参数：appId 或 verifyFilters' };
    }
    
    console.log(`[验证调试] 查询返回结果数量: ${res.data ? res.data.length : 0}`);
    appendLog(groupId, `[验证调试] 查询参数: ${JSON.stringify(queryParams)}, 返回结果数量: ${res.data ? res.data.length : 0}`);
    
    if (!res.data || res.data.length === 0) {
      const searchInfo = appId ? `編號 ${appId}` : JSON.stringify(verifyFilters);
      console.log(`[验证调试] 找唔到編號: ${searchInfo}`);
      return { success: false, detail: `找唔到編號: ${searchInfo}` };
    }
    
    const record = res.data[0];
    console.log(`[验证调试] 找到记录，record keys: ${Object.keys(record).join(', ')}`);
    
    // 调试：打印原始数据
    console.log(`[验证调试] senderType: ${senderType}, record.update_history类型: ${typeof record.update_history}, 值: ${JSON.stringify(record.update_history)}`);
    console.log(`[验证调试] record.update_safety_history类型: ${typeof record.update_safety_history}, 值: ${JSON.stringify(record.update_safety_history)}`);
    appendLog(groupId, `[验证调试] senderType: ${senderType}, update_history原始值: ${JSON.stringify(record.update_history)}`);
    
    // 解析三个 update history 字段
    const updateHistory = parseUpdateHistory(record.update_history);
    const updateSafetyHistory = parseUpdateHistory(record.update_safety_history);
    const updateConstructHistory = parseUpdateHistory(record.update_construct_history);
    
    // 调试：打印解析后的数据
    console.log(`[验证调试] 解析后 - updateHistory长度: ${updateHistory.length}, updateSafetyHistory长度: ${updateSafetyHistory.length}, updateConstructHistory长度: ${updateConstructHistory.length}`);
    appendLog(groupId, `[验证调试] 解析后 - updateHistory: ${JSON.stringify(updateHistory)}, updateSafetyHistory: ${JSON.stringify(updateSafetyHistory)}`);
    
    const checkRecentTimestamp = (timestamps) => {
      if (!Array.isArray(timestamps) || timestamps.length === 0) {
        console.log(`[验证时间戳] 时间戳数组为空或不是数组: ${JSON.stringify(timestamps)}`);
        return false;
      }
      const latest = timestamps[timestamps.length - 1];
      if (!latest) {
        console.log(`[验证时间戳] 最新时间戳为空: ${JSON.stringify(timestamps)}`);
        return false;
      }
      
      try {
        // 后端返回的时间格式：GMT格式字符串 "Mon, 29 Dec 2025 16:06:12 GMT"
        // 注意：数据库返回的时间戳实际上是服务器本地时间（香港时间 UTC+8），但格式标记为 GMT
        // 移除 " GMT" 后缀，提取日期时间部分，手动创建本地时间对象
        const dateTimeStr = latest.replace(/\s+GMT$/, '').replace(/^\w+,\s*/, ''); // 移除 "GMT" 和星期
        // 格式: "29 Dec 2025 16:06:12"
        const dateTimeMatch = dateTimeStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
        if (!dateTimeMatch) {
          console.warn(`[验证时间戳] 无法解析时间戳格式: ${latest}, 处理后: ${dateTimeStr}`);
          appendLog(groupId, `[验证时间戳] 无法解析时间戳格式: ${latest}`);
          return false;
        }
        
        const monthMap = { 'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5, 'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11 };
        const latestTime = new Date(
          parseInt(dateTimeMatch[3], 10), // year
          monthMap[dateTimeMatch[2]],     // month
          parseInt(dateTimeMatch[1], 10), // day
          parseInt(dateTimeMatch[4], 10), // hour
          parseInt(dateTimeMatch[5], 10),  // minute
          parseInt(dateTimeMatch[6], 10)  // second
        );
        
        if (isNaN(latestTime.getTime())) {
          console.warn(`[验证时间戳] 时间戳解析失败: ${latest}, 解析结果: ${latestTime}`);
          appendLog(groupId, `[验证时间戳] 时间戳解析失败: ${latest}`);
          return false;
        }
        
        const now = new Date();
        const timeDiff = Math.abs(now - latestTime);
        const timeDiffSeconds = Math.floor(timeDiff / 1000);
        const timeDiffMinutes = Math.floor(timeDiffSeconds / 60);
        
        console.log(`[验证时间戳] 最新: ${latest}, 解析后: ${latestTime.toLocaleString('zh-CN')}, 当前: ${now.toLocaleString('zh-CN')}, 时间差: ${timeDiffSeconds}秒 (${timeDiffMinutes}分钟)`);
        appendLog(groupId, `[验证时间戳] 最新: ${latest}, 时间差: ${timeDiffSeconds}秒 (${timeDiffMinutes}分钟)`);
        
        const isRecent = timeDiff <= 5 * 60 * 1000; // 5分钟
        if (!isRecent) {
          console.log(`[验证时间戳] 时间差超过5分钟: ${timeDiffMinutes}分钟`);
        }
        return isRecent;
      } catch (e) {
        console.warn(`[验证时间戳] 解析失败: ${latest}, 错误: ${e.message}, 堆栈: ${e.stack}`);
        appendLog(groupId, `[验证时间戳] 解析失败: ${latest}, 错误: ${e.message}`);
        return false;
      }
    };
    
    // 根据 sender_type 检查对应的 history 字段
    let expectedHistory = null;
    let historyName = '';
    
    if (senderType === SENDER_TYPES.CSG_SAFETY) {
      // 中建安全部 -> update_safety_history
      expectedHistory = updateSafetyHistory;
      historyName = 'update_safety_history';
    } else if (senderType === SENDER_TYPES.CSG_CONSTRUCT) {
      // 中建施工部 -> update_construct_history
      expectedHistory = updateConstructHistory;
      historyName = 'update_construct_history';
    } else {
      // 其他 -> update_history
      expectedHistory = updateHistory;
      historyName = 'update_history';
    }
    
    // 检查是否有最近的时间戳
    const hasRecentUpdate = checkRecentTimestamp(expectedHistory);
    
    if (hasRecentUpdate) {
      const latest = expectedHistory[expectedHistory.length - 1];
      return { 
        success: true, 
        detail: `${historyName}已正确更新，最新时间戳: ${latest}` 
      };
    } else {
      return { 
        success: false, 
        detail: `${historyName}未找到最近5分钟内的更新，当前记录数: ${expectedHistory.length}，最新时间戳: ${expectedHistory[expectedHistory.length - 1] || '无'}` 
      };
    }
  } catch (e) {
    return { success: false, detail: `验证失败: ${e.message}` };
  }
}

// ============================
// 外墙棚架工作流处理主函数
// ============================

async function processScaffoldingQuery(query, groupId, contactPhone) {
  // 保存原始query用于CSV记录
  const originalQuery = query;
  try { query = converter(query); } catch (e) {}

  // 忽略总结消息
  if (query.includes('External Scaffolding Work') || query.includes('指引')) return null;

  // 忽略安全交底消息
  if (query.includes('安全交底')) {
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '未知',
      groupId,
      success: false,
      errorMsg: '未匹配到工作流'
    });
    return "未匹配到工作流";
  }

  const firstThree = getFirstThreeLines(query);
  const appId = extractApplicationId(firstThree);

  resetDailyIfNeeded(groupId);

  // === 场景 1: 申请 (Apply) ===
  // 逻辑：先做模板校验 -> 通过后才生成ID -> 插入DB -> 返回带ID的成功消息
  if (/申請|開工|申请|开工/.test(query)) {
    // applicationId 由 handleApply 在通过模板校验后生成，避免不符合模板也消耗编号
    return await handleApply(query, groupId);
  }

  // === 场景 2: 短码优先处理 (Shortcode First) === // 只要有 ID，且有关键字，无视其他字段格式
  if (appId) {
    // 删除
    if (/刪除|删除|取消/.test(query)) {
      return await handleDeleteById(appId, groupId, query);
    }
    // 撤离
    if (/撤離|撤离|收工|放工/.test(query)) {
      return await handleLeaveById(appId, groupId, query);
    }
    // 安全相
    if (/安全相|安全帶|扣帶|已扣安全帶/.test(query)) {
      return await handleSafetyById(appId, groupId, contactPhone, query);
    }
  }

  // === 场景 3: 降级处理 (Fallback) ===
  // 无 ID 或无匹配短码，走原有严格模板
  for (const { test, action } of scaffold_conditions) {
    if (test(query)) return await action(query, groupId, contactPhone);
  }

  // 未匹配到工作流，也记录到CSV
  await logOperationToCsvIfTargetGroup({
    query: originalQuery,
    category: '未知',
    groupId,
    success: false,
    errorMsg: '未匹配到工作流'
  });

  return "未匹配到工作流";
}

async function handleSafetyById(appId, groupId, contactPhone, query) {
  // 根据需求，只要有编号+唤醒词，其他不填也没问题。// 我们只更新 safety_flag，如果用户补了时间等信息，这里暂不解析（为了"快"），// 如需解析非必填字段可在此处正则提取。此处按需求"其他字段不填/填错都没问题"处理。
  // 保存原始query用于CSV记录（短码方式不需要 normalizeQuery，所以query就是原始query）
  const originalQuery = query;
  const senderType = getSenderType(contactPhone, groupId);
  const data = {
    where: { application_id: appId, group_id: groupId },
    set: {
      safety_flag: 1,
      sender_type: senderType,
    }
  };
  try {
    const res = await axios.put(`${CRUD_API_HOST}/records/update_by_condition`, data);
    // 后端返回格式：{ status: "ok", updated_count: count } 或 { error: "..." }
    // 注意：updated_count 可能为 0（记录存在但无需更新），这仍然算成功
    if (res.data.error || !res.data.status) {
      const errMsg = res.data.error || `找唔到編號 ${appId}，請檢查是否已撤離或輸入錯誤。`;
      console.log(errMsg);
      appendLog(groupId, errMsg);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '安全相',
        groupId,
        success: false,
        errorMsg: errMsg,
        shortcode: appId
      });
      return errMsg;
    }
    
    // 验证 update history 是否正确更新（仅对目标群组生效）
    const verifyResult = isTargetGroup(groupId) 
      ? await verifySafetyUpdate(appId, groupId, senderType)
      : { success: true, detail: '跳过验证（非目标群组）' };
    const isSuccess = verifyResult.success;
    
    if (isSuccess) {
      const successMsg = `安全相已記錄 (編號: ${appId})`;
      console.log(successMsg);
      appendLog(groupId, `${successMsg} - 验证: ${verifyResult.detail}`);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '安全相',
        groupId,
        success: true,
        shortcode: appId
      });
      return `安全相已記錄 (編號: ${appId})`;
    } else {
      const errMsg = `安全相更新失败，验证未通过: ${verifyResult.detail}`;
      console.log(errMsg);
      appendLog(groupId, errMsg);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '安全相',
        groupId,
        success: false,
        errorMsg: errMsg,
        shortcode: appId
      });
      return `安全相更新失败: ${verifyResult.detail}`;
    }
  } catch (e) {
    const errMsg = `安全相更新失败 (編號: ${appId}): ${e.message}`;
    console.log(errMsg);
    appendLog(groupId, errMsg);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '安全相',
      groupId,
      success: false,
      errorMsg: errMsg,
      shortcode: appId
    });
    return `系统錯誤: ${e.message}`;
  }
}

async function handleLeaveById(appId, groupId, query) {
  // 保存原始query用于CSV记录
  const originalQuery = query;
  try {

    const res = await axios.get(`${CRUD_API_HOST}/records/today`, { params: { group_id: groupId, application_id: appId } });
    if (!res.data || res.data.length === 0) {
      const errMsg = `找唔到編號 ${appId}`;
      console.log(errMsg);
      appendLog(groupId, errMsg);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '撤离',
        groupId,
        success: false,
        errorMsg: errMsg,
        shortcode: appId
      });
      return errMsg;
    }

    const fields = [
      { name: '人數', regex: /人數[：:]\s*(\d+)[人個]?/ },
    ];
    // 匹配字段，添加换行
    query = normalizeQuery(query, fields);
    // 正则匹配用户输入，提取字段值
    const matches = extractFields(query, fields);
    console.log(`群组id: ${groupId}, 撤离更新匹配的字段值： ${JSON.stringify(matches)}`);
    appendLog(groupId, `撤离更新匹配的字段值： ${JSON.stringify(matches)}`);
  
    const part_leave_number_from_query = matches['人數'];

    const record = res.data[0];
    const data = {
      where: { application_id: appId, group_id: groupId },
      set: {
        part_leave_number: part_leave_number_from_query 
          ? parseInt(part_leave_number_from_query) 
          : parseInt(record.number)
      }, 
    };
    const updateRes = await axios.put(`${CRUD_API_HOST}/records/update_by_condition`, data);
    // 后端返回格式：{ status: "ok", updated_count: count } 或 { error: "..." }
    // 注意：updated_count 可能为 0（记录存在但无需更新），这仍然算成功
    if (updateRes.data.error || !updateRes.data.status) {
      const errMsg = updateRes.data.error || `撤離更新失敗，找唔到編號 (編號: ${appId})`;
      console.log(errMsg);
      appendLog(groupId, errMsg);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '撤离',
        groupId,
        success: false,
        errorMsg: errMsg,
        shortcode: appId
      });
      return errMsg;
    }
    const successMsg = `已撤離 (編號: ${appId})`;
    console.log(successMsg);
    appendLog(groupId, successMsg);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '撤离',
      groupId,
      success: true,
      shortcode: appId
    });
    return successMsg;
  } catch (e) {
    const errMsg = `撤離失敗 (編號: ${appId}): ${e.message}`;
    console.log(errMsg);
    appendLog(groupId, errMsg);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '撤离',
      groupId,
      success: false,
      errorMsg: errMsg,
      shortcode: appId
    });
    return `撤離失敗: ${e.message}`;
  }
}

async function handleDeleteById(appId, groupId, query) {
  // 注意：API服务器需要支持按 application_id 删除// 临时方案：先查 ID 拿到 sub/loc 再调原有删除，或者修改后端支持 fast delete// 这里假设后端已支持传 application_id
  // 保存原始query用于CSV记录（短码方式不需要 normalizeQuery，所以query就是原始query）
  const originalQuery = query;
  
  // 添加日期过滤，只删除今天的记录，避免误删历史记录
  // 使用香港时区获取今天日期，确保与后端匹配
  const todayStr = getTodayDateStr();
  const data = { 
    application_id: appId, 
    group_id: groupId,
    bstudio_create_time: todayStr  // 只删除今天的记录
  };
  console.log(`[删除记录] 使用日期过滤: ${todayStr}, 删除条件: ${JSON.stringify(data)}`);
  appendLog(groupId, `[删除记录] 使用日期过滤: ${todayStr}, 只删除今天的记录`);
  
  try {
    const res = await axios.post(`${CRUD_API_HOST}/delete_fastgpt_records`, data);
    
    // 检查响应状态
    if (res.data.error || (res.data.deleted_count !== undefined && res.data.deleted_count === 0)) {
      // 后端返回了错误信息
      const errorMsg = res.data.error || res.data.message || `刪除失敗，找唔到編號 (編號: ${appId})`;
      console.log(`[删除记录] 后端返回错误: ${errorMsg}`);
      appendLog(groupId, `[删除记录] 后端返回错误: ${errorMsg}`);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '取消',
        groupId,
        success: false,
        errorMsg: errorMsg,
        shortcode: appId
      });
      return errorMsg;
    }
    
    // 删除成功
    const successMsg = `記錄已刪除 (編號: ${appId})`;
    console.log(successMsg);
    appendLog(groupId, successMsg);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '取消',
      groupId,
      success: true,
      shortcode: appId
    });
    return successMsg;
  } catch (e) {
    // 处理axios错误（包括404等HTTP错误）
    let errMsg = `刪除失敗 (編號: ${appId})`;
    
    // 尝试从响应中获取错误信息
    if (e.response && e.response.data) {
      const errorData = e.response.data;
      const errorText = errorData.error || errorData.message || `Request failed with status code ${e.response.status}`;
      errMsg = errorText;
      console.log(`[删除记录] HTTP错误 ${e.response.status}: ${errorText}`);
      appendLog(groupId, `[删除记录] HTTP错误 ${e.response.status}: ${errorText}`);
    } else {
      // 网络错误或其他错误
      errMsg = `${errMsg}: ${e.message}`;
      console.log(`[删除记录] 请求异常: ${e.message}`);
      appendLog(groupId, `[删除记录] 请求异常: ${e.message}`);
    }
    
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '取消',
      groupId,
      success: false,
      errorMsg: errMsg,
      shortcode: appId
    });
    return errMsg;
  }
}

// 模板常量（需要根据实际模板内容进行填充）
const SCAFFOLD_TEMPLATES = {
  apply: "申請\n" +
      "日期：2025/XX/XX\n" +
      "分判商：\n" +
      "人數：X人\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序：\n" +
      "時間：HHMM-HHMM",
  safety: "分判商：\n" +
      "人數：X人\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序：\n" +
      "已扣安全帶",
  leave: "撤離\n" +
      "日期：2025/XX/XX\n" +
      "分判商：\n" +
      "人數：X人\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序：",
  delete: "刪除\n" +
      "日期：2025/XX/XX\n" +
      "分判商：\n" +
      "人數：X人\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序："
};

const scaffold_conditions = [
  {
    test: query => /(申請|開工)/.test(query),
    action: (query, groupId, contactPhone) => handleApply(query, groupId, contactPhone),
  },
  {
    test: query => /(安全帶|扣帶|返回室內|出棚)/.test(query),
    action: (query, groupId, contactPhone) => handleSafety(query, groupId, contactPhone),
  },
  {
    test: query => /(撤離|撤退|收工|放工)/.test(query),
    action: (query, groupId, contactPhone) => handleLeave(query, groupId, contactPhone),
  },
  {
    test: query => /刪除/.test(query),
    action: (query, groupId, contactPhone) => handleDelete(query, groupId, contactPhone),
  },
];

// ============================
// 1. 辅助函数
// ============================
// 1、输入格式化函数 - 为关键字添加换行符
function normalizeQuery(query, fields) {
  const keywords = fields.map(field => field.name);
  keywords.forEach(keyword => {
    const regex = new RegExp(`\\s*(${keyword}[：:])`, 'g');
    query = query.replace(regex, '\n$1');
  });
  return query.trim();
}


// 2、匹配字段的正则表达式
function extractFields(query, fields) {
  return fields.reduce((result, field) => {
    if (field.regex) {
      const match = query.match(field.regex);
      result[field.name] = match ? match[1] : null;
    } else {
      // 按行匹配，确保只匹配当前行的内容
      const lines = query.split(/\r?\n/);
      let matched = false;
      for (const line of lines) {
        const pattern = new RegExp(`^${field.name}[：:]\\s*(.*)$`);
        const match = line.match(pattern);
        if (match) {
          const value = match[1].trim();
          result[field.name] = value || null;
          matched = true;
          break;
        }
      }
      if (!matched) {
        result[field.name] = null;
      }
    }
    return result;
  }, {});
}

// 3、格式化位置字段：前半部分替换为 Blk A，后半部分只去除空格
function formatLocation(locationText) {
  if (!locationText) return '';
  
  // 1. 找到第一个 b 或 B，然后找到它之后的第一个 k 或 K
  const bIndex = locationText.search(/[Bb]/i);
  if (bIndex !== -1) {
    const afterB = locationText.substring(bIndex);
    const kIndex = afterB.search(/[Kk]/i);
    if (kIndex !== -1) {
      // 2. 找到 k 之后的第一个字母作为楼栋字母
      const afterK = afterB.substring(kIndex + 1);
      const letterMatch = afterK.match(/[A-Za-z]/);
      if (letterMatch) {
        const buildingLetter = letterMatch[0].toUpperCase();
        const letterIndexInAfterK = letterMatch.index;
        
        // 3. 计算字母在原始字符串中的位置
        const letterIndexInOriginal = bIndex + kIndex + 1 + letterIndexInAfterK;
        
        // 4. 从字母位置往后找第一个空格或中英文逗号的位置
        const afterLetter = locationText.substring(letterIndexInOriginal + 1);
        const separatorMatch = afterLetter.match(/[，,\s]/);
        
        if (separatorMatch) {
          // 找到分隔符，替换前半部分为 Blk A，后半部分只去除空格
          const separatorIndex = separatorMatch.index;
          const separator = separatorMatch[0];
          const beforePart = `Blk ${buildingLetter}`;
          const afterPart = afterLetter.substring(separatorIndex + 1).replace(/\s+/g, '');
          return beforePart + separator + afterPart;
        } else {
          // 没有找到分隔符，整个替换为 Blk A
          return `Blk ${buildingLetter}`;
        }
      }
    }
  }
  
  // 回退逻辑：优先匹配 "B座"、"B 座"、"B棟"、"B 棟"、"B樓"、"B 樓" 等模式
  // 匹配字母后跟（可能有空格）"座"、"棟"、"樓"等字符
  const buildingPattern = /([A-Za-z])\s*[座棟樓]/;
  const buildingMatch = locationText.match(buildingPattern);
  if (buildingMatch) {
    const buildingLetter = buildingMatch[1].toUpperCase();
    // 找到"座"、"棟"、"樓"之后的内容
    const afterBuilding = locationText.substring(buildingMatch.index + buildingMatch[0].length);
    
    // 如果"座"后面直接是逗号，则保留逗号后的内容（如 "B座,南面" -> "Blk B,南面"）
    if (afterBuilding.trim().startsWith(',') || afterBuilding.trim().startsWith('，')) {
      const afterComma = afterBuilding.trim().substring(1).trim();
      if (afterComma) {
        return `Blk ${buildingLetter},${afterComma.replace(/\s+/g, '')}`;
      }
    }
    
    // 否则只返回楼栋部分，忽略"座"后面的内容（如"南面"）
    // 这样 "B座南面" 和 "B 座南面" 都会返回 "Blk B"，与申请时一致
    return `Blk ${buildingLetter}`;
  }
  
  // 如果没匹配到"座"、"棟"、"樓"，直接取第一个字母作为楼栋
  const firstLetterMatch = locationText.match(/[A-Za-z]/);
  if (firstLetterMatch) {
    const buildingLetter = firstLetterMatch[0].toUpperCase();
    const letterIndex = firstLetterMatch.index;
    
    // 从字母位置往后找第一个中英文逗号的位置
    const afterLetter = locationText.substring(letterIndex + 1);
    const commaMatch = afterLetter.match(/[，,]/);
    
    if (commaMatch) {
      // 找到逗号分隔符
      const commaIndex = commaMatch.index;
      const beforePart = `Blk ${buildingLetter}`;
      const afterPart = afterLetter.substring(commaIndex + 1).replace(/\s+/g, '');
      return beforePart + commaMatch[0] + afterPart;
    } else {
      // 没有找到逗号，整个替换为 Blk A
      return `Blk ${buildingLetter}`;
    }
  }
  
  return locationText.replace(/\s+/g, '');
}


// ============================
// 2. 封装的 Action 函数
// ============================
// 1. 申请开工
async function handleApply(query, groupId, contactPhone) {// 修正后的代码
  // 保存原始query用于CSV记录
  const originalQuery = query;

  const fields = [
    { name: '日期' },
    { name: '分判商' },
    { name: '人數', regex: /人數[：:]\s*(\d+)[人個]?/ },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' },
    { name: '時間', regex: /時間[：:]\s*(\d{4}-\d{4})/ },
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 申请匹配的字段值：`, matches);
  appendLog(groupId, `申请匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const number = matches['人數'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];
  const time_range = matches['時間'];

  // 检查必填字段（日期和时间不是必填）
  const missingFields = [];
  if (!subcontractor) missingFields.push('分判商');
  if (!number) missingFields.push('人數');
  if (!location) missingFields.push('位置');
  if (!floor) missingFields.push('樓層');
  if (!process) missingFields.push('工序');

  if (missingFields.length > 0) {
    // 模板校验失败，记录到CSV
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '申请',
      groupId,
      success: false,
      errorMsg: '不符合模版，缺少必填字段：' + missingFields.join('、')
    });
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.apply +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }
  
  // 格式化位置字段：前半部分替换为 BLK A，后半部分只去除空格
  const formattedLocation = formatLocation(location);
  
  // 检查是否已存在相同记录
  try {
    const checkRes = await axios.get(`${CRUD_API_HOST}/records/today`, {
      params: {
        group_id: groupId,
        subcontractor: subcontractor.trim(),
        number: parseInt(number),
        location: formattedLocation,
        floor: floor.trim(),
        process: process.trim()
      }
    });
    
    if (checkRes.data && checkRes.data.length > 0 && checkRes.data[0].application_id) {
      const existingAppId = checkRes.data[0].application_id;
      // 记录重复申请到CSV
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '申请',
        groupId,
        success: false,
        errorMsg: `已經申請過相同記錄，申請編號爲${existingAppId}`,
        shortcode: existingAppId
      });
      console.log(`检测到重复记录，申请编号: ${existingAppId}`);
      appendLog(groupId, `检测到重复记录，申请编号: ${existingAppId}`);
      return `已經申請過相同記錄，申請編號爲${existingAppId}`;
    }
  } catch (error) {
    // 查询失败不影响主流程，继续执行（查不到是正常情况）
    console.log(`未检查到重复记录，继续执行: ${error.message}`);
    appendLog(groupId, `未检查到重复记录，继续执行: ${error.message}`);
  }
  
  // 通过模板校验后才生成申请编号，避免无效消息消耗编号
  const applicationId = generateApplicationId(query, groupId);

  const timeStr = new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Hong_Kong'
  });
  const data = {
    bstudio_create_time: timeStr,
    subcontractor: subcontractor.trim(),
    number: parseInt(number),
    location: formattedLocation,
    floor: floor.trim(),
    process: process.trim(),
    time_range: time_range?.trim() || '0800-1800',
    morning: 0,
    afternoon: 0,
    xiaban: 0,
    part_leave_number: 0,
    group_id: groupId,
    application_id: applicationId 
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 外墙棚架申请流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `外墙棚架申请流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.post(`${CRUD_API_HOST}/records`, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 外墙棚架申请流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `外墙棚架申请流程响应信息： ${JSON.stringify(response.data)}`);
    
    // 判断是否成功：后端返回 { status: "ok", inserted_id: ... } 或 { error: "..." }
    const isSuccess = !response.data.error && (response.status === 201 || response.data.status === 'ok' || response.data.inserted_id);
    if (isSuccess) {
      replyStr = `申請成功！\n申請編號：${applicationId}\n\n申請请求完成`;
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '申请',
        groupId,
        success: true,
        shortcode: applicationId
      });
    } else {
      const errorMsg = response.data.error || '未知错误';
      replyStr = `申請失敗，請重試`;
      console.log(`群组id: ${groupId}, 外墙群组-申请流程失败： ${errorMsg}`);
      appendLog(groupId, `外墙群组-申请流程失败： ${errorMsg}`);
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '申请',
        groupId,
        success: false,
        errorMsg: errorMsg,
        shortcode: applicationId
      });
    }
  } catch (e) {
    replyStr = `申請失敗，請重試`;
    console.log(`群组id: ${groupId}, 外墙群组-申请流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-申请流程异常信息： ${e.message}`);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '申请',
      groupId,
      success: false,
      errorMsg: e.message,
      shortcode: applicationId
    });
  }
  return replyStr;
}
// 2. 安全相更新
async function handleSafety(query, groupId, contactPhone) {
  // 保存原始query用于CSV记录
  const originalQuery = query;
  const senderType = getSenderType(contactPhone, groupId);

  const fields = [
    { name: '分判商' },
    { name: '人數', regex: /人數[：:]\s*(\d+)[人個]?/ },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' }
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 发送人手机号: ${contactPhone}, 安全相更新类型: ${senderType}, 安全相更新匹配的字段值： ${JSON.stringify(matches)}`);
  appendLog(groupId, `发送人手机号: ${contactPhone}, 安全相更新类型: ${senderType}, 安全相更新匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const number = matches['人數'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];

  // 检查必填字段
  const missingFields = [];
  if (!subcontractor) missingFields.push('分判商');
  if (!number) missingFields.push('人數');
  if (!location) missingFields.push('位置');
  if (!floor) missingFields.push('樓層');
  if (!process) missingFields.push('工序');

  if (missingFields.length > 0) {
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '安全相',
      groupId,
      success: false,
      errorMsg: '不符合模版，缺少必填字段：' + missingFields.join('、')
    });
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.safety +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }

  // 格式化位置字段：与申请时保持一致，确保能匹配到记录
  const formattedLocation = formatLocation(location);

  const data = {
    where: {
      subcontractor: subcontractor.trim(),
      number: parseInt(number),
      process: process.trim(),
      location: formattedLocation,
      floor: floor.trim(),
      group_id: groupId,
    },
    set: {
      safety_flag: 1,
      sender_type: senderType,
    },
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 外墙棚架安全相更新流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `外墙棚架安全相更新流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.put(`${CRUD_API_HOST}/records/update_by_condition`, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 外墙棚架安全相更新流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `外墙棚架安全相更新流程响应信息： ${JSON.stringify(response.data)}`);
    
    // 模板方式没有application_id，所以没有短码
    // 后端返回格式：{ status: "ok", updated_count: count } 或 { error: "..." }
    const isUpdateSuccess = !response.data.error && (response.data.status === 'ok' || response.data.updated_count > 0);
    
    if (isUpdateSuccess) {
      // 验证 update history 是否正确更新（通过字段查询，仅对目标群组生效）
      const verifyFilters = {
        subcontractor: subcontractor.trim(),
        number: parseInt(number),
        process: process.trim(),
        location: formattedLocation,
        floor: floor.trim()
      };
      const verifyResult = isTargetGroup(groupId)
        ? await verifySafetyUpdate(null, groupId, senderType, verifyFilters)
        : { success: true, detail: '跳过验证（非目标群组）' };
      const isSuccess = verifyResult.success;
      
      if (isSuccess) {
        replyStr = '安全相更新请求完成';
        appendLog(groupId, `安全相更新验证: ${verifyResult.detail}`);
        await logOperationToCsvIfTargetGroup({
          query: originalQuery,
          category: '安全相',
          groupId,
          success: true
        });
      } else {
        const errorMsg = `安全相更新失败，验证未通过: ${verifyResult.detail}`;
        replyStr = '更新失敗，驗證未通過';
        appendLog(groupId, errorMsg);
        await logOperationToCsvIfTargetGroup({
          query: originalQuery,
          category: '安全相',
          groupId,
          success: false,
          errorMsg: errorMsg
        });
      }
    } else {
      const errorMsg = response.data.error || '未找到匹配記錄';
      replyStr = '更新失敗，未找到匹配記錄';
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '安全相',
        groupId,
        success: false,
        errorMsg: errorMsg
      });
    }
  } catch (e) {
    replyStr = '更新失敗，請重試';
    console.log(`群组id: ${groupId}, 外墙群组-安全相更新流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-安全相更新流程异常信息： ${e.message}`);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '安全相',
      groupId,
      success: false,
      errorMsg: e.message
    });
  }
  return replyStr;
}
// 3. 撤离
async function handleLeave(query, groupId, contactPhone) {
  // 保存原始query用于CSV记录
  const originalQuery = query;
  const fields = [
    { name: '分判商' },
    { name: '人數', regex: /人數[：:]\s*(\d+)[人個]?/ },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' }
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 撤离更新匹配的字段值： ${JSON.stringify(matches)}`);
  appendLog(groupId, `撤离更新匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const number = matches['人數'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];

  // 检查必填字段
  const missingFields = [];
  if (!subcontractor) missingFields.push('分判商');
  if (!number) missingFields.push('人數');
  if (!location) missingFields.push('位置');
  if (!floor) missingFields.push('樓層');
  if (!process) missingFields.push('工序');

  if (missingFields.length > 0) {
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '撤离',
      groupId,
      success: false,
      errorMsg: '不符合模版，缺少必填字段：' + missingFields.join('、')
    });
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.leave +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }
  
  // 格式化位置字段：与申请时保持一致，确保能匹配到记录
  const formattedLocation = formatLocation(location);
  
  const data = {
    where: {
      subcontractor: subcontractor.trim(),
      // number: parseInt(number),
      process: process.trim(),
      location: formattedLocation,
      floor: floor.trim(),
      group_id: groupId,
    },
    set: {
      part_leave_number: parseInt(number)
    },
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 外墙棚架撤离流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `外墙棚架撤离流程请求参数： ${JSON.stringify(data)}`);
      const response = await axios.put(`${CRUD_API_HOST}/records/update_by_condition`, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 外墙棚架撤离流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `外墙棚架撤离流程响应信息： ${JSON.stringify(response.data)}`);
    
    // 模板方式没有application_id，所以没有短码
    // 后端返回格式：{ status: "ok", updated_count: count } 或 { error: "..." }
    const isSuccess = !response.data.error && (response.data.status === 'ok' || response.data.updated_count > 0);
    
    if (isSuccess) {
      replyStr = '撤離请求完成';
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '撤离',
        groupId,
        success: true
      });
    } else {
      const errorMsg = response.data.error || '未找到匹配記錄';
      replyStr = '撤離失敗，未找到匹配記錄';
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '撤离',
        groupId,
        success: false,
        errorMsg: errorMsg
      });
    }
  } catch (e) {
    replyStr = '撤離失敗，請重試';
    console.log(`群组id: ${groupId}, 外墙群组-撤離流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-撤離流程异常信息： ${e.message}`);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '撤离',
      groupId,
      success: false,
      errorMsg: e.message
    });
  }
  return replyStr;
}
// 4. 删除
async function handleDelete(query, groupId, contactPhone) {
  // 保存原始query用于CSV记录
  const originalQuery = query;
  const fields = [
    { name: '分判商' },
    { name: '人數', regex: /人數[：:]\s*(\d+)[人個]?/ },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' }
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 删除场景匹配的字段值： ${JSON.stringify(matches)}`);
  appendLog(groupId, `删除场景匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const number = matches['人數'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];

  // 检查必填字段
  const missingFields = [];
  if (!subcontractor) missingFields.push('分判商');
  if (!number) missingFields.push('人數');
  if (!location) missingFields.push('位置');
  if (!floor) missingFields.push('樓層');
  if (!process) missingFields.push('工序');

  if (missingFields.length > 0) {
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '取消',
      groupId,
      success: false,
      errorMsg: '不符合模版，缺少必填字段：' + missingFields.join('、')
    });
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.delete +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }
  
  // 格式化位置字段：与申请时保持一致，确保能匹配到记录
  const formattedLocation = formatLocation(location);
  
  const data = {
    subcontractor: subcontractor.trim(),
    location: formattedLocation,
    number: parseInt(number),
    floor: floor.trim(),
    process: process.trim(),
    group_id: groupId,
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 外墙棚架删除流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `外墙棚架删除流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.post(`${CRUD_API_HOST}/delete_fastgpt_records`, data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 外墙棚架删除流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `外墙棚架删除流程响应信息： ${JSON.stringify(response.data)}`);
    
    // 模板方式没有application_id，所以没有短码
    // 后端返回格式：{ status: "ok", deleted_count: count } 或 { error: "..." }
    const isSuccess = !response.data.error && (response.data.deleted_count !== undefined && response.data.deleted_count > 0);
    
    if (isSuccess) {
      replyStr = '刪除请求完成';
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '取消',
        groupId,
        success: true
      });
    } else {
      const errorMsg = response.data.error || '未找到匹配記錄';
      replyStr = '刪除失敗，請重試';
      await logOperationToCsvIfTargetGroup({
        query: originalQuery,
        category: '取消',
        groupId,
        success: false,
        errorMsg: errorMsg
      });
    }
  } catch (e) {
    replyStr = '刪除失敗，請重試';
    console.log(`群组id: ${groupId}, 外墙群组-删除流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-删除流程异常信息： ${e.message}`);
    await logOperationToCsvIfTargetGroup({
      query: originalQuery,
      category: '取消',
      groupId,
      success: false,
      errorMsg: e.message
    });
  }
  return replyStr;
}


module.exports = {
  processScaffoldingQuery,
  SCAFFOLD_TEMPLATES
};


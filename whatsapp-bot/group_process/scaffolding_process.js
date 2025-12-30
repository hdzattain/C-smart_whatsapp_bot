const axios = require('axios');
const OpenCC = require('opencc-js');
const converter = OpenCC.Converter({ from: 'cn', to: 'hk' });
const { appendLog } = require('../group_utils/bot_logger_util');
const { getSenderType } = require('../group_utils/sender_contract_util');


const CRUD_API_HOST = 'http://llm-ai.c-smart.hk';
const { generateApplicationId, resetDailyIfNeeded } = require('../bot_util.js');

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
  // 匹配：申请编号:A1 或 直接 A1 // 优化正则：行首或非单词字符后跟随 [Letter][Digit]
  const match = cleanedText.match(/(?:申請編號|編號|Code)[:：\s]*([A-Za-z]\d{1,3})\b|\b([A-Za-z]\d{1,3})\b/i);
  return match ? (match[1] || match[2]).toUpperCase() : null;
}

// ============================
// 外墙棚架工作流处理主函数
// ============================

async function processScaffoldingQuery(query, groupId, contactPhone) {
  try { query = converter(query); } catch (e) {}

  // 忽略总结消息
  if (query.includes('External Scaffolding Work') || query.includes('指引')) return null;

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
    // 安全相
    if (/安全相|安全帶|扣帶|已扣安全帶/.test(query)) {
      return await handleSafetyById(appId, groupId, contactPhone);
    }
    // 撤离
    if (/撤離|撤离|收工|放工/.test(query)) {
      return await handleLeaveById(appId, groupId, query);
    }
    // 删除
    if (/刪除|删除|取消/.test(query)) {
      return await handleDeleteById(appId, groupId);
    }
  }

  // === 场景 3: 降级处理 (Fallback) ===
  // 无 ID 或无匹配短码，走原有严格模板
  for (const { test, action } of scaffold_conditions) {
    if (test(query)) return await action(query, groupId);
  }

  return "未匹配到工作流";
}

async function handleSafetyById(appId, groupId, contactPhone) {
  // 根据需求，只要有编号+唤醒词，其他不填也没问题。// 我们只更新 safety_flag，如果用户补了时间等信息，这里暂不解析（为了"快"），// 如需解析非必填字段可在此处正则提取。此处按需求"其他字段不填/填错都没问题"处理。
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
    if (res.data.affectedRows === 0) {
      const errMsg = `找唔到編號 ${appId}，請檢查是否已撤離或輸入錯誤。`;
      console.log(errMsg);
      appendLog(groupId, errMsg);
      return errMsg;
    }
    const successMsg = `安全相已記錄 (編號: ${appId})`;
    console.log(successMsg);
    appendLog(groupId, successMsg);
    return `安全相已記錄 (編號: ${appId})`;
  } catch (e) {
    const errMsg = `安全相更新失败 (編號: ${appId}): ${e.message}`;
    console.log(errMsg);
    appendLog(groupId, errMsg);
    return `系统錯誤: ${e.message}`;
  }
}

async function handleLeaveById(appId, groupId, query) {
  try {

    const res = await axios.get(`${CRUD_API_HOST}/records/today`, { params: { group_id: groupId, application_id: appId } });
    if (!res.data || res.data.length === 0) {
      const errMsg = `找唔到編號 ${appId}`;
      console.log(errMsg);
      appendLog(groupId, errMsg);
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
    await axios.put(`${CRUD_API_HOST}/records/update_by_condition`, data);
    const successMsg = `已撤離 (編號: ${appId})`;
    console.log(successMsg);
    appendLog(groupId, successMsg);
    return successMsg;
  } catch (e) {
    const errMsg = `撤離失敗 (編號: ${appId}): ${e.message}`;
    console.log(errMsg);
    appendLog(groupId, errMsg);
    return `撤離失敗: ${e.message}`;
  }
}

async function handleDeleteById(appId, groupId) {
  // 注意：API服务器需要支持按 application_id 删除// 临时方案：先查 ID 拿到 sub/loc 再调原有删除，或者修改后端支持 fast delete// 这里假设后端已支持传 application_id
  const data = { application_id: appId, group_id: groupId };
  try {
    await axios.post(`${CRUD_API_HOST}/delete_fastgpt_records`, data);
    const successMsg = `記錄已刪除 (編號: ${appId})`;
    console.log(successMsg);
    appendLog(groupId, successMsg);
    return successMsg;
  } catch (e) {
    const errMsg = `刪除失敗 (編號: ${appId}): ${e.message}`;
    console.log(errMsg);
    appendLog(groupId, errMsg);
    return `刪除失敗: ${e.message}`;
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
  
  // 回退逻辑：直接取字符串中的第一个字母作为楼栋
  const firstLetterMatch = locationText.match(/[A-Za-z]/);
  if (firstLetterMatch) {
    const buildingLetter = firstLetterMatch[0].toUpperCase();
    const letterIndex = firstLetterMatch.index;
    
    // 从字母位置往后找第一个空格或中英文逗号的位置
    const afterLetter = locationText.substring(letterIndex + 1);
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
  
  return locationText.replace(/\s+/g, '');
}


// ============================
// 2. 封装的 Action 函数
// ============================
// 1. 申请开工
async function handleApply(query, groupId, contactPhone) {// 修正后的代码

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
    replyStr = `申請成功！\n申請編號：${applicationId}\n\n申請请求完成`;
  } catch (e) {
    replyStr = `申請失敗，請重試`;
    console.log(`群组id: ${groupId}, 外墙群组-申请流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-申请流程异常信息： ${e.message}`);
  }
  return replyStr;
}
// 2. 安全相更新
async function handleSafety(query, groupId, contactPhone) {
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
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.apply +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }

  const data = {
    where: {
      subcontractor: subcontractor.trim(),
      number: parseInt(number),
      process: process.trim(),
      location: location.trim(),
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
    replyStr = '安全相更新请求完成';
  } catch (e) {
    replyStr = '更新失敗，請重試';
    console.log(`群组id: ${groupId}, 外墙群组-安全相更新流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-安全相更新流程异常信息： ${e.message}`);
  }
  return replyStr;
}
// 3. 撤离
async function handleLeave(query, groupId, contactPhone) {
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
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.leave +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }
  const data = {
    where: {
      subcontractor: subcontractor.trim(),
      // number: parseInt(number),
      process: process.trim(),
      location: location.trim(),
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
    replyStr = '撤離请求完成';
  } catch (e) {
    replyStr = '撤離失敗，請重試';
    console.log(`群组id: ${groupId}, 外墙群组-撤離流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-撤離流程异常信息： ${e.message}`);
  }
  return replyStr;
}
// 4. 删除
async function handleDelete(query, groupId, contactPhone) {
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
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.delete +'\n\n以下字段未填冩正確，請補充：\n' + 
           missingFields.map((field, index) => `${index + 1}. ${field}`).join('\n');
  }
  const data = {
    subcontractor: subcontractor.trim(),
    location: location.trim(),
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
    replyStr = '刪除请求完成';
  } catch (e) {
    replyStr = '刪除失敗，請重試';
    console.log(`群组id: ${groupId}, 外墙群组-删除流程异常信息： ${e.message}`);
    appendLog(groupId, `外墙群组-删除流程异常信息： ${e.message}`);
  }
  return replyStr;
}


module.exports = {
  processScaffoldingQuery,
  SCAFFOLD_TEMPLATES
};


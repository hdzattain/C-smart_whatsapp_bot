const axios = require('axios');
const OpenCC = require('opencc-js');
const converter = OpenCC.Converter({ from: 'cn', to: 'hk' });
const { appendLog } = require('../bot_logger_util');

// 模板常量（需要根据实际模板内容进行填充）
const DRILLING_TEMPLATES = {
  apply: "申請\n" +
      "日期：2025/XX/XX\n" +
      "分判商：\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序：\n" +
      "時間：HHMM-HHMM",
  safety: "分判商：\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序：\n" +
      "（圍封｜告示｜看守｜防墮｜眼罩｜耳塞｜安全帶）",
  leave: "撤離\n" +
      "日期：2025/XX/XX\n" +
      "分判商：\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序：",
  delete: "刪除\n" +
      "日期：2025/XX/XX\n" +
      "分判商：\n" +
      "位置：\n" +
      "樓層：\n" +
      "工序："
};

const drill_conditions = [
  {
    test: query => /(申請|開工|申请|开工)/.test(query),
    action: (query, groupId) => handleApply(query, groupId),
  },
  {
    test: query => /(圍封|看守|防墮|眼罩|耳塞|安全帶|围封|防坠|安全带)/.test(query),
    action: (query, groupId) => handleSafety(query, groupId),
  },
  {
    test: query => /(撤離|撤退|收工|放工)/.test(query),
    action: (query, groupId) => handleLeave(query, groupId),
  },
  {
    test: query => /刪除/.test(query),
    action: (query, groupId) => handleDelete(query, groupId),
  },
];

// ============================
// 外墙棚架工作流处理主函数
// ============================
async function processDrillingQuery(query, groupId) {
  try {
    query = converter(query);
    appendLog(groupId, `打窿群組转换繁体，query: ${query}`);
  } catch (error) {
    console.log(`简繁转换失败: ${error.message}，使用原始输入内容处理工作流`);
  }

  // 如果包含特定文本，则不向下执行
  if (query.includes('Core drill hole Summary')) {
    return "打窿群組无需处理的输入";
  }

  for (const { test, action } of drill_conditions) {
    if (test(query)) {
      return await action(query, groupId);
    }
  }
  // 如果没有匹配到任何条件，返回默认提示
  return "未匹配到工作流";
}
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
    const match = field.regex
      ? query.match(field.regex)
      : query.match(new RegExp(`${field.name}[：:]\\s*([^\\n\\r]+)`));
    result[field.name] = match ? match[1] : null;
    return result;
  }, {});
}



// ============================
// 2. 封装的 Action 函数
// ============================
// 1. 申请开工
async function handleApply(query, groupId) {// 修正后的代码

  const fields = [
    { name: '日期' },
    { name: '分判商' },
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
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];
  const time_range = matches['時間'];

  if (!subcontractor || !location || !floor || !process) {
    return '不符合模版，請拷貝模板重試。\n' + DRILLING_TEMPLATES.apply;
  }

  const timeStr = new Date().toLocaleString('sv-SE', {
    timeZone: 'Asia/Hong_Kong'
  });
  const data = {
    bstudio_create_time: timeStr,
    subcontractor: subcontractor.trim(),
    number: 1, // 默认人数为1
    location: location.trim(),
    floor: floor.trim(),
    process: process.trim(),
    time_range: time_range?.trim() || '0800-1800',
    morning: 0,
    afternoon: 0,
    xiaban: 0,
    part_leave_number: 0,
    group_id: groupId,
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 打窿群組申请流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `打窿群組申请流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.post('http://llm-ai.c-smart.hk/records', data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 打窿群組申请流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `打窿群組申请流程响应信息： ${JSON.stringify(response.data)}`);
    replyStr = '申請请求完成';
  } catch (e) {
    replyStr = '申請失敗，請重試';
    console.log(`群组id: ${groupId}, 打窿群組-申请流程异常信息： ${e.message}`);
    appendLog(groupId, `打窿群組-申请流程异常信息： ${e.message}`);
  }
  return replyStr;
}
// 2. 安全相更新
async function handleSafety(query, groupId) {
  const fields = [
    { name: '分判商' },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' }
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 打窿群組 - 安全相更新匹配的字段值： ${JSON.stringify(matches)}`);
  appendLog(groupId, `打窿群組 - 安全相更新匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];

  if (!subcontractor || !location || !floor || !process) {
    return '不符合模版，請拷貝模板重試。\n' + DRILLING_TEMPLATES.safety;
  }

  const data = {
    where: {
      subcontractor: subcontractor.trim(),
      process: process.trim(),
      location: location.trim(),
      floor: floor.trim(),
      group_id: groupId,
    },
    set: {
      safety_flag: 1,
    },
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 打窿群組安全相更新流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `打窿群組安全相更新流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.put('http://llm-ai.c-smart.hk/records/update_by_condition', data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 打窿群組安全相更新流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `打窿群組安全相更新流程响应信息： ${JSON.stringify(response.data)}`);
    replyStr = '安全相更新请求完成';
  } catch (e) {
    replyStr = '更新失敗，請重試';
    console.log(`群组id: ${groupId}, 打窿群組-安全相更新流程异常信息： ${e.message}`);
    appendLog(groupId, `打窿群組-安全相更新流程异常信息： ${e.message}`);
  }
  return replyStr;
}
// 3. 撤离
async function handleLeave(query, groupId) {
  const fields = [
    { name: '分判商' },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' }
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 打窿群組-撤离更新匹配的字段值： ${JSON.stringify(matches)}`);
  appendLog(groupId, `打窿群組-撤离更新匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];

  if (!subcontractor || !location || !floor || !process) {
    return '不符合模版，請拷貝模板重試。\n' + DRILLING_TEMPLATES.leave;
  }
  const data = {
    where: {
      subcontractor: subcontractor.trim(),
      process: process.trim(),
      location: location.trim(),
      floor: floor.trim(),
      group_id: groupId,
    },
    set: {
      xiaban: 1
    },
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 打窿群組撤离流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `打窿群組撤离流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.put('http://llm-ai.c-smart.hk/records/update_by_condition', data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 打窿群組撤离流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `打窿群組撤离流程响应信息： ${JSON.stringify(response.data)}`);
    replyStr = '撤離请求完成';
  } catch (e) {
    replyStr = '撤離失敗，請重試';
    console.log(`群组id: ${groupId}, 打窿群組-撤離流程异常信息： ${e.message}`);
    appendLog(groupId, `打窿群組-撤離流程异常信息： ${e.message}`);
  }
  return replyStr;
}
// 4. 删除
async function handleDelete(query, groupId) {
  const fields = [
    { name: '分判商' },
    { name: '位置' },
    { name: '樓層' },
    { name: '工序' }
  ];
  // 匹配字段，添加换行
  query = normalizeQuery(query, fields);
  // 正则匹配用户输入，提取字段值
  const matches = extractFields(query, fields);
  console.log(`群组id: ${groupId}, 打窿群組删除场景匹配的字段值： ${JSON.stringify(matches)}`);
  appendLog(groupId, `打窿群組删除场景匹配的字段值： ${JSON.stringify(matches)}`);

  const subcontractor = matches['分判商'];
  const location = matches['位置'];
  const floor = matches['樓層'];
  const process = matches['工序'];

  if (!subcontractor || !location || !floor || !process) {
    return '不符合模版，請拷貝模板重試。\n' + SCAFFOLD_TEMPLATES.delete;
  }
  const data = {
    subcontractor: subcontractor.trim(),
    location: location.trim(),
    floor: floor.trim(),
    process: process.trim(),
    group_id: groupId,
  };
  let replyStr;
  try {
    console.log(`群组id: ${groupId}, 打窿群組删除流程请求参数： ${JSON.stringify(data)}`);
    appendLog(groupId, `打窿群組删除流程请求参数： ${JSON.stringify(data)}`);
    const response = await axios.post('http://llm-ai.c-smart.hk/delete_fastgpt_records', data, {
      headers: { 'Content-Type': 'application/json' },
    });
    console.log(`群组id: ${groupId}, 打窿群組删除流程响应信息： ${JSON.stringify(response.data)}`);
    appendLog(groupId, `打窿群組删除流程响应信息： ${JSON.stringify(response.data)}`);
    replyStr = '刪除请求完成';
  } catch (e) {
    replyStr = '刪除失敗，請重試';
    console.log(`群组id: ${groupId}, 打窿群組-删除流程异常信息： ${e.message}`);
    appendLog(groupId, `打窿群組-删除流程异常信息： ${e.message}`);
  }
  return replyStr;
}


module.exports = {
  processDrillingQuery
};


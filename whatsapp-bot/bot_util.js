const fs = require('fs-extra');
const path = require('path');

// === 外墙棚架核心工具：申请编号生成与每日重置 ===

const SCAFFOLDING_DATA_FILE = path.join(__dirname, 'data', 'scaffolding_applications.json');
fs.ensureDirSync(path.dirname(SCAFFOLDING_DATA_FILE));

let scaffoldingData = { groups: {} };

// 加载数据
function loadScaffoldingData() {
  if (fs.existsSync(SCAFFOLDING_DATA_FILE)) {
    try {
      scaffoldingData = JSON.parse(fs.readFileSync(SCAFFOLDING_DATA_FILE, 'utf-8'));
    } catch (e) {
      console.warn('加载计数器失败，初始化为空');
    }
  }
}

// 保存数据
function saveScaffoldingData() {
  try {
    fs.writeFileSync(SCAFFOLDING_DATA_FILE, JSON.stringify(scaffoldingData, null, 2));
  } catch (e) {
    console.error('保存计数器失败', e);
  }
}

// 获取群组数据
function getGroupData(groupId) {
  if (!scaffoldingData.groups[groupId]) {
    scaffoldingData.groups[groupId] = {
      lastDate: null,
      counters: {} // 结构: { 'A': 1, 'B': 5, 'Z': 0 }
    };
  }
  return scaffoldingData.groups[groupId];
}

// 每日重置逻辑
function resetDailyIfNeeded(groupId) {
  const groupData = getGroupData(groupId);
  // 使用香港时间判断日期
  const today = new Date()
    .toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
    .split(' ')[0];

  if (groupData.lastDate !== today) {
    console.log(`[重置计数器] 群组 ${groupId} 新的一天: ${today}`);
    groupData.lastDate = today;
    groupData.counters = {}; // 清空所有楼栋计数
    saveScaffoldingData();
  }
}

// 提取楼栋字母 (A座 -> A, Blk A -> A, 默认 -> Z)
function extractBuildingLetter(text = '') {
  const patterns = [
    /([A-Za-z])[座棟]/ // A座, A棟
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return 'Z'; // 默认回落
}

// 生成申请编号 (核心逻辑)
function generateApplicationId(text, groupId) {
  resetDailyIfNeeded(groupId);
  const groupData = getGroupData(groupId);
  const building = extractBuildingLetter(text);

  // 初始化该楼栋计数
  if (!groupData.counters[building]) groupData.counters[building] = 0;

  // 自增 (即使删除也不回退，符合需求)
  groupData.counters[building]++;

  const seq = groupData.counters[building];
  const appId = `${building}${seq}`;

  saveScaffoldingData();
  return appId;
}

// 初始化加载
loadScaffoldingData();

module.exports = {
  generateApplicationId,
  resetDailyIfNeeded
};


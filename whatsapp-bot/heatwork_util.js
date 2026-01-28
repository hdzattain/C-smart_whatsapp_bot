const fs = require('fs-extra');
const path = require('path');

// === 火纸专用核心工具：独立存储文件 ===
const DATA_FILE = path.join(__dirname, 'data', 'hotwork_applications.json');
fs.ensureDirSync(path.dirname(DATA_FILE));

let hotworkData = { groups: {} };

// 加载数据
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            hotworkData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        } catch (e) {
            console.warn('加载火纸计数器失败，初始化为空');
        }
    }
}

// 保存数据
function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(hotworkData, null, 2));
    } catch (e) {
        console.error('保存火纸计数器失败', e);
    }
}

// 获取群组数据
function getGroupData(groupId) {
    if (!hotworkData.groups[groupId]) {
        hotworkData.groups[groupId] = {
            lastDate: null,
            counters: {},
            mappings: {}
        };
    }
    return hotworkData.groups[groupId];
}

// 每日重置逻辑
function resetIfNeeded(groupId) {
    const groupData = getGroupData(groupId);
    const today = new Date()
        .toLocaleString('sv-SE', { timeZone: 'Asia/Hong_Kong' })
        .split(' ')[0];

    if (groupData.lastDate !== today) {
        console.log(`[火纸重置] 群组 ${groupId} 新的一天: ${today}`);
        groupData.lastDate = today;
        groupData.counters = {};
        groupData.mappings = {};
        saveData();
    }
}

// 提取楼栋字母
function extractBuildingLetter(text = '') {
    const locationLine = String(text).split(/\r?\n/).find(line => line.includes('位置'));
    if (!locationLine) return 'Z';
    const cleaned = locationLine.replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '');
    const bIndex = cleaned.search(/[Bb]/i);
    if (bIndex !== -1) {
        const afterB = cleaned.substring(bIndex);
        const kIndex = afterB.search(/[Kk]/i);
        if (kIndex !== -1) {
            const afterBlk = afterB.substring(kIndex + 1);
            const letterMatch = afterBlk.match(/[A-Za-z]/);
            if (letterMatch) return letterMatch[0].toUpperCase();
        }
    }
    const firstLetterMatch = cleaned.match(/[A-Za-z]/);
    if (firstLetterMatch) return firstLetterMatch[0].toUpperCase();
    return 'Z';
}

// 生成申请编号
function generateApplicationId(text, groupId, longAppId = null) {
    resetIfNeeded(groupId);
    const groupData = getGroupData(groupId);

    if (longAppId && groupData.mappings[longAppId]) {
        return groupData.mappings[longAppId];
    }

    const building = extractBuildingLetter(text);
    if (!groupData.counters[building]) groupData.counters[building] = 0;

    let shortId;
    let isUnique = false;
    const existingValues = new Set(Object.values(groupData.mappings));

    while (!isUnique) {
        groupData.counters[building]++;
        const seq = groupData.counters[building];
        shortId = `${building}${seq}`;
        if (!existingValues.has(shortId)) {
            isUnique = true;
        }
    }

    if (longAppId) groupData.mappings[longAppId] = shortId;
    saveData();
    return shortId;
}

// 查询短码
function getShortCode(longAppId, groupId) {
    resetIfNeeded(groupId);
    const groupData = getGroupData(groupId);
    return groupData.mappings[longAppId] || null;
}

loadData();

module.exports = {
    generateApplicationId,
    getShortCode
};

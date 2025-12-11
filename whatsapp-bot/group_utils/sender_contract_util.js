// sender_contract_util.js
require('dotenv').config();
const fs = require('fs');
const { appendLog } = require('../group_utils/bot_logger_util');

// 定义发送人类型常量
const SENDER_TYPES = {
  CSG_SAFETY: 1,    // 中建安全部
  CSG_CONSTRUCT: 2, // 中建施工部
  OTHER: 3          // 其他
};

// 修改为 let 声明以便重新赋值
let CSG_SAFETY_PHONES = process.env.CSG_SAFETY_PHONES ? process.env.CSG_SAFETY_PHONES.split(',') : [];
let CSG_CONSTRUCT_PHONES = process.env.CSG_CONSTRUCT_PHONES ? process.env.CSG_CONSTRUCT_PHONES.split(',') : [];

// ... 其他代码 ...

function refreshPhoneLists() {
  try {
    // 强制重新加载 .env 文件
    require('dotenv').config({ override: true });

    // 更新电话号码列表
    CSG_SAFETY_PHONES = process.env.CSG_SAFETY_PHONES ?
      process.env.CSG_SAFETY_PHONES.split(',').map(phone => phone.trim()).filter(phone => phone) : [];
    CSG_CONSTRUCT_PHONES = process.env.CSG_CONSTRUCT_PHONES ?
      process.env.CSG_CONSTRUCT_PHONES.split(',').map(phone => phone.trim()).filter(phone => phone) : [];

    console.log('已刷新电话号码列表:');
    appendLog('default', '已刷新电话号码列表');
    console.log('安全部电话:', CSG_SAFETY_PHONES);
    appendLog('default', `安全部电话: ${JSON.stringify(CSG_SAFETY_PHONES)}`);
    console.log('施工部电话:', CSG_CONSTRUCT_PHONES);
    appendLog('default', `施工部电话: ${JSON.stringify(CSG_CONSTRUCT_PHONES)}`);
  } catch (error) {
    console.error('刷新配置时发生错误:', error.message);
  }
}

/**
 * 判断消息发送人的电话号码类型
 * @param {string} phoneNumber - 发送人的电话号码
 * @param {string} groupId - WhatsApp 群组 ID
 * @returns {number} 1: 中建安全部, 2: 中建施工部, 3: 其他
 */
function getSenderType(phoneNumber, groupId) {
  try {
    // 清理电话号码，去除空格和特殊字符
    const cleanNumber = phoneNumber ? phoneNumber.replace(/\s+/g, '').replace(/[-()\s]/g, '') : '';

    if (!cleanNumber) return SENDER_TYPES.OTHER;

    // 检查是否在中建安全部电话列表中
    if (Array.isArray(CSG_SAFETY_PHONES) && CSG_SAFETY_PHONES.some(safetyPhone =>
      safetyPhone === cleanNumber)) {
      return SENDER_TYPES.CSG_SAFETY;
    }

    // 检查是否在中建施工部电话列表中
    if (Array.isArray(CSG_CONSTRUCT_PHONES) && CSG_CONSTRUCT_PHONES.some(constructPhone =>
      constructPhone === cleanNumber)) {
      return SENDER_TYPES.CSG_CONSTRUCT;
    }

    return SENDER_TYPES.OTHER;
  } catch (error) {
    // 发生异常时统一返回其他类型
    console.error(`群组id: ${groupId}, 发送人电话: ${phoneNumber}， 判断发送人类型时发生异常: ${error.message}`);
    appendLog(groupId, `发送人手机号: ${phoneNumber}, 判断发送人类型时发生异常： ${error.message}`);
    return SENDER_TYPES.OTHER;
  }
}

// 监听 .env 文件变化
fs.watch('.env', (eventType, filename) => {
  if (eventType === 'change') {
    console.log('检测到 .env 文件变化，正在刷新配置...');
    refreshPhoneLists();
  }
}).on('error', (error) => {
  console.error('监听 .env 文件时发生错误:', error.message);
});

module.exports = {
  SENDER_TYPES,
  getSenderType
};
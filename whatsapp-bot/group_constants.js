// 群组ID定义
const GROUP_ID = '120363418441024423@g.us'; // PTW LiftShaft TEST
const GROUP_ID_2 = '120363400601106571@g.us'; // TEST_C-Smart_Bot
const GROUP_ID_3 = '120363030675916527@g.us'; // 啟德醫院 B 𨋢膽第一線
const GROUP_ID_4 = '120363372181860061@g.us'; // 啟德醫院 Site 🅰 外牆棚架工作
const GROUP_ID_5 = '120363401312839305@g.us'; // 啟德醫院🅰️Core/打窿工序通知群組
const GROUP_ID_6 = '120363162893788546@g.us'; // 啓德醫院BLW🅰️熱工序及巡火匯報群組
const GROUP_ID_7 = '120363283336621477@g.us'; //  啟德醫院 🅰️𨋢膽台
const GROUP_ID_8 = '120363423214854498@g.us'; // 打窿工序测试群组
const GROUP_ID_9 = '120363420660094468@g.us'; // 牆棚架工作测试群组
const GROUP_ID_10 = '120363423057141205@g.us'; // 熱工序及巡火匯報测试群组

// 打窿群组定义
const DRILL_GROUPS = [
  GROUP_ID_5,
  GROUP_ID_8
];

// 外墙棚架群组定义
const EXTERNAL_SCAFFOLDING_GROUPS = [
  GROUP_ID_2,
  GROUP_ID_4,
  GROUP_ID_9
];

// 完全静默群组配置
const BLACKLIST_GROUPS = [
  GROUP_ID_5,
  GROUP_ID_6
];

// 错误缺失提醒群组配置
const ERROR_REPLY_GROUPS = [
  GROUP_ID_2
];

const HEAT_WORK_GROUPS = [
  GROUP_ID_6,
  GROUP_ID_10
];

module.exports = {
  GROUP_ID,
  GROUP_ID_2,
  GROUP_ID_3,
  GROUP_ID_4,
  GROUP_ID_5,
  GROUP_ID_6,
  GROUP_ID_7,
  GROUP_ID_8,
  GROUP_ID_9,
  DRILL_GROUPS,
  EXTERNAL_SCAFFOLDING_GROUPS,
  BLACKLIST_GROUPS,
  ERROR_REPLY_GROUPS,
  HEAT_WORK_GROUPS
};



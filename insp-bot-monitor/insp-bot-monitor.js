require('dotenv').config();
const axios = require('axios');

const CONFIG = {
    WEBHOOKS: process.env.WEBHOOKS ? process.env.WEBHOOKS.split(',').map(s => s.trim()) : [],
    HEALTH_URL: 'http://localhost:3080/health',
    BOMB_INTERVAL: 2 * 60 * 1000, // 2分钟轰炸一次
    CHECK_INTERVAL: 20 * 1000     // 20秒检查一次
};

let firstAlertTime = 0; // 记录故障开始的时间（用于计算总时长）
let lastAlertTime = 0;  // 记录最近一次发送的时间（用于控制频率）

async function doBomb(title, content, duration) {
    const cardBody = {
        msg_type: "interactive",
        card: {
            header: {
                title: { tag: "plain_text", content: `🚨紧急: ${title}` },
                template: "red"
            },
            elements: [
                {
                    tag: "div",
                    text: {
                        tag: "lark_md",
                        content: `**<font color='red'>WA状态报警</font>**\n\n**异常情况：** ${content}\n**已持续：** <font color='red'>${duration}</font>\n**解决办法：** 请立即登录服务器执行：\n\`journalctl -u wa-bot -f\``
                    }
                },
                { tag: "hr" },
                { tag: "div", text: { tag: "lark_md", content: "<at id=all></at>" } }
            ]
        }
    };

    for (const url of CONFIG.WEBHOOKS) {
        try { await axios.post(url, cardBody); } catch (e) { console.error('推送失败'); }
    }
    lastAlertTime = Date.now(); // 更新最近发送时间
}

setInterval(async () => {
    try {
        const res = await axios.get(CONFIG.HEALTH_URL, { timeout: 3000 });
        const currentStatus = res.data.status;

        if (currentStatus === 'QR_NEEDED' || currentStatus === 'DISCONNECTED') {
            const now = Date.now();
            
            // 首次发现异常，初始化起始时间
            if (firstAlertTime === 0) {
                firstAlertTime = now;
            }

            // 检查是否达到轰炸间隔
            if (lastAlertTime === 0 || (now - lastAlertTime) >= CONFIG.BOMB_INTERVAL) {
                // 计算总掉线时间：当前时间 - 故障开始时间
                const totalMinutes = ((now - firstAlertTime) / 60000).toFixed(0);
                const durationText = totalMinutes === "0" ? "刚刚开始" : `${totalMinutes} 分钟`;
                
                await doBomb("C-smart多功能机器人掉线，业务中断！", "机器人检测到登录失效，正在等待扫码重登。", durationText);
            }
        } else if (currentStatus === 'READY') {
            // 状态恢复正常，全部重置
            if (firstAlertTime !== 0) {
                console.log("状态恢复正常，清空计时器。");
                firstAlertTime = 0;
                lastAlertTime = 0;
            }
        }
    } catch (e) {
        // 接口不通（进程崩溃）也按同样逻辑计时
        const now = Date.now();
        if (firstAlertTime === 0) firstAlertTime = now;
        
        if (lastAlertTime === 0 || (now - lastAlertTime) >= CONFIG.BOMB_INTERVAL) {
            const totalMinutes = ((now - firstAlertTime) / 60000).toFixed(0);
            await doBomb("C-smart多功能机器人主进程崩溃！", "接口无法访问，请检查服务器进程状态。", `${totalMinutes} 分钟`);
        }
    }
}, CONFIG.CHECK_INTERVAL);
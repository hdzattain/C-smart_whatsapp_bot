/**
 * FastGPT 独立客户端
 * 从 insp_bot.js 提取的 FastGPT 调用功能
 */

const axios = require('axios');

// ========== FastGPT 客户端类 ==========
class FastGPTClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.url = options.url || '';
    this.chatId = options.chatId || 'default';

    if (!this.apiKey) throw new Error('未提供 FastGPT API key');
    if (!this.url) throw new Error('未提供 FastGPT URL');

    // 日志函数（可选）
    this.logger = options.logger || ((user, message) => {
      console.log(`[FastGPT] [${user || 'default'}] ${message}`);
    });
  }

  /**
   * 从 FastGPT 返回数据中提取“最终输出文本”。
   * 兼容两类结构：
   * - OpenAI 风格：{ choices: [{ message: { content: "..." } }] }
   * - FastGPT workflow 风格：{ responseData: [{ pluginOutput: { output: "..." } }, ...] }
   *   也可能在中间节点：{ extractResult: { output: "..." } }
   */
  _extractTextFromResponse(data) {
    // 1) 标准 choices.content
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content;

    // 2) workflow responseData（优先 pluginOutput.output；否则 extractResult.output）
    const resp = data?.responseData;
    if (Array.isArray(resp)) {
      for (let i = resp.length - 1; i >= 0; i--) {
        const item = resp[i];
        const po = item?.pluginOutput?.output;
        if (typeof po === 'string' && po.trim()) return po;
      }
      for (let i = resp.length - 1; i >= 0; i--) {
        const item = resp[i];
        const eo = item?.extractResult?.output;
        if (typeof eo === 'string' && eo.trim()) return eo;
      }
    }

    // 3) 少数情况下可能直接返回 { pluginOutput: { output } }
    const directPo = data?.pluginOutput?.output;
    if (typeof directPo === 'string' && directPo.trim()) return directPo;

    // 4) 或直接返回 { output: "..." }
    const out = data?.output;
    if (typeof out === 'string' && out.trim()) return out;

    return null;
  }

  // ========== 公共 POST + 重试函数 ==========
  async _postToFastGPT(data, user) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await axios.post(this.url, data, {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 100000 // 100s 超时
        });
        console.log(`[LOG] FastGPT 返回数据: ${JSON.stringify(res.data)}`);
        const text = this._extractTextFromResponse(res.data);
        if (!text) throw new Error('FastGPT 返回数据中缺少可用输出字段（content/pluginOutput.output/extractResult.output）');
        return text;
      } catch (err) {
        lastErr = err;
        const msg = (err.message || '') + (err.code ? ' ' + err.code : '');
        console.log('[ERR] FastGPT 请求失败:', msg);
        if (
          (msg.includes('aborted') || msg.includes('stream') || msg.includes('ECONNRESET') || msg.includes('ERR_BAD_RESPONSE')) &&
          i < 2
        ) {
          console.log(`FastGPT 请求断流，正在第${i + 1}次重试...`);
          this.logger(user, `FastGPT 请求断流，正在第${i + 1}次重试...`);
          await new Promise(res => setTimeout(res, 1200 * (i + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // ========== Messages 构建 Helper（支持文本 + 多图 + variables） ==========
  buildMessages(contentParts, variables = {}) {
    const content = contentParts.map(part => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image_url') return { type: 'image_url', image_url: { url: part.url } };
      throw new Error(`不支持的 type: ${part.type}`);
    });
    const data = {
      chatId: this.chatId,
      stream: false,
      detail: false,
      messages: [{ role: 'user', content }]
    };
    // 如果有 variables，添加到请求中
    if (Object.keys(variables).length > 0) {
      data.variables = variables;
    }
    return data;
  }

  // ========== 纯文本调用（支持 variables） ==========
  async sendToFastGPT({ query, user, variables = {} }) {
    const contentParts = [{ type: 'text', text: query }];
    const data = this.buildMessages(contentParts, variables);
    return this._postToFastGPT(data, user);
  }

  // ========== 图文混合调用（支持 variables） ==========
  async sendToFastGPTWithMedia({ query, images = [], user, variables = {} }) {
    const contentParts = [{ type: 'text', text: query }];
    images.forEach(url => contentParts.push({ type: 'image_url', url }));
    const data = this.buildMessages(contentParts, variables);
    return this._postToFastGPT(data, user);
  }
}

// ========== 导出 ==========
module.exports = FastGPTClient;

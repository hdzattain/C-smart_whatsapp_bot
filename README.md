# C-smart_whatsapp_bot
# V0.0
Based on dify, fastGPT, flask, whatsapp-web.js, a chat agent for whatsapp group messages collections, with the MySQL integrated.

Whatsapp-bot unofficially implement, no related to the authority of Whatsapp.

public contribution is welcome.everyone could use this code for uncommercial purpose.
# V0.1
Add Wechaty to support wechat group bot

## LangChain ACE 模块

新增的 `ace` 包实现了一个基于 LangChain 的 ACE（Align、Critique、Evolve）工作流：

- **生成器**：可接入任意 `Runnable`/链式 LangChain 模型，根据最新的动态 Playbook 和用户输入生成候选回复。
- **打分模型**：通过第二个 LangChain 模型对回复进行评分，ACE 会在分数低于阈值时触发反思与二次生成。
- **反思模型**：利用第三个模型输出改进建议，指导生成器迭代优化。所有反思记录都会写入 Playbook，便于持续学习。
- **动态 Playbook**：`Playbook` 类以 JSON 形式记录每次交互的提示-回复对、评分、反思与人工备注，既可自动更新，也支持人工强制纠偏。

通过 `ACEEngine` 可以不断利用用户输入与模型生成的语料构建数据对，导出为轻量训练样本，实现无需 GPU 的持续迭代。示例：

```python
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from ace import ACEEngine, Playbook

# 定义三个模型
prompt = ChatPromptTemplate.from_messages([
    ("system", "你是一名专注施工许可的助手"),
    ("human", "{input}\n\n现有经验：{playbook}\n\n反思：{reflection}"),
])
llm = ChatOpenAI(model="gpt-3.5-turbo")
parser = StrOutputParser()

generator = prompt | llm | parser
scorer = ChatOpenAI(model="gpt-3.5-turbo")
reflector = ChatOpenAI(model="gpt-3.5-turbo")

engine = ACEEngine(generator, scorer, reflector, playbook=Playbook("data/ace_playbook.json"))
result = engine.process_interaction("申请外墙棚架施工许可需要哪些资料？")
print(result["response"], result["score"])
```

人工可通过 `record_feedback`/`force_correction` 手动修正 Playbook，实现 "失败可人工干预" 的闭环。

### 多模型接入

ACE 模块现在内置了 DeepSeek-Chat、Ollama 本地模型以及 HuggingFace Inference API 的快速接入。使用 `ModelConfig` 即可在不同模型之间切换，无需重写链路：

```python
from ace import ACEEngine, ModelConfig, Playbook

generator_cfg = ModelConfig(
    provider="deepseek-chat",
    model="deepseek-chat",
    options={"temperature": 0.2, "api_key": "<DEEPSEEK_API_KEY>"},
)
scorer_cfg = ModelConfig(
    provider="ollama",
    model="mistral",
    options={"base_url": "http://localhost:11434"},
)
reflector_cfg = ModelConfig(
    provider="huggingface",
    model="mistralai/Mixtral-8x7B-Instruct-v0.1",
    options={"api_key": "<HUGGINGFACEHUB_API_TOKEN>"},
)

engine = ACEEngine.from_model_configs(
    generator_cfg,
    scorer_cfg,
    reflector_cfg,
    playbook=Playbook("data/ace_playbook.json"),
)
result = engine.process_interaction("最新的安全文明施工规范有哪些更新？")
print(result)
```

- **DeepSeek-Chat**：需要提供 `DEEPSEEK_API_KEY`，默认云端推理。
- **Ollama**：确保本地 `ollama` 服务已启动，可通过 `base_url` 指定地址。
- **HuggingFace API**：传入 `api_key`（或预设 `HUGGINGFACEHUB_API_TOKEN` 环境变量）即可调用任意开放模型。

如需自定义提示词，可在 `ModelConfig.messages` 中传入 LangChain `ChatPromptTemplate` 所需的消息列表，进一步定制提示风格。

### 服务化部署与配置

为了方便在不同机器人或业务系统中复用，现在可以把 ACE 模块作为独立 HTTP 服务运行：

- 使用 `ace.service.create_app` 构建 Flask 应用，提供 `/ACE/*` API。
- 服务启动时读取 JSON/YAML 配置文件（示例：`ace/config.example.json`），支持通过 `${ENV_NAME}` 扩展环境变量，用于设置不同模型的 `API_KEY`、`base_url` 等参数。
- 提示词文件（例如 `ace/prompts/generator_prompt.json`）可以随时修改，也可通过配置接口热更新，便于 UI 工具对提示词和 Playbook 进行维护。

#### 配置文件

```json
{
  "generator": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "options": {"api_key": "${DEEPSEEK_API_KEY}"},
    "prompt_path": "ace/prompts/generator_prompt.json"
  },
  "scorer": {
    "provider": "huggingface",
    "model": "your-scorer-model",
    "prompt_path": "ace/prompts/scorer_prompt.json"
  },
  "reflector": {
    "provider": "ollama",
    "model": "llama2",
    "options": {"base_url": "http://localhost:11434"},
    "prompt_path": "ace/prompts/reflector_prompt.json"
  },
  "playbook_path": "data/ace_playbook.json",
  "min_score": 0.75,
  "max_reflection_steps": 3
}
```

将文件保存为 `ace_service_config.json` 后即可通过 `python -m ace.server --config ace_service_config.json` 启动。修改配置或提示词文件后，可通过 `POST /ACE/config/reload` 热重载。

#### HTTP API

| 方法 | 路径 | 描述 |
| ---- | ---- | ---- |
| GET  | `/ACE/health` | 健康检查 |
| GET  | `/ACE/config` | 查看当前生效配置 |
| PUT  | `/ACE/config` | 局部或整体更新配置（支持只更新 options/提示词路径），可通过 `persist=false` 禁止写回磁盘 |
| POST | `/ACE/config/reload` | 从磁盘重新加载配置 |
| POST | `/ACE/chat` | 调用 ACE 流程生成回复并更新 Playbook |

`POST /ACE/chat` 支持在请求体中指定提示词文件和 Playbook 路径：

```bash
curl -X POST http://localhost:8000/ACE/chat \
  -H "Content-Type: application/json" \
  -d '{
        "user_input": "hello, this is example input",
        "generator_prompt": "ace/prompts/generator_prompt.json",
        "curator_prompt": "ace/prompts/scorer_prompt.json",
        "reflector_prompt": "ace/prompts/reflector_prompt.json",
        "playbook": "data/ace_playbook.json"
      }'
```

返回结构体包含模型回复、评分、反思以及 Playbook entry 的 ID：

```json
{
  "response": "...",
  "score": 0.82,
  "reflections": ["..."],
  "status": "accepted",
  "entry_id": "...",
  "playbook_path": "data/ace_playbook.json"
}
```

#### 与 WhatsApp 机器人集成

在 `whatsapp-bot/bot.js` 中可以直接向本地 ACE 服务发起请求，将机器人输入和所需提示词路径传给 `/ACE/chat` 并依据返回的 JSON 决定最终发送的消息：

```javascript
const axios = require('axios');

async function callAce(userMessage) {
  const { data } = await axios.post('http://localhost:8000/ACE/chat', {
    user_input: userMessage,
    generator_prompt: 'ace/prompts/generator_prompt.json',
    curator_prompt: 'ace/prompts/scorer_prompt.json',
    reflector_prompt: 'ace/prompts/reflector_prompt.json',
    playbook: 'data/ace_playbook.json'
  });
  return data;
}
```

如此一来，不同项目只需调整配置文件和提示词路径，即可复用同一个 ACE 服务实例，实现多项目共享、按需复制的效果。

#### Docker 部署

仓库提供了 `ace/Dockerfile`，用于封装独立的 ACE 服务镜像：

```bash
docker build -f ace/Dockerfile -t ace-service .
docker run -p 8000:8000 -v $(pwd)/ace_service_config.json:/app/config.json \
  -v $(pwd)/data:/app/data \
  ace-service --config /app/config.json
```

通过挂载配置文件和数据目录，可以在不重新打包镜像的情况下调整 API Key、提示词或 Playbook。

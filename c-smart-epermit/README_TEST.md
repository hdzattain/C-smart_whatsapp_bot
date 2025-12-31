# C-Smart PTW API Server 研發流程与测试指引

为了确保代码的健壮性和逻辑的正确性（特别是复杂的 SQL 匹配逻辑），本作引入了 LLT（Low Level Test）单元测试流程。

## 1. 测试环境准备

在运行测试之前，请确保已安装以下 Python 依赖：

```bash
pip install flask pymysql pytz python-dateutil unittest
```

## 2. 运行单元测试

测试脚本位于 `c-smart-epermit/crud_sql_apiserver_test.py`。该测试通过 Mock 数据库连接，模拟了真实 API 请求，并在不真实连接数据库的情况下验证 SQL 生成逻辑。

**执行命令：**

```bash
cd c-smart-epermit
python crud_sql_apiserver_test.py
```

**预期输出：**

```text
Ran 4 tests in 0.0xxs
OK
```

## 3. 楼层归一化匹配逻辑说明

本项目针对工人发送模板不规范（如楼层字段使用 `3---4/F`）的问题，在 API 层实现了“语义匹配”逻辑：

- **归一化规则**：
  1. 移除所有空格。
  2. 将中文逗号 `、` `，` 统一化为标准逗号 `,`。
  3. 将一个或多个连续的横线（包括 `-`, `—`, `–`, `−`, `－`）统一化为**单个标准逗号** `,`。

- **匹配示例**：
  - `3---4/F`  => `3,4/F`
  - `3-4/F`    => `3,4/F` (匹配成功 ✅)
  - `34/F`     => `34/F`   (区分成功 ✅，不会混淆)

## 4. 研发规范

1. **修改逻辑前先跑测试**：在修改 `crud_sql_apiserver.py` 的核心逻辑（尤其是 SQL 部分）前，请务必先运行一遍单元测试。
2. **新增功能同步新增测试**：若新增了 API 路由，请在 `crud_sql_apiserver_test.py` 中添加对应的测试用例。
3. **保持 SQL 容错性**：涉及到位置、楼层、分判商名称等用户手动输入的字段，应优先考虑使用 SQL 函数进行标准化匹配，而非精确匹配。

---
*Created by Antigravity AI - 2025-12-31*

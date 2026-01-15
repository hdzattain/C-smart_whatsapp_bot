import os
import sys
import warnings
import json
import time
import random
import string
import threading
from dotenv import load_dotenv
import lark_oapi as lark
from lark_oapi.api.contact.v3 import GetUserRequest
import requests

# 确保 print 输出立即刷新到 journalctl
def log_print(*args, **kwargs):
    """带立即刷新的 print，确保日志能被 journalctl 实时捕获"""
    print(*args, **kwargs, flush=True)

# 过滤 pkg_resources 弃用警告
warnings.filterwarnings("ignore", category=UserWarning, module="pkg_resources")

# 加载 .env 文件
load_dotenv()

# 配置信息
APP_ID = os.getenv("APP_ID")
APP_SECRET = os.getenv("APP_SECRET")
FASTGPT_URL = os.getenv("FASTGPT_URL", "")
FASTGPT_API_KEY = os.getenv("FASTGPT_API_KEY", "")

# 创建 Lark 客户端（用于获取用户信息）
def create_lark_client():
    return lark.Client.builder() \
        .app_id(APP_ID) \
        .app_secret(APP_SECRET) \
        .log_level(lark.LogLevel.INFO) \
        .build()

# 获取用户信息（通过 user_id）
def get_user_email(user_id: str) -> str:
    """通过 user_id 获取用户邮箱"""
    log_print(f"[日志] ========== 开始获取用户邮箱 ==========")
    log_print(f"[日志] 用户ID: {user_id}")
    try:
        log_print(f"[日志] 创建 Lark 客户端...")
        client = create_lark_client()
        
        log_print(f"[日志] 构建 GetUserRequest 请求...")
        request = GetUserRequest.builder() \
            .user_id(user_id) \
            .user_id_type("user_id") \
            .department_id_type("open_department_id") \
            .build()
        
        log_print(f"[日志] 调用 contact.v3.user.get API...")
        response = client.contact.v3.user.get(request)
        
        log_print(f"[日志] API 调用完成，检查响应状态...")
        if not response.success():
            log_print(f"[错误] 获取用户信息失败: code={response.code}, msg={response.msg}")
            log_print(f"[错误] 响应详情: {lark.JSON.marshal(response, indent=2)}")
            return None
        
        log_print(f"[成功] contact.v3.user.get 调用成功")
        log_print(f"[日志] 解析响应数据...")
        user_data = response.data.user
        log_print(f"[日志] 用户数据对象: {type(user_data)}")
        
        # 获取邮箱（优先使用 primary_email，如果没有则使用 email）
        log_print(f"[日志] 尝试提取 primary_email...")
        primary_email = getattr(user_data, 'primary_email', None)
        log_print(f"[日志] primary_email: {primary_email}")
        
        if not primary_email:
            log_print(f"[日志] primary_email 为空，尝试提取 email...")
            email = getattr(user_data, 'email', None)
            log_print(f"[日志] email: {email}")
        else:
            email = primary_email
        
        if not email:
            log_print(f"[警告] 用户 {user_id} 没有邮箱信息")
            log_print(f"[日志] 用户数据所有属性: {dir(user_data)}")
            return None
        
        log_print(f"[成功] ========== 成功提取用户邮箱 ==========")
        log_print(f"[成功] 用户ID: {user_id}")
        log_print(f"[成功] 用户邮箱: {email}")
        return email
    except Exception as e:
        log_print(f"[错误] 获取用户邮箱异常: {e}")
        import traceback
        log_print(f"[错误] 异常堆栈: {traceback.format_exc()}")
        return None

# 生成随机 chatId
def generate_random_chat_id():
    return ''.join(random.choices(string.ascii_letters + string.digits, k=32))

# 调用 FastGPT
def call_fastgpt(query: str, email_account: str):
    """调用 FastGPT API"""
    log_print(f"[日志] ========== 开始调用 FastGPT ==========")
    log_print(f"[日志] query: {query}")
    log_print(f"[日志] email_account: {email_account}")
    
    if not FASTGPT_URL or not FASTGPT_API_KEY:
        log_print("[错误] 缺少 FastGPT 配置：FASTGPT_URL 或 FASTGPT_API_KEY")
        log_print(f"[错误] FASTGPT_URL: {FASTGPT_URL[:50] if FASTGPT_URL else '未设置'}...")
        log_print(f"[错误] FASTGPT_API_KEY: {'已设置' if FASTGPT_API_KEY else '未设置'}")
        return None
    
    try:
        log_print(f"[日志] 生成随机 chatId...")
        chat_id = generate_random_chat_id()
        log_print(f"[日志] chatId: {chat_id}")
        
        data = {
            "chatId": chat_id,
            "stream": False,
            "detail": False,
            "messages": [{
                "role": "user",
                "content": [{"type": "text", "text": query}]
            }],
            "variables": {
                "email_account": email_account
            }
        }
        
        headers = {
            "Authorization": f"Bearer {FASTGPT_API_KEY}",
            "Content-Type": "application/json"
        }
        
        log_print(f"[日志] 请求数据: {json.dumps(data, indent=2, ensure_ascii=False)}")
        log_print(f"[日志] 请求URL: {FASTGPT_URL}")
        
        # 重试逻辑（最多3次）
        last_err = None
        for i in range(3):
            try:
                attempt_num = i + 1
                log_print(f"[日志] ========== FastGPT 请求 (第 {attempt_num} 次尝试) ==========")
                log_print(f"[日志] 发送 POST 请求到 FastGPT...")
                
                response = requests.post(
                    FASTGPT_URL,
                    json=data,
                    headers=headers,
                    timeout=100
                )
                
                log_print(f"[日志] HTTP 状态码: {response.status_code}")
                response.raise_for_status()
                
                log_print(f"[日志] 解析响应JSON...")
                result = response.json()
                log_print(f"[FastGPT] 返回数据: {json.dumps(result, indent=2, ensure_ascii=False)}")
                
                log_print(f"[日志] 提取 content 字段...")
                content = result.get("choices", [{}])[0].get("message", {}).get("content")
                if not content:
                    raise ValueError("FastGPT 返回数据中缺少 content 字段")
                
                log_print(f"[成功] ========== FastGPT 调用成功 ==========")
                log_print(f"[成功] 结果长度: {len(content)} 字符")
                log_print(f"[成功] 结果前100字符: {content[:100]}...")
                return content
            except Exception as err:
                last_err = err
                err_msg = str(err)
                log_print(f"[错误] FastGPT 请求失败 (第 {attempt_num} 次尝试): {err_msg}")
                import traceback
                log_print(f"[错误] 异常堆栈: {traceback.format_exc()}")
                
                # 如果是网络错误且未达到最大重试次数，则重试
                if (any(keyword in err_msg.lower() for keyword in ['aborted', 'stream', 'econnreset', 'bad response']) 
                    and i < 2):
                    wait_time = 1.2 * (i + 1)
                    log_print(f"[日志] 请求断流，正在第{i+1}次重试，等待 {wait_time} 秒...")
                    time.sleep(wait_time)
                    continue
                raise err
        
        raise last_err
    except Exception as e:
        log_print(f"[错误] ========== FastGPT 调用异常 ==========")
        log_print(f"[错误] 异常信息: {e}")
        import traceback
        log_print(f"[错误] 异常堆栈: {traceback.format_exc()}")
        return None

def do_p2_application_bot_menu_v6(data: lark.application.v6.P2ApplicationBotMenuV6) -> None:
    log_print("=" * 60)
    log_print("[回调消息] P2ApplicationBotMenuV6 (机器人菜单事件)")
    log_print("=" * 60)
    log_print(f'完整数据: {lark.JSON.marshal(data, indent=4)}')
    log_print("=" * 60)
    
    # 检查 event_key
    event = data.event
    if not event:
        log_print("[警告] 事件数据中没有 event 字段")
        return
    
    event_key = getattr(event, 'event_key', None)
    if event_key != "read_unseen_emails":
        log_print(f"[信息] 忽略非目标事件: {event_key}")
        return
    
    log_print(f"[处理] 收到 read_unseen_emails 事件")
    
    # 获取用户ID
    operator = getattr(event, 'operator', None)
    if not operator:
        log_print("[错误] 事件中没有 operator 字段")
        return
    
    operator_id = getattr(operator, 'operator_id', None)
    if not operator_id:
        log_print("[错误] operator 中没有 operator_id 字段")
        return
    
    user_id = getattr(operator_id, 'user_id', None)
    if not user_id:
        log_print("[错误] operator_id 中没有 user_id 字段")
        return
    
    log_print(f"[处理] 用户ID: {user_id}")
    
    # 在后台线程中处理，避免阻塞事件处理
    def process_menu_event():
        log_print(f"[日志] ========== 后台线程开始处理菜单事件 ==========")
        log_print(f"[日志] 线程ID: {threading.current_thread().ident}")
        
        # 获取用户邮箱
        log_print(f"[日志] 步骤1: 获取用户邮箱")
        email = get_user_email(user_id)
        if not email:
            log_print("[错误] 无法获取用户邮箱，终止处理")
            log_print(f"[日志] ========== 处理流程终止 ==========")
            return
        
        log_print(f"[日志] 步骤1完成: 成功获取邮箱 {email}")
        
        # 调用 FastGPT
        log_print(f"[日志] 步骤2: 调用 FastGPT")
        result = call_fastgpt("定时自动总结", email)
        if result:
            log_print(f"[成功] ========== 处理流程完成 ==========")
            log_print(f"[成功] FastGPT 调用完成，结果已返回")
        else:
            log_print(f"[失败] ========== 处理流程失败 ==========")
            log_print(f"[失败] FastGPT 调用失败")
    
    # 在后台线程中执行，避免阻塞
    thread = threading.Thread(target=process_menu_event, daemon=True)
    thread.start()
    log_print(f"[处理] 已在后台线程中启动处理流程")

# 注册事件 Register event
event_handler = lark.EventDispatcherHandler.builder("", "") \
    .register_p2_application_bot_menu_v6(do_p2_application_bot_menu_v6) \
    .build()
def main():
    if not APP_ID or not APP_SECRET:
        log_print("错误: 请在 .env 文件中配置 APP_ID 和 APP_SECRET")
        raise ValueError("请在 .env 文件中配置 APP_ID 和 APP_SECRET")
    
    log_print("=" * 60)
    log_print("Lark 菜单服务启动中...")
    log_print(f"APP_ID: {APP_ID[:10]}..." if APP_ID else "APP_ID: 未设置")
    log_print("=" * 60)
    
    # 构建 client Build client
    cli = lark.ws.Client(APP_ID, APP_SECRET,
                         event_handler=event_handler,
                         log_level=lark.LogLevel.DEBUG)
    log_print("事件监听客户端已启动，等待机器人菜单回调消息...")
    # 建立长连接 Establish persistent connection
    cli.start()
if __name__ == "__main__":
    main()
import os
import warnings
from dotenv import load_dotenv
import lark_oapi as lark
from lark_oapi.api.drive.v1 import P2DriveFileBitableRecordChangedV1, SubscribeFileRequest
from lark_oapi.api.bitable.v1 import ListAppTableFieldRequest
import json
from datetime import datetime, timedelta
from pathlib import Path
import threading
import time

# 过滤 pkg_resources 弃用警告
warnings.filterwarnings("ignore", category=UserWarning, module="pkg_resources")

# 加载 .env 文件
load_dotenv()

# 配置信息
APP_ID = os.getenv("APP_ID")
APP_SECRET = os.getenv("APP_SECRET")
VERIFICATION_TOKEN = os.getenv("VERIFICATION_TOKEN", "")
ENCRYPT_KEY = os.getenv("ENCRYPT_KEY", "")

# 多维表格 file_token (app_token，从独立表格链接 base/ 后部分获取)
FILE_TOKEN = "IVUDbMmT0a4CWgsYelmcmbrnnwh"  # 替换为实际值，例如 "bascXXXXXXX"

# 目标表格 ID（可选过滤）
TARGET_TABLE_ID = "tblpuG3THQpAjkE7"

# 日志配置
LOG_DIR = os.getenv("LARK_LOG_DIR", os.path.join(os.path.dirname(__file__), "logs"))
LOG_RETENTION_DAYS = int(os.getenv("LARK_LOG_RETENTION_DAYS", "30"))  # 默认保留30天

# 确保日志目录存在
Path(LOG_DIR).mkdir(parents=True, exist_ok=True)

# ========== 字段映射缓存 ==========
# 缓存结构: { table_id: { field_id -> field_info } }
field_mapping_cache = {}
# 缓存结构: { table_id: { field_id: { option_id -> option_name } } }
option_mapping_cache = {}

# ========== 日志记录 & 老化功能 ==========
def ensure_log_dir(table_id):
    """确保日志目录存在"""
    table_dir = Path(LOG_DIR) / table_id
    table_dir.mkdir(parents=True, exist_ok=True)
    return table_dir

def append_log(table_id, message):
    """按 table_id/日期/xx.log 格式记录日志"""
    try:
        table_dir = ensure_log_dir(table_id)
        date_str = datetime.now().strftime("%Y-%m-%d")
        log_file = table_dir / f"{date_str}.log"
        
        timestamp = datetime.now().isoformat()
        log_entry = f"[{timestamp}] {message}\n"
        
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(log_entry)
    except Exception as e:
        print(f"[错误] 写入日志失败: {e}")

def cleanup_old_logs():
    """清理过期日志文件"""
    try:
        log_path = Path(LOG_DIR)
        if not log_path.exists():
            return
        
        cutoff_date = datetime.now() - timedelta(days=LOG_RETENTION_DAYS)
        deleted_count = 0
        
        # 遍历所有 table_id 目录
        for table_dir in log_path.iterdir():
            if not table_dir.is_dir():
                continue
            
            # 遍历该 table_id 下的所有日志文件
            for log_file in table_dir.glob("*.log"):
                try:
                    # 从文件名提取日期 (格式: YYYY-MM-DD.log)
                    date_str = log_file.stem
                    file_date = datetime.strptime(date_str, "%Y-%m-%d")
                    
                    # 如果文件日期早于截止日期，删除
                    if file_date < cutoff_date:
                        log_file.unlink()
                        deleted_count += 1
                        print(f"[日志清理] 已删除过期日志: {log_file}")
                except (ValueError, OSError) as e:
                    # 文件名格式不正确或删除失败，跳过
                    print(f"[日志清理] 处理文件 {log_file} 时出错: {e}")
                    continue
        
        if deleted_count > 0:
            print(f"[日志清理] 共清理 {deleted_count} 个过期日志文件")
    except Exception as e:
        print(f"[错误] 清理日志失败: {e}")

def start_log_cleanup_scheduler():
    """启动日志清理定时任务（每天凌晨2点执行）"""
    def cleanup_worker():
        while True:
            try:
                # 计算到下一个凌晨2点的时间
                now = datetime.now()
                next_run = now.replace(hour=2, minute=0, second=0, microsecond=0)
                if next_run <= now:
                    next_run += timedelta(days=1)
                
                wait_seconds = (next_run - now).total_seconds()
                print(f"[日志清理] 下次清理时间: {next_run}, 等待 {wait_seconds:.0f} 秒")
                time.sleep(wait_seconds)
                
                # 执行清理
                cleanup_old_logs()
            except Exception as e:
                print(f"[错误] 日志清理任务异常: {e}")
                # 出错后等待1小时再重试
                time.sleep(3600)
    
    # 启动后台线程
    cleanup_thread = threading.Thread(target=cleanup_worker, daemon=True)
    cleanup_thread.start()
    print(f"[日志清理] 日志清理任务已启动，保留 {LOG_RETENTION_DAYS} 天日志")

# ========== 字段映射获取 ==========
def get_field_mapping(table_id, app_token=FILE_TOKEN):
    """获取表格字段映射（field_id -> field_name）并缓存"""
    # 如果缓存中有，直接返回
    if table_id in field_mapping_cache:
        return field_mapping_cache[table_id], option_mapping_cache.get(table_id, {})
    
    try:
        client = (
            lark.Client.builder()
            .app_id(APP_ID)
            .app_secret(APP_SECRET)
            .log_level(lark.LogLevel.INFO)
            .build()
        )
        
        request = ListAppTableFieldRequest.builder() \
            .app_token(app_token) \
            .table_id(table_id) \
            .page_size(500) \
            .build()
        
        response = client.bitable.v1.app_table_field.list(request)
        
        if not response.success():
            print(f"[错误] 获取字段列表失败: code={response.code}, msg={response.msg}")
            print(f"[错误] 响应详情: {response}")
            return {}, {}
        
        # 检查 response.data 是否存在
        if not response.data:
            print(f"[错误] response.data 为 None")
            return {}, {}
        
        print(f"[调试] response.data 类型: {type(response.data)}")
        print(f"[调试] response.data 内容: {response.data}")
        
        # 构建字段映射
        field_map = {}
        option_map = {}
        
        items = getattr(response.data, 'items', None)
        if items is None:
            print(f"[错误] response.data.items 为 None")
            # 尝试直接访问
            try:
                items = response.data.items
            except AttributeError:
                print(f"[错误] response.data 没有 items 属性")
                # 尝试使用 lark.JSON.marshal 查看数据结构
                try:
                    data_str = lark.JSON.marshal(response.data, indent=2)
                    print(f"[调试] response.data 的 JSON 表示: {data_str}")
                except:
                    pass
                return {}, {}
        
        if not isinstance(items, (list, tuple)):
            print(f"[错误] items 不是列表类型: {type(items)}")
            return {}, {}
        
        print(f"[调试] 找到 {len(items)} 个字段")
        
        for item in items:
            field_id = getattr(item, 'field_id', '')
            field_name = getattr(item, 'field_name', '')
            field_type = getattr(item, 'type', 0)
            property_obj = getattr(item, 'property', None)
            
            if field_id and field_name:
                field_map[field_id] = {
                    'name': field_name,
                    'type': field_type,
                    'property': property_obj
                }
            
            # 如果是选项字段，构建选项映射
            if property_obj and hasattr(property_obj, 'options'):
                options = getattr(property_obj, 'options', None)
                if options is not None:
                    # 确保 options 是可迭代的
                    try:
                        option_map[field_id] = {}
                        for opt in options:
                            opt_id = getattr(opt, 'id', '')
                            opt_name = getattr(opt, 'name', '')
                            if opt_id and opt_name:
                                option_map[field_id][opt_id] = opt_name
                    except (TypeError, AttributeError) as e:
                        print(f"[警告] 处理字段 {field_id} 的选项时出错: {e}")
                        # 尝试直接访问属性
                        try:
                            if hasattr(property_obj, 'options') and property_obj.options:
                                for opt in property_obj.options:
                                    opt_id = getattr(opt, 'id', '')
                                    opt_name = getattr(opt, 'name', '')
                                    if opt_id and opt_name:
                                        option_map[field_id][opt_id] = opt_name
                        except Exception as e2:
                            print(f"[警告] 备用方法也失败: {e2}")
        
        # 缓存结果
        field_mapping_cache[table_id] = field_map
        option_mapping_cache[table_id] = option_map
        
        print(f"[字段映射] 已获取表格 {table_id} 的字段映射，共 {len(field_map)} 个字段")
        return field_map, option_map
        
    except Exception as e:
        print(f"[错误] 获取字段映射失败: {e}")
        import traceback
        print(f"[错误] 错误堆栈:")
        traceback.print_exc()
        return {}, {}

def translate_field_value(field_id, field_value, field_map, option_map):
    """翻译字段值（将 option_id 转换为 option_name）"""
    if field_id not in field_map:
        return field_value
    
    field_info = field_map[field_id]
    if not isinstance(field_info, dict):
        return field_value
    
    field_type = field_info.get('type', 0)
    
    # 如果是选项字段（type 3 是单选，type 4 是多选）
    if field_id in option_map and option_map[field_id]:
        opt_map = option_map[field_id]
        
        # 如果是字符串，尝试匹配 option_id
        if isinstance(field_value, str):
            if field_value in opt_map:
                return opt_map[field_value]
        
        # 如果是数组（多选），转换每个选项
        if isinstance(field_value, list):
            translated = []
            for item in field_value:
                if isinstance(item, str) and item in opt_map:
                    translated.append(opt_map[item])
                else:
                    translated.append(item)
            return translated
    
    # 处理日期时间字段（type 5）
    if field_type == 5 and isinstance(field_value, (str, int)):
        # 尝试将时间戳转换为可读格式
        try:
            if isinstance(field_value, str):
                timestamp = int(field_value) / 1000  # 毫秒转秒
            else:
                timestamp = field_value / 1000
            dt = datetime.fromtimestamp(timestamp)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except:
            pass
    
    # 其他类型直接返回原值
    return field_value

def translate_event_data(event_data, table_id):
    """翻译事件数据，将 field_id 转换为 field_name，option_id 转换为 option_name"""
    try:
        # 获取字段映射
        print(f"[翻译] 获取表格 {table_id} 的字段映射...")
        field_map, option_map = get_field_mapping(table_id)
        
        if not field_map:
            print(f"[翻译] 无法获取表格 {table_id} 的字段映射，跳过翻译")
            return None
        
        print(f"[翻译] 字段映射获取成功，共 {len(field_map)} 个字段")
        
        # 安全的深拷贝函数
        def safe_serialize_for_copy(obj):
            """用于深拷贝的序列化函数"""
            if isinstance(obj, (str, int, float, bool, type(None))):
                return obj
            elif isinstance(obj, dict):
                return {k: safe_serialize_for_copy(v) for k, v in obj.items()}
            elif isinstance(obj, (list, tuple)):
                return [safe_serialize_for_copy(item) for item in obj]
            else:
                # 对于无法序列化的对象，尝试转换为字符串或字典
                try:
                    if hasattr(obj, '__dict__'):
                        return safe_serialize_for_copy(obj.__dict__)
                    else:
                        return str(obj)
                except:
                    return str(obj)
        
        # 深拷贝事件数据
        print(f"[翻译] 开始深拷贝事件数据...")
        translated = safe_serialize_for_copy(event_data)
        
        # 处理 action_list 中的字段
        if 'event' in translated and 'action_list' in translated['event']:
            print(f"[翻译] 处理 action_list，共 {len(translated['event']['action_list'])} 个动作")
            for idx, action_item in enumerate(translated['event']['action_list']):
                action = action_item.get('action', 'unknown')
                
                # 处理 after_value（record_added 和 record_updated）
                if 'after_value' in action_item:
                    translated_fields = {}
                    print(f"[翻译] 处理动作 {idx+1} ({action})，共 {len(action_item['after_value'])} 个字段")
                    for field_item in action_item['after_value']:
                        field_id = field_item.get('field_id', '')
                        field_value = field_item.get('field_value', None)
                        field_identity_value = field_item.get('field_identity_value', None)
                        
                        # 获取字段名
                        field_info = field_map.get(field_id, {})
                        if isinstance(field_info, dict):
                            field_name = field_info.get('name', field_id)
                        else:
                            field_name = field_id
                        
                        # 优先使用 field_identity_value，否则使用 field_value
                        value_to_translate = field_identity_value if field_identity_value else field_value
                        
                        # 如果是复杂对象（如用户字段），直接使用 field_identity_value
                        if field_identity_value and isinstance(field_identity_value, dict):
                            # 对于用户字段等复杂类型，直接使用 field_identity_value
                            translated_fields[field_name] = value_to_translate
                        else:
                            # 翻译字段值（选项字段等）
                            translated_value = translate_field_value(field_id, value_to_translate, field_map, option_map)
                            translated_fields[field_name] = translated_value
                    
                    # 添加翻译后的字段（保留原始 after_value）
                    action_item['translated_fields'] = translated_fields
                    print(f"[翻译] 动作 {idx+1} ({action}) 翻译完成，共 {len(translated_fields)} 个字段")
                
                # 处理 before_value（record_deleted）
                elif 'before_value' in action_item:
                    translated_fields = {}
                    print(f"[翻译] 处理动作 {idx+1} ({action})，共 {len(action_item['before_value'])} 个字段")
                    for field_item in action_item['before_value']:
                        field_id = field_item.get('field_id', '')
                        field_value = field_item.get('field_value', None)
                        field_identity_value = field_item.get('field_identity_value', None)
                        
                        # 获取字段名
                        field_info = field_map.get(field_id, {})
                        if isinstance(field_info, dict):
                            field_name = field_info.get('name', field_id)
                        else:
                            field_name = field_id
                        
                        # 优先使用 field_identity_value，否则使用 field_value
                        value_to_translate = field_identity_value if field_identity_value else field_value
                        
                        # 如果是复杂对象（如用户字段），直接使用 field_identity_value
                        if field_identity_value and isinstance(field_identity_value, dict):
                            # 对于用户字段等复杂类型，直接使用 field_identity_value
                            translated_fields[field_name] = value_to_translate
                        else:
                            # 翻译字段值（选项字段等）
                            translated_value = translate_field_value(field_id, value_to_translate, field_map, option_map)
                            translated_fields[field_name] = translated_value
                    
                    # 添加翻译后的字段（保留原始 before_value）
                    action_item['translated_fields'] = translated_fields
                    print(f"[翻译] 动作 {idx+1} ({action}) 翻译完成，共 {len(translated_fields)} 个字段")
        
        print(f"[翻译] 翻译完成")
        return translated
        
    except Exception as e:
        print(f"[错误] 翻译事件数据失败: {e}")
        import traceback
        traceback.print_exc()
        return None

# v2.0 多维表格记录变更事件处理函数
def do_p2_drive_file_bitable_record_changed_v1(data: P2DriveFileBitableRecordChangedV1) -> None:
    print("[ 收到 v2.0 多维表格记录变更事件 ]")
    event_data_str = lark.JSON.marshal(data, indent=4)
    print(event_data_str)

    event = data.event
    # 实际数据结构：table_id 直接在 event 中，不是 event.object.table_id
    table_id = getattr(event, 'table_id', None) or (getattr(event, 'object', None) and getattr(event.object, 'table_id', None)) or 'unknown'

    # 记录所有事件到日志（包括非目标表格）
    append_log(table_id, f"收到事件 - 表格ID: {table_id}")
    append_log(table_id, f"事件数据: {event_data_str}")

    print(f"[DEBUG] 表格ID检查: 当前={table_id}, 目标={TARGET_TABLE_ID}")
    append_log(table_id, f"[DEBUG] 表格ID检查: 当前={table_id}, 目标={TARGET_TABLE_ID}")
    
    if table_id != TARGET_TABLE_ID:
        print(f"忽略非目标表格事件: {table_id}")
        append_log(table_id, f"忽略非目标表格事件 (目标: {TARGET_TABLE_ID})")
        return

    print(f"[DEBUG] 表格ID匹配，继续处理事件")
    append_log(table_id, "[DEBUG] 表格ID匹配，继续处理事件")

    # 实际数据结构：使用 action_list 而不是 changes
    action_list = getattr(event, 'action_list', [])
    print(f"[DEBUG] action_list 长度: {len(action_list)}")
    append_log(table_id, f"[DEBUG] action_list 长度: {len(action_list)}")
    
    if not action_list:
        print("没有变更记录")
        append_log(table_id, "没有变更记录")
        return

    # 映射 action 到 change_type
    action_to_change_type = {
        'record_added': 'created',
        'record_updated': 'updated',
        'record_deleted': 'deleted'
    }

    for action_item in action_list:
        action = getattr(action_item, 'action', 'unknown')
        change_type = action_to_change_type.get(action, action)
        record_id = getattr(action_item, 'record_id', '')
        
        # 只对 record_added 事件记录日志
        if action == 'record_added':
            after_value = getattr(action_item, 'after_value', [])
            
            # 将 after_value 数组转换为 fields 字典
            fields_dict = {}
            for field_item in after_value:
                field_id = getattr(field_item, 'field_id', '')
                field_value = getattr(field_item, 'field_value', None)
                # 如果有 field_identity_value，优先使用
                if hasattr(field_item, 'field_identity_value') and field_item.field_identity_value:
                    fields_dict[field_id] = field_item.field_identity_value
                else:
                    fields_dict[field_id] = field_value

            print(f"变更类型: {change_type} (action: {action})")
            print(f"记录 ID: {record_id}")
            print("记录字段值:")
            
            # 安全的序列化函数
            def safe_serialize_for_log(obj):
                """用于日志的序列化函数"""
                if isinstance(obj, (str, int, float, bool, type(None))):
                    return obj
                elif isinstance(obj, dict):
                    return {k: safe_serialize_for_log(v) for k, v in obj.items()}
                elif isinstance(obj, (list, tuple)):
                    return [safe_serialize_for_log(item) for item in obj]
                else:
                    try:
                        if hasattr(obj, '__dict__'):
                            return safe_serialize_for_log(obj.__dict__)
                        else:
                            return str(obj)
                    except:
                        return str(obj)
            
            try:
                fields_dict_safe = safe_serialize_for_log(fields_dict)
                fields_str = json.dumps(fields_dict_safe, indent=4, ensure_ascii=False)
                print(fields_str)
                
                # 记录变更详情到日志（只记录 record_added）
                append_log(table_id, f"变更类型: {change_type} (action: {action}), 记录ID: {record_id}")
                append_log(table_id, f"字段值: {fields_str}")
            except Exception as e:
                print(f"[错误] 序列化字段值失败: {e}")
                append_log(table_id, f"变更类型: {change_type} (action: {action}), 记录ID: {record_id}")
                append_log(table_id, f"[错误] 序列化字段值失败: {e}")
        else:
            # 非 record_added 事件，只打印不记录日志
            print(f"[跳过日志] 非新增事件: {action}, 记录ID: {record_id}")

    # 生成翻译版的影子日志
    try:
        # 先尝试解析 event_data_str（它可能是字符串或已经是字典）
        if isinstance(event_data_str, str):
            event_data_dict = json.loads(event_data_str)
        else:
            event_data_dict = event_data_str
        
        print(f"[翻译] 开始翻译事件数据...")
        translated_data = translate_event_data(event_data_dict, table_id)
        
        if translated_data:
            # 检查是否有 record_added 事件，只记录这种类型
            has_record_added = False
            if 'event' in translated_data and 'action_list' in translated_data['event']:
                for action_item in translated_data['event']['action_list']:
                    if action_item.get('action') == 'record_added':
                        has_record_added = True
                        break
            
            if has_record_added:
                # 使用更安全的序列化方法
                def safe_serialize(obj):
                    """安全的序列化函数，处理无法序列化的对象"""
                    try:
                        if hasattr(obj, '__dict__'):
                            return str(obj)
                        elif isinstance(obj, (set, frozenset)):
                            return list(obj)
                        else:
                            return str(obj)
                    except:
                        return str(obj)
                
                translated_str = json.dumps(translated_data, indent=4, ensure_ascii=False, default=safe_serialize)
                append_log(table_id, f"[翻译版] 事件数据: {translated_str}")
                print(f"[翻译版] 已生成翻译版影子日志（仅 record_added 事件）")
            else:
                print(f"[翻译版] 跳过日志记录（非 record_added 事件）")
        else:
            print(f"[翻译版] 翻译失败，跳过影子日志")
            # 即使翻译失败，如果是 record_added 事件，也记录一下
            if 'event' in event_data_dict and 'action_list' in event_data_dict['event']:
                for action_item in event_data_dict['event']['action_list']:
                    if action_item.get('action') == 'record_added':
                        append_log(table_id, "[翻译版] 翻译失败，跳过影子日志")
                        break
    except json.JSONDecodeError as e:
        print(f"[错误] JSON 解析失败: {e}")
        append_log(table_id, f"[错误] JSON 解析失败: {e}")
    except Exception as e:
        print(f"[错误] 生成翻译版日志失败: {e}")
        append_log(table_id, f"[错误] 生成翻译版日志失败: {e}")
        import traceback
        traceback.print_exc()

    # 只记录日志，不发送回调
    print(f"[INFO] 事件处理完成，已记录到日志")
    append_log(table_id, "[INFO] 事件处理完成，已记录到日志")

# 事件处理器
event_handler = (
    lark.EventDispatcherHandler.builder(VERIFICATION_TOKEN, ENCRYPT_KEY)
    .register_p2_drive_file_bitable_record_changed_v1(do_p2_drive_file_bitable_record_changed_v1)
    .build()
)

def subscribe_bitable():
    client = (
        lark.Client.builder()
        .app_id(APP_ID)
        .app_secret(APP_SECRET)
        .log_level(lark.LogLevel.INFO)
        .build()
    )

    request = (
        SubscribeFileRequest.builder()
        .file_token(FILE_TOKEN)
        .file_type("bitable")
        .build()
    )

    response = client.drive.v1.file.subscribe(request)

    if not response.success():
        lark.logger.error(f"订阅失败: code={response.code}, msg={response.msg}")
        return False

    lark.logger.info("订阅多维表格记录变更事件成功！")
    return True

def main():
    if not APP_ID or not APP_SECRET:
        raise ValueError("请在 .env 文件中配置 APP_ID 和 APP_SECRET")

    # 启动日志清理定时任务
    start_log_cleanup_scheduler()
    
    # 启动时立即执行一次清理（可选）
    print("[日志清理] 启动时执行一次日志清理...")
    cleanup_old_logs()

    # 先订阅事件（只需运行一次，成功后可注释掉）
    if not subscribe_bitable():
        print("订阅失败，服务退出")
        append_log("system", "订阅失败，服务退出")
        return

    append_log("system", "服务启动成功，开始监听多维表格记录变更事件")
    
    # 启动长连接监听
    cli = lark.ws.Client(
        APP_ID,
        APP_SECRET,
        event_handler=event_handler,
        log_level=lark.LogLevel.DEBUG
    )
    print("事件订阅客户端启动，监听 v2.0 多维表格记录变更事件...")
    print(f"日志目录: {LOG_DIR}")
    print(f"日志保留天数: {LOG_RETENTION_DAYS} 天")
    cli.start()

if __name__ == "__main__":
    main()

from flask import Flask, request, jsonify
from pymysql import connect
from pymysql.err import IntegrityError, DataError
import pymysql.cursors
import re
from datetime import datetime, date
import uuid
from dateutil import parser as date_parser
from typing import Optional
import imaplib
import email
from email.header import decode_header
from email.utils import parsedate_to_datetime
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.header import Header
from html.parser import HTMLParser
from html import unescape
import os
from zhconv import convert
import json
from cryptography.fernet import Fernet
import base64
from dotenv import load_dotenv

# 加载 .env 文件
load_dotenv()

app = Flask(__name__)

# --- 外墙棚架群组定义 ---
EXTERNAL_SCAFFOLDING_GROUPS = [
    '120363400601106571@g.us',
    '120363372181860061@g.us',
    '120363420660094468@g.us',
    '120363423214854498@g.us', # 打窿
    '120363401312839305@g.us', # 打窿
]

# --- 打窿群组定义 ---
DRILLING_GROUPS = [
    # '120363423214854498@g.us',
    # '120363401312839305@g.us'
    
]


DB_CONFIG = {
    "host": "10.25.0.42",
    "port": 3306,
    "user": "aitest",
    "password": "hN2$aA6$jA2k",
    "database": "ai_test",
    "charset": "utf8mb4",
    "cursorclass": pymysql.cursors.DictCursor
}

TABLE_NAME = "e_permit3"
FIELDS = [
    "id", "group_id", "project", "uuid", "bstudio_create_time",
    "location", "number", "floor", "morning",
    "afternoon", "xiaban", "subcontractor", "part_leave_number",
    "process", "time_range", "building", "update_history", "update_safety_history", "update_construct_history", "safety_flag", "application_id"
]

# --- jiaodika 表配置 ---
JIAODIKA_TABLE = "jiaodika"
JIAODIKA_FIELDS = [
    "id",
    "bstudio_create_time",
    "file",
    "gongchengfenlei",
    "gongxu",
    "zhuyaocailiao",
    "gongjushebei",
    "gongrenzige",
    "caozuogongyi",
    "yanshoubiaozhun",
    "anquanshixiang",
    "huanbaoshixiang",
    "drawings",
    "keydiagrams",
    "mockups",
    "updated_at",
]

# --- 邮箱账号密码表配置 ---
EMAIL_ACCOUNT_TABLE = "email_accounts"
EMAIL_ACCOUNT_FIELDS = [
    "id",
    "email_account",
    "encrypted_password",
    "user_refresh_token",
    "description",
    "created_at",
    "updated_at",
]

# --- 每日邮件处理记录表配置（handle_ids） ---
EMAIL_EVERYDAY_TABLE = "email_everyday"
EMAIL_EVERYDAY_FIELDS = [
    "id",
    "email_account",
    "email_id",
    "received_time",
    "created_at",
]

# --- 群组文件表配置 ---
GROUP_FILES_TABLE = "CEQManagement"
GROUP_FILES_FIELDS = [
    "id",
    "group_id",
    "bstudio_create_time",
    "file_url",
    "file_name",
]

# --- safetybot_table 表配置 ---
SAFETY_TABLE = "safetybot_table"
SAFETY_FIELDS = [
    "group_id",
    "date",
    "zone",
    "item_type",
    "id",
    "description",
    "created_at",
]

# --- 加密密钥配置 ---
# 从 .env 文件读取 EMAIL_ENCRYPTION_KEY，必须设置
ENCRYPTION_KEY_RAW = os.getenv("EMAIL_ENCRYPTION_KEY")
if not ENCRYPTION_KEY_RAW:
    raise RuntimeError("EMAIL_ENCRYPTION_KEY 未设置，请在 .env 文件中配置")

# 处理密钥
try:
    # 尝试作为 base64 字符串直接使用
    _fernet_key = ENCRYPTION_KEY_RAW.encode()
    # 验证格式
    base64.urlsafe_b64decode(_fernet_key)
except Exception:
    # 如果不是有效的 base64，将原始字符串转换为密钥
    key_material = ENCRYPTION_KEY_RAW.encode()
    if len(key_material) < 32:
        key_material = key_material.ljust(32, b"0")
    elif len(key_material) > 32:
        key_material = key_material[:32]
    _fernet_key = base64.urlsafe_b64encode(key_material)

# 初始化加密器
try:
    _fernet = Fernet(_fernet_key)
except Exception as e:
    # 如果密钥格式错误，直接报错，不生成新密钥
    raise RuntimeError(f"EMAIL_ENCRYPTION_KEY 格式错误，无法初始化加密器: {str(e)}")


# --- 加密/解密工具函数 ---
def encrypt_password(password: str) -> str:
    """加密密码"""
    if not password:
        return ""
    try:
        encrypted = _fernet.encrypt(password.encode())
        return encrypted.decode()
    except Exception as e:
        raise RuntimeError(f"密码加密失败: {str(e)}")


def decrypt_password(encrypted_password: str) -> str:
    """解密密码"""
    if not encrypted_password:
        return ""
    try:
        decrypted = _fernet.decrypt(encrypted_password.encode())
        return decrypted.decode()
    except Exception as e:
        raise RuntimeError(f"密码解密失败: {str(e)}")


# --- DB Utility ---
def get_conn():
    return connect(**DB_CONFIG)


def execute_query(sql, params=(), fetch=False, many=False, return_lastrowid: bool = False):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params) if not many else cur.executemany(sql, params)
            if fetch:
                return cur.fetchall()
            conn.commit()
            if return_lastrowid and not many:
                return cur.lastrowid
            return cur.rowcount
    finally:
        conn.close()


def normalize_date(value):
    try:
        dt = date_parser.parse(value)
        return dt.strftime("%Y-%m-%d")
    except:
        return None


# ==========================
# Mail Utilities (IMAP/SMTP)
# ==========================

def _json_error(message: str, status_code: int = 400, *, code: str = "bad_request", detail: Optional[str] = None):
    payload = {"ok": False, "error": message, "code": code}
    if detail:
        payload["detail"] = detail
    return jsonify(payload), status_code


def _env_str(key: str) -> Optional[str]:
    v = os.getenv(key)
    if v is None:
        return None
    v = v.strip()
    return v if v else None


def _env_int(key: str) -> Optional[int]:
    v = _env_str(key)
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        return None


# 你说先不放环境变量：这里提供“代码内默认值”
# 如需以后改回环境变量，只要把 env_* 放到 or 的前面即可
DEFAULT_IMAP_SERVER = "owahk.cohl.com"
DEFAULT_IMAP_PORT = 993
DEFAULT_SMTP_SERVER = "owahk.cohl.com"
DEFAULT_SMTP_PORT = 587
DEFAULT_SMTP_SECURITY = "starttls"  # starttls / ssl / plain


def _require_str(data: dict, key: str, *, aliases=None) -> str:
    keys = [key] + (list(aliases) if aliases else [])
    for k in keys:
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    raise ValueError(f"缺少参数: {key}")


def _require_int(data: dict, key: str, *, aliases=None) -> int:
    keys = [key] + (list(aliases) if aliases else [])
    for k in keys:
        if k in data and data.get(k) is not None:
            try:
                return int(data.get(k))
            except Exception:
                raise ValueError(f"参数格式错误: {key} 必须是整数")
    raise ValueError(f"缺少参数: {key}")


def _parse_smtp_security(value: Optional[str], port: int) -> str:
    """
    返回: 'starttls' | 'ssl' | 'plain'
    - 默认优先: 465->ssl, 587->starttls, 其他->starttls
    """
    v = (value or "").strip().lower()
    if v in ("ssl", "smtps", "tls"):
        return "ssl"
    if v in ("starttls", "upgrade"):
        return "starttls"
    if v in ("plain", "none"):
        return "plain"
    if port == 465:
        return "ssl"
    if port == 587:
        return "starttls"
    return "starttls"


def _decode_mime_header(value):
    if not value:
        return ""
    try:
        parts = decode_header(value)
        decoded = []
        for part, enc in parts:
            if isinstance(part, bytes):
                # 对于 bytes，总是使用智能解码（尝试多种编码）
                # 即使 decode_header 返回了编码信息，也可能不准确
                decoded.append(_decode_payload_smart(part, enc))
            else:
                # 如果已经是字符串，但可能编码不对，尝试重新编码再解码
                # 先转成 bytes（假设是 latin1，因为它能无损转换任何字节）
                try:
                    part_bytes = str(part).encode('latin1')
                    decoded.append(_decode_payload_smart(part_bytes, None))
                except Exception:
                    decoded.append(str(part))
        return "".join(decoded)
    except Exception:
        # 如果 decode_header 失败，尝试直接智能解码整个值
        try:
            if isinstance(value, bytes):
                return _decode_payload_smart(value, None)
            elif isinstance(value, str):
                # 尝试将字符串转成 bytes 再解码
                return _decode_payload_smart(value.encode('latin1'), None)
        except Exception:
            pass
        return str(value)


class _HTMLToTextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self._chunks = []

    def handle_data(self, data):
        if data:
            self._chunks.append(data)

    def handle_starttag(self, tag, attrs):
        if tag in ("br",):
            self._chunks.append("\n")
        elif tag in ("p", "div", "tr", "li"):
            self._chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in ("p", "div", "tr", "li"):
            self._chunks.append("\n")

    def get_text(self):
        text = unescape("".join(self._chunks))
        lines = [ln.strip() for ln in text.splitlines()]
        return "\n".join([ln for ln in lines if ln != ""])


def _html_to_text(html):
    parser = _HTMLToTextParser()
    try:
        parser.feed(html or "")
        parser.close()
    except Exception:
        return html or ""
    return parser.get_text()


def _decode_payload_smart(payload: bytes, declared_charset: Optional[str] = None) -> str:
    """
    智能解码邮件 payload，尝试多种编码（优先声明编码，再试常见中文编码）。
    """
    if payload is None:
        return ""
    
    # 常见编码列表（按优先级）
    # 需求：优先级按照 encodings_to_try（gb18030 最高）
    encodings_to_try = [
        "gb18030",  # 最全的中文字符集，兼容 gb2312/gbk
        "utf-8",    # 通用标准
        "big5",     # 繁体中文
        "gbk",      # 简体中文常见
        "latin-1",  # 兜底
    ]
    encodings = ["gb18030"]
    if declared_charset:
        # 不抢占 gb18030 的最高优先级，但也保留声明编码的尝试机会
        encodings.append(declared_charset.lower())
    encodings.extend(encodings_to_try[1:])
    
    # 去重但保持顺序
    seen = set()
    unique_encodings = []
    for enc in encodings:
        if enc not in seen:
            seen.add(enc)
            unique_encodings.append(enc)
    
    # 逐个尝试解码
    for enc in unique_encodings:
        try:
            return payload.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    
    # 全部失败，用 errors="ignore" 兜底
    return payload.decode("utf-8", errors="ignore")


def _extract_mail_body_plain(msg):
    """
    返回纯文本：
    - 优先 text/plain
    - 否则取第一个 text/*，若为 text/html 则转纯文本
    """
    if msg.is_multipart():
        fallback_text = ""
        fallback_is_html = False
        for part in msg.walk():
            ctype = part.get_content_type()
            cdisp = str(part.get("Content-Disposition") or "")
            if "attachment" in cdisp.lower():
                continue

            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            declared_charset = part.get_content_charset()
            text = _decode_payload_smart(payload, declared_charset)

            if ctype == "text/plain":
                return text
            if ctype.startswith("text/") and not fallback_text:
                fallback_text = text
                fallback_is_html = (ctype == "text/html")
        return _html_to_text(fallback_text) if fallback_is_html else fallback_text

    payload = msg.get_payload(decode=True)
    if payload is None:
        return ""
    declared_charset = msg.get_content_charset()
    text = _decode_payload_smart(payload, declared_charset)
    return _html_to_text(text) if msg.get_content_type() == "text/html" else text


def _as_int(v, default):
    if v is None:
        return default
    try:
        return int(v)
    except Exception:
        return default


def _parse_mail_date_to_iso(date_value: str) -> Optional[str]:
    """
    解析邮件头 Date 为 ISO8601 字符串（北京时间 UTC+8）。
    失败则返回 None。
    """
    try:
        dt = parsedate_to_datetime(date_value)
        if dt is None:
            return None
        # 转换为北京时间（UTC+8）
        if dt.tzinfo is None:
            # 如果没有时区信息，假设为UTC
            dt = pytz.UTC.localize(dt)
        # 转换为北京时间
        beijing_tz = pytz.timezone("Asia/Shanghai")
        dt_beijing = dt.astimezone(beijing_tz)
        return dt_beijing.isoformat()
    except Exception:
        return None


def receive_emails_imap(email_account, email_password, imap_server, imap_port, receive_number=20, mailbox="inbox", unread_only=False, today_only=False):
    result = []
    mail = None
    try:
        n = _as_int(receive_number, 20)
        if n <= 0:
            n = 1
        if n > 200:
            n = 200

        # 如果启用 today_only，获取香港时区的今天日期
        today_date = None
        if today_only:
            hongkong_tz = pytz.timezone("Asia/Hong_Kong")
            today_date = datetime.now(hongkong_tz).date()

        mail = imaplib.IMAP4_SSL(imap_server, imap_port)
        mail.login(email_account, email_password)
        # 支持选择不同的邮箱文件夹，默认 inbox
        mailbox_name = str(mailbox).strip() if mailbox else "inbox"
        mail.select(mailbox_name)

        # 更简单、稳定的"最新在前"实现：UID SEARCH + 本地按 UID 倒序取前 N 封
        # - 不依赖服务器 SORT 扩展（很多服务器不支持，会 BAD/NO）
        # - UID 可能不连续（删除/服务器分配策略），但通常单调递增；数字越大越新
        # 支持搜索未读邮件
        search_criteria = "UNSEEN" if unread_only else "ALL"
        status, data = mail.uid("search", None, search_criteria)
        if status != "OK":
            raise RuntimeError(f"IMAP UID SEARCH 返回非 OK: {status}")

        uids = (data[0] or b"").split()
        if not uids:
            return {"result": []}

        # 如果启用 today_only，需要获取更多邮件以便过滤（最多 500 封）
        # 否则只取前 n 封
        max_fetch = 500 if today_only else n
        latest_uids = sorted(uids, key=lambda x: int(x), reverse=True)[:max_fetch]

        for uid in latest_uids:
            # 使用 BODY.PEEK[] 而不是 RFC822，避免标记邮件为已读
            status, msg_data = mail.uid("fetch", uid, "(BODY.PEEK[])")
            if status != "OK" or not msg_data or not msg_data[0]:
                continue

            msg = email.message_from_bytes(msg_data[0][1])
            subject = _decode_mime_header(msg.get("Subject"))
            from_addr = _decode_mime_header(msg.get("From"))
            date_header = _decode_mime_header(msg.get("Date"))
            date_iso = _parse_mail_date_to_iso(date_header) if date_header else None
            
            # 将 date 字段也转换为香港时区格式
            date_hongkong = None
            mail_date_hongkong = None
            if date_header:
                try:
                    dt = parsedate_to_datetime(date_header)
                    if dt:
                        if dt.tzinfo is None:
                            dt = pytz.UTC.localize(dt)
                        hongkong_tz = pytz.timezone("Asia/Hong_Kong")
                        dt_hongkong = dt.astimezone(hongkong_tz)
                        mail_date_hongkong = dt_hongkong.date()
                        # 格式化为 RFC 2822 格式
                        date_hongkong = dt_hongkong.strftime("%a, %d %b %Y %H:%M:%S %z")
                except Exception:
                    pass
            
            # 如果启用 today_only，需要判断日期
            if today_only and today_date:
                if not mail_date_hongkong:
                    # 如果无法解析日期，标记为未读并跳过
                    try:
                        mail.uid("store", uid, "-FLAGS", "\\Seen")
                    except Exception:
                        pass
                    continue
                if mail_date_hongkong != today_date:
                    # 不是今天的邮件，标记为未读并跳过
                    try:
                        mail.uid("store", uid, "-FLAGS", "\\Seen")
                    except Exception:
                        pass
                    continue
                # 是今天的邮件，继续处理（不改变已读状态）
            
            body = _extract_mail_body_plain(msg)

            result.append(
                {
                    "id": uid.decode(errors="ignore") if isinstance(uid, (bytes, bytearray)) else str(uid),
                    "from": from_addr,
                    "subject": subject,
                    "date": date_hongkong if date_hongkong else date_header,
                    "date_iso": date_iso,
                    "body": body,
                }
            )
            
            # 如果启用 today_only，已经收集到足够的今天邮件，可以提前结束
            if today_only and len(result) >= n:
                break
    except imaplib.IMAP4.error as e:
        raise RuntimeError(f"IMAP 登录/读取失败: {str(e)}") from e
    except Exception as e:
        raise RuntimeError(f"IMAP 读取失败: {str(e)}") from e
    finally:
        if mail:
            try:
                mail.logout()
            except Exception:
                pass
    return {"result": result}


def send_email_smtp(
    email_account,
    email_password,
    smtp_server,
    smtp_port,
    to_email,
    subject,
    content,
    content_type="text/plain",
    smtp_security: Optional[str] = None,
):
    """
    SMTP 发送邮件（邮箱+密码登录），支持 text/plain 或 text/html。
    """
    try:
        msg = MIMEMultipart("alternative")
        msg["From"] = Header(email_account, "utf-8")
        msg["To"] = Header(to_email, "utf-8")
        msg["Subject"] = Header(subject or "", "utf-8")

        ctype = "plain" if (content_type or "").lower() in ("text/plain", "plain") else "html"
        part = MIMEText(content or "", ctype, "utf-8")
        msg.attach(part)

        security = _parse_smtp_security(smtp_security, int(smtp_port))
        if security == "ssl":
            with smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=20) as server:
                server.ehlo()
                server.login(email_account, email_password)
                server.sendmail(email_account, [to_email], msg.as_string())
        else:
            with smtplib.SMTP(smtp_server, smtp_port, timeout=20) as server:
                server.ehlo()
                if security == "starttls":
                    # 兼容部分服务器：先 ehlo 再 starttls 再 ehlo
                    server.starttls()
                    server.ehlo()
                server.login(email_account, email_password)
                server.sendmail(email_account, [to_email], msg.as_string())
        return {"ok": True}
    except Exception as e:
        raise RuntimeError(f"SMTP 发送失败: {str(e)}") from e


def test_email_login(email_account, email_password, imap_server=None, imap_port=None):
    """
    测试邮箱账号和密码是否能成功登录 IMAP 服务器
    - 返回: (success: bool, error_message: str)
    """
    mail = None
    try:
        imap_server = imap_server or DEFAULT_IMAP_SERVER
        imap_port = imap_port or DEFAULT_IMAP_PORT
        
        if not imap_server:
            return False, "缺少 IMAP 服务器配置"
        
        mail = imaplib.IMAP4_SSL(imap_server, imap_port, timeout=10)
        mail.login(email_account, email_password)
        return True, ""
    except imaplib.IMAP4.error as e:
        return False, f"IMAP 登录失败: {str(e)}"
    except Exception as e:
        return False, f"登录测试失败: {str(e)}"
    finally:
        if mail:
            try:
                mail.logout()
            except Exception:
                pass


def mark_emails_unread_imap(
    email_account,
    email_password,
    imap_server,
    imap_port,
    email_uids,
    mailbox="inbox"
):
    """
    将指定邮件标记为未读
    - email_uids: 邮件 UID 列表（字符串或整数列表）
    - mailbox: 邮箱文件夹，默认 inbox
    """
    mail = None
    try:
        mail = imaplib.IMAP4_SSL(imap_server, imap_port)
        mail.login(email_account, email_password)
        
        mailbox_name = str(mailbox).strip() if mailbox else "inbox"
        mail.select(mailbox_name)
        
        # 处理 UID 列表
        if isinstance(email_uids, str):
            uid_list = [uid.strip() for uid in email_uids.split(",")]
        elif isinstance(email_uids, list):
            uid_list = [str(uid) for uid in email_uids]
        else:
            uid_list = [str(email_uids)]
        
        # 移除 \Seen 标志（标记为未读）
        # 使用 -FLAGS 来移除标志
        marked_count = 0
        for uid in uid_list:
            try:
                # 移除 \Seen 标志
                status, response = mail.uid("store", uid, "-FLAGS", "\\Seen")
                if status == "OK":
                    marked_count += 1
            except Exception as e:
                # 单个邮件失败不影响其他邮件
                continue
        
        return {"ok": True, "marked_count": marked_count, "total": len(uid_list)}
    except imaplib.IMAP4.error as e:
        raise RuntimeError(f"IMAP 操作失败: {str(e)}") from e
    except Exception as e:
        raise RuntimeError(f"标记邮件为未读失败: {str(e)}") from e
    finally:
        if mail:
            try:
                mail.logout()
            except Exception:
                pass


def add_read_ids(email_account, email_uids):
    """
    将邮件 UID 添加到 email_everyday 表（不进行 IMAP 操作，只更新数据库）
    - email_account: 邮箱账号
    - email_uids: 邮件 UID 列表（字符串、整数或列表）
    """
    import pytz
    from datetime import datetime
    
    # 处理 UID 列表
    if isinstance(email_uids, str):
        uid_list = [uid.strip() for uid in email_uids.split(",")]
    elif isinstance(email_uids, list):
        uid_list = [str(uid) for uid in email_uids]
    else:
        uid_list = [str(email_uids)]
    
    # 获取当前时间（北京时间）
    beijing_tz = pytz.timezone("Asia/Shanghai")
    current_time = datetime.now(beijing_tz)
    
    # 插入到 email_everyday 表
    try:
        conn = get_conn()
        added_count = 0
        try:
            with conn.cursor() as cur:
                for uid in uid_list:
                    try:
                        # 使用 INSERT IGNORE 避免重复插入
                        sql = f"""
                            INSERT IGNORE INTO `{EMAIL_EVERYDAY_TABLE}` 
                            (`email_account`, `email_id`, `received_time`) 
                            VALUES (%s, %s, %s)
                        """
                        cur.execute(sql, (email_account, uid, current_time))
                        if cur.rowcount > 0:
                            added_count += 1
                    except Exception as e:
                        # 单个 UID 失败不影响其他
                        continue
                conn.commit()
        finally:
            conn.close()
        
        return {"ok": True, "added_count": added_count, "added_uids": uid_list}
    except Exception as e:
        raise RuntimeError(f"添加 handle_ids 失败: {str(e)}") from e


# --- Routes ---
@app.route('/')
def index():
    return "API is running."


# --------------------------
# Mail Routes (IMAP/SMTP)
# --------------------------
@app.route("/mail/health", methods=["GET"])
def mail_health():
    return jsonify({"ok": True})


@app.route("/mail/receive", methods=["GET", "POST"])
def mail_receive():
    # 隐私要求：不允许使用 URL query 传任何参数（避免进 nginx/flask 日志）
    if request.args:
        return _json_error("隐私要求：/mail/receive 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        email_account = _require_str(data, "email_account")
        email_password = _require_str(data, "email_password")
        # 生产推荐：server/port 从环境变量读取，调用方无需传
        imap_server = data.get("IMAP_SERVER") or data.get("imap_server") or DEFAULT_IMAP_SERVER
        imap_port = data.get("IMAP_PORT") or data.get("imap_port") or DEFAULT_IMAP_PORT
        if not imap_server:
            raise ValueError("缺少参数: IMAP_SERVER（建议用环境变量 DEFAULT_IMAP_SERVER 配置）")
        if imap_port is None:
            raise ValueError("缺少参数: IMAP_PORT（建议用环境变量 DEFAULT_IMAP_PORT 配置）")
        imap_server = str(imap_server).strip()
        imap_port = int(imap_port)
        receive_number = _as_int(data.get("receive_number", 20), 20)
        # 支持选择邮箱文件夹，默认 inbox
        mailbox = data.get("mailbox") or data.get("folder") or "inbox"
        # 支持只获取未读邮件，默认 false（全部获取）
        unread_only = data.get("unread_only", False)
        if isinstance(unread_only, str):
            unread_only = unread_only.lower() in ("true", "1", "yes")
    except ValueError as e:
        return _json_error(str(e), 400)

    try:
        res = receive_emails_imap(
            email_account=email_account,
            email_password=email_password,
            imap_server=imap_server,
            imap_port=imap_port,
            receive_number=receive_number,
            mailbox=mailbox,
            unread_only=unread_only,
        )
        return jsonify({"ok": True, **res})
    except Exception as e:
        # 不回显账号/密码，仅回显错误原因
        return _json_error("收取邮件失败", 502, code="mail_receive_failed", detail=str(e))


@app.route("/mail/receive_from_db", methods=["GET", "POST"])
def mail_receive_from_db():
    """
    从数据库读取邮箱账号列表并收取邮件
    - 不需要密码，从 email_accounts 表自动读取并解密
    - email_account 可选：指定则只处理该邮箱，不指定则处理所有邮箱
    - receive_number 可选：指定收取邮件数量，默认 20
    - unread_only 可选：是否只获取未读邮件，默认 false（全部获取）
    - mailbox 可选：指定邮箱文件夹，默认 inbox
    - today_only 可选：是否只获取今天的邮件（香港时区），默认 false（全部获取）
    """
    # 隐私要求：不允许使用 URL query 传任何参数（避免进 nginx/flask 日志）
    if request.args:
        return _json_error("隐私要求：/mail/receive_from_db 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        # email_account 为可选，如果不指定则处理所有邮箱
        email_account = data.get("email_account")
        if email_account:
            email_account = str(email_account).strip()
        
        # 生产推荐：server/port 从环境变量读取，调用方无需传
        imap_server = data.get("IMAP_SERVER") or data.get("imap_server") or DEFAULT_IMAP_SERVER
        imap_port = data.get("IMAP_PORT") or data.get("imap_port") or DEFAULT_IMAP_PORT
        if not imap_server:
            raise ValueError("缺少参数: IMAP_SERVER（建议用环境变量 DEFAULT_IMAP_SERVER 配置）")
        if imap_port is None:
            raise ValueError("缺少参数: IMAP_PORT（建议用环境变量 DEFAULT_IMAP_PORT 配置）")
        imap_server = str(imap_server).strip()
        imap_port = int(imap_port)
        receive_number = _as_int(data.get("receive_number", 20), 20)
        # 支持选择邮箱文件夹，默认 inbox
        mailbox = data.get("mailbox") or data.get("folder") or "inbox"
        # 支持只获取未读邮件，默认 false（全部获取）
        unread_only = data.get("unread_only", False)
        if isinstance(unread_only, str):
            unread_only = unread_only.lower() in ("true", "1", "yes")
        # 支持只获取今天的邮件（香港时区），默认 false（全部获取）
        today_only = data.get("today_only", False)
        if isinstance(today_only, str):
            today_only = today_only.lower() in ("true", "1", "yes")
    except ValueError as e:
        return _json_error(str(e), 400)

    try:
        # 从数据库读取邮箱账号列表
        if email_account:
            # 指定单个邮箱
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
            accounts = execute_query(sql, (email_account,), fetch=True)
        else:
            # 不指定则读取所有邮箱
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` ORDER BY `id`"
            accounts = execute_query(sql, (), fetch=True)
        
        if not accounts:
            return _json_error("未找到邮箱账号", 404, code="no_email_accounts")
        
        # 处理每个邮箱账号
        all_results = []
        errors = []
        
        for account_row in accounts:
            acc = account_row.get("email_account")
            encrypted_pwd = account_row.get("encrypted_password")
            
            if not acc or not encrypted_pwd:
                errors.append({"email_account": acc, "error": "账号或密码为空"})
                continue
            
            try:
                # 解密密码
                email_password = decrypt_password(encrypted_pwd)
            except Exception as e:
                errors.append({"email_account": acc, "error": f"密码解密失败: {str(e)}"})
                continue
            
            try:
                # 收取邮件
                res = receive_emails_imap(
                    email_account=acc,
                    email_password=email_password,
                    imap_server=imap_server,
                    imap_port=imap_port,
                    receive_number=receive_number,
                    mailbox=mailbox,
                    unread_only=unread_only,
                    today_only=today_only,
                )
                all_results.append({
                    "email_account": acc,
                    "ok": True,
                    **res
                })
            except Exception as e:
                errors.append({
                    "email_account": acc,
                    "error": str(e)
                })
        
        return jsonify({
            "ok": True,
            "results": all_results,
            "errors": errors,
            "total_accounts": len(accounts),
            "success_count": len(all_results),
            "error_count": len(errors)
        })
    except Exception as e:
        # 不回显账号/密码，仅回显错误原因
        return _json_error("收取邮件失败", 502, code="mail_receive_failed", detail=str(e))


@app.route("/mail/send", methods=["POST"])
def mail_send():
    # 隐私要求：不允许使用 URL query 传任何参数（避免进 nginx/flask 日志）
    if request.args:
        return _json_error("隐私要求：/mail/send 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        email_account = _require_str(data, "email_account")
        email_password = _require_str(data, "email_password")
        # 生产推荐：server/port 从环境变量读取，调用方无需传
        smtp_server = data.get("SMTP_SERVER") or data.get("smtp_server") or DEFAULT_SMTP_SERVER
        smtp_port = data.get("SMTP_PORT") or data.get("smtp_port") or DEFAULT_SMTP_PORT
        if not smtp_server:
            raise ValueError("缺少参数: SMTP_SERVER（建议用环境变量 DEFAULT_SMTP_SERVER 配置）")
        if smtp_port is None:
            raise ValueError("缺少参数: SMTP_PORT（建议用环境变量 DEFAULT_SMTP_PORT 配置）")
        smtp_server = str(smtp_server).strip()
        smtp_port = int(smtp_port)
        to_email = _require_str(data, "to", aliases=["to_email", "recipient"])
    except ValueError as e:
        return _json_error(str(e), 400)

    subject = data.get("subject", "") or ""
    content = data.get("content", "") or ""
    content_type = data.get("content_type", "text/plain") or "text/plain"
    smtp_security = data.get("smtp_security") or DEFAULT_SMTP_SECURITY  # 可选: starttls / ssl / plain

    try:
        res = send_email_smtp(
            email_account=email_account,
            email_password=email_password,
            smtp_server=smtp_server,
            smtp_port=smtp_port,
            to_email=to_email,
            subject=subject,
            content=content,
            content_type=content_type,
            smtp_security=smtp_security,
        )
        return jsonify(res)
    except Exception as e:
        return _json_error("发送邮件失败", 502, code="mail_send_failed", detail=str(e))


@app.route("/mail/mark_unread", methods=["POST"])
def mail_mark_unread():
    """
    将邮件标记为未读
    - email_account, email_password: 邮箱账号密码
    - email_uids: 邮件 UID（字符串、整数或列表），多个用逗号分隔
    - mailbox: 邮箱文件夹，默认 inbox
    """
    # 隐私要求：不允许使用 URL query 传任何参数
    if request.args:
        return _json_error("隐私要求：/mail/mark_unread 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        email_account = _require_str(data, "email_account")
        email_password = _require_str(data, "email_password")
        imap_server = data.get("IMAP_SERVER") or data.get("imap_server") or DEFAULT_IMAP_SERVER
        imap_port = data.get("IMAP_PORT") or data.get("imap_port") or DEFAULT_IMAP_PORT
        if not imap_server:
            raise ValueError("缺少参数: IMAP_SERVER")
        if imap_port is None:
            raise ValueError("缺少参数: IMAP_PORT")
        imap_server = str(imap_server).strip()
        imap_port = int(imap_port)
        
        email_uids = data.get("email_uids") or data.get("uid") or data.get("uids")
        if not email_uids:
            raise ValueError("缺少参数: email_uids")
        
        mailbox = data.get("mailbox") or data.get("folder") or "inbox"
    except ValueError as e:
        return _json_error(str(e), 400)

    try:
        res = mark_emails_unread_imap(
            email_account=email_account,
            email_password=email_password,
            imap_server=imap_server,
            imap_port=imap_port,
            email_uids=email_uids,
            mailbox=mailbox,
        )
        return jsonify(res)
    except Exception as e:
        return _json_error("标记邮件为未读失败", 502, code="mail_mark_unread_failed", detail=str(e))


@app.route("/mail/mark_unread_from_db", methods=["POST"])
def mail_mark_unread_from_db():
    """
    从数据库读取邮箱账号并标记邮件为未读
    - email_account 可选：指定则只处理该邮箱，不指定则处理所有邮箱
    - email_uids: 邮件 UID（字符串、整数或列表），多个用逗号分隔
    - mailbox: 邮箱文件夹，默认 inbox
    """
    # 隐私要求：不允许使用 URL query 传任何参数
    if request.args:
        return _json_error("隐私要求：/mail/mark_unread_from_db 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        email_account = data.get("email_account")
        if email_account:
            email_account = str(email_account).strip()
        
        imap_server = data.get("IMAP_SERVER") or data.get("imap_server") or DEFAULT_IMAP_SERVER
        imap_port = data.get("IMAP_PORT") or data.get("imap_port") or DEFAULT_IMAP_PORT
        if not imap_server:
            raise ValueError("缺少参数: IMAP_SERVER")
        if imap_port is None:
            raise ValueError("缺少参数: IMAP_PORT")
        imap_server = str(imap_server).strip()
        imap_port = int(imap_port)
        
        email_uids = data.get("email_uids") or data.get("uid") or data.get("uids")
        if not email_uids:
            raise ValueError("缺少参数: email_uids")
        
        mailbox = data.get("mailbox") or data.get("folder") or "inbox"
    except ValueError as e:
        return _json_error(str(e), 400)

    try:
        # 从数据库读取邮箱账号列表
        if email_account:
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
            accounts = execute_query(sql, (email_account,), fetch=True)
        else:
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` ORDER BY `id`"
            accounts = execute_query(sql, (), fetch=True)
        
        if not accounts:
            return _json_error("未找到邮箱账号", 404, code="no_email_accounts")
        
        # 处理每个邮箱账号
        all_results = []
        errors = []
        
        for account_row in accounts:
            acc = account_row.get("email_account")
            encrypted_pwd = account_row.get("encrypted_password")
            
            if not acc or not encrypted_pwd:
                errors.append({"email_account": acc, "error": "账号或密码为空"})
                continue
            
            try:
                email_password = decrypt_password(encrypted_pwd)
            except Exception as e:
                errors.append({"email_account": acc, "error": f"密码解密失败: {str(e)}"})
                continue
            
            try:
                res = mark_emails_unread_imap(
                    email_account=acc,
                    email_password=email_password,
                    imap_server=imap_server,
                    imap_port=imap_port,
                    email_uids=email_uids,
                    mailbox=mailbox,
                )
                all_results.append({
                    "email_account": acc,
                    **res
                })
            except Exception as e:
                errors.append({
                    "email_account": acc,
                    "error": str(e)
                })
        
        return jsonify({
            "ok": True,
            "results": all_results,
            "errors": errors,
            "total_accounts": len(accounts),
            "success_count": len(all_results),
            "error_count": len(errors)
        })
    except Exception as e:
        return _json_error("标记邮件为未读失败", 502, code="mail_mark_unread_failed", detail=str(e))


@app.route("/mail/mark_read", methods=["POST"])
def mail_mark_read():
    """
    从数据库读取邮箱账号并将邮件 UID 添加到 email_everyday 表（不进行 IMAP 操作）
    - email_account 必填：只处理该邮箱
    - email_uids: 邮件 UID（字符串、整数或列表），多个用逗号分隔（必填）
    """
    # 隐私要求：不允许使用 URL query 传任何参数
    if request.args:
        return _json_error("隐私要求：/mail/mark_read 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        email_account = _require_str(data, "email_account")
        email_uids = data.get("email_uids") or data.get("uid") or data.get("uids")
        if not email_uids:
            raise ValueError("缺少参数: email_uids")
    except ValueError as e:
        return _json_error(str(e), 400)

    try:
        # 从数据库读取邮箱账号列表
        sql = f"SELECT `email_account` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
        accounts = execute_query(sql, (email_account,), fetch=True)
        
        if not accounts:
            return _json_error("未找到邮箱账号", 404, code="no_email_accounts")
        
        # 处理每个邮箱账号
        all_results = []
        errors = []
        
        for account_row in accounts:
            acc = account_row.get("email_account")
            
            if not acc:
                errors.append({"email_account": acc, "error": "账号为空"})
                continue
            
            try:
                res = add_read_ids(acc, email_uids)
                all_results.append({
                    "email_account": acc,
                    **res
                })
            except Exception as e:
                errors.append({
                    "email_account": acc,
                    "error": str(e)
                })
        
        return jsonify({
            "ok": True,
            "results": all_results,
            "errors": errors,
            "total_accounts": len(accounts),
            "success_count": len(all_results),
            "error_count": len(errors)
        })
    except Exception as e:
        return _json_error("添加 handle_ids 失败", 502, code="mail_mark_read_failed", detail=str(e))


@app.route("/records", methods=["POST"])
def create_record():
    data = request.get_json(force=True)

    # 1. 支持批量或单条
    if isinstance(data, list):
        results = []
        for rec in data:
            res = insert_one_record(rec)
            results.append(res)
        # 可返回所有条目结果
        return jsonify(results), 207 if any(r.get('error') for r in results) else 201

    # 单条
    res = insert_one_record(data)
    if "error" in res:
        return jsonify(res), 200
    return jsonify(res), 201


from datetime import datetime
import pytz
import uuid
from dateutil.parser import parse as date_parser


def generate_gmt_cst_time():
    """生成当前北京时间，格式为 Fri, 10 Oct 2025 11:03:13 GMT"""
    cst_tz = pytz.timezone("Asia/Shanghai")
    cst_time = datetime.now(cst_tz)
    return cst_time.strftime("%a, %d %b %Y %H:%M:%S GMT")


def normalize_date(value):
    """解析 GMT 格式时间并返回 YYYY-MM-DD"""
    try:
        dt = datetime.strptime(value, "%a, %d %b %Y %H:%M:%S GMT")
        dt = pytz.UTC.localize(dt)
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None


def clean_string(value):
    """移除字符串中的所有空格（包括中间空格）"""
    if isinstance(value, str):
        return re.sub(r'\s+', '', value)
    return value


def insert_one_record(data):
    """
    智能插入或累加记录
    - 如果当天、同 group_id/location/subcontractor/number/floor 已存在，则累加 part_leave_number
    - 若累加超过 number，报错
    - 没有则新插入
    - group_id、part_leave_number 字段必须支持
    """
    # 校验必填字段
    is_scaffold_group = data.get("group_id") in EXTERNAL_SCAFFOLDING_GROUPS
    required = ["location", "subcontractor", "number", "floor"]
    if is_scaffold_group:
        required.extend(["process"])

    name_dict = {
        "location": "位置",
        "subcontractor": "分判",
        "number": "人數",
        "floor": "樓層",
        "process": "工序"
    }
    missing_keys = [k for k in required if not data.get(k)]
    if missing_keys:
        missing_names = [name_dict[k] for k in missing_keys]
        if is_scaffold_group:
            return {
                "error": f"缺少字段: {', '.join(missing_names)}，請按照[位置]，[樓層]，[分判]，[人數]，[工序]，[時間]格式輸入，如：“申請BLK A，A11-A13，9/F，偉健2人，工序:拆板，時間:0800-1800”"}
        else:
            return {
                "error": f"缺少字段: {', '.join(missing_names)}，請按照[位置]，[分判]，[人數]，[樓層]格式輸入，如：“申請 EP7，中建，1人，G/F”"}

    # 校验 time_range 格式
    if error := validate_time_range(data):
        return error

    # 楼栋提取
    building = extract_building(data.get("location", ""))
    data["building"] = building

    number = int(data["number"])
    new_part = int(data.get("part_leave_number", 0) or 0)
    hkt_tz = pytz.timezone("Asia/Hong_Kong")
    today_str = (datetime.now(hkt_tz).strftime("%Y-%m-%d"))[:10]
    start_time = f"{today_str} 00:00:00"
    end_time = f"{today_str} 23:59:59"

    # 查找当天已存在的记录
    # 如果是外墙群组，需要添加 process 和 time_range 的查询条件
    is_scaffold_group = data.get("group_id") in EXTERNAL_SCAFFOLDING_GROUPS
    is_drilling_group = data.get("group_id") in DRILLING_GROUPS

    if is_scaffold_group or is_drilling_group:
        # 外墙群组：添加 process 和 time_range 查询条件
        check_sql = f"""
            SELECT id, part_leave_number, number FROM `{TABLE_NAME}`
            WHERE `group_id`=%s AND REPLACE(`location`,' ','')=%s AND `subcontractor`=%s AND `number`=%s 
            AND REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(`floor`, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',') = REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',')
            AND REPLACE(`process`,' ','')=%s
            AND `bstudio_create_time` BETWEEN %s AND %s
            ORDER BY id DESC LIMIT 1
        """
        params = (
            clean_string(data.get("group_id", "")),
            clean_string(data.get("location", "")),
            clean_string(data.get("subcontractor", "")),
            data.get("number", 0),
            clean_string(data.get("floor", "")),
            clean_string(data.get("process", "")),
            start_time,
            end_time
        )
    else:
        # 非外墙群组：保持原查询条件
        check_sql = f"""
            SELECT id, part_leave_number, number FROM `{TABLE_NAME}`
            WHERE `group_id`=%s AND REPLACE(`location`,' ','')=%s AND `subcontractor`=%s AND `number`=%s 
            AND REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(`floor`, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',') = REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',')
            AND `bstudio_create_time` BETWEEN %s AND %s
            ORDER BY id DESC LIMIT 1
        """
        params = (
            clean_string(data.get("group_id", "")),
            clean_string(data.get("location", "")),
            clean_string(data.get("subcontractor", "")),
            data.get("number", 0),  # 整数，无需清理
            clean_string(data.get("floor", "")),
            start_time,  # 日期，无需清理
            end_time  # 日期，无需清理
        )

    conn = get_conn()
    exists = None
    try:
        with conn.cursor() as cur:
            cur.execute(check_sql, params)
            exists = cur.fetchone()
    finally:
        conn.close()

    # 只允许部分撤离累计不超过总人数
    if exists:
        xiaban = int(exists.get("xiaban") or 0)
        final_part = int(exists.get("part_leave_number") or 0) if xiaban == 0 else number
        if final_part > number:
            return {"error": f"部分撤離人數({final_part})不能大於總人數({number})，请重新输入"}
        # 累加并更新
        update_sql = f"UPDATE `{TABLE_NAME}` SET `part_leave_number`=%s WHERE id=%s"
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(update_sql, (final_part, exists["id"]))
                conn.commit()
            return {
                "status": "updated",
                "id": exists["id"],
                "part_leave_number": final_part
            }
        finally:
            conn.close()
    else:
        # 新插入校验
        if new_part > number:
            return {"error": f"部分撤離人數({new_part})不能大於總人數({number})，请重新输入"}

        # 构造插入数据
        # - id 建议由数据库 AUTO_INCREMENT 生成，因此这里不再由服务端生成/传入
        insert_fields = [f for f in FIELDS if f != "id"]
        record = {k: data.get(k) for k in insert_fields}
        record["uuid"] = data.get("uuid") or str(uuid.uuid4())
        record["xiaban"] = 1 if new_part == number else 0

        # 处理时间字段 - 统一使用服务器当前时间，不考虑用户传入的时间
        record["bstudio_create_time"] = datetime.now(hkt_tz).strftime("%Y-%m-%d %H:%M:%S")

        # 插入
        cols = ", ".join(f"`{f}`" for f in insert_fields)
        placeholders = ", ".join(["%s"] * len(insert_fields))
        values = tuple(record.get(f) for f in insert_fields)
        sql = f"INSERT INTO `{TABLE_NAME}` ({cols}) VALUES ({placeholders})"
        try:
            inserted_id = execute_query(sql, values, return_lastrowid=True)
        except Exception as e:
            return {"error": "插入失败", "detail": str(e)}
        return {"status": "ok", "inserted_id": inserted_id}




def validate_time_range(data):
    """校验时间范围格式"""
    time_range = data.get("time_range", "")

    # 如果是外墙棚架群组
    if data.get("group_id") in EXTERNAL_SCAFFOLDING_GROUPS:
        # 如果time_range为空，赋予默认值
        if not time_range or time_range.strip() == "":
            data["time_range"] = "0800-1800"  # 默认工作时间
            return None

        # 校验格式
        if not re.match(r"^\d{4}-\d{4}$", time_range):
            return {"error": "時間格式錯誤，應為 0900-1730"}

    return None


# --- 外墙棚架 楼栋提取 ---
def extract_building(location):
    """改进的楼栋提取函数"""
    location = clean_string(location)
    building = "未知"

    # 匹配 BLK A XXX 格式
    blk_regex = r'^BLK\s*([A-Z])'
    match = re.match(blk_regex, location, re.IGNORECASE)
    if match:
        building_letter = match.group(1).upper()
        building = f"{building_letter}座"
        return building

    # 匹配 "A座" "A棟" "A樓" 以及复合格式如 "C座,CP9" 等
    combined_building_regex = r'^([A-Z])[\s\-\_]*[座棟樓]([,\s]*[A-Z0-9\-]+)?'
    match = re.match(combined_building_regex, location, re.IGNORECASE)
    if match:
        building_letter = match.group(1).upper()
        building = f"{building_letter}座"
        return building

    # 匹配 "Block A" 格式
    block_regex = r'^Block[\s\-_]*([A-Z])'
    match = re.match(block_regex, location, re.IGNORECASE)
    if match:
        building_letter = match.group(1).upper()
        building = f"{building_letter}座"
        return building

    return building


@app.route("/records/<int:record_id>", methods=["GET"])
def get_record(record_id):
    sql = f"SELECT * FROM `{TABLE_NAME}` WHERE `id`=%s"
    rows = execute_query(sql, (record_id,), fetch=True)
    return jsonify(rows[0]) if rows else (jsonify({"error": "未找到该记录"}), 404)


def normalize_date(dt_str: str) -> Optional[str]:
    """
    支持多种输入格式：
      - 'Thu, 24 Jul 2025 12:06:05 GMT'
      - '2025-07-28 10:25:35'
      - '2025-07-28'
    成功解析返回 'YYYY-MM-DD'，否则返回 None。
    """
    formats = [
        "%a, %d %b %Y %H:%M:%S GMT",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d"
    ]
    for fmt in formats:
        try:
            return datetime.strptime(dt_str, fmt).strftime("%Y-%m-%d")
        except Exception:
            continue
    return None


@app.route("/records", methods=["GET"])
def list_records():
    """
    列表/查询记录
    - 继续支持 URL 查询参数，例如： /records?group_id=xxx&subcontractor=xxx
    - 额外支持在 GET 请求中通过 JSON body 传入查询条件
      （例如 FastGPT 等只能用 POST/带 body 的场景，可以改成 GET + JSON body）
    - body 与 query 参数同时存在时，后者优先覆盖同名字段
    """
    # 1. 读取 URL 查询参数
    query_filters = request.args.to_dict()

    # 2. 尝试从 body 中读取 JSON 作为过滤条件（即便是 GET 也允许有 body）
    body_filters = request.get_json(silent=True) or {}
    if not isinstance(body_filters, dict):
        body_filters = {}

    # 3. 合并：body 为基础，query 覆盖
    filters = {**body_filters, **query_filters}

    # 如果完全没有过滤条件，则返回所有记录
    if not filters:
        sql = f"SELECT * FROM `{TABLE_NAME}` ORDER BY `id`"
        rows = execute_query(sql, fetch=True)
        return jsonify(rows)

    # 自动拼接 WHERE 条件
    conditions = []
    params = []
    for k, v in filters.items():
        if k in FIELDS:  # 只支持已知字段
            conditions.append(f"`{k}`=%s")
            params.append(v)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM `{TABLE_NAME}` {where} ORDER BY `id`"
    rows = execute_query(sql, tuple(params), fetch=True)
    return jsonify(rows)


@app.route("/records/today", methods=["GET"])
def get_today_records():
    today_str = date.today().strftime("%Y-%m-%d")
    start_time = f"{today_str} 00:00:00"
    end_time = f"{today_str} 23:59:59"
    filters = request.args.to_dict()
    conditions = ["`bstudio_create_time` BETWEEN %s AND %s"]
    params = [start_time, end_time]
    # 支持额外group_id等筛选
    for k, v in filters.items():
        if k in FIELDS:
            if k == "group_id" and (not v or v.strip() == ""):
                continue
            conditions.append(f"`{k}`=%s")
            params.append(v)
    where = f"WHERE {' AND '.join(conditions)}"
    sql = f"SELECT * FROM `{TABLE_NAME}` {where} ORDER BY `id`"
    return jsonify(execute_query(sql, tuple(params), fetch=True))


@app.route("/records/update_by_condition", methods=["PUT"])
def update_by_condition():
    data = request.get_json(force=True)
    filters = data.get("where")
    updates = data.get("set")

    if not filters or not updates:
        return jsonify({"error": "请提供 'where' 和 'set' 字段"}), 400

    print("Received filters:", filters)
    print("Received updates:", updates)
    # 自动添加当前北京时间的 bstudio_create_time 到 updates
    current_time = generate_gmt_cst_time()

    print("after time added updates:", updates)
    print("FIELDS:", FIELDS)

    # 校验外墙棚架群组在更新时的必填字段
    error_response = validate_scaffold_group_fields(filters)
    if error_response:
        return error_response

    # location, building, floor 不区分大小写，不记入string_fields中
    string_fields = {"subcontractor", "group_id"}
    if filters.get("group_id") in EXTERNAL_SCAFFOLDING_GROUPS:
        string_fields.update({"process", "time_range"})

    conditions = []
    params = []
    for key, value in filters.items():
        if key in FIELDS:
            if key == "bstudio_create_time":
                norm = normalize_date(value)
                if norm:
                    start, end = f"{norm} 00:00:00", f"{norm} 23:59:59"
                    conditions.append(f"`{key}` BETWEEN %s AND %s")
                    params.extend([start, end])
                    continue
            if key == "location":
                # 将、，分隔符统一转换为逗号进行比较
                conditions.append(
                    "REPLACE(REPLACE(REPLACE(`location`, '、', ','), ' ', ''), '，', ',') "
                    "= REPLACE(REPLACE(REPLACE(%s, '、', ','), ' ', ''), '，', ',')")
                params.append(value)
                continue
            if key == "floor":
                # 将空格移除，横线和中文逗号统一替换为单逗号进行比较
                conditions.append(
                    "REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(`floor`, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',') "
                    "= REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',')")
                params.append(value)
                continue
            if key in string_fields:
                conditions.append(f"BINARY `{key}` = %s")
            else:
                conditions.append(f"`{key}` = %s")
            params.append(value)
        else:
            print(f"Warning: Field {key} not in FIELDS")

    if not conditions:
        return jsonify({"error": "无有效过滤条件字段"}), 400

    update_clause = []
    update_params = []
    for key, value in updates.items():
        if key in FIELDS:
            # part_leave_number 做累加更新
            if key == "part_leave_number":
                try:
                    inc = int(value)
                except (TypeError, ValueError):
                    inc = 0
                update_clause.append("`part_leave_number` = IFNULL(`part_leave_number`, 0) + %s")
                update_params.append(inc)
                continue
            update_clause.append(f"`{key}` = %s")
            update_params.append(value)
        else:
            print(f"Warning: Update field {key} not in FIELDS")

    # 添加update_history字段的更新
    safety_flag = updates.get("safety_flag")
    sender_type = updates.get("sender_type")
    if safety_flag == 1:
        if sender_type == 1:
            # 添加到中建安全部 update_safety_history
            update_clause.append(f"`update_safety_history` = JSON_ARRAY_APPEND(IFNULL(`update_safety_history`, '[]'), "
                                 f"'$', %s)")
            update_params.append(current_time)
            print("safety_flag为1，sender_type为1，将更新update_safety_history字段")
        elif sender_type == 2:
            # 添加到中建施工部 update_construct_history
            update_clause.append(f"`update_construct_history` = JSON_ARRAY_APPEND(IFNULL(`update_construct_history`, "
                                 f"'[]'), '$', %s)")
            update_params.append(current_time)
            print("safety_flag为1，sender_type为2，将更新update_construct_history字段")
        else:
            # 添加update_history字段的更新
            update_clause.append(f"`update_history` = JSON_ARRAY_APPEND(IFNULL(`update_history`, '[]'), '$', %s)")
            update_params.append(current_time)
            print("safety_flag为1，将更新update_history字段")
    else:
        print(f"safety_flag为{safety_flag}，跳过update_history字段更新")

    if not update_clause:
        return jsonify({"error": "无可更新字段"}), 400

    sql = f"UPDATE `{TABLE_NAME}` SET {', '.join(update_clause)} WHERE {' AND '.join(conditions)}"
    total_params = tuple(update_params + params)

    print("SQL:", sql)
    print("Params:", total_params)

    select_sql = f"SELECT * FROM `{TABLE_NAME}` WHERE {' AND '.join(conditions)}"
    print("Debug SELECT SQL:", select_sql)
    print("Debug SELECT Params:", params)

    try:
        # 执行 SELECT 查询，设置 fetch=True 获取结果集
        select_result = execute_query(select_sql, params, fetch=True)
        select_count = len(select_result) if select_result else 0
        print("SELECT result count:", select_count)

        # 如果记录存在，返回成功（即使更新没有影响行）
        if select_count > 0:
            count = execute_query(sql, total_params, fetch=False)
            return jsonify({
                "status": "ok",
                "updated_count": count,
                "message": "记录存在，无需更新" if count == 0 else "更新成功"
            })
        else:
            return jsonify({
                "error": "未找到匹配记录",
                "sql": sql,
                "params": total_params,
                "select_sql": select_sql,
                "select_params": params
            }), 404
    except Exception as e:
        print("Query error:", str(e))
        return jsonify({"error": f"查询失败: {str(e)}"}), 500


def validate_scaffold_group_fields(filters):
    """
    校验外墙棚架群组的必填字段

    Args:
        filters (dict): 过滤条件字典

    Returns:
        dict or None: 如果校验失败返回错误信息字典，否则返回None
    """
    # 外墙棚架群组校验必填字段
    app_id = filters.get("application_id")
    if app_id is not None and app_id != "":
        return None
    is_scaffold_group = filters.get("group_id") in EXTERNAL_SCAFFOLDING_GROUPS
    required = ["subcontractor", "process"]

    name_dict = {
        "subcontractor": "分判",
        "process": "工序"
    }

    if is_scaffold_group:
        # 检查缺失字段
        missing_keys = [k for k in required if not filters.get(k)]
        if missing_keys:
            missing_names = [name_dict[k] for k in missing_keys]
            return {
                "error": f"缺少字段: {', '.join(missing_names)}，更新安全相、撤离时，请输入必填字段：[分判商][工序]"
            }

    return None


# 新增工人
@app.route("/records/add_worker", methods=["POST"])
def add_worker():
    data = request.get_json(force=True)

    # 1. 支持批量或单条
    if isinstance(data, list):
        results = []
        for rec in data:
            res = add_worker_func(rec)
            results.append(res)
        # 可返回所有条目结果
        return jsonify(results), 207 if any(r.get('error') for r in results) else 201

    # 单条
    res = add_worker_func(data)
    if "error" in res:
        return jsonify(res), 200
    return jsonify(res), 201


def add_worker_func(data):
    """
    新增工人：累加更新现有记录的 number 字段
    - 不处理外墙棚架群组
    - 需要 location, floor, number, subcontractor 四个必填字段
    - 根据 group_id, location, subcontractor, floor 和当天日期查询记录
    - 如果存在则累加更新 number 字段
    """
    # 1. 校验是否为外墙棚架群组
    group_id = data.get("group_id", "")
    if group_id in EXTERNAL_SCAFFOLDING_GROUPS:
        return {"error": "外墙棚架群组不支持新增工人操作"}

    # 2. 校验必填字段
    required = ["location", "floor", "number", "subcontractor"]
    name_dict = {
        "location": "位置",
        "floor": "樓層",
        "number": "人數",
        "subcontractor": "分判"
    }
    missing_keys = [k for k in required if not data.get(k)]
    if missing_keys:
        missing_names = [name_dict[k] for k in missing_keys]
        return {"error": f"缺少必填字段: {', '.join(missing_names)}"}

    # 校验 number 是否为有效数字
    try:
        add_number = int(data.get("number", 0))
        if add_number <= 0:
            return {"error": "新增人數必須大於0"}
    except (ValueError, TypeError):
        return {"error": "人數必須為有效數字"}

    # 3. 查询数据库是否存在记录
    # 使用当天的日期范围进行查询 +8小时
    today_str = datetime.now(pytz.timezone('Asia/Shanghai')).strftime("%Y-%m-%d")
    start_time = f"{today_str} 00:00:00"
    end_time = f"{today_str} 23:59:59"
    # 打印时间日志用于调试
    print(f"新增工人-查询时间范围: {start_time} 至 {end_time}")

    # 构建查询SQL（参考 insert_one_record 中非外墙群组的查询逻辑）
    check_sql = f"""
        SELECT id, number FROM `{TABLE_NAME}`
        WHERE `group_id`=%s AND REPLACE(`location`,' ','')=%s AND `subcontractor`=%s 
        AND REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(`floor`, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',') = REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',')
        AND `bstudio_create_time` BETWEEN %s AND %s
        ORDER BY id DESC LIMIT 1
    """
    params = (
        clean_string(group_id),
        clean_string(data.get("location", "")),
        clean_string(data.get("subcontractor", "")),
        clean_string(data.get("floor", "")),
        start_time,
        end_time
    )

    conn = get_conn()
    exists = None
    try:
        with conn.cursor() as cur:
            cur.execute(check_sql, params)
            exists = cur.fetchone()
    finally:
        conn.close()

    # 4. 如果不存在记录，返回错误
    if not exists:
        return {"error": "未找到匹配的记录，无法新增工人"}

    # 5. 如果存在，累加更新 number 字段
    record_id = exists["id"]
    current_number = int(exists.get("number", 0))
    new_number = current_number + add_number

    update_sql = f"UPDATE `{TABLE_NAME}` SET `number`=%s WHERE `id`=%s"
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(update_sql, (new_number, record_id))
            conn.commit()
        return {
            "status": "ok",
            "id": record_id,
            "old_number": current_number,
            "added_number": add_number,
            "new_number": new_number
        }
    finally:
        conn.close()


@app.route("/records/<int:record_id>", methods=["PUT"])
def update_record(record_id):
    data = request.get_json(force=True)
    updates = [f"`{k}`=%s" for k in data if k in FIELDS and k != "id"]
    if not updates:
        return jsonify({"error": "无可更新字段"}), 400

    sql = f"UPDATE `{TABLE_NAME}` SET {', '.join(updates)} WHERE `id`=%s"
    params = tuple(data[k] for k in data if k in FIELDS and k != "id") + (record_id,)

    if execute_query(sql, params) == 0:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify({"status": "ok", "updated_id": record_id})


@app.route("/records", methods=["DELETE"])
def delete_records():
    filters = request.get_json(silent=True) or request.args.to_dict()
    if not filters:
        return jsonify({"error": "请提供过滤条件"}), 400

    conditions, params = [], []
    for key, value in filters.items():
        if key in FIELDS:
            if key == "bstudio_create_time":
                norm = normalize_date(value)
                if norm:
                    start, end = f"{norm} 00:00:00", f"{norm} 23:59:59"
                    conditions.append(f"`{key}` BETWEEN %s AND %s")
                    params.extend([start, end])
                    continue
            if key == "floor":
                conditions.append("REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(`floor`, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',') = REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',')")
                params.append(value)
                continue
            conditions.append(f"`{key}` = %s")
            params.append(value)

    if not conditions:
        return jsonify({"error": "没有有效过滤字段"}), 400

    sql = f"DELETE FROM `{TABLE_NAME}` WHERE {' AND '.join(conditions)}"
    deleted = execute_query(sql, params)
    if deleted == 0:
        return jsonify({"error": f"未找到匹配的记录"}), 404
    return jsonify({"status": "ok", "deleted_count": deleted})


@app.route("/delete_fastgpt_records", methods=["POST"])
def delete_fastgpt_records():
    filters = request.get_json(silent=True) or request.args.to_dict()
    print(f"Received request data: {filters}")

    if not filters:
        return jsonify({"error": "请提供过滤条件"}), 400

    conditions = []
    params = []
    for key, value in filters.items():
        print(f"Processing filter: {key} = {value} (type: {type(value)})")
        if key in FIELDS:
            if key == "bstudio_create_time":
                norm = normalize_date(value)
                if norm:
                    start, end = f"{norm} 00:00:00", f"{norm} 23:59:59"
                    conditions.append(f"`{key}` BETWEEN %s AND %s")
                    params.extend([start, end])
                    print(f"Date range for {key}: {start} to {end}")
                    continue
            if key == "floor":
                # 统一清理空格，并将各种形式的横线和逗号替换为单逗号，忽略大小写
                conditions.append("LOWER(REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(`floor`, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ',')) = LOWER(REGEXP_REPLACE(REPLACE(REPLACE(REPLACE(%s, ' ', ''), '、', ','), '，', ','), '[-—–−－]+', ','))")
                params.append(str(value))
            elif key in ["group_id", "location", "subcontractor", "project", "uuid"]:
                # 移除所有空格（包括中间空格）并忽略大小写
                conditions.append(f"LOWER(REGEXP_REPLACE(`{key}`, '\\s+', '')) = LOWER(REGEXP_REPLACE(%s, '\\s+', ''))")
                params.append(str(value))
            else:
                conditions.append(f"`{key}` = %s")
                params.append(value)
        else:
            print(f"Warning: Invalid filter field '{key}', skipping")

    if not conditions:
        return jsonify({"error": "没有有效过滤字段"}), 400

    # 先查询是否存在匹配的记录
    select_sql = f"SELECT * FROM `{TABLE_NAME}` WHERE {' AND '.join(conditions)}"
    select_params = tuple(params)
    
    print(f"Generated SELECT SQL: {select_sql}")
    print(f"SELECT params: {select_params}")
    
    try:
        select_result = execute_query(select_sql, select_params, fetch=True)
        select_count = len(select_result) if select_result else 0
        print(f"SELECT result count: {select_count}")
        
        if select_count == 0:
            # 未找到匹配记录，返回明确的错误信息
            error_msg = "未找到匹配记录"
            # 如果有application_id，明确告知找不到该编号
            if filters.get("application_id"):
                error_msg = f"找唔到編號 {filters.get('application_id')}"
            return jsonify({
                "error": error_msg,
                "message": error_msg,
                "found": False
            }), 404
        
        # 找到了记录，执行删除
        sql = f"DELETE FROM `{TABLE_NAME}` WHERE {' AND '.join(conditions)}"
        total_params = tuple(params)
        
        print(f"Generated DELETE SQL: {sql}")
        print(f"DELETE params: {total_params}")
        
        deleted = execute_query(sql, total_params)
        print(f"Deleted rows count: {deleted}")
        
        if deleted == 0:
            # 这种情况理论上不应该发生，因为已经查询到了记录
            return jsonify({
                "error": "删除失败，记录可能已被其他操作删除",
                "message": "删除失败，记录可能已被其他操作删除",
                "found": True,
                "deleted": False
            }), 500
        
        return jsonify({
            "status": "ok", 
            "deleted_count": deleted,
            "message": "删除成功"
        })
    except Exception as e:
        print(f"Delete query error: {str(e)}")
        return jsonify({
            "error": f"删除操作失败: {str(e)}",
            "message": f"删除操作失败: {str(e)}"
        }), 500


@app.route("/columns", methods=["GET"])
def show_columns():
    table = request.args.get("table")
    if not table:
        return jsonify({"error": "请提供表名"}), 400
    sql = f"SHOW COLUMNS FROM `{table}`"
    rows = execute_query(sql, fetch=True)
    return jsonify({"columns": [row["Field"] for row in rows]})



@app.route("/convert", methods=["POST"])
def convert_text():
    """
    中文转换接口
    接收原始文本作为 body，target 通过 query 参数或 header 指定（默认 zh-hant）
    支持的 target: zh-cn, zh-tw, zh-hk, zh-sg, zh-hans, zh-hant
    返回: {"ok": True, "result": "转换后的文本"}
    """
    # 直接读取原始文本内容
    text = request.get_data(as_text=True)
    if not text:
        return _json_error("缺少文本内容", 400)
    
    # 从 query 参数或 header 获取 target，默认 zh-hant
    target = request.args.get("target") or request.headers.get("X-Target", "zh-hant")
    
    valid_targets = ["zh-cn", "zh-tw", "zh-hk", "zh-sg", "zh-hans", "zh-hant"]
    if target not in valid_targets:
        return _json_error(
            f"参数 target 无效，支持的值: {', '.join(valid_targets)}", 
            400,
            code="invalid_target"
        )
    
    try:
        result = convert(text, target)
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        return _json_error("转换失败", 500, code="convert_failed", detail=str(e))


# ==========================
# jiaodika 表：查询 & 更新
# ==========================


@app.route("/jiaodika", methods=["GET"])
def list_jiaodika():
    """
    查询 jiaodika 表
    - 支持 URL query 参数和 GET JSON body 作为过滤条件
    - 仅支持已知字段过滤（JIAODIKA_FIELDS）
    """
    query_filters = request.args.to_dict()
    body_filters = request.get_json(silent=True) or {}
    if not isinstance(body_filters, dict):
        body_filters = {}

    filters = {**body_filters, **query_filters}

    conditions = []
    params = []
    for k, v in filters.items():
        if k in JIAODIKA_FIELDS:
            if k == "bstudio_create_time" and v:
                # 支持传 YYYY-MM-DD，按一天范围查
                try:
                    dt = datetime.strptime(v[:10], "%Y-%m-%d")
                    start = dt.strftime("%Y-%m-%d 00:00:00")
                    end = dt.strftime("%Y-%m-%d 23:59:59")
                    conditions.append("`bstudio_create_time` BETWEEN %s AND %s")
                    params.extend([start, end])
                    continue
                except Exception:
                    # 解析失败则按等值匹配
                    pass
            conditions.append(f"`{k}`=%s")
            params.append(v)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM `{JIAODIKA_TABLE}` {where} ORDER BY `id`"
    rows = execute_query(sql, tuple(params), fetch=True)
    return jsonify(rows)


def _insert_one_jiaodika(data: dict):
    """
    插入一条 jiaodika 记录
    - 允许部分字段缺省，只插入提供的字段
    - 自动填充 bstudio_create_time / updated_at（如未提供）
    """
    if not isinstance(data, dict):
        return {"error": "每条记录必须是 JSON 对象"}

    # 自动时间
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    record = {}
    for k in JIAODIKA_FIELDS:
        if k == "id":
            # 一般由数据库自增，如需手动传入也允许
            if "id" in data:
                record["id"] = data.get("id")
            continue
        if k == "bstudio_create_time":
            record[k] = data.get(k) or now_str
            continue
        if k == "updated_at":
            record[k] = data.get(k) or now_str
            continue
        if k in data:
            record[k] = data.get(k)

    # 只插入有值的字段
    cols = []
    vals = []
    for k, v in record.items():
        if v is not None:
            cols.append(f"`{k}`")
            vals.append(v)

    if not cols:
        return {"error": "没有可插入字段"}

    placeholders = ", ".join(["%s"] * len(cols))
    cols_sql = ", ".join(cols)
    sql = f"INSERT INTO `{JIAODIKA_TABLE}` ({cols_sql}) VALUES ({placeholders})"

    try:
        affected = execute_query(sql, tuple(vals))
        return {"status": "ok", "affected_rows": affected}
    except Exception as e:
        return {"error": "插入失败", "detail": str(e)}


@app.route("/jiaodika", methods=["POST"])
def create_jiaodika():
    """
    新增 jiaodika 记录
    - 支持单条：body 为 JSON 对象
    - 支持批量：body 为 JSON 数组
    """
    data = request.get_json(force=True)

    # 批量
    if isinstance(data, list):
        results = []
        for rec in data:
            res = _insert_one_jiaodika(rec)
            results.append(res)
        # 有错误时返回 207，和 /records 接口风格保持一致
        has_error = any(isinstance(r, dict) and r.get("error") for r in results)
        return jsonify(results), 207 if has_error else 201

    # 单条
    res = _insert_one_jiaodika(data)
    if isinstance(res, dict) and res.get("error"):
        # 和上面 /records 保持类似语义，这里直接 200 兼容现有调用方式
        return jsonify(res), 200
    return jsonify(res), 201


@app.route("/jiaodika/<int:record_id>", methods=["PUT"])
def update_jiaodika(record_id):
    """
    按 id 更新 jiaodika 表
    - body 为要更新的字段，忽略 id
    """
    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return jsonify({"error": "body 必须是 JSON 对象"}), 400

    updates = [f"`{k}`=%s" for k in data if k in JIAODIKA_FIELDS and k != "id"]
    if not updates:
        return jsonify({"error": "无可更新字段"}), 400

    sql = f"UPDATE `{JIAODIKA_TABLE}` SET {', '.join(updates)} WHERE `id`=%s"
    params = tuple(data[k] for k in data if k in JIAODIKA_FIELDS and k != "id") + (record_id,)

    affected = execute_query(sql, params)
    if affected == 0:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify({"status": "ok", "updated_id": record_id})


# ==========================
# group_files 表：查询 & 更新
# ==========================


@app.route("/group_files", methods=["GET"])
def list_group_files():
    """
    查询 group_files 表
    - 支持 URL query 参数和 GET JSON body 作为过滤条件
    - 仅支持已知字段过滤（GROUP_FILES_FIELDS）
    """
    query_filters = request.args.to_dict()
    body_filters = request.get_json(silent=True) or {}
    if not isinstance(body_filters, dict):
        body_filters = {}

    filters = {**body_filters, **query_filters}

    conditions = []
    params = []
    for k, v in filters.items():
        if k in GROUP_FILES_FIELDS:
            if k == "bstudio_create_time" and v:
                # 支持传 YYYY-MM-DD，按一天范围查
                try:
                    dt = datetime.strptime(v[:10], "%Y-%m-%d")
                    start = dt.strftime("%Y-%m-%d 00:00:00")
                    end = dt.strftime("%Y-%m-%d 23:59:59")
                    conditions.append("`bstudio_create_time` BETWEEN %s AND %s")
                    params.extend([start, end])
                    continue
                except Exception:
                    # 解析失败则按等值匹配
                    pass
            conditions.append(f"`{k}`=%s")
            params.append(v)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM `{GROUP_FILES_TABLE}` {where} ORDER BY `id` DESC"
    rows = execute_query(sql, tuple(params), fetch=True)
    return jsonify(rows)


def _insert_one_group_file(data: dict):
    """
    插入一条 group_files 记录
    - 允许部分字段缺省，只插入提供的字段
    - 自动填充 bstudio_create_time（如未提供）
    - group_id, file_url, file_name 为必填字段
    """
    if not isinstance(data, dict):
        return {"error": "每条记录必须是 JSON 对象"}

    # 校验必填字段
    if not data.get("group_id"):
        return {"error": "缺少必填字段: group_id"}
    if not data.get("file_url"):
        return {"error": "缺少必填字段: file_url"}
    if not data.get("file_name"):
        return {"error": "缺少必填字段: file_name"}

    # 自动时间
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    record = {}
    for k in GROUP_FILES_FIELDS:
        if k == "id":
            # 一般由数据库自增，如需手动传入也允许
            if "id" in data:
                record["id"] = data.get("id")
            continue
        if k == "bstudio_create_time":
            record[k] = data.get(k) or now_str
            continue
        if k in data:
            record[k] = data.get(k)

    # 只插入有值的字段
    cols = []
    vals = []
    for k, v in record.items():
        if v is not None:
            cols.append(f"`{k}`")
            vals.append(v)

    if not cols:
        return {"error": "没有可插入字段"}

    placeholders = ", ".join(["%s"] * len(cols))
    cols_sql = ", ".join(cols)
    sql = f"INSERT INTO `{GROUP_FILES_TABLE}` ({cols_sql}) VALUES ({placeholders})"

    try:
        inserted_id = execute_query(sql, tuple(vals), return_lastrowid=True)
        return {"status": "ok", "inserted_id": inserted_id, "affected_rows": 1}
    except Exception as e:
        return {"error": "插入失败", "detail": str(e)}


@app.route("/group_files", methods=["POST"])
def create_group_file():
    """
    新增 group_files 记录
    - 支持单条：body 为 JSON 对象
    - 支持批量：body 为 JSON 数组
    """
    data = request.get_json(force=True)

    # 批量
    if isinstance(data, list):
        results = []
        for rec in data:
            res = _insert_one_group_file(rec)
            results.append(res)
        # 有错误时返回 207，和 /records 接口风格保持一致
        has_error = any(isinstance(r, dict) and r.get("error") for r in results)
        return jsonify(results), 207 if has_error else 201

    # 单条
    res = _insert_one_group_file(data)
    if isinstance(res, dict) and res.get("error"):
        # 和上面 /records 保持类似语义，这里直接 200 兼容现有调用方式
        return jsonify(res), 200
    return jsonify(res), 201


@app.route("/group_files/<int:record_id>", methods=["GET"])
def get_group_file(record_id):
    """按 id 查询 group_files 记录"""
    sql = f"SELECT * FROM `{GROUP_FILES_TABLE}` WHERE `id`=%s"
    rows = execute_query(sql, (record_id,), fetch=True)
    if not rows:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify(rows[0])


@app.route("/group_files/<int:record_id>", methods=["PUT"])
def update_group_file(record_id):
    """
    按 id 更新 group_files 表
    - body 为要更新的字段，忽略 id
    """
    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return jsonify({"error": "body 必须是 JSON 对象"}), 400

    updates = [f"`{k}`=%s" for k in data if k in GROUP_FILES_FIELDS and k != "id"]
    if not updates:
        return jsonify({"error": "无可更新字段"}), 400

    sql = f"UPDATE `{GROUP_FILES_TABLE}` SET {', '.join(updates)} WHERE `id`=%s"
    params = tuple(data[k] for k in data if k in GROUP_FILES_FIELDS and k != "id") + (record_id,)

    affected = execute_query(sql, params)
    if affected == 0:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify({"status": "ok", "updated_id": record_id})


@app.route("/group_files/<int:record_id>", methods=["DELETE"])
def delete_group_file(record_id):
    """按 id 删除 group_files 记录"""
    sql = f"DELETE FROM `{GROUP_FILES_TABLE}` WHERE `id`=%s"
    deleted = execute_query(sql, (record_id,))
    if deleted == 0:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify({"status": "ok", "deleted_id": record_id})


# ==========================
# 邮箱账号密码表：CRUD 接口
# ==========================

@app.route("/email_accounts", methods=["GET"])
def list_email_accounts():
    """
    查询邮箱账号列表
    - 支持 URL query 参数和 GET JSON body 作为过滤条件
    - 返回时自动解密密码字段
    """
    query_filters = request.args.to_dict()
    body_filters = request.get_json(silent=True) or {}
    if not isinstance(body_filters, dict):
        body_filters = {}

    filters = {**body_filters, **query_filters}

    conditions = []
    params = []
    for k, v in filters.items():
        if k in EMAIL_ACCOUNT_FIELDS:
            conditions.append(f"`{k}`=%s")
            params.append(v)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM `{EMAIL_ACCOUNT_TABLE}` {where} ORDER BY `id`"
    rows = execute_query(sql, tuple(params), fetch=True)

    # 不返回密码字段（包括加密和明文的）
    for row in rows:
        if "encrypted_password" in row:
            del row["encrypted_password"]
        if "password" in row:
            del row["password"]

    return jsonify(rows)


@app.route("/email_accounts/credentials", methods=["POST"])
def list_email_account_credentials():
    """
    内部接口：返回邮箱账号 + 加密密码（不解密）
    - 只允许 POST JSON body，禁止 URL query（避免进 nginx/flask 日志）
    - 可选：如果设置了环境变量 EMAIL_ACCOUNTS_CREDENTIALS_TOKEN，则要求请求携带 token
      - Header: Authorization: Bearer <token>  或  X-Internal-Token: <token>
    - body 可选字段：
      - email_account: 指定单个账号；不传则返回全部
    """
    if request.args:
        return _json_error("隐私要求：/email_accounts/credentials 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    # 可选 token 保护（不破坏现有部署：未配置 token 时不强制）
    required_token = os.getenv("EMAIL_ACCOUNTS_CREDENTIALS_TOKEN") or ""
    if required_token:
        auth = request.headers.get("Authorization", "") or ""
        internal = request.headers.get("X-Internal-Token", "") or ""
        got = ""
        if auth.lower().startswith("bearer "):
            got = auth.split(" ", 1)[1].strip()
        elif internal:
            got = internal.strip()
        if got != required_token.strip():
            return _json_error("未授权", 401, code="unauthorized")

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    email_account = data.get("email_account")
    if email_account is not None:
        email_account = str(email_account).strip()

    try:
        if email_account:
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
            rows = execute_query(sql, (email_account,), fetch=True)
        else:
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` ORDER BY `id`"
            rows = execute_query(sql, (), fetch=True)
        return jsonify({"ok": True, "results": rows})
    except Exception as e:
        return _json_error("读取邮箱账号失败", 500, code="email_accounts_credentials_failed", detail=str(e))


@app.route("/email_accounts/plain_credentials", methods=["POST"])
def list_email_account_plain_credentials():
    """
    内部接口：返回邮箱账号 + 明文密码（会解密）
    - 只允许 POST JSON body，禁止 URL query（避免进 nginx/flask 日志）
    - 强制 token 保护：必须设置环境变量 EMAIL_ACCOUNTS_PLAINTEXT_TOKEN
      - Header: Authorization: Bearer <token>  或  X-Internal-Token: <token>
    - body 可选字段：
      - email_account: 指定单个账号；不传则返回全部
    """
    if request.args:
        return _json_error("隐私要求：/email_accounts/plain_credentials 不允许使用 URL query 传参，请全部放到 JSON body", 400)

    required_token = os.getenv("EMAIL_ACCOUNTS_PLAINTEXT_TOKEN") or ""
    if not required_token:
        return _json_error("服务端未配置 EMAIL_ACCOUNTS_PLAINTEXT_TOKEN，拒绝提供明文密码接口", 403, code="plaintext_token_not_configured")

    auth = request.headers.get("Authorization", "") or ""
    internal = request.headers.get("X-Internal-Token", "") or ""
    got = ""
    if auth.lower().startswith("bearer "):
        got = auth.split(" ", 1)[1].strip()
    elif internal:
        got = internal.strip()
    if got != required_token.strip():
        return _json_error("未授权", 401, code="unauthorized")

    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    email_account = data.get("email_account")
    if email_account is not None:
        email_account = str(email_account).strip()

    try:
        if email_account:
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
            rows = execute_query(sql, (email_account,), fetch=True)
        else:
            sql = f"SELECT `email_account`, `encrypted_password` FROM `{EMAIL_ACCOUNT_TABLE}` ORDER BY `id`"
            rows = execute_query(sql, (), fetch=True)

        results = []
        for r in rows or []:
            acc = r.get("email_account")
            enc = r.get("encrypted_password")
            if not acc or not enc:
                continue
            try:
                pwd = decrypt_password(enc)
            except Exception as e:
                results.append({"email_account": acc, "password": None, "decrypt_error": str(e)})
                continue
            results.append({"email_account": acc, "password": pwd})

        return jsonify({"ok": True, "results": results})
    except Exception as e:
        return _json_error("读取邮箱账号失败", 500, code="email_accounts_plain_credentials_failed", detail=str(e))


@app.route("/email_accounts/check", methods=["GET", "POST"])
def check_email_account_exists():
    """
    检查邮箱账号是否存在
    - 支持 URL query 参数和 JSON body
    - 返回简单的状态信息
    """
    query_params = request.args.to_dict()
    body_params = request.get_json(silent=True) or {}
    if not isinstance(body_params, dict):
        body_params = {}
    
    params = {**body_params, **query_params}
    email_account = params.get("email_account")
    
    if not email_account:
        return jsonify({"status": "error", "message": "缺少参数: email_account"}), 400
    
    # 检查是否存在
    check_sql = f"SELECT `id` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
    existing = execute_query(check_sql, (email_account,), fetch=True)
    
    if existing:
        return jsonify({"status": "exists", "exists": True})
    else:
        return jsonify({"status": "not_found", "exists": False})


@app.route("/email_accounts", methods=["POST"])
def create_email_account():
    """
    新增邮箱账号
    - 支持单条：body 为 JSON 对象
    - 支持批量：body 为 JSON 数组
    - password 字段明文传入，自动加密存储
    """
    data = request.get_json(force=True)

    # 批量
    if isinstance(data, list):
        results = []
        for rec in data:
            res = _insert_one_email_account(rec)
            results.append(res)
        has_error = any(isinstance(r, dict) and r.get("error") for r in results)
        return jsonify(results), 207 if has_error else 201

    # 单条
    res = _insert_one_email_account(data)
    if isinstance(res, dict) and res.get("error"):
        return jsonify(res), 200
    return jsonify(res), 201


def _insert_one_email_account(data: dict):
    """插入一条邮箱账号记录，如果已存在则更新密码"""
    if not isinstance(data, dict):
        return {"error": "每条记录必须是 JSON 对象"}

    # 校验必填字段
    email_account = data.get("email_account")
    if not email_account:
        return {"error": "缺少必填字段: email_account"}

    # 处理密码：明文输入，加密存储
    password = data.get("password") or data.get("email_password", "")
    if not password:
        return {"error": "缺少必填字段: password"}

    try:
        encrypted_password = encrypt_password(password)
    except Exception as e:
        return {"error": f"密码加密失败: {str(e)}"}

    # 测试邮箱登录
    imap_server = data.get("imap_server") or DEFAULT_IMAP_SERVER
    imap_port = data.get("imap_port") or DEFAULT_IMAP_PORT
    login_success, login_error = test_email_login(email_account, password, imap_server, imap_port)
    if not login_success:
        return {"status": "login fail", "error": login_error}

    # 检查是否已存在
    check_sql = f"SELECT `id` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
    existing = execute_query(check_sql, (email_account,), fetch=True)
    
    if existing:
        # 已存在，更新密码
        record_id = existing[0]["id"]
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        updates = {
            "encrypted_password": encrypted_password,
            "updated_at": now_str,
        }
        
        # 如果提供了 description，也更新
        if "description" in data:
            updates["description"] = data.get("description", "")
        
        update_fields = [f"`{k}`=%s" for k in updates.keys()]
        sql = f"UPDATE `{EMAIL_ACCOUNT_TABLE}` SET {', '.join(update_fields)} WHERE `id`=%s"
        params = tuple(updates.values()) + (record_id,)
        
        try:
            affected = execute_query(sql, params)
            return {"status": "updated", "updated_id": record_id, "affected_rows": affected}
        except Exception as e:
            return {"error": "更新失败", "detail": str(e)}
    else:
        # 不存在，插入新记录
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        record = {
            "email_account": email_account,
            "encrypted_password": encrypted_password,
            "description": data.get("description", ""),
            "created_at": data.get("created_at") or now_str,
            "updated_at": data.get("updated_at") or now_str,
        }

        # 如果提供了 id，也插入
        if "id" in data:
            record["id"] = data.get("id")

        # 构建 SQL
        cols = [f"`{k}`" for k in record.keys()]
        placeholders = ", ".join(["%s"] * len(cols))
        cols_sql = ", ".join(cols)
        sql = f"INSERT INTO `{EMAIL_ACCOUNT_TABLE}` ({cols_sql}) VALUES ({placeholders})"

        try:
            affected = execute_query(sql, tuple(record.values()))
            return {"status": "created", "affected_rows": affected}
        except Exception as e:
            return {"error": "插入失败", "detail": str(e)}


@app.route("/email_accounts/<int:record_id>", methods=["GET"])
def get_email_account(record_id):
    """按 id 查询邮箱账号（自动解密密码）"""
    sql = f"SELECT * FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `id`=%s"
    rows = execute_query(sql, (record_id,), fetch=True)
    if not rows:
        return jsonify({"error": "未找到该记录"}), 404

    row = rows[0]
    # 解密密码
    if row.get("encrypted_password"):
        try:
            row["password"] = decrypt_password(row["encrypted_password"])
        except Exception as e:
            row["password"] = None
            row["decrypt_error"] = str(e)
    # 不返回加密后的密码字段
    if "encrypted_password" in row:
        del row["encrypted_password"]

    return jsonify(row)


@app.route("/email_accounts/<int:record_id>", methods=["PUT"])
def update_email_account(record_id):
    """
    按 id 更新邮箱账号
    - body 为要更新的字段，忽略 id
    - 如果提供了 password 字段（明文），会自动加密后更新 encrypted_password
    """
    data = request.get_json(force=True)
    if not isinstance(data, dict):
        return jsonify({"error": "body 必须是 JSON 对象"}), 400

    # 处理密码字段
    if "password" in data or "email_password" in data:
        password = data.get("password") or data.get("email_password", "")
        try:
            encrypted_password = encrypt_password(password)
            data["encrypted_password"] = encrypted_password
            # 移除明文密码字段
            data.pop("password", None)
            data.pop("email_password", None)
        except Exception as e:
            return jsonify({"error": f"密码加密失败: {str(e)}"}), 400

    # 自动更新 updated_at
    data["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    updates = [f"`{k}`=%s" for k in data if k in EMAIL_ACCOUNT_FIELDS and k != "id"]
    if not updates:
        return jsonify({"error": "无可更新字段"}), 400

    sql = f"UPDATE `{EMAIL_ACCOUNT_TABLE}` SET {', '.join(updates)} WHERE `id`=%s"
    params = tuple(data[k] for k in data if k in EMAIL_ACCOUNT_FIELDS and k != "id") + (record_id,)

    affected = execute_query(sql, params)
    if affected == 0:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify({"status": "ok", "updated_id": record_id})


@app.route("/email_accounts/<int:record_id>", methods=["DELETE"])
def delete_email_account(record_id):
    """按 id 删除邮箱账号"""
    sql = f"DELETE FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `id`=%s"
    deleted = execute_query(sql, (record_id,))
    if deleted == 0:
        return jsonify({"error": "未找到该记录"}), 404
    return jsonify({"status": "ok", "deleted_id": record_id})


@app.route("/email_accounts/update_refresh_token", methods=["POST"])
def update_refresh_token():
    """
    更新邮箱账号的 user_refresh_token
    - email_account: 邮箱账号（必填）
    - user_refresh_token: 刷新令牌（必填）
    """
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "body 必须是 JSON 对象"}), 400

    try:
        email_account = _require_str(data, "email_account")
        user_refresh_token = _require_str(data, "user_refresh_token")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # 自动更新 updated_at
    updated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 更新 user_refresh_token 和 updated_at
    sql = f"UPDATE `{EMAIL_ACCOUNT_TABLE}` SET `user_refresh_token`=%s, `updated_at`=%s WHERE `email_account`=%s"
    params = (user_refresh_token, updated_at, email_account)

    try:
        affected = execute_query(sql, params)
        if affected == 0:
            return jsonify({"error": "未找到该邮箱账号"}), 404
        return jsonify({
            "status": "ok",
            "email_account": email_account,
            "message": "刷新令牌更新成功"
        })
    except Exception as e:
        return jsonify({"error": f"更新失败: {str(e)}"}), 500


@app.route("/email_accounts/get_refresh_token", methods=["GET", "POST"])
def get_refresh_token():
    """
    查询邮箱账号的 user_refresh_token
    - email_account: 邮箱账号（必填）
    - 支持 GET（通过 query 参数）和 POST（通过 JSON body）
    """
    # 支持 GET 和 POST 两种方式
    if request.method == "GET":
        email_account = request.args.get("email_account")
    else:
        data = request.get_json(silent=True) or {}
        if not isinstance(data, dict):
            return jsonify({"error": "body 必须是 JSON 对象"}), 400
        email_account = data.get("email_account")

    if not email_account or not str(email_account).strip():
        return jsonify({"error": "缺少参数: email_account"}), 400

    email_account = str(email_account).strip()

    # 查询 user_refresh_token
    sql = f"SELECT `email_account`, `user_refresh_token`, `updated_at` FROM `{EMAIL_ACCOUNT_TABLE}` WHERE `email_account`=%s"
    params = (email_account,)

    try:
        rows = execute_query(sql, params, fetch=True)
        if not rows:
            return jsonify({"error": "未找到该邮箱账号"}), 404
        
        row = rows[0]
        return jsonify({
            "status": "ok",
            "email_account": row.get("email_account"),
            "user_refresh_token": row.get("user_refresh_token"),
            "updated_at": row.get("updated_at")
        })
    except Exception as e:
        return jsonify({"error": f"查询失败: {str(e)}"}), 500


# ==========================
# email_everyday 表：查询接口
# ==========================

@app.route("/email_everyday", methods=["GET"])
def list_email_everyday():
    """
    查询 email_everyday 表（已处理的邮件记录）
    - 支持 URL query 参数和 GET JSON body 作为过滤条件
    - 支持按 email_account, email_id, received_time 等字段过滤
    """
    query_filters = request.args.to_dict()
    body_filters = request.get_json(silent=True) or {}
    if not isinstance(body_filters, dict):
        body_filters = {}

    filters = {**body_filters, **query_filters}

    conditions = []
    params = []
    for k, v in filters.items():
        if k in EMAIL_EVERYDAY_FIELDS:
            if k == "received_time" and v:
                # 支持传 YYYY-MM-DD，按一天范围查
                try:
                    dt = datetime.strptime(v[:10], "%Y-%m-%d")
                    start = dt.strftime("%Y-%m-%d 00:00:00")
                    end = dt.strftime("%Y-%m-%d 23:59:59")
                    conditions.append("`received_time` BETWEEN %s AND %s")
                    params.extend([start, end])
                    continue
                except Exception:
                    # 解析失败则按等值匹配
                    pass
            conditions.append(f"`{k}`=%s")
            params.append(v)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM `{EMAIL_EVERYDAY_TABLE}` {where} ORDER BY `received_time` DESC, `id` DESC"
    rows = execute_query(sql, tuple(params), fetch=True)
    return jsonify(rows)


@app.route("/email_everyday/check", methods=["POST"])
def check_email_handled():
    """
    检查邮件是否已被处理
    - email_account: 邮箱账号（必填）
    - email_ids: 邮件 UID 列表（字符串、整数或列表），多个用逗号分隔（必填）
    - 返回每个邮件 ID 的处理状态
    """
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return _json_error("body 必须是 JSON object", 400)

    try:
        email_account = _require_str(data, "email_account")
        email_ids = data.get("email_ids") or data.get("email_uids") or data.get("uid") or data.get("uids")
        if not email_ids:
            raise ValueError("缺少参数: email_ids")
    except ValueError as e:
        return _json_error(str(e), 400)

    # 处理 UID 列表
    if isinstance(email_ids, str):
        uid_list = [uid.strip() for uid in email_ids.split(",")]
    elif isinstance(email_ids, list):
        uid_list = [str(uid) for uid in email_ids]
    else:
        uid_list = [str(email_ids)]

    try:
        # 查询这些邮件 ID 是否已处理
        placeholders = ", ".join(["%s"] * len(uid_list))
        sql = f"""
            SELECT `email_id`, `received_time` 
            FROM `{EMAIL_EVERYDAY_TABLE}` 
            WHERE `email_account`=%s AND `email_id` IN ({placeholders})
        """
        params = [email_account] + uid_list
        rows = execute_query(sql, tuple(params), fetch=True)
        
        # 构建已处理的邮件 ID 集合
        handled_set = {row["email_id"] for row in rows}
        
        # 构建返回结果
        result = []
        for uid in uid_list:
            result.append({
                "email_id": uid,
                "handled": uid in handled_set,
                "received_time": next((r["received_time"] for r in rows if r["email_id"] == uid), None)
            })
        
        return jsonify({
            "ok": True,
            "email_account": email_account,
            "results": result,
            "handled_count": len(handled_set),
            "total_count": len(uid_list)
        })
    except Exception as e:
        return _json_error("查询失败", 500, code="check_failed", detail=str(e))

# ==========================
# safetybot_table 表：CRUD 接口
# ==========================

def _parse_safety_date(raw_date):
    """
    統一日期解析邏輯：支持時間戳(秒/毫秒)、日期字串
    返回 YYYY-MM-DD 格式
    """
    import pytz
    hk_tz = pytz.timezone("Asia/Hong_Kong")
    try:
        if isinstance(raw_date, (int, float)):
            # 判斷是秒還是毫秒 (10位數是秒，13位數是毫秒)
            ts = raw_date / 1000.0 if raw_date > 1e11 else raw_date
            dt_obj = datetime.fromtimestamp(ts, hk_tz)
            return dt_obj.strftime("%Y-%m-%d")
        elif isinstance(raw_date, str) and raw_date.isdigit():
            raw_ts = float(raw_date)
            ts = raw_ts / 1000.0 if raw_ts > 1e11 else raw_ts
            dt_obj = datetime.fromtimestamp(ts, hk_tz)
            return dt_obj.strftime("%Y-%m-%d")
        else:
            # 嘗試解析字串
            parsed_dt = date_parser.parse(str(raw_date))
            return parsed_dt.strftime("%Y-%m-%d")
    except Exception:
        return None

@app.route("/safety/records", methods=["GET"])
def list_safety_records():
    """
    查询安全记录列表
    - 支持按 date, zone, item_type 过滤
    """
    query_filters = request.args.to_dict()
    body_filters = request.get_json(silent=True) or {}
    if not isinstance(body_filters, dict):
        body_filters = {}

    filters = {**body_filters, **query_filters}
    conditions = []
    params = []

    for k, v in filters.items():
        if k in SAFETY_FIELDS:
            if k == "date" and v:
                parsed_v = _parse_safety_date(v)
                if parsed_v:
                    conditions.append(f"`{k}`=%s")
                    params.append(parsed_v)
                continue
            conditions.append(f"`{k}`=%s")
            params.append(v)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"SELECT * FROM `{SAFETY_TABLE}` {where} ORDER BY `date` DESC, `zone`, `item_type`, `id` DESC"
    
    try:
        rows = execute_query(sql, tuple(params), fetch=True)
        # 轉換 date 為字串避免 JSON 序列化錯誤
        for row in rows:
            if isinstance(row.get('date'), (date, datetime)):
                row['date'] = row['date'].strftime('%Y-%m-%d')
        return jsonify(rows)
    except Exception as e:
        return jsonify({"error": "查詢失敗", "detail": str(e)}), 500

def _insert_one_safety_record(data: dict):
    """
    分組自增邏輯：
    維度：date + zone + item_type
    支持傳入日期字串 (YYYY-MM-DD) 或 Unix 時間戳 (秒/毫秒)
    """
    import pytz
    hk_tz = pytz.timezone("Asia/Hong_Kong")

    # 1. 基礎校驗
    group_id = data.get("group_id")
    raw_date = data.get("date")
    item_type = data.get("item_type")
    zone = data.get("zone")
    description = data.get("description")
    manual_id = data.get("id")  # 支持手動傳入 ID

    if not all([group_id, raw_date, item_type, zone, description]):
        return {"error": "缺少必填字段: group_id, date, item_type, zone, description"}

    # 2. 解析日期 (支持時間戳和字串)
    date_str = _parse_safety_date(raw_date)
    if not date_str:
        return {"error": "日期格式錯誤，請傳入正確的時間戳或日期字串"}

    # 3. 規範 item_type
    valid_types = ["緊急", "非緊急", "次緊急"]
    item_type = str(item_type).strip()
    if item_type not in valid_types:
        return {"error": f"無效的 item_type，必須是: {', '.join(valid_types)}"}

    # 4. 數據操作
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # 獲取鎖，防止併發衝突
            find_id_sql = f"""
                SELECT COALESCE(MAX(`id`), 0) + 1 AS next_id 
                FROM `{SAFETY_TABLE}` 
                WHERE `group_id` = %s AND `date` = %s AND `item_type` = %s AND `zone` = %s 
                FOR UPDATE
            """
            cur.execute(find_id_sql, (group_id, date_str, item_type, zone))
            calc_id = cur.fetchone()['next_id']

            # 如果手動傳入了 id，則使用手動的；否則使用計算出來的
            final_id = int(manual_id) if manual_id is not None else calc_id

            # 插入數據
            insert_sql = f"""
                INSERT INTO `{SAFETY_TABLE}` (`group_id`, `date`, `item_type`, `zone`, `id`, `description`)
                VALUES (%s, %s, %s, %s, %s, %s)
            """
            cur.execute(insert_sql, (
                group_id, date_str, item_type, zone, 
                final_id, description
            ))
            
        conn.commit()
        return {
            "ok": True, 
            "id": final_id, 
            "group_id": group_id,
            "item_type": item_type,
            "zone": zone,
            "date": date_str
        }
    except Exception as e:
        if conn: conn.rollback()
        return {"ok": False, "error": "數據插入失敗", "detail": str(e)}
    finally:
        if conn: conn.close()

@app.route("/safety/records", methods=["POST"])
def create_safety_record():
    """
    新增安全記錄
    支持單條或批量
    """
    data = request.get_json(force=True)

    if isinstance(data, list):
        results = []
        for rec in data:
            res = _insert_one_safety_record(rec)
            results.append(res)
        has_error = any(isinstance(r, dict) and (not r.get("ok") or r.get("error")) for r in results)
        return jsonify(results), 207 if has_error else 201

    res = _insert_one_safety_record(data)
    if isinstance(res, dict) and (not res.get("ok") or res.get("error")):
        return jsonify(res), 400
    return jsonify(res), 201


@app.route("/safety/records", methods=["PUT"])
def update_safety_record():
    """
    修改安全記錄描述
    需要 body 提供: date, zone, item_type, id 以及新的 description
    """
    data = request.get_json(force=True)
    required = ["group_id", "date", "zone", "item_type", "id", "description"]
    for req in required:
        if data.get(req) is None:
            return jsonify({"error": f"缺少字段: {req}"}), 400
    
    # 統一解析日期 (支持時間戳)
    date_str = _parse_safety_date(data['date'])
    if not date_str:
        return jsonify({"error": "日期格式錯誤"}), 400

    # 定位一條記錄並更新描述
    sql = f"""
        UPDATE `{SAFETY_TABLE}` SET `description` = %s 
        WHERE `group_id` = %s AND `date` = %s AND `zone` = %s AND `item_type` = %s AND `id` = %s
    """
    params = (
        data['description'], 
        data['group_id'], date_str, data['zone'], data['item_type'], data['id']
    )
    
    try:
        affected = execute_query(sql, params)
        if affected == 0:
            return jsonify({"error": "未找到匹配的記錄"}), 404
        return jsonify({"ok": True, "message": "修改成功"})
    except Exception as e:
        return jsonify({"error": "修改失敗", "detail": str(e)}), 500


@app.route("/safety/records", methods=["DELETE"])
@app.route("/safety/records/delete", methods=["POST"])
def delete_safety_record():
    """
    刪除安全記錄
    支持 DELETE 方法或 POST 方法 (為了繞過某些 WAF 對 DELETE body 的限制)
    需要 body 提供: group_id, date, zone, item_type, id
    """
    data = request.get_json(force=True)
    required = ["group_id", "date", "zone", "item_type", "id"]
    for req in required:
        if data.get(req) is None:
            return jsonify({"error": f"缺少定位字段: {req}"}), 400

    # 統一解析日期 (支持時間戳)
    date_str = _parse_safety_date(data['date'])
    if not date_str:
        return jsonify({"error": "日期格式錯誤"}), 400

    sql = f"""
        DELETE FROM `{SAFETY_TABLE}` 
        WHERE `group_id` = %s AND `date` = %s AND `zone` = %s AND `item_type` = %s AND `id` = %s
    """
    params = (data['group_id'], date_str, data['zone'], data['item_type'], data['id'])
    
    try:
        affected = execute_query(sql, params)
        if affected == 0:
            return jsonify({"error": "未找到匹配的記錄"}), 404
        return jsonify({"ok": True, "message": "刪除成功"})
    except Exception as e:
        return jsonify({"error": "刪除失敗", "detail": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

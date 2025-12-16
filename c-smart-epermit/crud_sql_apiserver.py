from flask import Flask, request, jsonify
from pymysql import connect
from pymysql.err import IntegrityError, DataError
import pymysql.cursors
import re
from datetime import datetime, date
import uuid
from dateutil import parser as date_parser
from typing import Optional

app = Flask(__name__)

# --- 外墙棚架群组定义 ---
EXTERNAL_SCAFFOLDING_GROUPS = [
    '120363400601106571@g.us',
    '120363372181860061@g.us'
]

# --- 打窿群组定义 ---
DRILLING_GROUPS = [
    '120363423214854498@g.us',
    '120363401312839305@g.us'
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


# --- DB Utility ---
def get_conn():
    return connect(**DB_CONFIG)


def execute_query(sql, params=(), fetch=False, many=False):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params) if not many else cur.executemany(sql, params)
            if fetch:
                return cur.fetchall()
            conn.commit()
            return cur.rowcount
    finally:
        conn.close()


def normalize_date(value):
    try:
        dt = date_parser.parse(value)
        return dt.strftime("%Y-%m-%d")
    except:
        return None


# --- Routes ---
@app.route('/')
def index():
    return "API is running."


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
            WHERE `group_id`=%s AND REPLACE(`location`,' ','')=%s AND `subcontractor`=%s AND `number`=%s AND `floor`=%s
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
            WHERE `group_id`=%s AND REPLACE(`location`,' ','')=%s AND `subcontractor`=%s AND `number`=%s AND `floor`=%s
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
        record = {k: data.get(k) for k in FIELDS}
        record["id"] = data.get("id") or int(datetime.utcnow().timestamp())
        record["uuid"] = data.get("uuid") or str(uuid.uuid4())
        record["xiaban"] = 1 if new_part == number else 0

        # 处理时间字段 - 统一使用服务器当前时间，不考虑用户传入的时间
        record["bstudio_create_time"] = datetime.now(hkt_tz).strftime("%Y-%m-%d %H:%M:%S")

        # 插入
        cols = ", ".join(f"`{f}`" for f in FIELDS)
        placeholders = ", ".join(["%s"] * len(FIELDS))
        values = tuple(record[f] for f in FIELDS)
        sql = f"INSERT INTO `{TABLE_NAME}` ({cols}) VALUES ({placeholders})"
        try:
            execute_query(sql, values)
        except Exception as e:
            return {"error": "插入失败", "detail": str(e)}
        return {"status": "ok", "inserted_id": record["id"]}




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
    # 支持通过url参数做简单筛选，比如 /records?group_id=xxx&subcontractor=xxx
    filters = request.args.to_dict()
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
                # 将、，分隔符统一转换为逗号进行比较
                conditions.append(
                    "REPLACE(REPLACE(REPLACE(`floor`, '、', ','), ' ', ''), '，', ',') "
                    "= REPLACE(REPLACE(REPLACE(%s, '、', ','), ' ', ''), '，', ',')")
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
        WHERE `group_id`=%s AND REPLACE(`location`,' ','')=%s AND `subcontractor`=%s AND `floor`=%s
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
            if key in ["floor", "group_id", "location", "subcontractor", "project", "uuid"]:
                # 移除所有空格（包括中间空格）并忽略大小写
                conditions.append(f"LOWER(REGEXP_REPLACE(`{key}`, '\s+', '')) = LOWER(REGEXP_REPLACE(%s, '\s+', ''))")
                params.append(str(value))
            else:
                conditions.append(f"`{key}` = %s")
                params.append(value)
        else:
            print(f"Warning: Invalid filter field '{key}', skipping")

    if not conditions:
        return jsonify({"error": "没有有效过滤字段"}), 400

    sql = f"DELETE FROM `{TABLE_NAME}` WHERE {' AND '.join(conditions)}"
    total_params = tuple(params)

    print(f"Generated SQL: {sql}")
    print(f"Total params: {total_params}")

    deleted = execute_query(sql, total_params)
    print(f"Deleted rows count: {deleted}")

    if deleted == 0:
        debug_sql = f"SELECT id, subcontractor, group_id, HEX(subcontractor), HEX(group_id), LENGTH(subcontractor), LENGTH(group_id) FROM `{TABLE_NAME}` WHERE LOWER(REGEXP_REPLACE(`group_id`, '\s+', '')) = %s"
        debug_params = (str(filters.get('group_id', '')),)
        try:
            similar_records = execute_query(debug_sql, debug_params, fetch=True)
            print(f"Similar records found: {similar_records}")
        except Exception as e:
            print(f"Debug query error: {e}")
        return jsonify({
            "error": "未找到匹配记录",
            "debug": f"Try running: {sql} with params {total_params} in DB. Check for triggers or concurrent updates."
        }), 404

    return jsonify({"status": "ok", "deleted_count": deleted})


@app.route("/columns", methods=["GET"])
def show_columns():
    table = request.args.get("table")
    if not table:
        return jsonify({"error": "请提供表名"}), 400
    sql = f"SHOW COLUMNS FROM `{table}`"
    rows = execute_query(sql, fetch=True)
    return jsonify({"columns": [row["Field"] for row in rows]})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)

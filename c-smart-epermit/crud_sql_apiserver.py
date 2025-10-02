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

# --- Config  deprecated---
# DB_CONFIG = {
#     "host": "rm-3ns8u64164878eu6i6o.mysql.rds.aliyuncs.com",
#     "port": 3306,
#     "user": "aitest",
#     "password": "G4!u7G231a1o",
#     "database": "ai_test",
#     "charset": "utf8mb4",
#     "cursorclass": pymysql.cursors.DictCursor
# }
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
    "afternoon", "xiaban", "subcontractor", "part_leave_number"
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
import uuid

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
    required = ["location", "subcontractor", "number", "floor"]
    
    name_dict = {
        "location": "位置",
        "subcontractor": "分判",
        "number": "人數",
        "floor": "樓層"
    }
    missing = [name_dict[k] for k in required if not data.get(k)]
    if missing:
        return {"error": f"缺少字段: {', '.join(missing)}，請重新按照[位置]，[分判]，[人數]，[樓層]格式輸入，如：“申請 EP7，中建，1人，G/F"}

    number = int(data["number"])
    new_part = int(data.get("part_leave_number", 0) or 0)
    today_str = (data.get("bstudio_create_time") or datetime.utcnow().strftime("%Y-%m-%d"))[:10]
    start_time = f"{today_str} 00:00:00"
    end_time = f"{today_str} 23:59:59"

    # 查找当天已存在的记录
    check_sql = f"""
        SELECT id, part_leave_number, number FROM `{TABLE_NAME}`
        WHERE `group_id`=%s AND `location`=%s AND `subcontractor`=%s AND `number`=%s AND `floor`=%s
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
        end_time    # 日期，无需清理
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

        # 处理时间字段
        if record.get("bstudio_create_time"):
            try:
                dt = date_parser.parse(record["bstudio_create_time"])
                record["bstudio_create_time"] = dt.strftime("%Y-%m-%d %H:%M:%S")
            except:
                record["bstudio_create_time"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        else:
            record["bstudio_create_time"] = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

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
            # 添加 TRIM 和 LOWER 以处理字符串匹配问题（如隐藏空格或大小写）
            conditions.append(f"LOWER(REGEXP_REPLACE(`{key}`, '\s+', '')) = LOWER(REGEXP_REPLACE(%s, '\s+', ''))")
            params.append(value)

    if not conditions:
        return jsonify({"error": "无有效过滤条件字段"}), 400

    update_clause = []
    update_params = []
    for key, value in updates.items():
        if key in FIELDS:
            update_clause.append(f"`{key}` = %s")
            update_params.append(value)
    if not update_clause:
        return jsonify({"error": "无可更新字段"}), 400

    sql = f"UPDATE `{TABLE_NAME}` SET {', '.join(update_clause)} WHERE {' AND '.join(conditions)}"
    total_params = tuple(update_params + params)
    count = execute_query(sql, total_params)

    if count == 0:
        return jsonify({"error": "未找到匹配记录"}), 404
    return jsonify({"status": "ok", "updated_count": count})

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
    rows = execute_query("SHOW TABLES", fetch=True)
    return jsonify({"tables": [list(row.values())[0] for row in rows]})

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

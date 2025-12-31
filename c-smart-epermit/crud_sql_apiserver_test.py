import unittest
from unittest.mock import patch, MagicMock
import json
import sys
import os

# 确保能导入 crud_sql_apiserver
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from crud_sql_apiserver import app, clean_string

class CrudSqlApiServerTest(unittest.TestCase):
    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True

    def test_clean_string(self):
        """测试字符串清理辅助函数"""
        self.assertEqual(clean_string("  A B C  "), "ABC")
        self.assertEqual(clean_string("3 --- 4 / F"), "3---4/F")

    @patch('crud_sql_apiserver.get_conn')
    @patch('crud_sql_apiserver.execute_query')
    def test_create_record_scaffold(self, mock_execute_query, mock_get_conn):
        """测试外墙棚架申请流程中的楼层匹配逻辑"""
        # 1. 模拟 get_conn 链条
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_get_conn.return_value = mock_conn
        mock_conn.cursor.return_value.__enter__.return_value = mock_cur
        
        # 模拟数据库中不存在记录 (第一次查询返回 None)
        mock_cur.fetchone.return_value = None
        
        # 2. 模拟 execute_query (插入时调用)
        mock_execute_query.return_value = 1
        
        test_data = {
            "group_id": "120363400601106571@g.us", # 外墙棚架群组
            "location": "BLK A, CP9",
            "subcontractor": "中建",
            "number": 2,
            "floor": "3---4/F",
            "process": "拆板"
        }
        
        response = self.app.post('/records', 
                                data=json.dumps(test_data),
                                content_type='application/json')
        
        self.assertEqual(response.status_code, 201)
        
        # 验证 check_sql (cur.execute 调用)
        args, kwargs = mock_cur.execute.call_args
        sql_arg = args[0]
        self.assertIn("REGEXP_REPLACE", sql_arg)
        self.assertIn("'[-—–−－]+'", sql_arg)

    @patch('crud_sql_apiserver.execute_query')
    def test_update_by_condition_floor_normalization(self, mock_execute_query):
        """测试更新接口中的楼层归一化匹配逻辑"""
        # 模拟 execute_query 调用
        # 第一次调用: select_result = execute_query(select_sql, params, fetch=True)
        # 第二次调用: count = execute_query(sql, total_params, fetch=False)
        mock_execute_query.side_effect = [
            [{"id": 123}], # 匹配到记录
            1              # 更新了 1 行
        ]
        
        update_request = {
            "where": {
                "group_id": "120363418441024423@g.us",
                "location": "EP7",
                "subcontractor": "中建",
                "floor": "3---4/F"
            },
            "set": {
                "safety_flag": 1,
                "sender_type": 1
            }
        }
        
        response = self.app.put('/records/update_by_condition',
                               data=json.dumps(update_request),
                               content_type='application/json')
        
        self.assertEqual(response.status_code, 200)
        
        # 检查生成的 SQL
        select_sql = mock_execute_query.call_args_list[0][0][0]
        self.assertIn("REGEXP_REPLACE", select_sql)
        self.assertIn("'[-—–−－]+'", select_sql)

    @patch('crud_sql_apiserver.execute_query')
    def test_delete_fastgpt_records_floor_normalization(self, mock_execute_query):
        """测试删除接口中的楼层归一化匹配逻辑"""
        mock_execute_query.return_value = 1 # 模拟删除成功
        
        delete_request = {
            "group_id": "120363418441024423@g.us",
            "floor": "3---4/F",
            "location": "EP7"
        }
        
        response = self.app.post('/delete_fastgpt_records',
                                data=json.dumps(delete_request),
                                content_type='application/json')
        
        self.assertEqual(response.status_code, 200)
        
        delete_sql = mock_execute_query.call_args[0][0]
        self.assertIn("REGEXP_REPLACE", delete_sql)

if __name__ == '__main__':
    unittest.main()

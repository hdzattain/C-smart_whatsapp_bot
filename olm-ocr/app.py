from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Request
from fastapi.responses import FileResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
import os
import shutil
import tempfile
import subprocess
import sys
import glob
import uuid
from pathlib import Path
from typing import List, Dict

app = FastAPI(title="OLMoCR Fault-Tolerant API")

# 高并发防护
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# 配置
VLLM_SERVER = "http://localhost:8000/v1"
OUTPUT_BASE = Path("/root/service/olmocr/test_output")
PYTHON_EXE = "/opt/conda/envs/olmocr/bin/python"
OUTPUT_BASE.mkdir(parents=True, exist_ok=True)

# 内存中存储任务状态
tasks_status: Dict[str, str] = {}

def remove_file(path: str):
    """用于后台清理生成的压缩包"""
    if os.path.exists(path):
        os.remove(path)
        print(f"--- [Cleanup] 已删除临时压缩包: {path}")

def run_pipeline(task_id: str, pdf_paths: List[str], task_dir: str):
    """后台运行 pipeline 并更新状态（增强容错）"""
    tasks_status[task_id] = "processing"
    current_env = os.environ.copy()
    
    cmd = [
        PYTHON_EXE, "-m", "olmocr.pipeline",
        task_dir,
        "--markdown",
        "--pdfs", *pdf_paths,
        "--server", VLLM_SERVER,
    ]
    
    print(f"--- [Task {task_id}] 开始处理 ---")
    try:
        with subprocess.Popen(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.STDOUT, 
            text=True, 
            env=current_env
        ) as proc:
            if proc.stdout:
                for line in proc.stdout:
                    print(f"[{task_id} Log] {line}", end='', flush=True)
                    sys.stdout.flush()
        
        proc.wait()
        
        # --- 容错处理开始 ---
        # 无论 proc.returncode 是否为 0，都尝试去搜寻并整理已生成的 md 文件
        md_files = glob.glob(f"{task_dir}/markdown/**/*.md", recursive=True)
        if md_files:
            for f in md_files:
                target_path = os.path.join(task_dir, os.path.basename(f))
                shutil.move(f, target_path)
            print(f"--- [Task {task_id}] 已整理 {len(md_files)} 个生成的 Markdown 文件 ---")

        if proc.returncode == 0:
            tasks_status[task_id] = "completed"
            print(f"--- [Task {task_id}] 任务圆满完成 ---")
        else:
            # 如果虽然报错了，但至少产生了一些文件，我们也允许下载
            if md_files:
                tasks_status[task_id] = "completed"
                print(f"--- [Task {task_id}] 警告：程序异常退出（码:{proc.returncode}），但已保留部分结果 ---")
            else:
                tasks_status[task_id] = f"failed_exit_{proc.returncode}"
                print(f"--- [Task {task_id}] 彻底失败，无文件产生 ---")
        # --- 容错处理结束 ---

    except Exception as e:
        tasks_status[task_id] = f"error: {str(e)}"
        print(f"--- [Task {task_id}] 运行异常: {str(e)} ---")
    finally:
        if pdf_paths:
            temp_parent = os.path.dirname(pdf_paths[0])
            shutil.rmtree(temp_parent, ignore_errors=True)

@app.post("/process")
@limiter.limit("10/minute")
async def process_pdfs(
    request: Request,
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
):
    if not files:
        raise HTTPException(status_code=400, detail="未上传文件")

    task_id = str(uuid.uuid4())[:8]
    task_dir = OUTPUT_BASE / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    
    temp_dir = tempfile.mkdtemp()
    pdf_paths = []
    for file in files:
        if file.filename.lower().endswith('.pdf'):
            path = os.path.join(temp_dir, file.filename)
            with open(path, "wb") as f:
                shutil.copyfileobj(file.file, f)
            pdf_paths.append(path)

    if not pdf_paths:
        shutil.rmtree(temp_dir)
        raise HTTPException(status_code=400, detail="无有效 PDF 文件")

    tasks_status[task_id] = "pending"
    background_tasks.add_task(run_pipeline, task_id, pdf_paths, str(task_dir))

    return {
        "status": "success",
        "task_id": task_id,
        "check_status_url": f"https://olmocr.c-smart.hk/status/{task_id}",
        "download_url": f"https://olmocr.c-smart.hk/download/{task_id}"
    }

@app.get("/status/{task_id}")
async def get_status(task_id: str):
    status = tasks_status.get(task_id, "not_found")
    return {"task_id": task_id, "status": status}

@app.get("/download/{task_id}")
async def download_results(task_id: str, background_tasks: BackgroundTasks):
    status = tasks_status.get(task_id)
    
    # 检查目录下是否有 md 文件，只要有文件就允许打包下载，不管 status
    task_dir = OUTPUT_BASE / task_id
    md_files = list(task_dir.glob("*.md"))
    
    if not md_files and status != "completed":
        raise HTTPException(status_code=400, detail=f"暂无可用结果。当前状态: {status}")

    zip_base_name = str(OUTPUT_BASE / f"results_{task_id}")
    full_zip_path = f"{zip_base_name}.zip"

    try:
        shutil.make_archive(zip_base_name, 'zip', str(task_dir))
        background_tasks.add_task(remove_file, full_zip_path)
        return FileResponse(
            path=full_zip_path, 
            filename=f"ocr_results_{task_id}.zip",
            media_type='application/zip'
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"压缩打包失败: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)

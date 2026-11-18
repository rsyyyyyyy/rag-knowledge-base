"""Configure the model before importing the application and start one worker."""
import argparse
import getpass
import os
from pathlib import Path
import sys
import warnings
from urllib.parse import urlsplit


def configure(argv=None):
    parser = argparse.ArgumentParser(description="启动 NexusMind 后端，密钥仅保存在进程环境中。")
    parser.add_argument("--api-key", help="模型 API Key；省略时读取 DEEPSEEK_API_KEY 或隐藏输入")
    parser.add_argument("--model", help="模型名称；默认读取 DEEPSEEK_MODEL")
    parser.add_argument("--base-url", help="模型 API 地址；默认读取 DEEPSEEK_BASE_URL")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8001, help="监听端口，默认 8001")
    parser.add_argument("--data-dir", help="文献和数据库目录，默认 backend/data")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须介于 1 和 65535 之间")
    model = (args.model if args.model is not None else os.getenv("DEEPSEEK_MODEL", "deepseek-flash")).strip()
    base_url = (args.base_url if args.base_url is not None else os.getenv(
        "DEEPSEEK_BASE_URL", "https://api.deepseek.com")).strip().rstrip("/")
    try:
        parsed = urlsplit(base_url)
        valid_url = (parsed.scheme in {"http", "https"} and bool(parsed.hostname)
                     and parsed.username is None and parsed.password is None
                     and not parsed.query and not parsed.fragment)
    except ValueError:
        valid_url = False
    if not model:
        parser.error("模型名称不能为空")
    if not valid_url:
        parser.error("API 地址需要是有效的 HTTP(S) 地址，不能包含凭据、查询参数或片段")
    key = (args.api_key if args.api_key is not None else os.getenv("DEEPSEEK_API_KEY", "")).strip()
    if args.api_key is not None and not key:
        parser.error("API Key 不能为空")
    if not key:
        if not sys.stdin.isatty():
            parser.error("非交互环境请通过 DEEPSEEK_API_KEY 或 --api-key 提供密钥")
        try:
            # Fail rather than fall back to visible input if this console cannot hide it.
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass("请输入模型 API Key（输入隐藏，不写入文件）: ").strip()
        except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
            parser.error("无法完成隐藏输入，请通过 DEEPSEEK_API_KEY 提供密钥")
        if not key:
            parser.error("API Key 不能为空")
    os.environ["DEEPSEEK_API_KEY"] = key
    os.environ["DEEPSEEK_MODEL"] = model
    os.environ["DEEPSEEK_BASE_URL"] = base_url
    if args.data_dir:
        os.environ["RAG_DATA_DIR"] = str(Path(args.data_dir).expanduser().resolve())
    return args


def main(argv=None):
    args = configure(argv)
    import uvicorn

    uvicorn.run("app:app", host=args.host, port=args.port, workers=1,
                app_dir=str(Path(__file__).resolve().parent))


if __name__ == "__main__":
    main()

"""Command line entry-point for running the ACE HTTP service."""

from __future__ import annotations

import argparse
from .service import create_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the ACE LangChain service")
    parser.add_argument(
        "--config",
        type=str,
        help="Path to the JSON/YAML service configuration file",
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host interface to bind")
    parser.add_argument("--port", type=int, default=8000, help="Port to serve on")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable Flask debug mode",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    app = create_app(args.config if args.config else None)
    app.run(host=args.host, port=args.port, debug=args.debug)


if __name__ == "__main__":  # pragma: no cover
    main()

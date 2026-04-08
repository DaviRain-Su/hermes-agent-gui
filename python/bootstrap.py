#!/usr/bin/env python3
"""
Bootstrap Hermes Agent gateway with only API_SERVER enabled.
This keeps the desktop app isolated from any existing messaging gateway.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

HERMES_AGENT_DIR = os.getenv("HERMES_AGENT_DIR", "")
HERMES_HOME_GUI = os.getenv("HERMES_HOME", "")
HERMES_GATEWAY_CONFIG = os.getenv("HERMES_GATEWAY_CONFIG", "")


def ensure_hermes_home():
    """Create isolated HERMES_HOME if needed and optionally seed config from default."""
    home = Path(HERMES_HOME_GUI)
    home.mkdir(parents=True, exist_ok=True)

    default_home = Path.home() / ".hermes"
    config_src = default_home / "config.yaml"
    config_dst = home / "config.yaml"

    if not config_dst.exists() and config_src.exists():
        try:
            import yaml
        except ImportError:
            yaml = None

        if yaml:
            with open(config_src, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}

            # Remove platform configs that aren't api_server so the GUI gateway
            # doesn't try to connect to Telegram/Discord/etc.
            if "platforms" in cfg and isinstance(cfg["platforms"], dict):
                cfg["platforms"] = {
                    k: v
                    for k, v in cfg["platforms"].items()
                    if k in ("api_server",)
                }

            with open(config_dst, "w", encoding="utf-8") as f:
                yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)

    # Ensure .env exists (empty is fine)
    env_file = home / ".env"
    if not env_file.exists():
        env_file.write_text("# Hermes Agent GUI environment\n")


async def main():
    ensure_hermes_home()

    if HERMES_AGENT_DIR:
        sys.path.insert(0, HERMES_AGENT_DIR)

    from gateway.run import start_gateway
    from gateway.config import GatewayConfig

    config = None
    if HERMES_GATEWAY_CONFIG and Path(HERMES_GATEWAY_CONFIG).exists():
        with open(HERMES_GATEWAY_CONFIG, "r", encoding="utf-8") as f:
            config = GatewayConfig.from_dict(json.load(f))

    success = await start_gateway(config=config, replace=False)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    asyncio.run(main())

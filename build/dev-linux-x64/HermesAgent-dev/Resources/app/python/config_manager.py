#!/usr/bin/env python3
"""
Lightweight config manager for the Hermes Agent GUI.
Reads and writes ~/.hermes-agent-gui/config.yaml without importing Hermes code.
"""
import json
import os
import sys
from pathlib import Path

HERMES_HOME = Path(os.getenv("HERMES_HOME", Path.home() / ".hermes-agent-gui"))
CONFIG_PATH = HERMES_HOME / "config.yaml"
SESSIONS_DIR = HERMES_HOME / "sessions"


def _load_yaml():
    try:
        import yaml
    except ImportError:
        print(json.dumps({"error": "PyYAML not installed"}), file=sys.stderr)
        sys.exit(1)
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}


def _save_yaml(cfg):
    try:
        import yaml
    except ImportError:
        print(json.dumps({"error": "PyYAML not installed"}), file=sys.stderr)
        sys.exit(1)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)


def cmd_get_model():
    cfg = _load_yaml()
    model = cfg.get("model", {}).get("default", "")
    provider = cfg.get("model", {}).get("provider", "")
    print(json.dumps({"model": model, "provider": provider}))


def cmd_set_model():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing model argument"}), file=sys.stderr)
        sys.exit(1)
    model = sys.argv[2]
    provider = sys.argv[3] if len(sys.argv) > 3 else None
    cfg = _load_yaml()
    if "model" not in cfg:
        cfg["model"] = {}
    cfg["model"]["default"] = model
    if provider:
        cfg["model"]["provider"] = provider
    _save_yaml(cfg)
    print(json.dumps({"success": True, "model": model, "provider": provider}))


def cmd_list_sessions():
    sessions_file = SESSIONS_DIR / "sessions.json"
    sessions = []
    if sessions_file.exists():
        try:
            with open(sessions_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            for entry in data.values():
                sid = entry.get("session_id", "")
                transcript_path = SESSIONS_DIR / f"{sid}.jsonl"
                msg_count = 0
                if transcript_path.exists():
                    with open(transcript_path, "r", encoding="utf-8") as tf:
                        msg_count = sum(1 for _ in tf if _.strip())
                sessions.append({
                    "id": sid,
                    "key": entry.get("session_key", ""),
                    "display_name": entry.get("display_name", "") or sid[:8],
                    "updated_at": entry.get("updated_at", ""),
                    "created_at": entry.get("created_at", ""),
                    "message_count": msg_count,
                })
        except Exception as e:
            print(json.dumps({"error": str(e)}), file=sys.stderr)
            sys.exit(1)
    # Sort by updated_at desc
    sessions.sort(key=lambda x: x.get("updated_at", ""), reverse=True)
    print(json.dumps(sessions))


def cmd_load_session():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing session_id argument"}), file=sys.stderr)
        sys.exit(1)
    sid = sys.argv[2]
    transcript_path = SESSIONS_DIR / f"{sid}.jsonl"
    messages = []
    if transcript_path.exists():
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        messages.append(json.loads(line))
                    except Exception:
                        pass
    print(json.dumps(messages))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided"}), file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "get-model":
        cmd_get_model()
    elif cmd == "set-model":
        cmd_set_model()
    elif cmd == "list-sessions":
        cmd_list_sessions()
    elif cmd == "load-session":
        cmd_load_session()
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}), file=sys.stderr)
        sys.exit(1)

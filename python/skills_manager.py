#!/usr/bin/env python3
"""
Skills manager for the Hermes Agent GUI.
Imports Hermes code and runs inside the hermes-agent venv.
"""
import io
import json
import os
import sys
from pathlib import Path

HERMES_AGENT_DIR = os.getenv("HERMES_AGENT_DIR", "")
if HERMES_AGENT_DIR:
    sys.path.insert(0, str(HERMES_AGENT_DIR))


def _get_config_path():
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "config.yaml"


def _load_config():
    path = _get_config_path()
    if not path.exists():
        return {}
    try:
        import yaml
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception:
        return {}


def _save_config(cfg):
    path = _get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        import yaml
        with open(path, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
    except Exception as e:
        raise RuntimeError(f"Failed to save config: {e}")


def _silent_console():
    from rich.console import Console
    return Console(file=io.StringIO(), force_terminal=False)


def cmd_list():
    try:
        from tools.skills_tool import skills_list
        result = skills_list()
        data = json.loads(result)
        print(json.dumps(data))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def cmd_view():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing skill name"}), file=sys.stderr)
        sys.exit(1)
    name = sys.argv[2]
    file_path = sys.argv[3] if len(sys.argv) > 3 else None
    try:
        from tools.skills_tool import skill_view
        result = skill_view(name, file_path)
        data = json.loads(result)
        print(json.dumps(data))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def cmd_commands():
    try:
        from agent.skill_commands import get_skill_commands
        cmds = get_skill_commands()
        out = {}
        for k, v in cmds.items():
            out[k] = {
                "name": v.get("name", ""),
                "description": v.get("description", ""),
                "skill_md_path": v.get("skill_md_path", ""),
                "skill_dir": v.get("skill_dir", ""),
            }
        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


def cmd_install():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing skill identifier"}), file=sys.stderr)
        sys.exit(1)
    identifier = sys.argv[2]
    c = _silent_console()
    try:
        from hermes_cli.skills_hub import do_install
        do_install(identifier, skip_confirm=True, console=c)
        # Verify installation by checking skills list
        from tools.skills_tool import skills_list
        data = json.loads(skills_list())
        installed = [s for s in data.get("skills", []) if s.get("name") == identifier or s.get("identifier") == identifier]
        if installed:
            print(json.dumps({"success": True, "skill": installed[0]}))
        else:
            print(json.dumps({"success": True, "message": "Installation completed"}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)


def cmd_update():
    name = sys.argv[2] if len(sys.argv) > 2 else None
    c = _silent_console()
    try:
        from hermes_cli.skills_hub import do_update
        do_update(name=name, console=c)
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)


def cmd_uninstall():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing skill name"}), file=sys.stderr)
        sys.exit(1)
    name = sys.argv[2]
    c = _silent_console()
    try:
        from hermes_cli.skills_hub import do_uninstall
        do_uninstall(name, skip_confirm=True, console=c)
        print(json.dumps({"success": True}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)


def cmd_enable():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing skill name"}), file=sys.stderr)
        sys.exit(1)
    name = sys.argv[2]
    cfg = _load_config()
    skills_cfg = cfg.setdefault("skills", {})
    disabled = set(skills_cfg.get("disabled", []))
    if name in disabled:
        disabled.discard(name)
        skills_cfg["disabled"] = sorted(disabled)
        _save_config(cfg)
    print(json.dumps({"success": True}))


def cmd_disable():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Missing skill name"}), file=sys.stderr)
        sys.exit(1)
    name = sys.argv[2]
    cfg = _load_config()
    skills_cfg = cfg.setdefault("skills", {})
    disabled = set(skills_cfg.get("disabled", []))
    if name not in disabled:
        disabled.add(name)
        skills_cfg["disabled"] = sorted(disabled)
        _save_config(cfg)
    print(json.dumps({"success": True}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided"}), file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "list":
        cmd_list()
    elif cmd == "view":
        cmd_view()
    elif cmd == "commands":
        cmd_commands()
    elif cmd == "install":
        cmd_install()
    elif cmd == "update":
        cmd_update()
    elif cmd == "uninstall":
        cmd_uninstall()
    elif cmd == "enable":
        cmd_enable()
    elif cmd == "disable":
        cmd_disable()
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
import json
import os
import sys

HERMES_AGENT_DIR = os.getenv("HERMES_AGENT_DIR", "")
if HERMES_AGENT_DIR:
    sys.path.insert(0, str(HERMES_AGENT_DIR))


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"error": "No command"}))
        return
    cmd = args[0]
    try:
        from tools.approval import (
            has_pending,
            pop_pending,
            approve_session,
            approve_permanent,
            save_permanent_allowlist,
            _permanent_approved,
            _lock,
        )

        if cmd == "get" and len(args) > 1:
            session_key = args[1]
            if has_pending(session_key):
                pending = pop_pending(session_key)
                print(json.dumps({"pending": pending}))
            else:
                print(json.dumps({"pending": None}))
        elif cmd == "respond" and len(args) > 3:
            session_key = args[1]
            choice = args[2]
            pattern_keys = json.loads(args[3]) if len(args) > 3 else []
            if choice in ("once", "session"):
                for k in pattern_keys:
                    approve_session(session_key, k)
            elif choice == "always":
                for k in pattern_keys:
                    approve_session(session_key, k)
                    approve_permanent(k)
                with _lock:
                    save_permanent_allowlist(_permanent_approved)
            print(json.dumps({"ok": True, "choice": choice}))
        else:
            print(json.dumps({"error": "Unknown command or missing args"}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()

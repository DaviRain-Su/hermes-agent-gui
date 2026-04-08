#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

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
        from cron.jobs import list_jobs, trigger_job, pause_job, resume_job, update_job, remove_job
        from hermes_constants import get_hermes_home

        if cmd == "list":
            jobs = list_jobs(include_disabled=True)
            print(json.dumps({"jobs": jobs or []}))
        elif cmd == "run" and len(args) > 1:
            job = trigger_job(args[1])
            print(json.dumps({"ok": bool(job), "job": job}))
        elif cmd == "pause" and len(args) > 1:
            job = pause_job(args[1])
            print(json.dumps({"ok": bool(job), "job": job}))
        elif cmd == "resume" and len(args) > 1:
            job = resume_job(args[1])
            print(json.dumps({"ok": bool(job), "job": job}))
        elif cmd == "delete" and len(args) > 1:
            ok = remove_job(args[1])
            print(json.dumps({"ok": ok}))
        elif cmd == "update" and len(args) > 1:
            job_id = args[1]
            payload = json.loads(args[2]) if len(args) > 2 else {}
            job = update_job(job_id, payload)
            print(json.dumps({"ok": bool(job), "job": job}))
        elif cmd == "output" and len(args) > 1:
            job_id = args[1]
            out_dir = Path(get_hermes_home()) / "cron" / "output" / job_id
            entries = []
            if out_dir.exists():
                for f in sorted(out_dir.iterdir(), reverse=True)[:20]:
                    entries.append({
                        "time": f.stem,
                        "content": f.read_text(encoding="utf-8"),
                    })
            print(json.dumps({"outputs": entries}))
        else:
            print(json.dumps({"error": "Unknown command or missing args"}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()

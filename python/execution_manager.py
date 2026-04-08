#!/usr/bin/env python3
"""Hermes GUI code execution wrapper."""
import base64
import json
import subprocess
import sys
import tempfile
import os


def run_code(code_b64: str) -> dict:
    try:
        code = base64.b64decode(code_b64.encode()).decode("utf-8")
    except Exception as e:
        return {"stdout": "", "stderr": f"Failed to decode code: {e}", "exit_code": -1}

    if not code.strip():
        return {"stdout": "", "stderr": "", "exit_code": 0}

    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(code)
            f.flush()
            tmp_path = f.name

        proc = subprocess.run(
            ["python3", tmp_path],
            capture_output=True,
            text=True,
            timeout=15,
        )
        os.unlink(tmp_path)
        return {
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "exit_code": proc.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "Execution timed out after 15 seconds", "exit_code": -1}
    except Exception as e:
        return {"stdout": "", "stderr": str(e), "exit_code": -1}


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] != "run":
        print(json.dumps({"error": "Usage: execution_manager.py run <base64_code>"}))
        sys.exit(1)

    result = run_code(sys.argv[2])
    print(json.dumps(result))

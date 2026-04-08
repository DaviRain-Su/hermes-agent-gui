#!/usr/bin/env python3
"""Hermes Agent GUI Launcher (PyQt5 + Bun backend)"""

import os
import signal
import subprocess
import sys
import time

from PyQt5.QtCore import QThread, QUrl, pyqtSignal
from PyQt5.QtWidgets import QApplication

try:
    from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEnginePage, QWebEngineProfile
except ImportError as e:
    print("PyQt5.QtWebEngineWidgets is required but not available:", e)
    sys.exit(1)


APP_NAME = "Hermes Agent"
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_CMD = ["bun", "src/backend-service.ts"]
FRONTEND_URL = "http://127.0.0.1:55000/"
MAX_WAIT_SECONDS = 30


class BackendWorker(QThread):
    backend_ready = pyqtSignal(str)

    def __init__(self, proc):
        super().__init__()
        self.proc = proc

    def run(self):
        import urllib.request
        started_at = time.time()
        while time.time() - started_at < MAX_WAIT_SECONDS:
            if self.proc.poll() is not None:
                print("[launcher] backend process exited early")
                return
            try:
                with urllib.request.urlopen(FRONTEND_URL, timeout=1) as resp:
                    if resp.status == 200:
                        self.backend_ready.emit(FRONTEND_URL)
                        return
            except Exception:
                pass
            time.sleep(0.3)
        print("[launcher] backend did not become ready in time")


def main():
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)

    # Start backend
    env = os.environ.copy()
    env["HERMES_AGENT_DIR"] = os.path.expanduser("~/dev/active/hermes-agent")
    proc = subprocess.Popen(
        BACKEND_CMD,
        cwd=PROJECT_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def cleanup():
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()

    app.aboutToQuit.connect(cleanup)
    signal.signal(signal.SIGINT, lambda *_: app.quit())
    signal.signal(signal.SIGTERM, lambda *_: app.quit())

    view = QWebEngineView()
    view.setWindowTitle(APP_NAME)
    view.resize(1280, 900)

    page = QWebEnginePage(QWebEngineProfile.defaultProfile(), view)
    view.setPage(page)

    def on_ready(url: str):
        print(f"[launcher] backend ready, loading {url}")
        view.setUrl(QUrl(url))
        view.show()
        view.raise_()
        view.activateWindow()

    worker = BackendWorker(proc)
    worker.backend_ready.connect(on_ready)
    worker.finished.connect(worker.deleteLater)
    worker.start()

    sys.exit(app.exec_())


if __name__ == "__main__":
    main()

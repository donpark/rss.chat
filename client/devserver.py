from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parent.parent
shutil.copyfile(ROOT / "server/code/config.local.json", ROOT / "server/code/config.json")


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()


ThreadingHTTPServer(("localhost", 8080), Handler).serve_forever()

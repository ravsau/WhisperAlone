#!/usr/bin/env python3
"""MLX Whisper HTTP server for WhisperAlone.

Runs a lightweight HTTP server that accepts audio files and returns transcriptions.
Keeps the model warm in memory for fast repeated transcriptions.

Endpoints:
  POST /transcribe  - multipart form: file=<audio>, model=<model_name>
  GET  /health      - returns {"status": "ok"}
  POST /shutdown     - gracefully shuts down the server
"""

import json
import os
import sys
import tempfile
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs
import cgi

# Current loaded model cache
_current_model = None
_current_model_name = None


def get_transcriber(model_name):
    """Import and cache mlx_whisper module."""
    global _current_model_name
    try:
        import mlx_whisper
        _current_model_name = model_name
        return mlx_whisper
    except ImportError:
        raise ImportError("mlx-whisper not installed")


class TranscribeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Log to stderr so Node can capture it
        print(f"[MLX-Server] {format % args}", file=sys.stderr, flush=True)

    def do_GET(self):
        if self.path == "/health":
            self._json_response(200, {"status": "ok", "model": _current_model_name})
        else:
            self._json_response(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/shutdown":
            self._json_response(200, {"status": "shutting down"})
            threading.Thread(target=self.server.shutdown).start()
            return

        if self.path != "/transcribe":
            self._json_response(404, {"error": "not found"})
            return

        try:
            # Parse multipart form data
            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" in content_type:
                form = cgi.FieldStorage(
                    fp=self.rfile,
                    headers=self.headers,
                    environ={
                        "REQUEST_METHOD": "POST",
                        "CONTENT_TYPE": content_type,
                    },
                )
                model_name = form.getvalue("model", "mlx-community/whisper-small")
                file_item = form["file"]
                audio_data = file_item.file.read()
            else:
                # Raw audio body with model in query string or header
                content_length = int(self.headers.get("Content-Length", 0))
                audio_data = self.rfile.read(content_length)
                model_name = self.headers.get("X-Model", "mlx-community/whisper-small")

            if not audio_data:
                self._json_response(400, {"error": "no audio data"})
                return

            # Write to temp file (mlx-whisper needs file path)
            suffix = ".webm"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(audio_data)
                tmp_path = tmp.name

            try:
                mlx_whisper = get_transcriber(model_name)
                result = mlx_whisper.transcribe(
                    tmp_path,
                    path_or_hf_repo=model_name,
                )
                text = result.get("text", "").strip()
                self._json_response(200, {"text": text})
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

        except ImportError as e:
            self._json_response(500, {"error": str(e)})
        except Exception as e:
            self._json_response(500, {"error": str(e)})

    def _json_response(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18456
    server = HTTPServer(("127.0.0.1", port), TranscribeHandler)
    print(f"MLX_SERVER_READY port={port}", flush=True)
    print(f"[MLX-Server] Listening on http://127.0.0.1:{port}", file=sys.stderr, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[MLX-Server] Shut down.", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()

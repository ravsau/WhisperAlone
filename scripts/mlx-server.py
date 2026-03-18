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
import re
import sys
import tempfile
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

_current_model_name = None


def get_transcriber(model_name):
    global _current_model_name
    try:
        import mlx_whisper
        _current_model_name = model_name
        return mlx_whisper
    except ImportError:
        raise ImportError("mlx-whisper not installed")


def parse_multipart(body, boundary):
    """Parse multipart form data without cgi module (removed in Python 3.13)."""
    parts = {}
    boundary_bytes = boundary.encode("utf-8") if isinstance(boundary, str) else boundary
    # Split on boundary
    chunks = body.split(b"--" + boundary_bytes)
    for chunk in chunks:
        if not chunk or chunk.strip() in (b"", b"--", b"--\r\n"):
            continue
        # Split headers from body at first double CRLF
        sep = chunk.find(b"\r\n\r\n")
        if sep == -1:
            continue
        header_block = chunk[:sep].decode("utf-8", errors="replace")
        content = chunk[sep + 4:]
        # Strip trailing \r\n
        if content.endswith(b"\r\n"):
            content = content[:-2]

        # Get field name from Content-Disposition
        name_match = re.search(r'name="([^"]+)"', header_block)
        if not name_match:
            continue
        name = name_match.group(1)

        filename_match = re.search(r'filename="([^"]+)"', header_block)
        if filename_match:
            parts[name] = {"filename": filename_match.group(1), "data": content}
        else:
            parts[name] = {"data": content.decode("utf-8", errors="replace").strip()}
    return parts


class TranscribeHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
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
            content_type = self.headers.get("Content-Type", "")
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)

            if "multipart/form-data" in content_type:
                # Extract boundary from Content-Type
                boundary_match = re.search(r"boundary=(.+?)(?:;|$)", content_type)
                if not boundary_match:
                    self._json_response(400, {"error": "missing boundary"})
                    return
                boundary = boundary_match.group(1).strip()

                parts = parse_multipart(body, boundary)
                model_name = parts.get("model", {}).get("data", "mlx-community/whisper-small") if "model" in parts else "mlx-community/whisper-small"
                file_part = parts.get("file")
                if not file_part:
                    self._json_response(400, {"error": "no file field"})
                    return
                audio_data = file_part["data"]
            else:
                audio_data = body
                model_name = self.headers.get("X-Model", "mlx-community/whisper-small")

            if not audio_data:
                self._json_response(400, {"error": "no audio data"})
                return

            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
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

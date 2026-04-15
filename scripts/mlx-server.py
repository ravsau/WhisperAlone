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
_mlx_whisper = None


def get_transcriber(model_name):
    global _current_model_name, _mlx_whisper
    if _mlx_whisper is None:
        try:
            import mlx_whisper
            _mlx_whisper = mlx_whisper
        except ImportError:
            raise ImportError("mlx-whisper not installed")
    _current_model_name = model_name
    return _mlx_whisper


def prewarm_model(model_name):
    """Load model into memory at startup by running a tiny transcription."""
    global _current_model_name
    print(f"[MLX-Server] Pre-warming model: {model_name}", file=sys.stderr, flush=True)
    try:
        mlx_whisper = get_transcriber(model_name)
        # Create a short silent WAV file to force model loading
        import struct
        import wave
        silence_path = os.path.join(tempfile.gettempdir(), "whisperalone_prewarm.wav")
        with wave.open(silence_path, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            # 0.5 seconds of silence
            wf.writeframes(struct.pack("<" + "h" * 8000, *([0] * 8000)))
        mlx_whisper.transcribe(silence_path, path_or_hf_repo=model_name)
        os.unlink(silence_path)
        print(f"[MLX-Server] Model pre-warmed successfully", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[MLX-Server] Pre-warm failed (non-fatal): {e}", file=sys.stderr, flush=True)


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


# --- Streaming session store ---
# Clients POST chunks to /stream/chunk and then POST /stream/finish to transcribe.
_stream_lock = threading.Lock()
_stream_chunks: list[bytes] = []
_stream_model: str = "mlx-community/whisper-small"


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

        if self.path == "/stream/start":
            return self._handle_stream_start()

        if self.path == "/stream/chunk":
            return self._handle_stream_chunk()

        if self.path == "/stream/finish":
            return self._handle_stream_finish()

        if self.path == "/transcribe":
            return self._handle_transcribe()

        self._json_response(404, {"error": "not found"})

    # --- Streaming endpoints ---

    def _handle_stream_start(self):
        """Begin a new streaming session, clearing any previous chunks."""
        global _stream_model
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else b""
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            data = {}
        with _stream_lock:
            _stream_chunks.clear()
            _stream_model = data.get("model", _stream_model)
        self._json_response(200, {"status": "ready"})

    def _handle_stream_chunk(self):
        """Append a raw audio chunk to the streaming buffer."""
        content_length = int(self.headers.get("Content-Length", 0))
        chunk = self.rfile.read(content_length)
        with _stream_lock:
            _stream_chunks.append(chunk)
        self._json_response(200, {"chunks": len(_stream_chunks)})

    def _handle_stream_finish(self):
        """Concatenate all streamed chunks and transcribe."""
        with _stream_lock:
            if not _stream_chunks:
                self._json_response(400, {"error": "no audio chunks received"})
                return
            audio_data = b"".join(_stream_chunks)
            model_name = _stream_model
            _stream_chunks.clear()

        if not audio_data:
            self._json_response(400, {"error": "empty audio"})
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
        except ImportError as e:
            self._json_response(500, {"error": str(e)})
        except Exception as e:
            self._json_response(500, {"error": str(e)})
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # --- Legacy batch endpoint (kept for fallback) ---

    def _handle_transcribe(self):
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

    # Parse --preload <model_name> to pre-warm the model at startup
    preload_model = None
    if "--preload" in sys.argv:
        idx = sys.argv.index("--preload")
        if idx + 1 < len(sys.argv):
            preload_model = sys.argv[idx + 1]

    if preload_model:
        prewarm_model(preload_model)

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

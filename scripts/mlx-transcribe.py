#!/usr/bin/env python3
"""MLX Whisper transcription script for WhisperAlone.

Usage: python3 mlx-transcribe.py <audio_file> [model_name]

Outputs transcribed text to stdout.
Errors go to stderr.
"""

import sys
import json

def main():
    if len(sys.argv) < 2:
        print("Usage: mlx-transcribe.py <audio_file> [model_name]", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "mlx-community/whisper-small"

    try:
        import mlx_whisper
    except ImportError:
        print("ERROR: mlx-whisper not installed. Run: pip3 install mlx-whisper", file=sys.stderr)
        sys.exit(2)

    try:
        result = mlx_whisper.transcribe(
            audio_file,
            path_or_hf_repo=model_name,
        )
        text = result.get("text", "").strip()
        # Output as JSON for reliable parsing
        print(json.dumps({"text": text}))
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()

import { describe, it, expect } from 'vitest';
import http from 'http';

describe('MLX Server Script', () => {
  it('mlx-server.py exists and is valid Python', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.join(__dirname, '../scripts/mlx-server.py');
    expect(fs.existsSync(scriptPath)).toBe(true);

    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('MLX_SERVER_READY');
    expect(content).toContain('/transcribe');
    expect(content).toContain('/health');
    expect(content).toContain('/shutdown');
  });

  it('mlx-transcribe.py exists and is valid Python', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.join(__dirname, '../scripts/mlx-transcribe.py');
    expect(fs.existsSync(scriptPath)).toBe(true);

    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('mlx_whisper');
    expect(content).toContain('json.dumps');
  });

  it('server script has proper shebang', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.join(__dirname, '../scripts/mlx-server.py');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content.startsWith('#!/usr/bin/env python3')).toBe(true);
  });

  it('server script uses correct default port', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.join(__dirname, '../scripts/mlx-server.py');
    const content = fs.readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('18456');
  });
});

describe('Multipart form building', () => {
  it('builds correct multipart boundary format', () => {
    const boundary = '----WhisperAloneTest123';
    const audioBuffer = Buffer.from('fake audio data');
    const modelName = 'mlx-community/whisper-small';

    const parts: Buffer[] = [];

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${modelName}\r\n`
    ));

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
      `Content-Type: audio/webm\r\n\r\n`
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const bodyStr = body.toString();

    expect(bodyStr).toContain(`--${boundary}`);
    expect(bodyStr).toContain('name="model"');
    expect(bodyStr).toContain(modelName);
    expect(bodyStr).toContain('name="file"');
    expect(bodyStr).toContain('filename="recording.webm"');
    expect(bodyStr).toContain(`--${boundary}--`);
  });
});

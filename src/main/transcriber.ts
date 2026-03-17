import OpenAI, { toFile } from 'openai';
import { log } from './logger';
import { getSettings } from './store';
import { transcribeViaServer } from './mlx-server';

// --- OpenAI backend ---

function getOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function transcribeWithOpenAI(audioBuffer: Buffer): Promise<string> {
  const openai = getOpenAIClient();
  const file = await toFile(audioBuffer, 'recording.webm', {
    type: 'audio/webm',
  });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'text',
  });

  return typeof transcription === 'string'
    ? transcription.trim()
    : (transcription as any).text?.trim() ?? '';
}

// --- Public API ---

export const MLX_MODELS = [
  { id: 'mlx-community/whisper-tiny', name: 'Whisper Tiny', size: '~75 MB', speed: 'Fastest' },
  { id: 'mlx-community/whisper-base', name: 'Whisper Base', size: '~140 MB', speed: 'Fast' },
  { id: 'mlx-community/whisper-small', name: 'Whisper Small', size: '~460 MB', speed: 'Balanced' },
  { id: 'mlx-community/whisper-medium', name: 'Whisper Medium', size: '~1.5 GB', speed: 'Accurate' },
  { id: 'mlx-community/whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo', size: '~1.6 GB', speed: 'Best (Turbo)' },
  { id: 'mlx-community/whisper-large-v3', name: 'Whisper Large v3', size: '~3 GB', speed: 'Best' },
];

export type TranscriberBackend = 'openai' | 'mlx';

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const settings = getSettings();
  const backend = settings.backend;
  const model = settings.mlxModel;

  log(`[Transcriber] Transcribing ${audioBuffer.length} bytes with ${backend}${backend === 'mlx' ? ` (${model})` : ''}...`);

  let text: string;
  if (backend === 'mlx') {
    text = await transcribeViaServer(audioBuffer, model);
  } else {
    text = await transcribeWithOpenAI(audioBuffer);
  }

  log(`[Transcriber] Done, ${text.length} chars`);
  return text;
}

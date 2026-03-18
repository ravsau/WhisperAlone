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

// --- Models ---

export const MLX_MODELS = [
  { id: 'mlx-community/whisper-large-v3-turbo', label: 'Fast', description: 'local, ~0.7s', size: '~1.6 GB' },
  { id: 'mlx-community/whisper-large-v3', label: 'Quality', description: 'local, most accurate', size: '~3 GB' },
];

export const DEFAULT_MLX_MODEL = MLX_MODELS[0].id;

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

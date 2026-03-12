import OpenAI, { toFile } from 'openai';
import { log } from './logger';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  log(`[Transcriber] Transcribing ${audioBuffer.length} bytes...`);

  const file = await toFile(audioBuffer, 'recording.webm', {
    type: 'audio/webm',
  });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'text',
  });

  const text = typeof transcription === 'string'
    ? transcription.trim()
    : (transcription as any).text?.trim() ?? '';

  log(`[Transcriber] Done, ${text.length} chars`);
  return text;
}

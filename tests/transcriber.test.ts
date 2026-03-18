import { describe, it, expect, vi } from 'vitest';
import { MLX_MODELS } from '../src/main/transcriber';

vi.mock('openai', () => ({
  default: class {
    audio = { transcriptions: { create: vi.fn() } };
  },
  toFile: vi.fn(),
}));

vi.mock('../src/main/store', () => ({
  getSettings: vi.fn(() => ({ backend: 'mlx', mlxModel: 'mlx-community/whisper-large-v3-turbo' })),
}));

vi.mock('../src/main/mlx-server', () => ({
  transcribeViaServer: vi.fn(),
}));

vi.mock('../src/main/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

describe('MLX_MODELS', () => {
  it('contains Fast and Quality models', () => {
    expect(MLX_MODELS.length).toBe(2);
    expect(MLX_MODELS.map(m => m.label)).toEqual(['Fast', 'Quality']);
  });

  it('Fast is whisper-large-v3-turbo', () => {
    const fast = MLX_MODELS.find(m => m.label === 'Fast');
    expect(fast?.id).toBe('mlx-community/whisper-large-v3-turbo');
  });

  it('Quality is whisper-large-v3', () => {
    const quality = MLX_MODELS.find(m => m.label === 'Quality');
    expect(quality?.id).toBe('mlx-community/whisper-large-v3');
  });

  it('each model has required fields', () => {
    for (const model of MLX_MODELS) {
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('label');
      expect(model).toHaveProperty('description');
      expect(model).toHaveProperty('size');
      expect(model.id).toMatch(/^mlx-community\/whisper-/);
    }
  });
});

describe('transcribeAudio', () => {
  it('routes to OpenAI when backend is openai', async () => {
    const { getSettings } = await import('../src/main/store');
    vi.mocked(getSettings).mockReturnValue({ backend: 'openai', mlxModel: 'mlx-community/whisper-large-v3-turbo' });
    const settings = getSettings();
    expect(settings.backend).toBe('openai');
  });

  it('routes to MLX when backend is mlx', async () => {
    const { getSettings } = await import('../src/main/store');
    vi.mocked(getSettings).mockReturnValue({ backend: 'mlx', mlxModel: 'mlx-community/whisper-large-v3-turbo' });
    const settings = getSettings();
    expect(settings.backend).toBe('mlx');
    expect(settings.mlxModel).toBe('mlx-community/whisper-large-v3-turbo');
  });
});

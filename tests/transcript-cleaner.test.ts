import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/main/transcript-cleaner';

describe('cleanTranscript', () => {
  it('leaves ordinary conversational dictation unchanged', () => {
    const text = "No, no, no. I don't want a rewrite; keep what I actually said.";
    expect(cleanTranscript(text)).toEqual({
      text,
      changed: false,
      rejected: false,
      removedLoops: 0,
      removedTokens: 0,
    });
  });

  it('removes a repeated single-word hallucination from the end', () => {
    const result = cleanTranscript(`Keep this sentence. ${'On '.repeat(223)}`);
    expect(result.text).toBe('Keep this sentence.');
    expect(result.changed).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.removedTokens).toBe(223);
  });

  it('removes the short lead-in attached to a long hallucinated tail', () => {
    const result = cleanTranscript(`Keep this sentence. On the left ${'page '.repeat(220)}`);
    expect(result.text).toBe('Keep this sentence.');
  });

  it('rejects a transcript made entirely from a decoder loop', () => {
    const result = cleanTranscript('page '.repeat(220));
    expect(result.text).toBe('');
    expect(result.rejected).toBe(true);
  });

  it('removes repeated phrases without rewriting surrounding text', () => {
    const loop = 'On the left of the world, '.repeat(12);
    const result = cleanTranscript(`First thought. ${loop}Second thought.`);
    expect(result.text).toBe('First thought. Second thought.');
    expect(result.removedLoops).toBe(1);
  });

  it('removes a short repeated phrase at the end of a hallucinated tail', () => {
    const result = cleanTranscript(`Keep this. ${'On '.repeat(220)}${'Thank you. '.repeat(4)}`);
    expect(result.text).toBe('Keep this.');
  });

  it('removes multiple separate loops and preserves content between them', () => {
    const result = cleanTranscript(
      `Start. ${'mol '.repeat(20)}Keep this. ${'please '.repeat(12)}Finish.`
    );
    expect(result.text).toBe('Start. Keep this. Finish.');
    expect(result.removedLoops).toBe(2);
  });

  it('does not erase short repetitions used for emphasis', () => {
    const text = 'This is bad bad bad, please please please, but recoverable.';
    expect(cleanTranscript(text).text).toBe(text);
  });
});

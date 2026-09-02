export interface TranscriptCleanupResult {
  text: string;
  changed: boolean;
  rejected: boolean;
  removedLoops: number;
  removedTokens: number;
}

interface WordToken {
  normalized: string;
  start: number;
  end: number;
}

interface RepetitionRun {
  startToken: number;
  endToken: number;
  copies: number;
  unitLength: number;
}

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const MAX_REPEATED_PHRASE_WORDS = 12;

function tokenize(text: string): WordToken[] {
  return [...text.matchAll(WORD_PATTERN)].map((match) => ({
    normalized: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function tokensMatch(tokens: WordToken[], first: number, second: number, length: number): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (tokens[first + offset].normalized !== tokens[second + offset].normalized) {
      return false;
    }
  }
  return true;
}

function isPathologicalRun(unitLength: number, copies: number): boolean {
  if (unitLength === 1) return copies >= 8;
  if (unitLength <= 3) return copies >= 4 && unitLength * copies >= 8;
  return copies >= 3 && unitLength * copies >= 12;
}

function findRunAt(tokens: WordToken[], startToken: number): RepetitionRun | null {
  let best: RepetitionRun | null = null;
  const remaining = tokens.length - startToken;
  const maxUnitLength = Math.min(MAX_REPEATED_PHRASE_WORDS, Math.floor(remaining / 2));

  for (let unitLength = 1; unitLength <= maxUnitLength; unitLength += 1) {
    let copies = 1;
    while (
      startToken + (copies + 1) * unitLength <= tokens.length &&
      tokensMatch(tokens, startToken, startToken + copies * unitLength, unitLength)
    ) {
      copies += 1;
    }

    if (!isPathologicalRun(unitLength, copies)) continue;

    const candidate: RepetitionRun = {
      startToken,
      endToken: startToken + copies * unitLength,
      copies,
      unitLength,
    };
    if (!best || candidate.endToken > best.endToken) {
      best = candidate;
    }
  }

  return best;
}

function findRepetitionRuns(tokens: WordToken[]): RepetitionRun[] {
  const runs: RepetitionRun[] = [];
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    const run = findRunAt(tokens, tokenIndex);
    if (run) {
      runs.push(run);
      tokenIndex = run.endToken;
    } else {
      tokenIndex += 1;
    }
  }

  return runs;
}

function tidyDeletionSeams(text: string): string {
  const tidied = text
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([.!?])\s*[,;:]+/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[\s,;:–—-]+$/u, '')
    .trim();

  return tokenize(tidied).length > 0 ? tidied : '';
}

function tailClusterCut(
  original: string,
  tokens: WordToken[],
  runs: RepetitionRun[]
): number | null {
  const firstRun = runs[0];
  const lastRun = runs[runs.length - 1];
  const suffix = original.slice(tokens[lastRun.endToken - 1].end);
  const suffixTokens = tokenize(suffix).length;
  const suffixHasSentence = suffixTokens > 0 && /[.!?]/u.test(suffix);
  const runTokens = runs.reduce((total, run) => total + run.endToken - run.startToken, 0);
  const clusterTokens = tokens.length - firstRun.startToken;
  const unexplainedClusterTokens = clusterTokens - runTokens;

  if (
    suffixHasSentence ||
    suffixTokens > Math.max(12, lastRun.unitLength) ||
    unexplainedClusterTokens > 12
  ) {
    return null;
  }

  let cut = tokens[firstRun.startToken].start;
  const prefix = original.slice(0, cut);
  const boundaryMatches = [...prefix.matchAll(/[.!?](?:\s+|$)/gu)];
  const lastBoundary = boundaryMatches.at(-1);

  if (lastBoundary?.index !== undefined) {
    const afterBoundary = lastBoundary.index + lastBoundary[0].length;
    if (tokenize(original.slice(afterBoundary, cut)).length <= MAX_REPEATED_PHRASE_WORDS) {
      cut = afterBoundary;
    }
  } else if (firstRun.startToken <= MAX_REPEATED_PHRASE_WORDS) {
    cut = 0;
  }

  return cut;
}

/**
 * Remove only high-confidence consecutive decoder loops while preserving the
 * rest of the transcription byte-for-byte apart from whitespace at deletion
 * seams. This deliberately does not rewrite grammar or infer missing speech.
 */
export function cleanTranscript(input: string): TranscriptCleanupResult {
  const original = input.trim();
  const tokens = tokenize(original);
  const runs = findRepetitionRuns(tokens);

  if (runs.length === 0) {
    return {
      text: original,
      changed: original !== input,
      rejected: original.length === 0,
      removedLoops: 0,
      removedTokens: 0,
    };
  }

  const tailCut = tailClusterCut(original, tokens, runs);
  if (tailCut !== null) {
    const text = tidyDeletionSeams(original.slice(0, tailCut));
    return {
      text,
      changed: text !== original,
      rejected: text.length === 0,
      removedLoops: runs.length,
      removedTokens: tokens.length - tokenize(text).length,
    };
  }

  let cursor = 0;
  const kept: string[] = [];
  let removedTokens = 0;

  for (const run of runs) {
    const start = tokens[run.startToken].start;
    const end = tokens[run.endToken - 1].end;
    kept.push(original.slice(cursor, start));
    cursor = end;
    removedTokens += run.endToken - run.startToken;
  }
  kept.push(original.slice(cursor));

  const text = tidyDeletionSeams(kept.join(' '));
  return {
    text,
    changed: text !== original,
    rejected: text.length === 0,
    removedLoops: runs.length,
    removedTokens,
  };
}

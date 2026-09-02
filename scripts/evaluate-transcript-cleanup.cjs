#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanTranscript } = require('../dist/main/transcript-cleaner.js');

const configPath = process.argv[2] || path.join(
  os.homedir(),
  'Library/Application Support/whisper-alone/config.json'
);

if (!fs.existsSync(configPath)) {
  console.error(`WhisperAlone history not found: ${configPath}`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const history = Array.isArray(config.history) ? config.history : [];
const summary = {
  totalEntries: history.length,
  unchangedEntries: 0,
  repairedEntries: 0,
  rejectedLoopOnlyEntries: 0,
  removedTokens: 0,
  residualDetectedLoops: 0,
};

for (const entry of history) {
  const result = cleanTranscript(String(entry.text || ''));
  if (result.changed) {
    summary.repairedEntries += 1;
    summary.removedTokens += result.removedTokens;
    if (result.rejected) summary.rejectedLoopOnlyEntries += 1;
  } else {
    summary.unchangedEntries += 1;
  }

  if (cleanTranscript(result.text).changed) {
    summary.residualDetectedLoops += 1;
  }
}

console.log(JSON.stringify(summary, null, 2));

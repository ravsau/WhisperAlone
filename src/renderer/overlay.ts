const NUM_BARS = 24;
const waveform = document.getElementById('waveform')!;
const pill = document.getElementById('pill')!;
const label = document.getElementById('label')!;

// Create bars
const bars: HTMLDivElement[] = [];
for (let i = 0; i < NUM_BARS; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.height = '4px';
  waveform.appendChild(bar);
  bars.push(bar);
}

// Animate bars with random heights that feel organic
let animationId: number | null = null;
let isRecording = false;

function animateBars() {
  if (!isRecording) return;

  bars.forEach((bar, i) => {
    // Create a wave-like pattern with some randomness
    const time = Date.now() / 150;
    const wave = Math.sin(time + i * 0.4) * 0.5 + 0.5;
    const random = Math.random() * 0.3;
    const height = 4 + (wave + random) * 20;
    bar.style.height = `${height}px`;
    bar.style.opacity = `${0.5 + wave * 0.5}`;
  });

  animationId = requestAnimationFrame(animateBars);
}

function startAnimation() {
  isRecording = true;
  pill.classList.remove('processing');
  label.textContent = 'Listening...';
  animateBars();
}

function stopAnimation() {
  isRecording = false;
  pill.classList.add('processing');
  label.textContent = 'Transcribing...';

  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  // Flatten bars
  bars.forEach((bar) => {
    bar.style.height = '4px';
    bar.style.opacity = '0.4';
  });
}

// Listen for IPC messages from main process
window.api.onStartRecording(() => {
  startAnimation();
});

window.api.onStopRecording(() => {
  stopAnimation();
});

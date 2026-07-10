const NUM_BARS = 16;
const waveform = document.getElementById('waveform')!;
const pill = document.getElementById('pill')!;

// Create bars
const bars: HTMLDivElement[] = [];
for (let i = 0; i < NUM_BARS; i++) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.style.height = '3px';
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
    const height = 3 + (wave + random) * 10;
    bar.style.height = `${height}px`;
    bar.style.opacity = `${0.5 + wave * 0.5}`;
  });

  animationId = requestAnimationFrame(animateBars);
}

function startAnimation() {
  isRecording = true;
  pill.classList.remove('processing');
  animateBars();
}

function stopAnimation() {
  isRecording = false;
  pill.classList.add('processing');

  if (animationId !== null) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  // Flatten bars
  bars.forEach((bar) => {
    bar.style.height = '3px';
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

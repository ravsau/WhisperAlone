const iconEl = document.getElementById('icon')!;
const titleEl = document.getElementById('title')!;
const statusEl = document.getElementById('status')!;
const progressEl = document.getElementById('progress')!;

const steps = {
  venv: {
    el: document.getElementById('step-venv')!,
    iconEl: document.getElementById('step-venv-icon')!,
  },
  install: {
    el: document.getElementById('step-install')!,
    iconEl: document.getElementById('step-install-icon')!,
  },
  server: {
    el: document.getElementById('step-server')!,
    iconEl: document.getElementById('step-server-icon')!,
  },
};

function setStep(step: 'venv' | 'install' | 'server', state: 'active' | 'done' | 'error') {
  const s = steps[step];
  s.el.className = `step ${state}`;
  if (state === 'active') {
    s.iconEl.innerHTML = '<span class="spinner"></span>';
  } else if (state === 'done') {
    s.iconEl.textContent = '\u2713';
  } else {
    s.iconEl.textContent = '\u2715';
  }
}

window.api.onSetupProgress((data: { step: string; state: string; message: string }) => {
  statusEl.textContent = data.message;
  statusEl.className = `status ${data.state === 'error' ? 'error' : ''}`;

  if (data.step === 'venv') {
    setStep('venv', data.state as any);
  } else if (data.step === 'install') {
    setStep('venv', 'done');
    setStep('install', data.state as any);
  } else if (data.step === 'server') {
    setStep('venv', 'done');
    setStep('install', 'done');
    setStep('server', data.state as any);
  } else if (data.step === 'done') {
    setStep('venv', 'done');
    setStep('install', 'done');
    setStep('server', 'done');
    progressEl.classList.remove('indeterminate');
    progressEl.style.width = '100%';
    statusEl.className = 'status success';
    statusEl.textContent = data.message;
    titleEl.textContent = 'Ready!';
    iconEl.textContent = '\u2705';
  } else if (data.step === 'error') {
    progressEl.classList.remove('indeterminate');
    progressEl.style.width = '0%';
    progressEl.style.background = '#ff453a';
    statusEl.className = 'status error';
    titleEl.textContent = 'Setup Failed';
    iconEl.textContent = '\u274C';
  }
});

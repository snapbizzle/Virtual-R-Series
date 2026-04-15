const placementStatus = document.getElementById('placement-status');
const resetPlacement = document.getElementById('reset-placement');
const padRadios = document.querySelectorAll('input[name="pad"]');
const zones = document.querySelectorAll('.placement-zone');
const placedSternum = document.getElementById('placed-sternum');
const placedApex = document.getElementById('placed-apex');

const screenCanvas = document.getElementById('ekg-screen');
const screenOverlay = document.getElementById('screen-overlay');
const screenLabel = document.getElementById('screen-label');
const energyLabel = document.getElementById('energy-label');
const deviceStatus = document.getElementById('device-status');
const controls = document.querySelector('.controls');

const placement = { sternum: false, apex: false };
const device = {
  on: false,
  charged: false,
  energy: 0,
  mode: 'idle',
  rhythm: 'sinus',
  phase: 0,
};
const VF_PROBABILITY = 0.5;

function selectedPad() {
  return [...padRadios].find((radio) => radio.checked)?.value || 'sternum';
}

function updatePlacementMessage(message, isOk = false) {
  placementStatus.textContent = message;
  placementStatus.className = isOk ? 'ok' : 'warn';
}

function refreshPlacedPads() {
  placedSternum.hidden = !placement.sternum;
  placedApex.hidden = !placement.apex;

  if (placement.sternum && placement.apex) {
    updatePlacementMessage('Great work. Both pads are correctly placed.', true);
  }
}

zones.forEach((zone) => {
  zone.addEventListener('click', () => {
    const currentPad = selectedPad();
    const zoneType = zone.dataset.zone;

    if (currentPad !== zoneType) {
      updatePlacementMessage(`That is not the correct location for the ${currentPad} pad.`);
      return;
    }

    placement[zoneType] = true;
    refreshPlacedPads();
    if (!(placement.sternum && placement.apex)) {
      updatePlacementMessage(`${currentPad[0].toUpperCase()}${currentPad.slice(1)} pad placed.`);
    }
  });
});

resetPlacement.addEventListener('click', () => {
  placement.sternum = false;
  placement.apex = false;
  refreshPlacedPads();
  placementStatus.className = '';
  placementStatus.textContent = 'Place both pads to complete training.';
});

const ctx = screenCanvas.getContext('2d');

function drawGrid() {
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, screenCanvas.width, screenCanvas.height);
  ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= screenCanvas.width; x += 20) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, screenCanvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= screenCanvas.height; y += 20) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(screenCanvas.width, y);
    ctx.stroke();
  }
}

function rhythmSample(x, rhythm, phase) {
  const base = Math.sin((x + phase) * 0.065) * 7;
  if (rhythm === 'vf') {
    return Math.sin((x + phase) * 0.25) * 22 + Math.sin((x + phase) * 0.08) * 7;
  }
  if (rhythm === 'paced') {
    return x % 80 < 4 ? -42 : base;
  }
  const qrs = x % 120;
  if (qrs > 27 && qrs < 30) return -38;
  if (qrs >= 30 && qrs < 34) return 44;
  if (qrs >= 34 && qrs < 38) return -22;
  return base;
}

function drawRhythm() {
  drawGrid();
  if (!device.on) return;

  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const yCenter = screenCanvas.height / 2;
  for (let x = 0; x <= screenCanvas.width; x += 2) {
    const y = yCenter + rhythmSample(x, device.rhythm, device.phase);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  device.phase += 3;
}

function renderScreenState() {
  screenOverlay.style.display = device.on ? 'none' : 'grid';
  screenLabel.textContent =
    !device.on ? 'Ready' : device.mode === 'pacer' ? 'Pacing' : device.mode === 'lead12' ? '12-Lead View' : 'Monitor';
  energyLabel.textContent = `Energy: ${device.energy} J`;
}

function setStatus(message, type = '') {
  deviceStatus.className = type;
  deviceStatus.textContent = message;
}

function handleAction(action) {
  if (action === 'power') {
    device.on = !device.on;
    if (!device.on) {
      device.charged = false;
      device.energy = 0;
      device.mode = 'idle';
      device.rhythm = 'sinus';
      setStatus('Device is off.');
    } else {
      setStatus('Device powered on. Monitoring rhythm.', 'ok');
    }
    renderScreenState();
    return;
  }

  if (!device.on) {
    setStatus('Power on the device first.', 'warn');
    return;
  }

  if (action === 'analyze') {
    device.rhythm = Math.random() > VF_PROBABILITY ? 'vf' : 'sinus';
    device.mode = 'idle';
    setStatus(
      device.rhythm === 'vf'
        ? 'Shockable rhythm detected (VF). Charge and shock if indicated.'
        : 'Non-shockable organized rhythm detected.',
      device.rhythm === 'vf' ? 'warn' : 'ok',
    );
  } else if (action === 'charge') {
    device.energy = Math.min(device.energy + 50, 200);
    device.charged = true;
    setStatus(`Charging complete. Selected energy: ${device.energy} J.`, 'ok');
  } else if (action === 'shock') {
    if (!device.charged || device.energy === 0) {
      setStatus('Charge before delivering a shock.', 'warn');
    } else {
      device.charged = false;
      device.rhythm = 'sinus';
      setStatus(`Shock delivered at ${device.energy} J. Rhythm reassessing...`, 'ok');
      device.energy = 0;
    }
  } else if (action === 'pacer') {
    device.mode = device.mode === 'pacer' ? 'idle' : 'pacer';
    device.rhythm = device.mode === 'pacer' ? 'paced' : 'sinus';
    setStatus(device.mode === 'pacer' ? 'Pacer enabled.' : 'Pacer disabled.', 'ok');
  } else if (action === 'lead12') {
    device.mode = 'lead12';
    setStatus('12-Lead preview selected (visual placeholder).', 'ok');
  }

  renderScreenState();
}

controls.addEventListener('click', (event) => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  handleAction(target.dataset.action);
});

renderScreenState();
setInterval(drawRhythm, 40);

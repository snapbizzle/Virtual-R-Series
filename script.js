'use strict';

/* ═══════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════ */
const ENERGY_LEVELS   = [1, 2, 5, 10, 20, 30, 50, 100, 150, 200]; // joules
const DEFAULT_ENERGY_IDX = ENERGY_LEVELS.length - 1;               // 200 J

const LEADS  = ['Pads', 'I', 'II', 'III', 'aVR', 'aVL', 'aVF'];
const GAINS  = ['×0.5', '×1', '×2', 'AUTO'];
const DEFAULT_LEAD_IDX = 2; // Lead II
const DEFAULT_GAIN_IDX = 1; // ×1

const OUTPUT_MIN  = 0;
const OUTPUT_MAX  = 140;
const OUTPUT_STEP = 10;
const OUTPUT_DEFAULT = 0;

const NORMAL_SINUS_HR = 72; // bpm — displayed when no HR can be calculated

const RATE_MIN  = 30;
const RATE_MAX  = 180;
const RATE_STEP = 10;
const RATE_DEFAULT = 70;

const ALARM_SUSPEND_DURATION_S = 90;
const VF_PROBABILITY = 0.5;

// Knob needle rotation angles (degrees) per mode
const MODE_NEEDLE_ANGLES = { off: 0, monitor: -75, defib: 75, pacer: 150 };

// Context-sensitive soft-key labels per mode
const SOFTKEYS = {
  off:     ['', '', '', '', '', ''],
  monitor: ['12-Lead', 'SpO₂', 'NIBP', 'Events', 'Alarms', 'Setup'],
  defib:   ['CPR Help', 'Events', 'SpO₂', 'NIBP', 'Alarms', 'Setup'],
  pacer:   ['Demand/Async', 'Events', 'SpO₂', 'NIBP', 'Alarms', 'Setup'],
};

/* ═══════════════════════════════════════════════════════════════
   Device state
   ═══════════════════════════════════════════════════════════════ */
const placement = { sternum: false, apex: false };

const device = {
  mode: 'off',          // 'off' | 'monitor' | 'defib' | 'pacer'
  // Defibrillation sub-state
  defibState: 'idle',   // 'idle'|'analyzing'|'shockAdvised'|'noShock'|'charging'|'charged'|'shocked'
  rhythm:  'sinus',     // 'sinus'|'vf'|'pvt'|'pea'|'asystole'|'paced'
  leadIdx:    DEFAULT_LEAD_IDX,
  gainIdx:    DEFAULT_GAIN_IDX,
  energyIdx:  DEFAULT_ENERGY_IDX,
  charged:    false,
  // Pacing
  output:     OUTPUT_DEFAULT,
  rate:       RATE_DEFAULT,
  pacingEnabled: false,
  pacingMode: 'demand', // 'demand' | 'async'
  // Accessories
  alarmSuspended: false,
  alarmTimer:     0,
  recording:      false,
  // Animation
  phase: 0,
};

/* ═══════════════════════════════════════════════════════════════
   DOM references
   ═══════════════════════════════════════════════════════════════ */
// Pad placement
const placementStatus = document.getElementById('placement-status');
const resetPlacement  = document.getElementById('reset-placement');
const padRadios       = document.querySelectorAll('input[name="pad"]');
const zones           = document.querySelectorAll('.placement-zone');
const placedSternum   = document.getElementById('placed-sternum');
const placedApex      = document.getElementById('placed-apex');

// Device
const deviceWrap   = document.getElementById('device-wrap');
const screenCanvas = document.getElementById('ekg-screen');
const screenOff    = document.getElementById('screen-off');
const knobNeedle   = document.getElementById('knob-needle');
const deviceStatus = document.getElementById('device-status');
const modeBadge    = document.getElementById('mode-badge');
const hintBox      = document.getElementById('hint-box');
const outputVal    = document.getElementById('output-val');
const rateVal      = document.getElementById('rate-val');
const softkeys     = document.querySelectorAll('.sk');

const ctx = screenCanvas.getContext('2d');

/* ═══════════════════════════════════════════════════════════════
   Pad placement module
   ═══════════════════════════════════════════════════════════════ */
function selectedPad() {
  return [...padRadios].find((r) => r.checked)?.value ?? 'sternum';
}

function updatePlacementMsg(msg, isOk = false) {
  placementStatus.textContent = msg;
  placementStatus.className   = isOk ? 'ok' : 'warn';
}

function refreshPlacedPads() {
  placedSternum.hidden = !placement.sternum;
  placedApex.hidden    = !placement.apex;
  if (placement.sternum && placement.apex) {
    updatePlacementMsg('Both pads correctly placed. Excellent work!', true);
  }
}

zones.forEach((zone) => {
  zone.addEventListener('click', () => {
    const pad  = selectedPad();
    const type = zone.dataset.zone;
    if (pad !== type) {
      updatePlacementMsg(`Incorrect location for the ${pad} pad. Try again.`);
      return;
    }
    placement[type] = true;
    refreshPlacedPads();
    if (!(placement.sternum && placement.apex)) {
      updatePlacementMsg(`${pad[0].toUpperCase()}${pad.slice(1)} pad placed correctly.`);
    }
  });
});

resetPlacement.addEventListener('click', () => {
  placement.sternum = false;
  placement.apex    = false;
  refreshPlacedPads();
  placementStatus.className = '';
  placementStatus.textContent = 'Place both pads to complete training.';
});

/* ═══════════════════════════════════════════════════════════════
   ECG waveform rendering
   ═══════════════════════════════════════════════════════════════ */
// Named waveform constants (avoids magic numbers in rhythmSample)
// Frequencies are in radians per sample (x). Amplitudes are in canvas pixels.
const WF = {
  BASE_FREQ:  0.065, // sine frequency for baseline wander
  BASE_AMP:    7,    // baseline wander amplitude (px)
  QRS_CYCLE:  120,   // sinus QRS cycle length (samples)
  // QRS deflection offsets within each cycle
  Q_START: 27, Q_END: 30,   Q_AMP:  -38, // Q wave (negative)
  R_START: 30, R_END: 34,   R_AMP:   44, // R wave (peak)
  S_START: 34, S_END: 38,   S_AMP:  -22, // S wave (negative)
  // Ventricular fibrillation
  VF_HI_FREQ: 0.25, VF_HI_AMP: 22,
  VF_LO_FREQ: 0.08, VF_LO_AMP:  7,
  // External pacing spikes
  PACED_INTERVAL: 80, SPIKE_WIDTH: 4, SPIKE_AMP: -42,
  // Polymorphic VT (pVT) modulation
  PVT_FREQ: 0.18, PVT_MOD_FREQ: 0.025, PVT_AMP: 30,
};

function rhythmSample(x, rhythm, phase) {
  const base = Math.sin((x + phase) * WF.BASE_FREQ) * WF.BASE_AMP;

  if (rhythm === 'vf') {
    return (
      Math.sin((x + phase) * WF.VF_HI_FREQ) * WF.VF_HI_AMP +
      Math.sin((x + phase) * WF.VF_LO_FREQ) * WF.VF_LO_AMP
    );
  }
  if (rhythm === 'asystole') {
    return base * 0.12;
  }
  if (rhythm === 'pvt') {
    return (
      Math.sin((x + phase) * WF.PVT_FREQ) *
      WF.PVT_AMP *
      Math.sin((x + phase) * WF.PVT_MOD_FREQ)
    );
  }
  if (rhythm === 'paced') {
    const pos = x % WF.PACED_INTERVAL;
    if (pos < WF.SPIKE_WIDTH) return WF.SPIKE_AMP;
    const qrsPos = pos - WF.SPIKE_WIDTH;
    if (qrsPos > 2 && qrsPos < 5)  return 30;
    if (qrsPos >= 5 && qrsPos < 8) return -15;
    return base * 0.5;
  }
  // sinus / pea — same morphology (PEA has organised ECG, no pulse)
  const qrs = x % WF.QRS_CYCLE;
  if (qrs > WF.Q_START && qrs < WF.Q_END) return WF.Q_AMP;
  if (qrs >= WF.R_START && qrs < WF.R_END) return WF.R_AMP;
  if (qrs >= WF.S_START && qrs < WF.S_END) return WF.S_AMP;
  return base;
}

function hrForRhythm(rhythm) {
  const map = { sinus: NORMAL_SINUS_HR, vf: 0, pvt: 0, pea: 60, asystole: 0, paced: device.rate };
  return map[rhythm] ?? NORMAL_SINUS_HR;
}

/* ── Screen draw loop ────────────────────────────────────────── */
const W = screenCanvas.width;
const H = screenCanvas.height;

const DEFIB_STATE_LABELS = {
  analyzing:    'ANALYZING — DO NOT TOUCH PATIENT',
  shockAdvised: 'SHOCK ADVISED — STAND CLEAR',
  noShock:      'NO SHOCK ADVISED',
  charging:     'CHARGING\u2026',
  charged:      'CHARGED — STAND CLEAR — PRESS SHOCK',
  shocked:      'SHOCK DELIVERED — REASSESS RHYTHM',
};

function drawScreen() {
  // Black background
  ctx.fillStyle = '#011';
  ctx.fillRect(0, 0, W, H);

  if (device.mode === 'off') return;

  // ECG grid
  ctx.strokeStyle = 'rgba(0,80,40,0.28)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 20) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y <= H; y += 20) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // ECG trace
  const gainMult = [0.5, 1.0, 2.0, 1.0][device.gainIdx];
  ctx.strokeStyle = '#00e676';
  ctx.lineWidth = 2;
  ctx.shadowColor = '#00e676';
  ctx.shadowBlur = 4;
  ctx.beginPath();
  const yCenter = H * 0.55;
  for (let x = 0; x <= W; x += 2) {
    const y = yCenter + rhythmSample(x, device.rhythm, device.phase) * gainMult;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
  device.phase += 3;

  // ── Screen HUD ───────────────────────────────────────────────
  // Lead + gain (top-left)
  ctx.fillStyle = '#00e676';
  ctx.font = 'bold 13px monospace';
  ctx.fillText(`Lead ${LEADS[device.leadIdx]}`, 6, 18);
  ctx.fillStyle = '#4ade80';
  ctx.font = '10px monospace';
  ctx.fillText(`Gain ${GAINS[device.gainIdx]}`, 6, 32);

  // HR display (top-right)
  const hr = hrForRhythm(device.rhythm);
  ctx.fillStyle = '#00e676';
  ctx.font = 'bold 22px monospace';
  const hrText = hr > 0 ? String(hr) : '---';
  const hrMeasure = ctx.measureText(hrText);
  ctx.fillText(hrText, W - hrMeasure.width - 6, 26);
  ctx.fillStyle = '#4ade80';
  ctx.font = '10px monospace';
  ctx.fillText('HR bpm', W - 52, 40);

  // Energy (DEFIB — top-center)
  if (device.mode === 'defib') {
    const eText = `${ENERGY_LEVELS[device.energyIdx]} J`;
    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = device.charged ? '#facc15' : '#94a3b8';
    const em = ctx.measureText(eText);
    ctx.fillText(eText, (W - em.width) / 2, 18);
  }

  // Pacing info (PACER — top-center)
  if (device.mode === 'pacer') {
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(`${device.output} mA  |  ${device.rate} ppm`, 6, H - 26);
    if (device.pacingEnabled) {
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(`PACING — ${device.pacingMode.toUpperCase()}`, W - 145, H - 26);
    }
  }

  // Defib status bar (bottom)
  const statusText = DEFIB_STATE_LABELS[device.defibState] ?? '';
  if (statusText) {
    const isWarn  = ['shockAdvised', 'charged'].includes(device.defibState);
    const isAlert = device.defibState === 'analyzing';
    ctx.fillStyle = isWarn ? '#ef4444' : isAlert ? '#f59e0b' : '#22c55e';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(statusText, 6, H - 10);
  }

  // Alarm suspend indicator
  if (device.alarmSuspended) {
    ctx.fillStyle = '#f59e0b';
    ctx.font = '10px monospace';
    ctx.fillText(`ALARM SUSP ${device.alarmTimer}s`, W - 130, H - 10);
  }

  // Recording indicator
  if (device.recording) {
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('\u25CF REC', 6, H - 26);
  }
}

setInterval(drawScreen, 40);

/* ═══════════════════════════════════════════════════════════════
   UI update helpers
   ═══════════════════════════════════════════════════════════════ */
function setStatus(msg, type = '') {
  deviceStatus.className   = type;
  deviceStatus.textContent = msg;
}

function updateModeBadge() {
  const labels = { off: 'OFF', monitor: 'MONITOR', defib: 'DEFIB', pacer: 'PACER' };
  modeBadge.textContent = labels[device.mode] ?? 'OFF';
  modeBadge.className = 'mode-badge';
  if (device.mode === 'monitor') modeBadge.classList.add('on-monitor');
  if (device.mode === 'defib')   modeBadge.classList.add('on-defib');
  if (device.mode === 'pacer')   modeBadge.classList.add('on-pacer');
}

function updateKnob() {
  const angle = MODE_NEEDLE_ANGLES[device.mode] ?? 0;
  knobNeedle.style.transform = `translate(0, -50%) rotate(${angle}deg)`;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active-mode', btn.dataset.mode === device.mode);
  });
}

function updateScreenOff() {
  screenOff.classList.toggle('hidden', device.mode !== 'off');
}

function updateSoftkeys() {
  const labels = SOFTKEYS[device.mode] ?? SOFTKEYS.off;
  softkeys.forEach((btn, i) => {
    btn.textContent = labels[i] ?? '';
    btn.disabled    = device.mode === 'off' || !labels[i];
    btn.title       = labels[i] ?? '';
  });
}

function updatePacerDisplay() {
  outputVal.textContent = `${device.output} mA`;
  rateVal.textContent   = `${device.rate} ppm`;
}

function updateButtonStates() {
  const on       = device.mode !== 'off';
  const inDefib  = device.mode === 'defib';
  const inPacer  = device.mode === 'pacer';

  const id = (s) => document.getElementById(s);

  id('btn-lead').disabled       = !on;
  id('btn-size').disabled       = !on;
  id('btn-alarm').disabled      = !on;
  id('btn-recorder').disabled   = !on;
  id('btn-analyze').disabled    = !inDefib;
  id('btn-charge').disabled     = !inDefib;
  id('btn-energy-up').disabled  = !inDefib;
  id('btn-energy-dn').disabled  = !inDefib;
  id('btn-shock').disabled      = !inDefib || !device.charged;
  id('btn-four-one').disabled   = !inPacer;
  id('btn-output-up').disabled  = !inPacer;
  id('btn-output-dn').disabled  = !inPacer;
  id('btn-rate-up').disabled    = !inPacer;
  id('btn-rate-dn').disabled    = !inPacer;

  // SHOCK armed pulse
  id('btn-shock').classList.toggle('shock-armed', device.charged);
}

function updateAll() {
  updateModeBadge();
  updateKnob();
  updateScreenOff();
  updateSoftkeys();
  updateButtonStates();
  updatePacerDisplay();
}

/* ═══════════════════════════════════════════════════════════════
   Alarm suspend timer
   ═══════════════════════════════════════════════════════════════ */
let alarmInterval = null;

function startAlarmSuspend() {
  device.alarmSuspended = true;
  device.alarmTimer     = ALARM_SUSPEND_DURATION_S;
  setStatus(`Alarms suspended for ${ALARM_SUSPEND_DURATION_S} seconds.`, 'ok');
  if (alarmInterval) clearInterval(alarmInterval);
  alarmInterval = setInterval(() => {
    device.alarmTimer -= 1;
    if (device.alarmTimer <= 0) {
      device.alarmSuspended = false;
      clearInterval(alarmInterval);
      alarmInterval = null;
      setStatus('Alarm suspend expired. Alarms re-enabled.', 'warn');
    }
  }, 1000);
}

/* ═══════════════════════════════════════════════════════════════
   Main action handler (full state machine)
   ═══════════════════════════════════════════════════════════════ */
function handleAction(action, extra) {
  switch (action) {

    /* ── Mode knob ─────────────────────────────────────────── */
    case 'mode': {
      const newMode = extra;
      if (newMode === device.mode) break;

      // Leaving defib — disarm
      if (device.mode === 'defib') {
        device.defibState = 'idle';
        device.charged    = false;
      }
      // Leaving pacer — stop pacing
      if (device.mode === 'pacer') {
        device.pacingEnabled = false;
        device.rhythm = 'sinus';
      }
      device.mode = newMode;

      const msgs = {
        off:     'Device is off. Click the Mode Knob (Step 1) to begin.',
        monitor: 'Monitor mode active. Continuously monitoring ECG rhythm.',
        defib:   'DEFIB mode: Step 1 complete. Press ANALYZE to assess rhythm, or CHARGE manually.',
        pacer:   'PACER mode: Increase OUTPUT mA to initiate pacing. Adjust RATE as needed.',
      };
      setStatus(msgs[newMode] ?? '', newMode !== 'off' ? 'ok' : '');
      break;
    }

    /* ── LEAD ──────────────────────────────────────────────── */
    case 'lead': {
      device.leadIdx = (device.leadIdx + 1) % LEADS.length;
      setStatus(`Lead: ${LEADS[device.leadIdx]}`, 'ok');
      break;
    }

    /* ── SIZE / GAIN ───────────────────────────────────────── */
    case 'size': {
      device.gainIdx = (device.gainIdx + 1) % GAINS.length;
      setStatus(`Waveform gain: ${GAINS[device.gainIdx]}`, 'ok');
      break;
    }

    /* ── ALARM SUSPEND ─────────────────────────────────────── */
    case 'alarm': {
      if (device.alarmSuspended) {
        device.alarmSuspended = false;
        if (alarmInterval) { clearInterval(alarmInterval); alarmInterval = null; }
        setStatus('Alarm suspend cancelled. Alarms re-enabled.', 'ok');
      } else {
        startAlarmSuspend();
      }
      break;
    }

    /* ── RECORDER ──────────────────────────────────────────── */
    case 'recorder': {
      device.recording = !device.recording;
      setStatus(device.recording ? 'Recorder started — printing ECG strip.' : 'Recorder stopped.', 'ok');
      break;
    }

    /* ── ANALYZE ───────────────────────────────────────────── */
    case 'analyze': {
      if (device.mode !== 'defib') break;
      device.defibState = 'analyzing';
      device.charged    = false;
      setStatus('Analyzing rhythm — DO NOT TOUCH PATIENT\u2026', 'warn');
      updateButtonStates();
      setTimeout(() => {
        const shockable   = Math.random() < VF_PROBABILITY;
        device.rhythm     = shockable ? 'vf' : 'sinus';
        device.defibState = shockable ? 'shockAdvised' : 'noShock';
        if (shockable) {
          setStatus('SHOCK ADVISED — VF detected. Press CHARGE, then SHOCK.', 'warn');
        } else {
          setStatus('No shock advised — organized rhythm detected. Continue CPR if pulseless.', 'ok');
        }
        updateButtonStates();
      }, 2500);
      break;
    }

    /* ── CHARGE ────────────────────────────────────────────── */
    case 'charge': {
      if (device.mode !== 'defib') break;
      const energy = ENERGY_LEVELS[device.energyIdx];
      device.defibState = 'charging';
      setStatus(`Charging to ${energy} J\u2026`, 'warn');
      updateButtonStates();
      setTimeout(() => {
        device.charged    = true;
        device.defibState = 'charged';
        setStatus(`Device charged — ${energy} J. STAND CLEAR. Press SHOCK to deliver.`, 'warn');
        updateButtonStates();
      }, 2000);
      break;
    }

    /* ── SHOCK ─────────────────────────────────────────────── */
    case 'shock': {
      if (!device.charged) { setStatus('Device not charged. Press CHARGE first.', 'warn'); break; }
      const energy = ENERGY_LEVELS[device.energyIdx];
      device.charged    = false;
      device.defibState = 'shocked';
      device.rhythm     = 'sinus'; // assume ROSC / reassessment for simulation
      setStatus(`Shock delivered — ${energy} J. Immediately resume CPR. Reassess rhythm in 2 minutes.`, 'ok');
      updateButtonStates();
      setTimeout(() => { device.defibState = 'idle'; updateButtonStates(); }, 3000);
      break;
    }

    /* ── ENERGY UP ─────────────────────────────────────────── */
    case 'energy-up': {
      if (device.charged) {
        device.charged = false; device.defibState = 'idle';
        setStatus('Energy changed — device disarmed.', 'warn');
      }
      device.energyIdx = Math.min(device.energyIdx + 1, ENERGY_LEVELS.length - 1);
      if (!device.charged) setStatus(`Energy selected: ${ENERGY_LEVELS[device.energyIdx]} J`, 'ok');
      break;
    }

    /* ── ENERGY DOWN ───────────────────────────────────────── */
    case 'energy-dn': {
      if (device.charged) {
        device.charged = false; device.defibState = 'idle';
        setStatus('Energy changed — device disarmed.', 'warn');
      }
      device.energyIdx = Math.max(device.energyIdx - 1, 0);
      if (!device.charged) setStatus(`Energy selected: ${ENERGY_LEVELS[device.energyIdx]} J`, 'ok');
      break;
    }

    /* ── OUTPUT UP (pacing mA) ─────────────────────────────── */
    case 'output-up': {
      device.output = Math.min(device.output + OUTPUT_STEP, OUTPUT_MAX);
      if (device.output > 0 && device.mode === 'pacer') {
        device.pacingEnabled = true;
        device.rhythm = 'paced';
      }
      setStatus(`Pacing output: ${device.output} mA`, 'ok');
      break;
    }

    /* ── OUTPUT DOWN (pacing mA) ───────────────────────────── */
    case 'output-dn': {
      device.output = Math.max(device.output - OUTPUT_STEP, OUTPUT_MIN);
      if (device.output === 0) {
        device.pacingEnabled = false;
        device.rhythm = 'sinus';
        setStatus('Pacing output: 0 mA — pacing stopped.', 'ok');
      } else {
        setStatus(`Pacing output: ${device.output} mA`, 'ok');
      }
      break;
    }

    /* ── RATE UP (pacing ppm) ──────────────────────────────── */
    case 'rate-up': {
      device.rate = Math.min(device.rate + RATE_STEP, RATE_MAX);
      setStatus(`Pacing rate: ${device.rate} ppm`, 'ok');
      break;
    }

    /* ── RATE DOWN (pacing ppm) ────────────────────────────── */
    case 'rate-dn': {
      device.rate = Math.max(device.rate - RATE_STEP, RATE_MIN);
      setStatus(`Pacing rate: ${device.rate} ppm`, 'ok');
      break;
    }

    /* ── 4:1 pacing test ───────────────────────────────────── */
    case 'four-one': {
      setStatus('4:1 test: pacing at 1:4 ratio — observe for capture. Increase output if no capture.', 'ok');
      break;
    }

    /* ── Soft keys ─────────────────────────────────────────── */
    case 'softkey': {
      const label = extra;
      if (!label) break;
      // Handle Demand/Async toggle separately to avoid IIFE in lookup object
      if (label === 'Demand/Async') {
        device.pacingMode = device.pacingMode === 'demand' ? 'async' : 'demand';
        setStatus(
          `Pacing mode set to: ${device.pacingMode.toUpperCase()}. ${
            device.pacingMode === 'demand'
              ? 'Demand mode — pacer inhibited by intrinsic rhythm.'
              : 'Asynchronous mode — fixed rate, ignores intrinsic rhythm.'
          }`,
          'ok',
        );
        break;
      }
      const softkeyMessages = {
        '12-Lead':  '12-Lead ECG initiated (6 leads + 6 limb leads — visual placeholder).',
        'SpO₂':     'SpO₂ / pulse oximetry display toggled.',
        'NIBP':     'Non-invasive blood pressure monitoring toggled.',
        'Events':   'Event log opened (records all device interactions with timestamps).',
        'Alarms':   'Alarm settings menu opened — adjust limits and thresholds.',
        'Setup':    'Device setup menu opened — configure parameters.',
        'CPR Help': 'CPR metronome active: target 100–120 compressions/min, 5–6 cm depth. Push hard, push fast.',
      };
      setStatus(softkeyMessages[label] ?? `${label} selected.`, 'ok');
      break;
    }

    default: break;
  }

  updateAll();
}

/* ═══════════════════════════════════════════════════════════════
   Centralised event delegation (device wrap)
   ═══════════════════════════════════════════════════════════════ */
deviceWrap.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action],[data-mode],[data-sk]');
  if (!el || el.disabled) return;

  if (el.dataset.mode !== undefined) {
    handleAction('mode', el.dataset.mode);
  } else if (el.dataset.sk !== undefined) {
    const label = (SOFTKEYS[device.mode] ?? SOFTKEYS.off)[Number(el.dataset.sk)];
    handleAction('softkey', label);
  } else {
    handleAction(el.dataset.action);
  }
});

/* ═══════════════════════════════════════════════════════════════
   Hover tooltip → updates hint-box in the status panel
   ═══════════════════════════════════════════════════════════════ */
deviceWrap.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  hintBox.innerHTML = el.dataset.tip;
});

deviceWrap.addEventListener('mouseleave', () => {
  hintBox.innerHTML = '<strong>💡 Hover a control</strong><br>to see its function here.';
});

/* ═══════════════════════════════════════════════════════════════
   Bootstrap
   ═══════════════════════════════════════════════════════════════ */
updateAll();

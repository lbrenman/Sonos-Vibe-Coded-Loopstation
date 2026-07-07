/* =====================================================================
   LOOPSTATION — browser loop synth with Sonos output
   - 8 synthesized drum voices + BASS and SYNTH note lanes
   - 16-step loop, swing, live overdub recording, step toggling
   - Pattern save/load as JSON
   - Renders the loop offline to WAV and pushes it to Sonos speakers
===================================================================== */

'use strict';

// ----------------------------------------------------------- constants
const STEPS = 16;
const RENDER_REPEATS = 8; // copies of the loop per WAV -> near-gapless repeat
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
const midiName = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

// --------------------------------------------------------- drum voices
const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  if (noiseCache.has(ctx)) return noiseCache.get(ctx);
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buf);
  return buf;
}

function env(ctx, dest, time, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + decay);
  g.connect(dest);
  return g;
}

const VOICES = [
  {
    id: 'kick', name: 'KICK',
    play(ctx, dest, t) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
      o.connect(env(ctx, dest, t, 1.0, 0.4));
      o.start(t); o.stop(t + 0.45);
    },
  },
  {
    id: 'snare', name: 'SNARE',
    play(ctx, dest, t) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      n.connect(bp); bp.connect(env(ctx, dest, t, 0.7, 0.18));
      n.start(t); n.stop(t + 0.2);
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = 185;
      o.connect(env(ctx, dest, t, 0.5, 0.12));
      o.start(t); o.stop(t + 0.15);
    },
  },
  {
    id: 'clap', name: 'CLAP',
    play(ctx, dest, t) {
      for (const dt of [0, 0.012, 0.026]) {
        const n = ctx.createBufferSource();
        n.buffer = noiseBuffer(ctx);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 1.5;
        n.connect(bp); bp.connect(env(ctx, dest, t + dt, 0.55, 0.09));
        n.start(t + dt); n.stop(t + dt + 0.1);
      }
    },
  },
  {
    id: 'ch', name: 'HAT ·',
    play(ctx, dest, t) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 7200;
      n.connect(hp); hp.connect(env(ctx, dest, t, 0.35, 0.05));
      n.start(t); n.stop(t + 0.06);
    },
  },
  {
    id: 'oh', name: 'HAT O',
    play(ctx, dest, t) {
      const n = ctx.createBufferSource();
      n.buffer = noiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 6500;
      n.connect(hp); hp.connect(env(ctx, dest, t, 0.32, 0.35));
      n.start(t); n.stop(t + 0.4);
    },
  },
  {
    id: 'tom', name: 'TOM',
    play(ctx, dest, t) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(85, t + 0.2);
      o.connect(env(ctx, dest, t, 0.8, 0.3));
      o.start(t); o.stop(t + 0.35);
    },
  },
  {
    id: 'rim', name: 'RIM',
    play(ctx, dest, t) {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = 1700;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 4;
      o.connect(bp); bp.connect(env(ctx, dest, t, 0.5, 0.045));
      o.start(t); o.stop(t + 0.06);
    },
  },
  {
    id: 'cow', name: 'COWBELL',
    play(ctx, dest, t) {
      for (const f of [540, 800]) {
        const o = ctx.createOscillator();
        o.type = 'square'; o.frequency.value = f;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 1.2;
        o.connect(bp); bp.connect(env(ctx, dest, t, 0.3, 0.25));
        o.start(t); o.stop(t + 0.3);
      }
    },
  },
];

// ------------------------------------------------------- melodic voices
// Each lane voice: play(ctx, dest, t, midi, dur)
const LANES = [
  {
    id: 'bass', name: 'BASS',
    defaultOctave: 2, // octave shown in the picker (C2..B2)
    play(ctx, dest, t, midi, dur) {
      const freq = midiToFreq(midi);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 8;
      // acid-style filter sweep: open on attack, close into the note
      lp.frequency.setValueAtTime(Math.min(freq * 9, 4000), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.4, 60), t + dur * 0.7);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55, t + 0.008);
      g.gain.setValueAtTime(0.55, t + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(lp); lp.connect(g); g.connect(dest);
      o.start(t); o.stop(t + dur + 0.05);
    },
  },
  {
    id: 'synth', name: 'SYNTH',
    defaultOctave: 4,
    play(ctx, dest, t, midi, dur) {
      const freq = midiToFreq(midi);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, t + Math.min(dur, 0.3));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 2;
      lp.frequency.setValueAtTime(freq * 8, t);
      lp.frequency.exponentialRampToValueAtTime(freq * 2, t + 0.22);
      lp.connect(g); g.connect(dest);
      // two detuned saws = wide pluck
      for (const cents of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        o.detune.value = cents;
        o.connect(lp);
        o.start(t); o.stop(t + 0.4);
      }
    },
  },
];

// --------------------------------------------------------------- state
const state = {
  bpm: 100,
  swing: 0, // 0-100 -> odd 16ths delayed up to half a step
  masterGain: 0.8,
  playing: false,
  recording: false,
  pattern: VOICES.map(() => new Array(STEPS).fill(false)),
  mutes: VOICES.map(() => false),
  melodic: LANES.map(() => new Array(STEPS).fill(null)), // midi | null
  melodicMutes: LANES.map(() => false),
};

// UI-only: currently picked note per lane
const picked = LANES.map((l) => ({ note: 9, octave: l.defaultOctave })); // default A

let audioCtx = null;
let masterNode = null;
let currentStep = 0;
let nextNoteTime = 0;
let loopStartTime = 0;
let schedulerTimer = null;
const drawQueue = [];

const stepDur = () => 60 / state.bpm / 4;
const loopDur = () => stepDur() * STEPS;
const swingOffset = (step) =>
  step % 2 === 1 ? (state.swing / 100) * stepDur() * 0.5 : 0;

function ensureCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterNode = audioCtx.createGain();
    masterNode.gain.value = state.masterGain;
    masterNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ----------------------------------------------------------- scheduler
function scheduleStep(step, time) {
  const t = time + swingOffset(step);
  state.pattern.forEach((row, ti) => {
    if (row[step] && !state.mutes[ti]) VOICES[ti].play(audioCtx, masterNode, t);
  });
  state.melodic.forEach((row, li) => {
    if (row[step] != null && !state.melodicMutes[li]) {
      LANES[li].play(audioCtx, masterNode, t, row[step], stepDur() * 0.95);
    }
  });
  drawQueue.push({ step, time: t });
}

function scheduler() {
  const ahead = 0.12;
  while (nextNoteTime < audioCtx.currentTime + ahead) {
    if (currentStep === 0) loopStartTime = nextNoteTime;
    scheduleStep(currentStep, nextNoteTime);
    nextNoteTime += stepDur();
    currentStep = (currentStep + 1) % STEPS;
  }
}

function startPlayback() {
  ensureCtx();
  currentStep = 0;
  nextNoteTime = audioCtx.currentTime + 0.06;
  loopStartTime = nextNoteTime;
  state.playing = true;
  schedulerTimer = setInterval(scheduler, 25);
  ui.btnPlay.classList.add('active');
  requestAnimationFrame(drawFrame);
  lcd();
}

function stopPlayback() {
  state.playing = false;
  clearInterval(schedulerTimer);
  ui.btnPlay.classList.remove('active');
  ui.needle.style.transform = 'rotate(0deg)';
  document.querySelectorAll('.step.now, .mstep.now').forEach((el) => el.classList.remove('now'));
  ringLeds.forEach((l) => l.classList.remove('now'));
  lcd();
}

// -------------------------------------------------- record / pad hits
function padHit(trackIndex) {
  ensureCtx();
  VOICES[trackIndex].play(audioCtx, masterNode, audioCtx.currentTime);
  flashPad(trackIndex);
  if (state.recording && state.playing) {
    const phase = (audioCtx.currentTime - loopStartTime) / stepDur();
    const step = Math.round(phase) % STEPS;
    state.pattern[trackIndex][(step + STEPS) % STEPS] = true;
    renderStepGrid();
  }
}

// ------------------------------------------------------------- WAV out
function renderLoopToWav() {
  const sr = 44100;
  const dur = loopDur() * RENDER_REPEATS + 0.5; // headroom for release tails
  const off = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
  const master = off.createGain();
  master.gain.value = state.masterGain;
  master.connect(off.destination);

  for (let r = 0; r < RENDER_REPEATS; r++) {
    for (let s = 0; s < STEPS; s++) {
      const t = r * loopDur() + s * stepDur() + swingOffset(s);
      state.pattern.forEach((row, ti) => {
        if (row[s] && !state.mutes[ti]) VOICES[ti].play(off, master, t);
      });
      state.melodic.forEach((row, li) => {
        if (row[s] != null && !state.melodicMutes[li]) {
          LANES[li].play(off, master, t, row[s], stepDur() * 0.95);
        }
      });
    }
  }
  // trim render back to exact loop length so REPEAT_ALL stays on-grid
  const exactFrames = Math.round(loopDur() * RENDER_REPEATS * sr);
  return off.startRendering().then((buf) => bufferToWav(buf, exactFrames));
}

function bufferToWav(buffer, frameLimit) {
  const ch = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const frames = Math.min(buffer.length, frameLimit || buffer.length);
  const bytesPerSample = 2;
  const dataSize = frames * ch * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);

  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * ch * bytesPerSample, true);
  dv.setUint16(32, ch * bytesPerSample, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, dataSize, true);

  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- UI
const ui = {
  btnPlay: document.getElementById('btn-play'),
  btnRec: document.getElementById('btn-rec'),
  btnClear: document.getElementById('btn-clear'),
  btnSave: document.getElementById('btn-save'),
  btnLoad: document.getElementById('btn-load'),
  fileLoad: document.getElementById('file-load'),
  bpm: document.getElementById('bpm'),
  bpmVal: document.getElementById('bpm-val'),
  swing: document.getElementById('swing'),
  swingVal: document.getElementById('swing-val'),
  gain: document.getElementById('master-gain'),
  gainVal: document.getElementById('gain-val'),
  padGrid: document.getElementById('pad-grid'),
  stepGrid: document.getElementById('step-grid'),
  melodicLanes: document.getElementById('melodic-lanes'),
  needle: document.getElementById('ring-needle'),
  ringLedsG: document.getElementById('ring-leds'),
  lcd1: document.getElementById('lcd-line1'),
  lcd2: document.getElementById('lcd-line2'),
  speakerList: document.getElementById('speaker-list'),
  btnRefresh: document.getElementById('btn-refresh'),
  btnPush: document.getElementById('btn-push'),
  btnSonosStop: document.getElementById('btn-sonos-stop'),
  sonosStatus: document.getElementById('sonos-status'),
};

function lcd(line1) {
  if (line1) ui.lcd1.textContent = line1.toUpperCase();
  else ui.lcd1.textContent = state.playing ? 'LOOPING — OVERLAY SOUNDS ON TOP' : 'STOPPED — PRESS PLAY';
  ui.lcd2.textContent = `BPM ${state.bpm} · SWING ${state.swing} · REC ${state.recording ? 'ON' : 'OFF'}`;
}

// Pads
const padEls = VOICES.map((v, i) => {
  const b = document.createElement('button');
  b.className = 'pad';
  b.innerHTML = `<span class="pad-name">${v.name}</span><span class="pad-key">${KEYS[i]}</span>`;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); padHit(i); });
  ui.padGrid.appendChild(b);
  return b;
});

function flashPad(i) {
  padEls[i].classList.add('lit');
  setTimeout(() => padEls[i].classList.remove('lit'), 90);
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const i = KEYS.indexOf(e.key);
  if (i >= 0) padHit(i);
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    ui.btnPlay.click();
  }
});

// Step grid (drums)
let stepEls = [];
function buildStepGrid() {
  ui.stepGrid.innerHTML = '';
  stepEls = [];
  VOICES.forEach((v, ti) => {
    const label = document.createElement('div');
    label.className = 'track-label';
    label.textContent = v.name;
    ui.stepGrid.appendChild(label);

    const row = [];
    for (let s = 0; s < STEPS; s++) {
      const b = document.createElement('button');
      b.className = 'step' + (s % 4 === 0 ? ' beat' : '');
      b.addEventListener('click', () => {
        state.pattern[ti][s] = !state.pattern[ti][s];
        b.classList.toggle('on', state.pattern[ti][s]);
        updateRingHits();
      });
      ui.stepGrid.appendChild(b);
      row.push(b);
    }
    stepEls.push(row);

    const mute = document.createElement('button');
    mute.className = 'mute-btn';
    mute.textContent = 'M';
    mute.title = `Mute ${v.name}`;
    mute.addEventListener('click', () => {
      state.mutes[ti] = !state.mutes[ti];
      mute.classList.toggle('muted', state.mutes[ti]);
    });
    ui.stepGrid.appendChild(mute);
  });
}

function renderStepGrid() {
  VOICES.forEach((_, ti) => {
    for (let s = 0; s < STEPS; s++) {
      stepEls[ti][s].classList.toggle('on', state.pattern[ti][s]);
    }
  });
  updateRingHits();
}

// Melodic lanes (bass + synth)
let mstepEls = [];   // [lane][step]
let noteBtnEls = []; // [lane][12]
let octLabelEls = [];

function buildMelodicLanes() {
  ui.melodicLanes.innerHTML = '';
  mstepEls = [];
  noteBtnEls = [];
  octLabelEls = [];

  LANES.forEach((lane, li) => {
    const wrap = document.createElement('div');
    wrap.className = 'melodic-lane';

    // header: name + octave control + 12 note buttons
    const head = document.createElement('div');
    head.className = 'lane-head';

    const name = document.createElement('span');
    name.className = 'lane-name';
    name.textContent = lane.name;
    head.appendChild(name);

    const down = document.createElement('button');
    down.className = 'oct-btn'; down.textContent = '−';
    const octLabel = document.createElement('span');
    octLabel.className = 'oct-label';
    const up = document.createElement('button');
    up.className = 'oct-btn'; up.textContent = '+';
    down.addEventListener('click', () => setOctave(li, picked[li].octave - 1));
    up.addEventListener('click', () => setOctave(li, picked[li].octave + 1));
    head.appendChild(down); head.appendChild(octLabel); head.appendChild(up);
    octLabelEls.push(octLabel);

    const btns = [];
    NOTE_NAMES.forEach((n, ni) => {
      const b = document.createElement('button');
      b.className = 'note-btn' + (n.includes('#') ? ' sharp' : '');
      b.textContent = n;
      b.addEventListener('click', () => {
        picked[li].note = ni;
        refreshNotePicker(li);
        // audition
        ensureCtx();
        lane.play(audioCtx, masterNode, audioCtx.currentTime, pickedMidi(li), stepDur() * 0.95);
      });
      head.appendChild(b);
      btns.push(b);
    });
    noteBtnEls.push(btns);
    wrap.appendChild(head);

    // step cells
    const grid = document.createElement('div');
    grid.className = 'melodic-grid';
    const row = [];
    for (let s = 0; s < STEPS; s++) {
      const b = document.createElement('button');
      b.className = 'mstep' + (s % 4 === 0 ? ' beat' : '');
      b.addEventListener('click', () => {
        const cur = state.melodic[li][s];
        const sel = pickedMidi(li);
        state.melodic[li][s] = cur === sel ? null : sel; // same note toggles off
        renderMelodicLane(li);
        updateRingHits();
      });
      grid.appendChild(b);
      row.push(b);
    }
    mstepEls.push(row);

    const mute = document.createElement('button');
    mute.className = 'mute-btn';
    mute.textContent = 'M';
    mute.title = `Mute ${lane.name}`;
    mute.addEventListener('click', () => {
      state.melodicMutes[li] = !state.melodicMutes[li];
      mute.classList.toggle('muted', state.melodicMutes[li]);
    });
    grid.appendChild(mute);

    wrap.appendChild(grid);
    ui.melodicLanes.appendChild(wrap);
    refreshNotePicker(li);
    renderMelodicLane(li);
  });
}

const pickedMidi = (li) => (picked[li].octave + 1) * 12 + picked[li].note;

function setOctave(li, oct) {
  picked[li].octave = Math.max(0, Math.min(7, oct));
  refreshNotePicker(li);
}

function refreshNotePicker(li) {
  octLabelEls[li].textContent = `O${picked[li].octave}`;
  noteBtnEls[li].forEach((b, ni) => b.classList.toggle('picked', ni === picked[li].note));
}

function renderMelodicLane(li) {
  for (let s = 0; s < STEPS; s++) {
    const midi = state.melodic[li][s];
    const el = mstepEls[li][s];
    el.classList.toggle('on', midi != null);
    el.textContent = midi != null ? midiName(midi) : '';
  }
}

// Loop ring
const ringLeds = [];
(function buildRing() {
  for (let s = 0; s < STEPS; s++) {
    const angle = (s / STEPS) * Math.PI * 2 - Math.PI / 2;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', 100 + 78 * Math.cos(angle));
    c.setAttribute('cy', 100 + 78 * Math.sin(angle));
    c.setAttribute('r', s % 4 === 0 ? 6 : 4.5);
    c.setAttribute('class', 'ring-led');
    ui.ringLedsG.appendChild(c);
    ringLeds.push(c);
  }
})();

function updateRingHits() {
  for (let s = 0; s < STEPS; s++) {
    const hit =
      state.pattern.some((row, ti) => row[s] && !state.mutes[ti]) ||
      state.melodic.some((row, li) => row[s] != null && !state.melodicMutes[li]);
    ringLeds[s].classList.toggle('hit', hit);
  }
}

function drawFrame() {
  if (!state.playing) return;
  const phase = ((audioCtx.currentTime - loopStartTime) / loopDur()) % 1;
  ui.needle.style.transform = `rotate(${phase * 360}deg)`;
  while (drawQueue.length && drawQueue[0].time <= audioCtx.currentTime) {
    const { step } = drawQueue.shift();
    document.querySelectorAll('.step.now, .mstep.now').forEach((el) => el.classList.remove('now'));
    ringLeds.forEach((l) => l.classList.remove('now'));
    ringLeds[step].classList.add('now');
    stepEls.forEach((row) => row[step].classList.add('now'));
    mstepEls.forEach((row) => row[step].classList.add('now'));
  }
  requestAnimationFrame(drawFrame);
}

// Transport wiring
ui.btnPlay.addEventListener('click', () => (state.playing ? stopPlayback() : startPlayback()));
ui.btnRec.addEventListener('click', () => {
  state.recording = !state.recording;
  ui.btnRec.classList.toggle('active', state.recording);
  if (state.recording && !state.playing) startPlayback();
  lcd();
});
ui.btnClear.addEventListener('click', () => {
  state.pattern.forEach((row) => row.fill(false));
  state.melodic.forEach((row) => row.fill(null));
  renderStepGrid();
  LANES.forEach((_, li) => renderMelodicLane(li));
  updateRingHits();
  lcd('PATTERN CLEARED');
});
ui.bpm.addEventListener('input', () => {
  state.bpm = Number(ui.bpm.value);
  ui.bpmVal.textContent = state.bpm;
  lcd();
});
ui.swing.addEventListener('input', () => {
  state.swing = Number(ui.swing.value);
  ui.swingVal.textContent = state.swing;
  lcd();
});
ui.gain.addEventListener('input', () => {
  state.masterGain = Number(ui.gain.value) / 100;
  ui.gainVal.textContent = ui.gain.value;
  if (masterNode) masterNode.gain.value = state.masterGain;
});

// --------------------------------------------------------- save / load
ui.btnSave.addEventListener('click', () => {
  const data = {
    version: 2,
    bpm: state.bpm,
    swing: state.swing,
    masterGain: state.masterGain,
    pattern: state.pattern,
    mutes: state.mutes,
    melodic: state.melodic,
    melodicMutes: state.melodicMutes,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `loopstation-${state.bpm}bpm-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  lcd('PATTERN SAVED');
});

ui.btnLoad.addEventListener('click', () => ui.fileLoad.click());
ui.fileLoad.addEventListener('change', async () => {
  const file = ui.fileLoad.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.pattern)) throw new Error('not a loopstation pattern file');
    state.bpm = data.bpm ?? state.bpm;
    state.swing = data.swing ?? 0;
    state.masterGain = data.masterGain ?? state.masterGain;
    VOICES.forEach((_, ti) => {
      state.pattern[ti] = (data.pattern[ti] || new Array(STEPS).fill(false)).slice(0, STEPS);
      state.mutes[ti] = (data.mutes || [])[ti] || false;
    });
    LANES.forEach((_, li) => {
      state.melodic[li] = ((data.melodic || [])[li] || new Array(STEPS).fill(null)).slice(0, STEPS);
      state.melodicMutes[li] = (data.melodicMutes || [])[li] || false;
    });
    ui.bpm.value = state.bpm; ui.bpmVal.textContent = state.bpm;
    ui.swing.value = state.swing; ui.swingVal.textContent = state.swing;
    ui.gain.value = Math.round(state.masterGain * 100);
    ui.gainVal.textContent = ui.gain.value;
    if (masterNode) masterNode.gain.value = state.masterGain;
    buildStepGrid();
    renderStepGrid();
    buildMelodicLanes();
    lcd(`LOADED ${file.name}`);
  } catch (err) {
    lcd('LOAD FAILED — BAD FILE');
  } finally {
    ui.fileLoad.value = '';
  }
});

// ------------------------------------------------------------- Sonos
function sonosStatus(msg, cls = '') {
  ui.sonosStatus.textContent = msg;
  ui.sonosStatus.className = `status-line ${cls}`;
}

const volDebounce = new Map();

async function loadSpeakers() {
  ui.speakerList.innerHTML = '<p class="empty-note">Scanning for speakers…</p>';
  try {
    const res = await fetch('/api/speakers');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    renderSpeakers(body.data);
  } catch (err) {
    ui.speakerList.innerHTML = `<p class="empty-note">No speakers found — ${err.message}. Make sure this machine is on the same network as your Sonos gear, then hit RESCAN.</p>`;
  }
}

function renderSpeakers(speakers) {
  ui.speakerList.innerHTML = '';
  if (!speakers.length) {
    ui.speakerList.innerHTML = '<p class="empty-note">No speakers found. Hit RESCAN.</p>';
    return;
  }
  for (const sp of speakers) {
    const card = document.createElement('div');
    card.className = 'speaker-card';
    card.dataset.uuid = sp.uuid;
    card.innerHTML = `
      <label class="speaker-head">
        <input type="checkbox" class="sp-select" checked />
        ${sp.name}
        <span class="speaker-ip">${sp.host}</span>
      </label>
      <div class="speaker-vol">
        <input type="range" class="sp-vol" min="0" max="100" value="${sp.volume ?? 25}" />
        <span class="value-chip sp-vol-val">${sp.volume ?? '–'}</span>
      </div>`;
    const check = card.querySelector('.sp-select');
    const sync = () => card.classList.toggle('selected', check.checked);
    check.addEventListener('change', sync);
    sync();

    const vol = card.querySelector('.sp-vol');
    const volVal = card.querySelector('.sp-vol-val');
    vol.addEventListener('input', () => {
      volVal.textContent = vol.value;
      clearTimeout(volDebounce.get(sp.uuid));
      volDebounce.set(
        sp.uuid,
        setTimeout(async () => {
          try {
            await fetch(`/api/speakers/${encodeURIComponent(sp.uuid)}/volume`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ volume: Number(vol.value) }),
            });
          } catch (e) {
            sonosStatus(`Volume failed: ${e.message}`, 'err');
          }
        }, 150)
      );
    });
    ui.speakerList.appendChild(card);
  }
}

function selectedUuids() {
  return [...document.querySelectorAll('.speaker-card')]
    .filter((c) => c.querySelector('.sp-select').checked)
    .map((c) => c.dataset.uuid);
}

ui.btnRefresh.addEventListener('click', loadSpeakers);

ui.btnPush.addEventListener('click', async () => {
  const uuids = selectedUuids();
  if (!uuids.length) return sonosStatus('Select at least one speaker first.', 'err');
  const hasContent =
    state.pattern.some((row) => row.some(Boolean)) ||
    state.melodic.some((row) => row.some((n) => n != null));
  if (!hasContent) {
    return sonosStatus('Pattern is empty — lay down some hits first.', 'err');
  }
  const mode = document.querySelector('input[name="syncmode"]:checked').value;

  try {
    ui.btnPush.disabled = true;
    sonosStatus('Rendering loop…');
    lcd('RENDERING LOOP TO WAV');
    const wav = await renderLoopToWav();

    sonosStatus('Uploading…');
    const up = await fetch('/api/loop', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    });
    const upBody = await up.json();
    if (!up.ok) throw new Error(upBody.error || up.statusText);

    sonosStatus('Starting playback on Sonos…');
    const play = await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuids, url: upBody.data.url, mode }),
    });
    const playBody = await play.json();
    if (!play.ok) throw new Error(playBody.error || play.statusText);

    const detail =
      playBody.data.mode === 'grouped'
        ? `grouped under ${playBody.data.coordinator}`
        : 'independent per speaker';
    sonosStatus(`Looping on ${uuids.length} speaker(s) — ${detail}.`, 'ok');
    lcd('LOOP IS LIVE ON SONOS');
  } catch (err) {
    sonosStatus(`Push failed: ${err.message}`, 'err');
    lcd('PUSH FAILED — SEE SONOS PANEL');
  } finally {
    ui.btnPush.disabled = false;
  }
});

ui.btnSonosStop.addEventListener('click', async () => {
  const uuids = selectedUuids();
  if (!uuids.length) return sonosStatus('Select the speakers to stop.', 'err');
  try {
    sonosStatus('Stopping…');
    const res = await fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuids }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    sonosStatus('Stopped.', 'ok');
    lcd('SONOS STOPPED');
  } catch (err) {
    sonosStatus(`Stop failed: ${err.message}`, 'err');
  }
});

// ----------------------------------------------------------- boot
buildStepGrid();
buildMelodicLanes();
// Starter groove: kick/snare/hats + a little A-minor bassline
[[0, 0], [0, 8], [1, 4], [1, 12], [3, 0], [3, 2], [3, 4], [3, 6], [3, 8], [3, 10], [3, 12], [3, 14]]
  .forEach(([t, s]) => (state.pattern[t][s] = true));
// bass lane: A1=33, C2=36, G1=31
[[0, 33], [3, 33], [7, 36], [8, 33], [11, 33], [14, 31]]
  .forEach(([s, m]) => (state.melodic[0][s] = m));
renderStepGrid();
LANES.forEach((_, li) => renderMelodicLane(li));
updateRingHits();
lcd();
loadSpeakers();

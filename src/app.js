const express = require('express');
const path = require('path');
const fs = require('fs');
const sonos = require('./sonos');
const { getLanIp } = require('./lanip');

const app = express();
app.set('trust proxy', 1);

const LOOPS_DIR = path.join(__dirname, '..', 'loops');
if (!fs.existsSync(LOOPS_DIR)) fs.mkdirSync(LOOPS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
// Sonos speakers fetch rendered loops from here
app.use('/loops', express.static(LOOPS_DIR));

// ---------------------------------------------------------------- health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.API_VERSION || '1.0.0',
    service: 'sonos-loopstation',
  });
});

// ------------------------------------------------------------- speakers
app.get('/api/speakers', async (req, res) => {
  try {
    const speakers = await sonos.listSpeakers();
    res.json({ data: speakers });
  } catch (err) {
    res.status(500).json({ error: `Discovery failed: ${err.message}` });
  }
});

app.post('/api/speakers/:uuid/volume', async (req, res) => {
  const { volume } = req.body || {};
  if (typeof volume !== 'number') {
    return res.status(400).json({ error: 'volume (number 0-100) is required' });
  }
  try {
    await sonos.setVolume(req.params.uuid, volume);
    res.json({ data: { uuid: req.params.uuid, volume } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------- loop
// Browser POSTs the rendered WAV here; we save it and return the LAN URL
// that Sonos speakers can fetch.
app.post(
  '/api/loop',
  express.raw({ type: ['audio/wav', 'application/octet-stream'], limit: '100mb' }),
  (req, res) => {
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'No audio data received' });
    }
    // Keep only the latest few loops on disk
    const name = `loop-${Date.now()}.wav`;
    fs.writeFileSync(path.join(LOOPS_DIR, name), req.body);
    const old = fs
      .readdirSync(LOOPS_DIR)
      .filter((f) => f.endsWith('.wav'))
      .sort()
      .slice(0, -5);
    old.forEach((f) => fs.unlinkSync(path.join(LOOPS_DIR, f)));

    const port = process.env.PORT || 3500;
    const url = `http://${getLanIp()}:${port}/loops/${name}`;
    res.json({ data: { url, bytes: req.body.length } });
  }
);

// ------------------------------------------------------------- playback
app.post('/api/play', async (req, res) => {
  const { uuids, url, mode } = req.body || {};
  if (!Array.isArray(uuids) || uuids.length === 0) {
    return res.status(400).json({ error: 'uuids (non-empty array) is required' });
  }
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    const result = await sonos.play(uuids, url, mode);
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop', async (req, res) => {
  const { uuids } = req.body || {};
  if (!Array.isArray(uuids) || uuids.length === 0) {
    return res.status(400).json({ error: 'uuids (non-empty array) is required' });
  }
  try {
    const result = await sonos.stop(uuids);
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;

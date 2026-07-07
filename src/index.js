require('dotenv').config();
const app = require('./app');
const { getLanIp } = require('./lanip');

const PORT = process.env.PORT || 3500;

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIp();
  console.log('');
  console.log('  Sonos Loopstation');
  console.log('  -----------------');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  LAN:     http://${ip}:${PORT}   <- Sonos fetches audio from here`);
  console.log('');
  console.log('  Discovering Sonos speakers in the background...');
});

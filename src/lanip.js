const os = require('os');

/**
 * Returns the machine's LAN IPv4 address. Sonos speakers fetch the rendered
 * loop WAV over HTTP, so the URL we hand them must use this address —
 * "localhost" means nothing to a speaker.
 *
 * Override with HOST_IP in .env if you have multiple interfaces (e.g. VPN,
 * Docker bridges) and the wrong one gets picked.
 */
function getLanIp() {
  if (process.env.HOST_IP) return process.env.HOST_IP;

  const ifaces = os.networkInterfaces();
  // Prefer common physical interface names first (macOS: en0, Linux: eth0/wlan0)
  const preferred = ['en0', 'en1', 'eth0', 'wlan0'];

  for (const name of preferred) {
    const addrs = ifaces[name] || [];
    const hit = addrs.find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }

  // Fall back to the first non-internal IPv4 on any interface
  for (const name of Object.keys(ifaces)) {
    const hit = (ifaces[name] || []).find(
      (a) => a.family === 'IPv4' && !a.internal
    );
    if (hit) return hit.address;
  }

  return '127.0.0.1';
}

module.exports = { getLanIp };

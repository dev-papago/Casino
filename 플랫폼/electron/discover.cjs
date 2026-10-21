// Finding the casino server on the Wi-Fi, for the player exe (no Electron here, so it can be tested with Node).
// It broadcasts "CASINO?" to the discovery port; the server answers with its HTTP port, and the answer's sender
// address is the server's address.
const dgram = require('node:dgram');
const os = require('node:os');

const DISCOVERY_PORT = 7778; // PLATFORM.discoveryPort

/** Asks the Wi-Fi "CASINO?" and takes the first server that answers. */
function discover(ms = 2000, port = DISCOVERY_PORT, targets = broadcastAddresses()) {
  return new Promise((done) => {
    const sock = dgram.createSocket('udp4');
    const finish = (url) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      done(url);
    };
    const timer = setTimeout(() => finish(''), ms);
    sock.on('error', () => finish(''));
    sock.on('message', (msg, from) => {
      try {
        const a = JSON.parse(msg.toString());
        if (a.casino && a.port) finish(`http://${from.address}:${a.port}/`);
      } catch {
        // not ours
      }
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      const q = Buffer.from('CASINO?');
      for (const addr of targets) sock.send(q, port, addr, () => {}); // a network that refuses one is skipped
    });
  });
}

/** 255.255.255.255 and the broadcast address of every IPv4 network this PC is on. */
function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

module.exports = { discover, broadcastAddresses };

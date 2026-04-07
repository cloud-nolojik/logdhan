import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Prepend an IST timestamp to every console.* line so log files are
// self-dating. Format: [DD-MM-YYYY HH:mm:ss IST]
// Patched here (the first import in index.js) so it covers everything.
(() => {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const stamp = () => {
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
    return `[${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second} IST]`;
  };
  for (const method of ['log', 'error', 'warn', 'info', 'debug']) {
    const orig = console[method].bind(console);
    console[method] = (...args) => orig(stamp(), ...args);
  }
})();
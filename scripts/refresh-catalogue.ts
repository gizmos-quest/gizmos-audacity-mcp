// Re-read the command and menu catalogue from a running Audacity. Run it with
// Audacity's UI language set to English, after a fresh plugin registry, so
// Nyquist effect ids are the English ones (High-passFilter, not Hochpassfilter).
import { writeFileSync } from 'node:fs';
import { formatCommand, parseInfoJson } from '../src/format.js';
import { AudacityPipe } from '../src/pipe.js';
import { sanitizeCatalogue } from './catalogue-sanitize.js';

const pipe = new AudacityPipe();
for (const type of ['Commands', 'Menus'] as const) {
  const reply = await pipe.send(formatCommand('GetInfo', { Type: type, Format: 'JSON' }));
  if (!reply.ok) throw new Error(`GetInfo ${type} failed: ${reply.body}`);
  const parsed = parseInfoJson(reply.body);
  if (!Array.isArray(parsed)) throw new Error(`GetInfo ${type} returned no catalogue array`);
  const data = sanitizeCatalogue(type, parsed);
  writeFileSync(
    new URL(`../catalogue/${type.toLowerCase()}.json`, import.meta.url),
    `${JSON.stringify(data, null, 1)}\n`,
  );
  console.log(`${type}: ${data.length}`);
}

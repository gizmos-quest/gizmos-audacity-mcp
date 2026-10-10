import { readFileSync } from 'node:fs';
import type { CatalogueParam } from './catalogue.js';

// GetInfo omits numeric limits. catalogue/parameters.json holds the limits that
// native validation applies, generated from the pinned Audacity tag by
// scripts/source-parameters.ts (provenance inside the file). At Audacity-3.7.8
// an out-of-range value makes a built-in effect or command show a blocking
// "Could not load settings" message (libraries/lib-effects/Effect.cpp:269-287,
// src/commands/AudacityCommand.cpp:142-151); a Nyquist plug-in silently keeps
// its saved control (libraries/lib-nyquist-effects/NyquistBase.cpp:401-414).
// Limits are cast like ShuttleAutomation.h:166-170 does: Amplify's 0.003162f
// becomes 0.0031620000954717398 in its double member, so 0.003162 is refused.
// Limits apply only where key and type agree with the live catalogue
// (test/source-parameters.test.ts records the remaining differences).
interface SourceParam {
  key: string;
  type: string;
  min?: number;
  max?: number;
}

const SOURCE = new Map(
  (
    JSON.parse(readFileSync(new URL('../catalogue/parameters.json', import.meta.url), 'utf8')) as {
      commands: { id: string; params: SourceParam[] }[];
    }
  ).commands.map((command) => [command.id, command.params]),
);

export function boundedParam(id: string, param: CatalogueParam): CatalogueParam {
  const source = SOURCE.get(id)?.find((candidate) => candidate.key === param.key && candidate.type === param.type);
  if (source?.min === undefined || source.max === undefined) return param;
  // DBL_MAX adds nothing to a finite-number check and is left out.
  return {
    ...param,
    ...(source.min > -Number.MAX_VALUE ? { minimum: source.min } : {}),
    ...(source.max < Number.MAX_VALUE ? { maximum: source.max } : {}),
  };
}

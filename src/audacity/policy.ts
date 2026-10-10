import { existsSync, statSync } from 'node:fs';
import { COMMAND_IDS } from '../catalogue.js';
import { preflightEffectParameters } from '../effect-safety.js';
import { catalogueCommand } from '../format.js';
import { validateExportFile } from './files.js';

/** Shared by generic commands and macro preflight, before any preceding edit can run. */
export function preflightCommand(id: string, params: Record<string, unknown> = {}): string {
  if (!COMMAND_IDS.includes(id)) throw new Error(`command is reserved or not in the safe catalogue: ${id}`);
  const command = catalogueCommand(id, params);
  // Live English 3.7.8, 2026-10-02: Ratio=3 AllowClipping=0 on a 0.5
  // amplitude tone returned OK and exported 2364 near-full-scale samples.
  // AmplifyBase::Parameters forces mCanClip=true in native batch mode.
  if (id === 'Amplify' && params.AllowClipping === false)
    throw new Error(
      'Amplify ignores AllowClipping=false in Audacity batch processing; measure headroom before choosing a gain',
    );
  preflightEffectParameters(id, params);
  if (id === 'Export2') validateExportFile(String(params.Filename ?? ''));
  if (id === 'Import2' && (!existsSync(String(params.Filename ?? '')) || !statSync(String(params.Filename)).isFile()))
    throw new Error('import file does not exist or is not a regular file');
  // Audacity-3.7.8 src/ProjectFileManager.cpp:1539-1546 answers an .aup3 import
  // with an error dialog; .aup and .lof are projects/lists, not audio (:1588-1598).
  if (id === 'Import2' && /\.(?:aup3|aup|lof)$/i.test(String(params.Filename)))
    throw new Error('Import2 imports audio; open .aup3 projects with audacity_project');
  // FindClippingBase.cpp:118-137 allocates Duty Cycle Start x 1000 samples and
  // reports a failed allocation in a dialog: keep that block within 64 MiB.
  if (id === 'FindClipping' && Number(params['Duty Cycle Start'] ?? 0) > 16_777)
    throw new Error('FindClipping Duty Cycle Start above 16777 needs an unbounded native buffer');
  if (id === 'SampleDataExport' && (params.MESSAGES !== 'None' || !params.FILENAME)) {
    throw new Error('SampleDataExport requires MESSAGES=None and an explicit FILENAME to avoid modal result dialogs');
  }
  if (id === 'NoiseGate' && params.MODE === 'Analyze')
    throw new Error('NoiseGate Analyze opens a result dialog; use audacity_measure');
  return command;
}

import { COMMAND_IDS } from '../catalogue.js';
import { preflightEffectParameters } from '../effects/parameters.js';
import { catalogueCommand } from '../format.js';
import { validateExportFile, validateImportFile } from './files.js';

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
  if (id === 'Import2') validateImportFile(String(params.Filename ?? ''));
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

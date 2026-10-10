import { describe, expect, it } from 'vitest';
import { validateProjectFile } from '../../src/audacity/files.js';
import { preflightCommand } from '../../src/audacity/policy.js';
import { parseMacro } from '../../src/controls/macros.js';
import { project, wave } from '../helpers/project-fixture.js';

describe('shared safety preflight', () => {
  it.each([
    ['ClickRemoval', { Threshold: 200, Width: 20 }],
    ['NoiseGate', { MODE: 'Analyze' }],
    ['RegularIntervalLabels', { VERBOSE: 'Details' }],
    ['RegularIntervalLabels', {}],
    ['RegularIntervalLabels', { MODE: 'Number', TOTALNUM: 2, REGION: 0, VERBOSE: 'None' }],
    ['SampleDataExport', { MESSAGES: 'None' }],
    ['SampleDataExport', { FILENAME: 'samples.txt', MESSAGES: 'Yes' }],
    ['Export2', { Filename: 'out.aup3' }],
    ['Import2', { Filename: 'definitely-missing-audio-fixture.wav' }],
  ])('rejects unsafe generic command %s before any pipe I/O', (command, params) => {
    const fixture = project([wave('Voice')]);
    expect(() => preflightCommand(command as string, params as Record<string, unknown>)).toThrow();
    expect(() => fixture.ops.command(command as string, params as Record<string, unknown>)).toThrow();
    expect(fixture.calls).toEqual([]);
  });

  it.each([
    'ClickRemoval:Threshold=200 Width=20',
    'NoiseGate:MODE=Analyze',
    'RegularIntervalLabels:VERBOSE=Details',
    'RegularIntervalLabels:MODE=Number TOTALNUM=2 REGION=0 VERBOSE=None',
    'SampleDataExport:MESSAGES=None',
    'Export2:Filename=out.aup3',
    'Import2:Filename=definitely-missing-audio-fixture.wav',
  ])('rejects unsafe later macro steps during planning: %s', (step) => {
    expect(() => parseMacro(`Amplify:Ratio=0.5\n${step}`)).toThrow();
  });

  it('validates special export parameters and the step limit', () => {
    expect(() => parseMacro('ExportMP3:Bad=1', 'out.mp3')).toThrow('no parameters');
    expect(() => parseMacro(Array.from({ length: 1001 }, () => 'ExportWav:').join('\n'), 'out.wav')).toThrow('1000');
    expect(() => parseMacro('ExportWav:', 'not-created-directory/out.wav')).toThrow('directory');
  });

  it('requires real .aup3 destinations and refuses overwrite before saving', () => {
    expect(() => validateProjectFile('backup.wav', true)).toThrow('.aup3');
    expect(() => validateProjectFile('not-created-directory/backup.aup3', true)).toThrow('directory');
    expect(() => validateProjectFile('definitely-missing-fixture.aup3', false)).toThrow('existing');
  });
});

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { AudacityNeedsRecovery, AudacityPipe, AudacityTimeout, type PipeReply } from '../src/pipe.js';
import { Ops } from '../src/ops.js';

const FIRST = '/FileFormats/MusicFileImportSettingChoice';
const SECOND = '/FileFormats/MusicFileImportOnExistingProjectSettingChoice';
const source = fileURLToPath(import.meta.url); // A real regular file; the injected transport never imports it into Audacity.
const read = (name: string) => `GetPreference: Name=${name}`;
const set = (name: string, value: string) => `SetPreference: Name=${name} Value=${value} Reload=0`;

interface Fault {
  matches: (id: string, params: Record<string, string>) => boolean;
  text?: string;
  timeout?: boolean;
}

function fixture(initial: { first?: string | null; second?: string | null } = {}) {
  const preferences = new Map<string, string>();
  if (initial.first !== null) preferences.set(FIRST, initial.first ?? 'Yes');
  if (initial.second !== null) preferences.set(SECOND, initial.second ?? 'Match');
  const calls: string[] = [];
  const timeouts: number[] = [];
  const faults: Fault[] = [];
  const pipe = new AudacityPipe({ to: 'import-fixture.to', from: 'import-fixture.from' }, 100,
    async (_paths, command, timeoutMs): Promise<PipeReply> => {
      calls.push(command);
      timeouts.push(timeoutMs);
      const id = command.slice(0, command.indexOf(':'));
      const params: Record<string, string> = {};
      for (const match of command.matchAll(/([A-Za-z]+)=(?:"([^"]*)"|([^\s]+))/g)) params[match[1]!] = match[2] ?? match[3]!;
      const faultIndex = faults.findIndex((fault) => fault.matches(id, params));
      if (faultIndex >= 0) {
        const fault = faults.splice(faultIndex, 1)[0]!;
        if (fault.timeout) {
          // A lost set reply can occur after the preference changed.
          if (id === 'SetPreference') preferences.set(params.Name!, params.Value!);
          throw new AudacityTimeout(fault.text ?? 'Audacity import reply was lost');
        }
        return { ok: false, body: fault.text ?? 'Audacity own import failure', status: 'Failed!' };
      }
      if (id === 'GetPreference') {
        const value = preferences.get(params.Name!);
        return { ok: value !== undefined, body: value ?? '', status: value !== undefined ? 'OK' : 'Failed!' };
      }
      if (id === 'SetPreference') preferences.set(params.Name!, params.Value!);
      return { ok: true, status: 'OK', body: id === 'Import2' ? 'Audacity imported fixture' : '' };
    });
  return { ops: new Ops(pipe), pipe, preferences, calls, timeouts, faults };
}

describe('silent import guard ordering and restoration', () => {
  it.each(['run', 'command'] as const)('protects %s Import2 before importing and restores both exact original choices', async (path) => {
    const project = fixture();
    const result = await project.ops[path]('Import2', { Filename: source }, 3210);
    expect(result).toBe('Audacity imported fixture');
    expect(project.calls.slice(0, 4)).toEqual([read(FIRST), set(FIRST, 'No'), read(SECOND), set(SECOND, 'DoNothing')]);
    expect(project.calls[4]).toMatch(/^Import2: Filename=/);
    expect(project.calls.slice(5)).toEqual([set(FIRST, 'Yes'), set(SECOND, 'Match')]);
    expect(project.timeouts[4]).toBe(3210);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('Match');
  });

  it('restores explicit native defaults when previously unset choices return an empty Failed reply', async () => {
    const project = fixture({ first: null, second: null });
    await project.ops.command('Import2', { Filename: source });
    expect(project.calls.slice(-2)).toEqual([set(FIRST, 'Ask'), set(SECOND, 'MatchIfBeatsAndMeasures')]);
    expect(project.preferences.get(FIRST)).toBe('Ask');
    expect(project.preferences.get(SECOND)).toBe('MatchIfBeatsAndMeasures');
  });

  it('preserves already-safe choices and does not change them after import', async () => {
    const project = fixture({ first: 'No', second: 'DoNothing' });
    await project.ops.command('Import2', { Filename: source });
    expect(project.calls.slice(-2)).toEqual([set(FIRST, 'No'), set(SECOND, 'DoNothing')]);
    expect(project.preferences.get(FIRST)).toBe('No');
    expect(project.preferences.get(SECOND)).toBe('DoNothing');
  });

  it.each(['run', 'command'] as const)('restores both choices after native import failure through %s and preserves Audacity error text', async (path) => {
    const project = fixture();
    project.faults.push({ matches: (id) => id === 'Import2', text: 'Audacity own importer: unsupported data' });
    await expect(project.ops[path]('Import2', { Filename: source })).rejects.toThrow('Audacity own importer: unsupported data');
    expect(project.calls.slice(-2)).toEqual([set(FIRST, 'Yes'), set(SECOND, 'Match')]);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('Match');
    const beforeRestore = project.calls.length;
    await project.ops.restoreImportPreferences();
    expect(project.calls).toHaveLength(beforeRestore); // Successfully restored guards are not replayed.
  });

  it.each([FIRST, SECOND])('restores saved choices after a guard set failure on %s before any import', async (name) => {
    const project = fixture();
    project.faults.push({ matches: (id, params) => id === 'SetPreference' && params.Name === name,
      text: 'Audacity own preference set failure' });
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow('Audacity own preference set failure');
    expect(project.calls.some((command) => command.startsWith('Import2:'))).toBe(false);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('Match');
    expect(project.calls.slice(-1)[0]).toBe(name === FIRST ? set(FIRST, 'Yes') : set(SECOND, 'Match'));
  });

  it('restores the first guard when reading the second preference fails with Audacity error text', async () => {
    const project = fixture();
    project.faults.push({ matches: (id, params) => id === 'GetPreference' && params.Name === SECOND,
      text: 'Audacity own preference read failure' });
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow('Audacity own preference read failure');
    expect(project.calls).toEqual([read(FIRST), set(FIRST, 'No'), read(SECOND), set(FIRST, 'Yes')]);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('Match');
  });

  it.each([{ first: 'Unexpected' }, { second: 'Unexpected' }])('refuses unsupported stored choices without importing and restores any earlier guard %#', async (initial) => {
    const project = fixture(initial);
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow('unsupported music-import preference');
    expect(project.calls.some((command) => command.startsWith('Import2:'))).toBe(false);
    expect(project.preferences.get(FIRST)).toBe(initial.first ?? 'Yes');
    expect(project.preferences.get(SECOND)).toBe(initial.second ?? 'Match');
  });

  it('reports original import and restoration errors together, retaining only the still-pending restoration', async () => {
    const project = fixture();
    project.faults.push(
      { matches: (id) => id === 'Import2', text: 'Audacity own import failure' },
      { matches: (id, params) => id === 'SetPreference' && params.Name === SECOND && params.Value === 'Match',
        text: 'Audacity own restore failure' },
    );
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow(/Audacity own import failure.*Import preference restoration also failed:.*Audacity own restore failure/);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('DoNothing');
    project.calls.length = 0;
    await project.ops.restoreImportPreferences();
    expect(project.calls).toEqual([set(SECOND, 'Match')]);
    expect(project.preferences.get(SECOND)).toBe('Match');
  });
});

describe('import timeout recovery', () => {
  it.each(['run', 'command'] as const)('leaves guards pending after %s import timeout until explicit pipe reset and restoration', async (path) => {
    const project = fixture();
    project.faults.push({ matches: (id) => id === 'Import2', timeout: true });
    await expect(project.ops[path]('Import2', { Filename: source })).rejects.toThrow('Audacity import reply was lost');
    expect(project.pipe.needsRecovery).toBe(true);
    expect(project.calls).toHaveLength(5);
    expect(project.preferences.get(FIRST)).toBe('No');
    expect(project.preferences.get(SECOND)).toBe('DoNothing');
    await expect(project.ops.restoreImportPreferences()).rejects.toBeInstanceOf(AudacityNeedsRecovery);
    expect(project.calls).toHaveLength(5);
    project.pipe.reset();
    await project.ops.restoreImportPreferences();
    expect(project.calls.slice(-2)).toEqual([set(FIRST, 'Yes'), set(SECOND, 'Match')]);
    expect(project.calls.filter((command) => command.startsWith('Import2:'))).toHaveLength(1);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('Match');
  });

  it('retains both originals when a guard-setting reply is lost after the native preference changed', async () => {
    const project = fixture();
    project.faults.push({ matches: (id, params) => id === 'SetPreference' && params.Name === SECOND && params.Value === 'DoNothing',
      timeout: true });
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow('reply was lost');
    expect(project.calls).toHaveLength(4);
    expect(project.calls.some((command) => command.startsWith('Import2:'))).toBe(false);
    expect(project.preferences.get(FIRST)).toBe('No');
    expect(project.preferences.get(SECOND)).toBe('DoNothing');
    project.pipe.reset();
    await project.ops.restoreImportPreferences();
    expect(project.calls.slice(-2)).toEqual([set(FIRST, 'Yes'), set(SECOND, 'Match')]);
  });

  it('retains only the changed first preference if the second read times out', async () => {
    const project = fixture();
    project.faults.push({ matches: (id, params) => id === 'GetPreference' && params.Name === SECOND, timeout: true });
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow('reply was lost');
    expect(project.calls).toEqual([read(FIRST), set(FIRST, 'No'), read(SECOND)]);
    project.pipe.reset();
    project.calls.length = 0;
    await project.ops.restoreImportPreferences();
    expect(project.calls).toEqual([set(FIRST, 'Yes')]);
    expect(project.preferences.get(SECOND)).toBe('Match');
  });

  it('restores a pending guard before the next explicit import begins reading preferences', async () => {
    const project = fixture();
    project.faults.push({ matches: (id) => id === 'Import2', timeout: true });
    await expect(project.ops.command('Import2', { Filename: source })).rejects.toThrow('reply was lost');
    project.pipe.reset();
    project.calls.length = 0;
    await project.ops.command('Import2', { Filename: source });
    expect(project.calls.slice(0, 3)).toEqual([set(FIRST, 'Yes'), set(SECOND, 'Match'), read(FIRST)]);
    expect(project.preferences.get(FIRST)).toBe('Yes');
    expect(project.preferences.get(SECOND)).toBe('Match');
  });
});

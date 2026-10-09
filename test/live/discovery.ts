// Real stdio MCP integration against Audacity 3.7.x. Only AUDACITY_LIVE=1
// enables process or pipe access. User projects are backed up persistently;
// every test edit happens in the hidden, disposable test project.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { type LiveContext, testTimeout, type Windows } from './session.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

export function registerDiscovery(context: LiveContext) {
  const { call, refuse, tracks, importVoice } = context;
  it(
    'advertises typed tools and rejects unknown inputs and modal menu commands',
    async () => {
      const { client } = context;
      const tools = (await client!.listTools()).tools;
      expect(tools.length).toBeGreaterThan(40);
      for (const tool of tools) {
        expect(tool.description?.length).toBeGreaterThan(30);
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
      await expect(refuse('audacity_status', { unexpected: true })).rejects.toThrow();
      await expect(refuse('audacity_menu', { command: 'New' })).rejects.toThrow();
      await expect(refuse('audacity_menu', { command: 'Preferences' })).rejects.toThrow();
      await expect(refuse('audacity_menu', { command: 'Record1stChoice' })).rejects.toThrow();
      await expect(refuse('audacity_menu', { command: 'Record2ndChoice' })).rejects.toThrow();
      await expect(refuse('audacity_command', { command: 'Amplify', params: { Bogus: 1 } })).rejects.toThrow();
      await expect(refuse('audacity_effect', { effect: 'ClickRemoval' })).rejects.toThrow();
      for (const effect of [
        'SpectralEditMultiTool',
        'SpectralEditParametricEq',
        'SpectralEditShelves',
        'SpectralDelete',
        'LabelSounds',
      ]) {
        await expect(refuse('audacity_effect', { effect })).rejects.toThrow();
        await expect(refuse('audacity_command', { command: effect })).rejects.toThrow();
      }
      expect((await call<Windows>('audacity_dialogs')).windows.some((window) => window.dialog)).toBe(false);
    },
    testTimeout,
  );

  it(
    'launches, hides/shows windows and reads catalogue and project state',
    async () => {
      await call('audacity_window', { show: true });
      expect(
        (await call<Windows>('audacity_dialogs')).windows.find((window) => window.title === 'Audacity')?.visible,
      ).toBe(true);
      await call('audacity_window', { show: false });
      expect(
        (await call<Windows>('audacity_dialogs')).windows.find((window) => window.title === 'Audacity')?.visible,
      ).toBe(false);
      for (const type of [
        'Tracks',
        'Clips',
        'Envelopes',
        'Labels',
        'Boxes',
        'Commands',
        'Menus',
        'Selection',
        'Preferences',
      ]) {
        expect(await call('audacity_info', { type })).toBeDefined();
      }
      expect(await call('audacity_describe', { command: 'Amplify' })).toMatchObject({ id: 'Amplify' });
      await call('audacity_menu', { command: 'SelectNone' });
      expect(await call('audacity_status')).toMatchObject({ running: true, tracks: [] });
      expect(await call('audacity_project_info')).toMatchObject({ rate: null, lengthSeconds: 0 });
    },
    testTimeout,
  );

  it(
    'refuses a different executable override before lifecycle calls touch the live project',
    async () => {
      await importVoice('Preserved voice');
      await call('audacity_select', { track: 'Preserved voice', start: 0.25, end: 0.75 });
      const before = await tracks();
      const selection = await call('audacity_info', { type: 'Selection' });
      const other = new Client({ name: 'wrong-installation-test', version: '1' });
      const env = Object.fromEntries(
        ['AUDACITY_CONFIG', 'AUDACITY_FFMPEG', 'AUDACITY_FFPROBE'].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key]!]],
        ),
      );
      // An existing, valid but different executable (Node itself): preflight must
      // refuse it before attempting either pipe access or executable launch.
      env.AUDACITY_EXE = process.execPath;
      try {
        await other.connect(
          new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist', 'main.js')], env }),
        );
        for (const name of ['audacity_launch', 'audacity_fresh', 'audacity_quit', 'audacity_recover']) {
          const result = await other.callTool({ name, arguments: {} });
          expect(result.isError).toBe(true);
          expect(
            result.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n'),
          ).toMatch(/Preserve and quit that installation/);
        }
      } finally {
        await other.close();
      }
      expect(await tracks()).toEqual(before);
      expect(await call('audacity_info', { type: 'Selection' })).toEqual(selection);
      expect((await call<Windows>('audacity_dialogs')).windows.filter((window) => window.dialog)).toEqual([]);
    },
    testTimeout,
  );
}

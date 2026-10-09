import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ helper: vi.fn() }));
vi.mock('../src/app-helper.js', () => ({ powershell: mock.helper }));

import { closeProjectWindow, listWindows, setWindowVisible } from '../src/app-windows.js';

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.clearAllMocks();
});
describe('native Windows messages', () => {
  it('includes untitled windows and uses native visibility/closure', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mock.helper.mockResolvedValue('[{"title":"","dialog":false}]');
    expect(await listWindows(false)).toEqual([{ title: '', dialog: false }]);
    mock.helper.mockResolvedValue('');
    expect(await listWindows(true)).toEqual([]);
    mock.helper.mockResolvedValue('1');
    expect(await setWindowVisible(true)).toBe(1);
    expect(await setWindowVisible(false)).toBe(1);
    mock.helper.mockResolvedValue('True');
    expect(await closeProjectWindow('123', 42)).toBe(true);
    expect(mock.helper).toHaveBeenLastCalledWith(expect.stringContaining('if ($owner -eq 42)'));
    mock.helper.mockResolvedValue('False');
    expect(await closeProjectWindow('123', 42)).toBe(false);
    await expect(closeProjectWindow('x', 42)).rejects.toThrow('invalid');
    await expect(closeProjectWindow('123', -1)).rejects.toThrow('invalid');
  });
  it('refuses unsupported native lifecycle without spawning helpers', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(listWindows(false)).rejects.toThrow('Windows only');
    await expect(setWindowVisible(true)).rejects.toThrow('Windows only');
    await expect(closeProjectWindow('123', 42)).rejects.toThrow('Windows only');
    expect(mock.helper).not.toHaveBeenCalled();
  });
});

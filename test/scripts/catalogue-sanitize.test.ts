import { describe, expect, it } from 'vitest';
import { sanitizeCatalogue } from '../../scripts/catalogue-sanitize.js';

describe('public catalogue normalization', () => {
  it('removes installation and saved macro IDs without inventing executable aliases', () => {
    const menus = [
      { id: 'Effect_C:\\example\\plug-ins\\filter.ny', label: 'Filter', flags: 0 },
      { id: 'Macro_Local', label: 'Saved macro', flags: 0 },
      { id: 'Play', label: 'Play', flags: 0 },
    ];
    expect(sanitizeCatalogue('Menus', menus)).toEqual([
      { label: 'Filter', flags: 0 },
      { label: 'Saved macro', flags: 0 },
      menus[2],
    ]);
    expect(menus[0]).toHaveProperty('id');
  });
  it('removes absolute path defaults and retains portable command defaults', () => {
    const input = [
      {
        id: 'Example',
        params: [
          { key: 'Filename', default: 'C:\\example\\export.wav' },
          { key: 'Other', default: '/tmp/example.wav' },
          { key: 'Network', default: '\\\\example\\share\\file.wav' },
          { key: 'Name', default: 'Untitled' },
          { key: 'Value', default: 1 },
        ],
      },
    ];
    expect(sanitizeCatalogue('Commands', input)).toEqual([
      {
        id: 'Example',
        params: [
          { key: 'Filename' },
          { key: 'Other' },
          { key: 'Network' },
          { key: 'Name', default: 'Untitled' },
          { key: 'Value', default: 1 },
        ],
      },
    ]);
  });
  it.each([null, 'invalid', []])('rejects malformed native rows %j', (row) => {
    expect(() => sanitizeCatalogue('Menus', [row])).toThrow('catalogue row');
    expect(() => sanitizeCatalogue('Commands', [{ params: [row] }])).toThrow('parameter');
  });
});

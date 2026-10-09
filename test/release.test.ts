import { describe, expect, it, vi } from 'vitest';
// JavaScript maintenance scripts are validated independently of runtime source coverage.
// @ts-expect-error The CLI script is deliberately not a library with declarations.
import { releaseChangelog, releasePlan, releaseVersion } from '../scripts/release.mjs';

describe('release planning without publication', () => {
  it.each([
    ['initial', '0.1.0'],
    ['patch', '0.1.1'],
    ['minor', '0.2.0'],
    ['major', '1.0.0'],
  ])('plans %s from the immutable dispatch version', (level, expected) => {
    expect(releaseVersion('0.1.0', level)).toBe(expected);
  });
  it.each(['1.0.0-beta.1', '01.0.0', 'broken'])('refuses ambiguous release version %s', (version) => {
    expect(() => releaseVersion(version, 'patch')).toThrow();
  });
  it('moves upcoming notes and is idempotent when already prepared', () => {
    const source = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Audio tools.\n';
    const prepared = releaseChangelog(source, '0.1.0', '2026-10-09');
    expect(prepared).toContain('## [Unreleased]\n\n## [0.1.0] - 2026-10-09');
    expect(prepared).toContain('- Audio tools.');
    expect(prepared).toContain('2026-10-09\n\n### Added');
    expect(releaseChangelog(prepared, '0.1.0', '2026-10-10')).toBe(prepared);
    expect(() => releaseChangelog('# no upcoming section', '0.1.0', '2026-10-09')).toThrow();
  });
  it('reconstructs an interrupted release from its dispatch commit on the next day', () => {
    const source = '# Changelog\n\n## [Unreleased]\n\n- Initial release.\n';
    const original = releasePlan('0.1.0', 'initial', '2026-10-09');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
      const rerun = releasePlan('0.1.0', 'initial', '2026-10-09');
      expect(rerun).toEqual(original);
      expect(releaseChangelog(source, rerun.version, rerun.date)).toBe(
        releaseChangelog(source, original.version, original.date),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { packedPackage } from '../../scripts/pack-result.js';

describe('npm pack JSON compatibility', () => {
  const packed = { name: '@example/audio', filename: 'audio-1.0.0.tgz', integrity: 'sha512-fixture', size: 123 };

  it('preserves the npm 11 package array', () => {
    expect(packedPackage(JSON.stringify([packed]))).toEqual(packed);
  });

  it('preserves the npm 12 name-keyed package collection', () => {
    expect(packedPackage(JSON.stringify({ [packed.name]: packed }))).toEqual(packed);
  });

  it.each([null, [], {}, [packed, packed], { one: packed, two: packed }, [{}], [null]])(
    'rejects an invalid or ambiguous package collection: %j',
    (value) => {
      expect(() => packedPackage(JSON.stringify(value))).toThrow();
    },
  );
});

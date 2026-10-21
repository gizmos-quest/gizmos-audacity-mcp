import assert from 'node:assert/strict';

export function packedPackage(output: string): Record<string, unknown> & { filename: string; integrity: string } {
  const result: unknown = JSON.parse(output);
  assert(result && typeof result === 'object', 'pack must return a package collection');
  const packages: unknown[] = Array.isArray(result) ? result : Object.values(result);
  assert.equal(packages.length, 1, 'pack must describe exactly one package');
  const packed = packages[0];
  assert(packed && typeof packed === 'object' && !Array.isArray(packed), 'pack must describe a package object');
  assert('filename' in packed && typeof packed.filename === 'string', 'pack must include a filename');
  assert('integrity' in packed && typeof packed.integrity === 'string', 'pack must include an integrity digest');
  return packed as Record<string, unknown> & { filename: string; integrity: string };
}

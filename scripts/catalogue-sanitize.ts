/** Remove installation-specific identifiers/defaults before checking in a capture. */
export function sanitizeCatalogue(type: 'Commands' | 'Menus', items: unknown[]): unknown[] {
  return items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`invalid ${type} catalogue row`);
    const row = { ...item } as Record<string, unknown>;
    if (type === 'Menus') {
      // Effect_/Macro_ IDs embed installed paths or local saved macro names.
      // These are excluded from the public safe menu catalogue, not aliases.
      if (typeof row.id === 'string' && (/^(Effect_|Macro_)/.test(row.id) || /[\\/]/.test(row.id))) delete row.id;
    } else if (Array.isArray(row.params)) {
      row.params = row.params.map((parameter: unknown) => {
        if (!parameter || typeof parameter !== 'object' || Array.isArray(parameter))
          throw new Error('invalid command parameter');
        const param = { ...parameter } as Record<string, unknown>;
        if (typeof param.default === 'string' && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(param.default))
          delete param.default;
        return param;
      });
    }
    return row;
  });
}

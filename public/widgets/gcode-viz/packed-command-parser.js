// The pinned gcode-preview parser splits ASCII letter fields before parsing
// their numeric values. Workers use the same fields without importing the
// renderer and its document import map.
export function createPackedCommandParser(tolerance) {
  const letters = /[A-Za-z]/g;
  return {
    tolerance,
    parseCommand(line) {
      const comment = line.indexOf(';');
      const end = comment < 0 ? line.length : comment;
      letters.lastIndex = 0;
      const first = letters.exec(line);
      if (!first || first.index >= end) return { gcode: '', params: {} };
      let next = letters.exec(line);
      if (next && next.index >= end) next = null;
      const fieldEnd = next ? next.index : end;
      const gcode = first[0].toLowerCase() + line.slice(first.index + 1, fieldEnd).trim();
      if (/^t[0-7]$/.test(gcode)) return { gcode, params: undefined };
      const params = {};
      while (next) {
        const field = next;
        next = letters.exec(line);
        if (next && next.index >= end) next = null;
        params[field[0].toLowerCase()] = parseFloat(line.slice(field.index + 1, next ? next.index : end));
      }
      return { gcode, params };
    },
  };
}

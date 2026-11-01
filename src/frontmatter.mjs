// Minimal YAML front-matter scalar reader shared by skills, agents and extension
// imports. Handles plain and quoted values plus folded (>) and literal (|) block
// scalars, which Agent Skills often use for long descriptions.
export function frontMatterValue(metadata, key) {
  const lines = String(metadata || '').split(/\r?\n/);
  const pattern = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*(.*)$', 'i');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    const value = match[1].trim();
    const block = value.match(/^([>|])[+-]?\d*\s*(?:#.*)?$/);
    if (!block) return value.replace(/^["']|["']$/g, '');
    const body = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() && !/^\s/.test(line)) break;
      body.push(line);
    }
    const indent = Math.min(...body.filter((line) => line.trim()).map((line) => line.match(/^\s*/)[0].length), Infinity);
    const text = body.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
    return (block[1] === '>' ? text.map((line) => line.trim()).join(' ').replace(/\s+/g, ' ') : text.join('\n')).trim();
  }
  return '';
}

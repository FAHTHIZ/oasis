// Turns a permission rule such as `run_command(npm test:*)` into the words on
// the approval sheet's "Always allow" button.
const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'apply_patch', 'notebook_edit', 'delete_file']);

export function alwaysAllowLabel(rule) {
  const text = String(rule || '').trim();
  const match = /^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/s.exec(text);
  if (!match) return 'Always allow this';
  const [, tool, rawSpec = ''] = match;
  const spec = rawSpec.trim();
  const short = (value) => value.length > 48 ? value.slice(0, 47) + '…' : value;
  if (/^(run_command|run_shell|powershell|bash)$/i.test(tool)) {
    if (!spec || spec === '*') return 'Always allow commands';
    if (spec.endsWith(':*')) return 'Always allow ' + short(spec.slice(0, -2)) + ' commands';
    if (spec.endsWith(' *')) return 'Always allow ' + short(spec.slice(0, -2)) + ' commands';
    return 'Always allow ' + short(spec);
  }
  if (WRITE_TOOLS.has(tool)) {
    const verb = tool === 'delete_file' ? 'deletions' : 'edits';
    if (!spec || spec === '*' || spec === '**') return 'Always allow file ' + verb;
    return 'Always allow ' + verb + ' in ' + short(spec.replace(/\/?\*\*?$/, '') || spec) ;
  }
  if (tool === 'fetch_url' || tool === 'web_fetch') {
    const domain = spec.replace(/^domain:/, '');
    return domain ? 'Always allow ' + short(domain) : 'Always allow web pages';
  }
  if (tool.startsWith('mcp_')) return 'Always allow this tool';
  return 'Always allow ' + tool.replace(/_/g, ' ') + (spec && spec !== '*' ? ' ' + short(spec) : '');
}

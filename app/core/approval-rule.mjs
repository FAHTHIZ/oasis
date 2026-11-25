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
    // `git:*` reads as "git commands"; `node cart.test.js:*` read as "node
    // cart.test.js commands", which is not English. A prefix of two words or
    // more is named as it is (it also covers the same command with more
    // arguments, which the button's hover text says).
    if (spec.endsWith(':*') || spec.endsWith(' *')) {
      const prefix = spec.slice(0, -2).trim();
      return 'Always allow ' + short(prefix) + (/\s/.test(prefix) ? '' : ' commands');
    }
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

// Hover text for the button: what exactly stops asking.
export function alwaysAllowTitle(rule, scope = 'this session') {
  const match = /^(run_command|run_shell|powershell|bash)\((.+)(?::\*| \*)\)$/is.exec(String(rule || '').trim());
  if (!match) return '';
  const prefix = match[2].trim();
  return 'Runs ' + prefix + ' and ' + prefix + ' with more arguments without asking again in ' + scope;
}

// Splits an approval prompt into prose lines and code blocks. An indented line
// is code; consecutive indented lines form one block with the shared
// indentation removed, so JSON arguments are not split into a box per line.
export function approvalParts(lines) {
  const parts = [];
  let block = null;
  for (const line of lines) {
    if (/^\s{2,}\S/.test(line)) {
      if (!block) { block = []; parts.push({ code: true, lines: block }); }
      block.push(line.replace(/\s+$/, ''));
      continue;
    }
    block = null;
    if (line.trim()) parts.push({ code: false, text: line.trim() });
  }
  return parts.map((part) => {
    if (!part.code) return part;
    const indent = Math.min(...part.lines.map((line) => line.match(/^\s*/)[0].length));
    return { code: true, text: part.lines.map((line) => line.slice(indent)).join('\n') };
  });
}

// Small, safe Markdown renderer for agent replies. Everything is escaped
// first; only a fixed set of constructs becomes HTML, and links must be
// http(s) or mailto.

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeHref(url) {
  const value = url.trim().replace(/&amp;/g, '&');
  return /^(https?:|mailto:)/i.test(value) ? escapeHtml(value) : null;
}

function inline(text) {
  const codes = [];
  let out = escapeHtml(text).replace(/`([^`\n]+)`/g, (_, code) => { codes.push(code); return '\u0000' + (codes.length - 1) + '\u0000'; });
  out = out
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => { const href = safeHref(url); return href ? '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label; })
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (match, lead, url) => lead + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[Number(i)] + '</code>');
}

function table(lines) {
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return '<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((row) => '<tr>' + row.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

export function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let paragraph = [];
  const flush = () => { if (paragraph.length) { html.push('<p>' + paragraph.map(inline).join('<br>') + '</p>'); paragraph = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const close = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      html.push('<pre><button class="copy" type="button">Copy</button><code' + (fence[2] ? ' data-lang="' + escapeHtml(fence[2]) + '"' : '') + '>' + escapeHtml(body.join('\n')) + '</code></pre>');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { flush(); const level = Math.min(heading[1].length + 1, 4); html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>'); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      html.push(table(block));
      continue;
    }
    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      flush();
      const ordered = /\d/.test(list[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) { items.push(m[3].replace(/^\[( |x)\]\s+/i, (s, x) => (x.trim() ? '☑ ' : '☐ '))); i++; }
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; }
        else break;
      }
      html.push((ordered ? '<ol>' : '<ul>') + items.map((item) => '<li>' + inline(item) + '</li>').join('') + (ordered ? '</ol>' : '</ul>'));
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      html.push('<blockquote>' + quote.map(inline).join('<br>') + '</blockquote>');
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { flush(); html.push('<hr>'); i++; continue; }
    if (!line.trim()) { flush(); i++; continue; }
    paragraph.push(line);
    i++;
  }
  flush();
  return html.join('');
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('pre .copy');
    if (!button) return;
    const code = button.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => { button.textContent = 'Copied'; setTimeout(() => { button.textContent = 'Copy'; }, 1200); }, () => {});
  });
}

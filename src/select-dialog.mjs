// Claude Code-style select dialog for permission prompts: arrow keys or j/k move, Enter
// accepts, digits pick directly, y/n/a answer at once, Esc declines. Keys come from the
// Confirmation and Select keybinding contexts, so keybindings.json can rebind them.
import { KeyDecoder } from './line-editor.mjs';
import { loadKeybindings, resolveBinding, actionEffect } from './keybindings.mjs';

/**
 * options: [{ label, value, hotkey? }]. Resolves to the chosen option's value, or the
 * value of the option with hotkey 'no' (or null) when declined or aborted.
 */
export function selectDialog({ input = process.stdin, output = process.stdout, options, initial = 0, context = 'Confirmation', env = process.env, color = true, signal = null, keybindings = undefined } = {}) {
  const items = (options || []).filter(Boolean);
  const declined = (items.find((item) => item.hotkey === 'no') || { value: null }).value;
  const byHotkey = (name) => items.find((item) => item.hotkey === name);
  return new Promise((resolve) => {
    if (!items.length) { resolve(declined); return; }
    const bindings = keybindings === undefined ? (() => { try { return loadKeybindings(env); } catch { return null; } })() : keybindings;
    const decoder = new KeyDecoder();
    const wasRaw = Boolean(input.isRaw);
    let index = Math.min(Math.max(0, initial), items.length - 1);
    let drawn = 0;
    let done = false;
    const paint = (t, on) => (color && on ? '\x1b[36m' + t + '\x1b[39m' : t);
    const draw = () => {
      let out = drawn ? '\x1b[' + drawn + 'A\r' : '\r';
      items.forEach((item, i) => { out += '\x1b[2K' + paint((i === index ? '❯ ' : '  ') + (i + 1) + '. ' + item.label, i === index) + '\r\n'; });
      out += '\x1b[2K' + (color ? '\x1b[2m' : '') + 'Enter to confirm · Esc to cancel' + (color ? '\x1b[22m' : '');
      output.write(out);
      drawn = items.length;
    };
    const finish = (value) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { input.setRawMode(wasRaw); } catch {}
      input.pause();
      const chosen = items.find((item) => item.value === value);
      output.write('\r\x1b[2K' + (chosen ? (color ? '\x1b[2m' : '') + '→ ' + chosen.label + (color ? '\x1b[22m' : '') : '') + '\r\n');
      resolve(value);
    };
    const act = (effect) => {
      if (effect === 'next') { index = (index + 1) % items.length; draw(); }
      else if (effect === 'previous') { index = (index - 1 + items.length) % items.length; draw(); }
      else if (effect === 'accept') finish(items[index].value);
      else if (effect === 'no') finish(declined);
      else { const item = byHotkey(effect); if (item) finish(item.value); }
    };
    const onKey = (key) => {
      if (done) return;
      if (key.name === 'ctrlC') { finish(declined); return; }
      const stroke = key.stroke || (key.name === 'char' ? key.text : '');
      const bound = bindings && stroke ? resolveBinding(bindings, context, stroke) : null;
      const effect = bound && bound.action ? actionEffect(bound.action) : null;
      if (effect && effect.dialog) { act(effect.dialog); return; }
      if (bound && bound.action === 'app:interrupt') { finish(declined); return; }
      if (key.name === 'char' && /^[1-9]$/.test(key.text) && Number(key.text) <= items.length) { finish(items[Number(key.text) - 1].value); return; }
      if (!bindings) {
        if (key.name === 'down') act('next');
        else if (key.name === 'up') act('previous');
        else if (key.name === 'enter') act('accept');
        else if (key.name === 'escape') act('no');
      }
    };
    const onData = (chunk) => { for (const key of decoder.feed(chunk.toString('utf8'))) onKey(key); };
    const onAbort = () => finish(declined);
    if (signal) { if (signal.aborted) { resolve(declined); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    try { input.setRawMode(true); } catch {}
    input.setEncoding && input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
    draw();
  });
}

/**
 * Options for the no-argument /model, /theme and /color pickers. Returns
 * { context, options, initial } or null when the command takes no picker.
 */
export async function pickerFor(command, { session = null, env = process.env, settings = null } = {}) {
  const cancel = { label: 'Cancel', value: null, hotkey: 'no' };
  if (command === 'model') {
    const { MODEL_ALIASES, modelAllowed } = await import('./model-aliases.mjs');
    const current = session && session.config ? session.config.model : '';
    const allowed = session && session.availableModels;
    const names = [...new Set([...(current ? [current] : []), ...MODEL_ALIASES, ...(allowed || [])])]
      .filter((name) => modelAllowed(name, allowed, { env, protocol: session && session.config && session.config.protocol }));
    const options = names.map((name) => ({ label: name + (name === current ? ' (current)' : ''), value: name }));
    return { context: 'ModelPicker', options: [...options, cancel], initial: Math.max(0, names.indexOf(current)) };
  }
  if (command === 'theme') {
    const themes = await import('./themes.mjs');
    const list = themes.listThemes({ env, plugins: (settings && settings.pluginThemeSources) || [] });
    const preference = themes.themePreference({ env, settings });
    const options = list.map((theme) => ({ label: theme.id + (theme.name !== theme.id ? ' — ' + theme.name : '') + (theme.id === preference ? ' (current)' : ''), value: theme.id }));
    return { context: 'ThemePicker', options: [...options, cancel], initial: Math.max(0, list.findIndex((theme) => theme.id === preference)) };
  }
  if (command === 'color') {
    const { PROMPT_COLORS, getPromptColor } = await import('./terminal-ui.mjs');
    const current = getPromptColor && getPromptColor();
    const names = [...Object.keys(PROMPT_COLORS), 'random', 'default'];
    return { context: 'Select', options: [...names.map((name) => ({ label: name + (name === current ? ' (current)' : ''), value: name })), cancel], initial: Math.max(0, names.indexOf(current)) };
  }
  return null;
}

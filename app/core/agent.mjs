// The OASIS agent loop for the universal app. Same behaviour as the terminal
// agent where it matters: repairs malformed tool calls from open models,
// resolves tool-name aliases, asks before risky actions, compacts long
// conversations and stops cleanly on request.

import { EMPTY_REPLY_NOTICE, EMPTY_REPLY_NUDGE, MAX_EMPTY_REPLY_NUDGES, providerStopNotice } from '../../src/empty-reply.mjs';
import { chat } from './providers.mjs';
import { TOOL_DEFINITIONS, TOOL_NAMES, executeTool, needsApproval } from './tools.mjs';
import { defineTool, runTool } from '../../src/tool-kernel-core.mjs';
import { validateAppToolArguments } from './tool-validation.mjs';
import { repairToolArguments, extractTextToolCalls, unknownTextToolCalls } from '../../src/tool-call-repair.mjs';
import { resolveToolAlias } from '../../src/tool-aliases.mjs';

/** Plain text of a message: images in a user message count as "[image]". */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => (part && part.type === 'text' ? String(part.text ?? '') : part && part.type === 'image_url' ? '[image]' : '')).filter(Boolean).join('\n');
}

const DEFAULT_MAX_STEPS = 40;
const MAX_STEERING_MESSAGES = 20;
const MAX_STEERING_NOTE_CHARS = 12_000;
const INSTRUCTION_FILES = ['OASIS.md', 'AGENTS.md', 'CLAUDE.md', '.oasis/instructions.md'];

const SCHEMAS = new Map(TOOL_DEFINITIONS.map((tool) => [tool.function.name, tool.function.parameters]));

function browserToolCapabilities(name) {
  if (['list_files', 'read_file', 'grep', 'glob_files', 'project_changes', 'load_skill'].includes(name)) return ['read'];
  if (name === 'fetch_url') return ['network'];
  if (name === 'github_push') return ['git', 'network', 'write'];
  if (name === 'run_javascript') return ['execute'];
  return ['write'];
}

function browserToolRisk(name) {
  if (['list_files', 'read_file', 'grep', 'glob_files', 'project_changes', 'load_skill'].includes(name)) return 'low';
  if (name === 'delete_file' || name === 'github_push') return 'critical';
  if (name === 'run_javascript' || name === 'fetch_url') return 'high';
  return 'medium';
}

function estimateChars(messages) {
  let total = 0;
  for (const message of messages) {
    total += typeof message.content === 'string' ? message.content.length : Array.isArray(message.content) ? textOf(message.content).length + 3000 * message.content.filter((part) => part && part.type === 'image_url').length : 0;
    for (const call of message.tool_calls || []) total += (call.function.arguments || '').length + 40;
  }
  return total;
}

export async function buildSystemPrompt({ workspace, skills, plugins = [], now = new Date() }) {
  const lines = [
    'You are OASIS, an independent coding agent running inside the OASIS app on the user\'s own device.',
    'You work on the project files stored on this device. You have no shell; use the file tools, grep and glob_files to explore, edit_file for precise changes, and run_javascript to execute code and tests in an isolated sandbox.',
    'Work like a careful senior engineer: read before editing, make the smallest complete change, verify it (run tests or code when you can), and report what you changed and how you checked it.',
    'Never invent file contents or results. If something cannot be done here (for example native builds or Python execution), say so plainly and give the exact commands the user can run elsewhere.',
    'For a task with three or more distinct steps, publish a short todo_write checklist before the first substantive action. Keep exactly one step in_progress at a time, update the list at meaningful milestones, and mark a step completed only after verifying it. Do not create checklists for simple questions. If a request is vague or large, state a short plan first and ask only questions whose answers would change the result. When asked to explain a project, cover its purpose, structure, entry points and how to run it.',
    'Keep replies short and concrete: lead with the outcome, then what changed and how you checked it. No filler.',
    'Date: ' + now.toISOString().slice(0, 10) + '.'
  ];
  if (workspace) {
    const paths = await workspace.paths();
    const source = workspace.project.source;
    lines.push('', 'Project: ' + workspace.project.name + (source && source.type === 'github' ? ' (GitHub ' + source.owner + '/' + source.repo + ', branch ' + source.branch + ')' : '') + ', ' + paths.length + ' files.');
    const allTop = [...new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] + '/' : p)))];
    const top = allTop.slice(0, 60);
    if (top.length) lines.push('Top level: ' + top.join(', ') + (allTop.length > top.length ? ', and ' + (allTop.length - top.length) + ' more top-level entries (use list_files to see them)' : ''));
    for (const name of INSTRUCTION_FILES) {
      if (await workspace.exists(name)) {
        const text = await workspace.read(name);
        lines.push('', 'Project instructions from ' + name + ':', text.length > 150000 ? text.slice(0, 150000) + '\n[... ' + name + ' truncated: ' + (text.length - 150000) + ' more characters not loaded. Read the file if the rest matters ...]' : text);
        break;
      }
    }
  } else {
    lines.push('', 'No project is open. You can still create files; they go into a new scratch project.');
  }
  if (skills) {
    const section = await skills.promptSection();
    if (section) lines.push('', section);
  }
  // Plugins the user switched on: their skills are already loaded, so the
  // model follows them without spending a step on load_skill.
  if (skills && plugins.length) {
    const loaded = [];
    for (const plugin of plugins.slice(0, 4)) {
      for (const name of (plugin.skills || []).slice(0, 3)) {
        if (loaded.some((entry) => entry.name === name)) continue;
        try { loaded.push({ plugin: plugin.name, ...(await skills.load(name)) }); } catch { /* skill missing offline */ }
      }
    }
    if (loaded.length) {
      lines.push('', 'Active plugins: ' + plugins.map((plugin) => plugin.name).join(', ') + '. The user turned these on; follow their skills below for this request.');
      let budget = 18000;
      for (const skill of loaded) {
        const body = skill.body.slice(0, Math.min(7000, budget));
        if (!body) break;
        budget -= body.length;
        lines.push('', '## Skill: ' + skill.name + ' (' + skill.plugin + ')', body);
      }
    }
    for (const plugin of plugins) if (plugin.prompt) lines.push('', plugin.name + ': ' + plugin.prompt);
  }
  return lines.join('\n');
}

const MAX_TRUNCATION_RECOVERIES = 3;
const TRUNCATED_REPLY_NOTE = (tool) => 'Your previous reply hit the output token limit and was cut off.' + (tool ? ' The ' + tool + ' call was incomplete and was NOT run; nothing changed from it. Split the work: write a large file as a short first part with write_file, then add the rest with edit_file calls.' : ' Continue from where you stopped, without repeating earlier text.');

// Saved chats from older versions kept only their last 300 messages, which can
// start on a tool result whose call was cut off; providers reject that. Drop
// tool results that answer no earlier call.
export function answeredHistory(messages) {
  const calls = new Set();
  const out = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls) if (call && call.id) calls.add(call.id);
    if (message.role === 'tool' && !calls.has(message.tool_call_id)) continue;
    out.push(message);
  }
  return out;
}

export class Agent {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig  provider config { protocol, baseURL, apiKey, model, ... }
   * @param {() => object} options.getContext tool context { workspace, sandbox, skills, github, fetch }
   * @param {(request) => Promise<boolean>} options.approve
   * @param {(event) => void} [options.onEvent]
   * @param {(error, config) => object|null} [options.onModelFailure]
   *   asked for the next model when a call fails for quota, rate-limit or
   *   model reasons; return a config to switch to, or null to give up
   */
  constructor({ getConfig, getContext, approve, onEvent = () => {}, chatImpl = chat, onModelFailure = null }) {
    this.onModelFailure = onModelFailure;
    this.steering = [];
    this.getConfig = getConfig;
    this.getContext = getContext;
    this.approve = approve;
    this.onEvent = onEvent;
    this.chatImpl = chatImpl;
    this.messages = [];
    this.controller = null;
    this.running = false;
    this.usage = { input: 0, output: 0 };
    this.todos = [];
  }

  get busy() { return this.running; }

  stop() { if (this.controller) this.controller.abort(); }

  reset() { this.messages = []; this.todos = []; this.usage = { input: 0, output: 0 }; this.steering = []; }

  load(messages, pendingSteering = []) {
    this.messages = Array.isArray(messages) ? answeredHistory(messages.filter((m) => m && m.role !== 'system')) : [];
    // Persisted browser state is untrusted and may be stale or malformed.
    // Restore only bounded, non-empty string notes accepted by steer().
    this.steering = Array.isArray(pendingSteering)
      ? pendingSteering
        .filter((note) => typeof note === 'string')
        .map((note) => note.trim())
        .filter((note) => note && note.length <= MAX_STEERING_NOTE_CHARS)
        .slice(0, MAX_STEERING_MESSAGES)
      : [];
  }

  async compact(config, signal) {
    const limit = Number(config.contextChars) || 240000;
    if (estimateChars(this.messages) < limit) return false;
    // First, shrink old tool results; they are the bulk of long sessions.
    const keepFrom = Math.max(0, this.messages.length - 12);
    for (let i = 0; i < keepFrom; i++) {
      const message = this.messages[i];
      if (message.role === 'tool' && message.content.length > 600) message.content = message.content.slice(0, 300) + '\n… (older output trimmed to save context)\n' + message.content.slice(-200);
    }
    if (estimateChars(this.messages) < limit) { this.onEvent({ type: 'compacted', mode: 'trim' }); return true; }
    // Then summarise everything except the latest exchange.
    let cut = Math.max(1, this.messages.length - 8);
    while (cut < this.messages.length && this.messages[cut].role === 'tool') cut++;
    const older = this.messages.slice(0, cut);
    const transcript = older.map((m) => m.role.toUpperCase() + ': ' + textOf(m.content) + (m.tool_calls ? ' [called ' + m.tool_calls.map((c) => c.function.name).join(', ') + ']' : '')).join('\n').slice(-120000);
    const summary = await this.chatImpl(config, {
      messages: [
        { role: 'system', content: 'Summarise this coding session for the agent that will continue it. Keep: the user\'s goals and constraints, decisions, files changed and why, current state, open problems and next steps. Be specific and brief.' },
        { role: 'user', content: transcript }
      ],
      tools: [],
      signal
    });
    this.messages = [{ role: 'user', content: '[Summary of the earlier conversation]\n' + summary.content }, { role: 'assistant', content: 'Understood. Continuing from that summary.' }, ...this.messages.slice(cut)];
    this.onEvent({ type: 'compacted', mode: 'summary' });
    return true;
  }

  /**
   * One model call. When it fails because the model ran out of quota, is
   * rate limited, retired, or cannot use tools, ask onModelFailure for the
   * next model and carry on with the same conversation.
   */
  async callModel(config, request, step) {
    let current = config;
    const tried = new Set();
    while (true) {
      tried.add((current.connectionId || '') + '|' + current.model);
      try {
        const options = this.onModelFailure ? { ...current, maxRetries: Number.isInteger(current.maxRetries) ? current.maxRetries : 1 } : current;
        return { reply: await this.chatImpl(options, request(current)), config: current };
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        if (!this.onModelFailure) throw error;
        const next = await this.onModelFailure(error, current);
        if (!next || tried.has((next.connectionId || '') + '|' + next.model)) throw error;
        this.onEvent({ type: 'model_switch', from: current.model, to: next.model, reason: error.message, step });
        current = next;
      }
    }
  }

  /** Add a note to the running task; it is read before the next step. */
  steer(text) {
    const note = String(text || '').trim();
    if (!this.running || !note || note.length > MAX_STEERING_NOTE_CHARS || this.steering.length >= MAX_STEERING_MESSAGES) return false;
    this.steering.push(note);
    this.onEvent({ type: 'steer', content: note });
    return true;
  }

  async send(text, { maxSteps = DEFAULT_MAX_STEPS, plugins = [], images = [] } = {}) {
    if (this.running) throw new Error('OASIS is already working. Stop it first.');
    // A note can arrive after the final permitted step. Carry it into the next
    // prompt instead of clearing it when the next send starts.
    const pendingSteering = this.steering.splice(0);
    this.running = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    for (const note of pendingSteering) this.messages.push({ role: 'user', content: note });
    const pictures = (Array.isArray(images) ? images : []).filter((image) => image && image.mediaType && image.data).slice(0, 4);
    this.messages.push({ role: 'user', content: pictures.length ? [{ type: 'text', text: String(text) }, ...pictures.map((image) => ({ type: 'image_url', image_url: { url: 'data:' + image.mediaType + ';base64,' + image.data } }))] : String(text) });
    this.onEvent({ type: 'user', content: String(text), images: pictures.length });
    const recent = [];
    let finalText = '';
    let system = null;
    let truncations = 0;
    let emptyReplies = 0;
    try {
      for (let step = 0; step < maxSteps; step++) {
        const config = this.getConfig();
        const ctx = { ...this.getContext(), signal, onTodos: (todos) => { this.todos = todos; this.onEvent({ type: 'todos', todos }); } };
        // Notes typed while OASIS works join the conversation before the next model call.
        let delivered = 0;
        while (this.steering.length) { this.messages.push({ role: 'user', content: this.steering.shift() }); delivered++; }
        if (delivered) this.onEvent({ type: 'steered', delivered });
        await this.compact(config, signal);
        // The prompt lists the project's files, so rebuild it only after the
        // file set may have changed (keeps slow phones responsive).
        if (system === null) system = await buildSystemPrompt({ workspace: ctx.workspace, skills: ctx.skills, plugins });
        this.onEvent({ type: 'thinking', step });
        let streamed = '';
        const { reply } = await this.callModel(config, () => {
          streamed = '';
          return {
            messages: [{ role: 'system', content: system }, ...this.messages],
            tools: TOOL_DEFINITIONS,
            signal,
            fetchImpl: ctx.providerFetch,
            onText: (delta) => { streamed += delta; this.onEvent({ type: 'delta', delta, step }); },
            onRetry: (attempt, error) => (streamed = '', this.onEvent({ type: 'retry', attempt, message: error.message, waitMs: error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : error && Number.isFinite(error.waitMs) ? error.waitMs : 0 }))
          };
        }, step);
        if (reply.usage) {
          this.usage.input += reply.usage.input || 0;
          this.usage.output += reply.usage.output || 0;
          this.onEvent({ type: 'usage', usage: { ...this.usage } });
        }
        let content = typeof reply.content === 'string' ? reply.content : streamed;
        let calls = Array.isArray(reply.tool_calls) ? reply.tool_calls.filter((c) => c && c.function) : [];
        // Output hit the token limit: the last tool call was still being written.
        // Never run it; tell the model why and how to fit the work.
        let cutCall = null;
        if (reply.truncated && calls.length) { cutCall = calls[calls.length - 1]; calls = calls.slice(0, -1); }
        if (content && /<tool_response>/i.test(content)) content = content.replace(/<tool_response>[\s\S]*?(?:<\/tool_response>|$)/gi, '').trim();
        if (!calls.length && content) {
          const extracted = extractTextToolCalls(content, TOOL_NAMES, SCHEMAS);
          if (extracted && extracted.calls.length) {
            calls = extracted.calls.map((call, index) => ({ id: 'text_' + step + '_' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
            content = extracted.text || '';
            this.onEvent({ type: 'repaired', count: calls.length });
          } else {
            const unknown = unknownTextToolCalls(content, TOOL_NAMES);
            if (unknown && unknown.length) {
              this.messages.push({ role: 'assistant', content });
              this.messages.push({ role: 'user', content: 'Those look like tool calls to tools that do not exist (' + unknown.join(', ') + '). Use only these tools: ' + [...TOOL_NAMES].join(', ') + '.' });
              continue;
            }
          }
        }
        calls = calls.map((call, index) => ({ id: call.id || 'call_' + step + '_' + index, type: 'function', function: { name: call.function.name, arguments: call.function.arguments }, ...(call.extra_content && typeof call.extra_content === 'object' ? { extra_content: call.extra_content } : {}) }));
        // An empty reply (no text, no tool call) is not an answer: ask again
        // (twice), then say so instead of ending the turn with nothing.
        if (!calls.length && !String(content || '').trim() && !reply.truncated) {
          if (!reply.providerStop && emptyReplies < MAX_EMPTY_REPLY_NUDGES && step < maxSteps - 1) {
            emptyReplies++;
            this.messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE });
            this.onEvent({ type: 'empty_reply', step });
            continue;
          }
          content = reply.providerStop ? providerStopNotice(reply.providerStop) : EMPTY_REPLY_NOTICE;
        }
        const assistant = { role: 'assistant', content: content || '' };
        if (calls.length) assistant.tool_calls = calls;
        this.messages.push(assistant);
        this.onEvent({ type: 'assistant', content: content || '', toolCalls: calls, step });
        let truncationNote = '';
        if (reply.truncated && truncations < MAX_TRUNCATION_RECOVERIES && step < maxSteps - 1) {
          truncations++;
          truncationNote = TRUNCATED_REPLY_NOTE(cutCall && cutCall.function.name);
          this.onEvent({ type: 'truncated', tool: cutCall ? cutCall.function.name : null, step });
          if (!calls.length) { this.messages.push({ role: 'user', content: truncationNote }); continue; }
        }
        if (!calls.length) {
          finalText = content || '';
          if (this.steering.length && step < maxSteps - 1) continue;
          break;
        }

        for (const call of calls) {
          if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
          let name = call.function.name;
          let args;
          let result;
          let ok = true;
          try {
            args = repairToolArguments(call.function.arguments).args;
          } catch (error) {
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: ' + error.message + ' Send the arguments again as a JSON object.' });
            this.onEvent({ type: 'tool_result', id: call.id, name, ok: false, content: error.message });
            continue;
          }
          const alias = resolveToolAlias(name, args, TOOL_NAMES);
          if (alias && alias.error) {
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Error: ' + alias.error });
            this.onEvent({ type: 'tool_result', id: call.id, name, ok: false, content: alias.error });
            continue;
          }
          if (alias) { name = alias.name; args = alias.args; }
          this.onEvent({ type: 'tool_start', id: call.id, name, args });
          const signature = name + ':' + JSON.stringify(args);
          recent.push(signature);
          const repeats = recent.filter((item) => item === signature).length;
          if (repeats >= 3 && !['read_file', 'list_files', 'project_changes'].includes(name)) {
            result = 'You already made this exact call ' + (repeats - 1) + ' times with the same result. Change approach: re-read the relevant file, try a different fix, or explain what is blocking you.';
            ok = false;
          } else {
            const mode = this.getConfig().mode || 'ask';
            const definition = TOOL_DEFINITIONS.find((item) => item && item.function && item.function.name === name);
            if (!definition) {
              result = 'Error: Unknown tool: ' + name;
              ok = false;
            } else {
              const tool = defineTool({
                name,
                title: name,
                description: definition.function.description || '',
                capabilities: browserToolCapabilities(name),
                risk: browserToolRisk(name),
                inputSchema: definition.function.parameters || { type: 'object' },
                timeoutMs: name === 'run_javascript' ? 70_000 : name === 'fetch_url' ? 45_000 : 120_000,
                run: async (validatedInput, runtime) => executeTool(name, validatedInput, { ...ctx, signal: runtime.signal })
              });
              const outcome = await runTool(tool, args, {
                signal,
                env: {},
                cwd: ctx.workspace && ctx.workspace.project && ctx.workspace.project.name || 'browser-workspace',
                validateArguments: validateAppToolArguments,
                authorize: async ({ input }) => {
                  const validation = await validateAppToolArguments(definition.function.parameters, input);
                  if (!validation.valid) return { decision: 'deny', reason: 'Invalid arguments for ' + name + ': ' + (validation.errors || []).join('; ') };
                  if (needsApproval(name, mode)) {
                    const allowed = await this.approve({ name, args: input, id: call.id });
                    if (!allowed) return { decision: 'deny', reason: 'The user declined this ' + name + ' call. Do not retry it; ask what they would prefer or continue another way.' };
                  }
                  return { decision: 'allow', input };
                }
              });
              if (outcome.cancelled && signal.aborted) throw new DOMException('Stopped', 'AbortError');
              if (!outcome.ok) {
                result = outcome.error && outcome.error.startsWith('The user declined this ')
                  ? outcome.error
                  : 'Error: ' + (outcome.error || 'Tool execution was denied.');
                ok = false;
              } else {
                result = outcome.output;
              }
            }
          }
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
          this.onEvent({ type: 'tool_result', id: call.id, name, ok, content: String(result) });
          if (ok && (name === 'write_file' || name === 'delete_file')) system = null;
        }
        if (truncationNote) this.messages.push({ role: 'user', content: truncationNote });
        if (step === maxSteps - 1) {
          finalText = 'Stopped after ' + maxSteps + ' steps. Send "continue" to keep going.';
          this.messages.push({ role: 'assistant', content: finalText });
          this.onEvent({ type: 'assistant', content: finalText, toolCalls: [], step });
        }
      }
      this.onEvent({ type: 'done', content: finalText });
      return finalText;
    } catch (error) {
      if (error && error.name === 'AbortError') {
        this.repairDangling();
        this.onEvent({ type: 'stopped' });
        return '';
      }
      this.repairDangling();
      this.onEvent({ type: 'error', message: error && error.message ? error.message : String(error) });
      throw error;
    } finally {
      this.running = false;
      this.controller = null;
    }
  }

  // Providers reject histories where a tool call has no result; fill any gaps.
  repairDangling() {
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (message.role !== 'assistant' || !message.tool_calls) continue;
      const answered = new Set();
      for (let j = i + 1; j < this.messages.length && this.messages[j].role === 'tool'; j++) answered.add(this.messages[j].tool_call_id);
      let insertAt = i + 1;
      while (insertAt < this.messages.length && this.messages[insertAt].role === 'tool') insertAt++;
      const missing = message.tool_calls.filter((call) => !answered.has(call.id)).map((call) => ({ role: 'tool', tool_call_id: call.id, content: 'Stopped by the user before this ran.' }));
      if (missing.length) this.messages.splice(insertAt, 0, ...missing);
    }
  }
}

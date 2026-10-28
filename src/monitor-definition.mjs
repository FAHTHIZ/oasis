// Tool schema for `monitor` (no imports, so tools.mjs can load it at top level).
const MONITOR_MAX_TIMEOUT_MS = 3600000;

export const MONITOR_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'monitor',
    description: 'Watch something in the background and get each new output line as an event, without polling. Use it to tail a log and flag errors, poll CI or a PR and report status changes, watch for file changes, or follow a long-running script. Give either command+args (one executable with argv, same rules and approvals as run_command) or ws (a WebSocket URL whose messages become events). Events arrive as <monitor-event> notices while you work, and wake you up when the user is idle. Keep scripts quiet: print only lines worth reacting to (use pattern to filter). Stop a monitor with kill_command.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short summary shown to the user and in each event, for example "errors in server.log".' },
        command: { type: 'string', description: 'Executable to run, for example tail, node, gh.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument array, for example ["-F", "server.log"].' },
        ws: { type: 'object', properties: { url: { type: 'string' }, protocols: { type: 'array', items: { type: 'string' } } }, required: ['url'], description: 'Watch a WebSocket instead of a command. Cannot be combined with command.' },
        pattern: { type: 'string', description: 'Optional JavaScript regular expression; only matching lines become events.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: MONITOR_MAX_TIMEOUT_MS, description: 'Stop after this long. Default 300000 (5 minutes).' },
        persistent: { type: 'boolean', description: 'Keep running until the session ends or kill_command stops it (no deadline).' }
      },
      required: ['description']
    }
  }
};

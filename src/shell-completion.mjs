// Shell (bash/zsh/fish/PowerShell) tab completion for the oasis command: `oasis completion bash|zsh|fish|powershell`.
// The scripts are static (no Node start-up on every Tab press) and list the top-level
// commands, their common subcommands and the main options.

export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

export const COMPLETION_COMMANDS = {
  web: 'Open the OASIS app in your browser',
  connect: 'Paste an API key, model link or local server',
  setup: 'Choose a model provider or a local model',
  doctor: 'Check Node, Git, provider, sandbox and config',
  models: 'List the models your provider serves',
  update: 'Update to the latest stable release',
  init: 'Create OASIS.md project instructions',
  mcp: 'Model Context Protocol servers',
  skills: 'Agent Skills',
  plugins: 'Native plugins',
  extensions: 'External extensions',
  ide: 'Editor integration',
  acp: 'Agent Client Protocol for editors',
  gateway: 'Chat from Telegram, Slack or Discord',
  sessions: 'Saved chats',
  memory: 'Project and user memory',
  permissions: 'Permission rules',
  trust: 'Trusted folders',
  import: 'Import settings from other tools',
  profile: 'Separate agent profiles',
  bg: 'Background sessions',
  schedule: 'Durable scheduled routines',
  batch: 'Run many prompts',
  plan: 'Plan without changing files',
  eval: 'Evaluation tasks',
  watch: 'Act on OASIS comments in files',
  config: 'Show the current configuration',
  auth: 'Sign in to providers',
  backups: 'List file backups',
  restore: 'Restore a backup',
  purge: 'Delete saved data',
  insights: 'Usage insights',
  diagnostics: 'Diagnostics bundle',
  uninstall: 'Remove the CLI',
  completion: 'Print a shell completion script',
  help: 'Show help'
};

export const COMPLETION_SUBCOMMANDS = {
  mcp: ['list', 'search', 'install', 'add', 'remove', 'serve', 'login', 'logout'],
  skills: ['list', 'find', 'inspect', 'add', 'install', 'eval'],
  plugins: ['list', 'install', 'remove', 'eval'],
  plugin: ['eval'],
  gateway: ['telegram', 'discord', 'slack'],
  sessions: ['list', 'search', 'export', 'clear', 'prune'],
  memory: ['list', 'search', 'show', 'forget', 'path'],
  bg: ['list', 'logs', 'attach', 'stop', 'rm'],
  schedule: ['add', 'list', 'show', 'edit', 'pause', 'resume', 'run', 'cancel', 'remove', 'tick', 'daemon'],
  profile: ['list', 'create', 'use', 'show', 'delete'],
  import: ['codex', 'gemini', 'cursor', 'claude', 'hermes', 'opencode', 'antigravity', 'windsurf', 'cline'],
  completion: COMPLETION_SHELLS,
  help: ['all'],
  web: ['--open', '--port', '--host', '--tls-cert', '--tls-key']
};

export const COMPLETION_OPTIONS = [
  '--help', '--version', '-p', '--print', '-c', '--continue', '-r', '--resume',
  '--model', '--profile', '--permission-mode', '--safe-mode', '--restricted',
  '-w', '--worktree', '--yes', '--verbose', '--debug', '--output-format'
];

export const PERMISSION_MODES = ['manual', 'accept-edits', 'plan', 'auto', 'dont-ask'];

const words = (list) => list.join(' ');

function bashScript() {
  const subs = Object.entries(COMPLETION_SUBCOMMANDS).map(([cmd, list]) => `    ${cmd}) COMPREPLY=( $(compgen -W "${words(list)}" -- "$cur") ); return ;;`).join('\n');
  return `# OASIS bash completion. Add to ~/.bashrc:  eval "$(oasis completion bash)"
_oasis_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$prev" = "--permission-mode" ]; then COMPREPLY=( $(compgen -W "${words(PERMISSION_MODES)}" -- "$cur") ); return; fi
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${words(Object.keys(COMPLETION_COMMANDS))} ${words(COMPLETION_OPTIONS)}" -- "$cur") ); return
  fi
  case "\${COMP_WORDS[1]}" in
${subs}
  esac
  COMPREPLY=( $(compgen -f -- "$cur") )
}
complete -o default -F _oasis_complete oasis
`;
}

function zshScript() {
  const cmds = Object.entries(COMPLETION_COMMANDS).map(([c, d]) => `    '${c}:${d.replace(/'/g, '')}'`).join('\n');
  const subs = Object.entries(COMPLETION_SUBCOMMANDS).map(([cmd, list]) => `    ${cmd}) compadd -- ${words(list)} ;;`).join('\n');
  return `#compdef oasis
# OASIS zsh completion. Add to ~/.zshrc:  eval "$(oasis completion zsh)"
_oasis() {
  local -a commands
  commands=(
${cmds}
  )
  if [[ "\${words[CURRENT-1]}" == --permission-mode ]]; then compadd -- ${words(PERMISSION_MODES)}; return; fi
  if (( CURRENT == 2 )); then
    _describe 'oasis command' commands
    compadd -- ${words(COMPLETION_OPTIONS)}
    return
  fi
  case "\${words[2]}" in
${subs}
    *) _files ;;
  esac
}
if (( $+functions[compdef] )); then compdef _oasis oasis; else autoload -Uz compinit && compinit && compdef _oasis oasis; fi
`;
}

function fishScript() {
  const top = Object.entries(COMPLETION_COMMANDS).map(([c, d]) => `complete -c oasis -n '__fish_use_subcommand' -a '${c}' -d '${d.replace(/'/g, '')}'`).join('\n');
  const subs = Object.entries(COMPLETION_SUBCOMMANDS).map(([cmd, list]) => `complete -c oasis -n '__fish_seen_subcommand_from ${cmd}' -a '${words(list)}'`).join('\n');
  const opts = COMPLETION_OPTIONS.filter((o) => o.startsWith('--')).map((o) => `complete -c oasis -l '${o.slice(2)}'`).join('\n');
  return `# OASIS fish completion. Save with:  oasis completion fish > ~/.config/fish/completions/oasis.fish
${top}
${subs}
${opts}
complete -c oasis -l permission-mode -x -a '${words(PERMISSION_MODES)}'
`;
}

function powershellScript() {
  const q = (list) => list.map((w) => `'${w}'`).join(', ');
  const subs = Object.entries(COMPLETION_SUBCOMMANDS).map(([cmd, list]) => `    '${cmd}' = @(${q(list)})`).join('\n');
  return `# OASIS PowerShell completion. Add to your $PROFILE:  oasis completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName oasis -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${q(Object.keys(COMPLETION_COMMANDS))})
  $options = @(${q(COMPLETION_OPTIONS)})
  $subs = @{
${subs}
  }
  $parts = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  $count = $parts.Count
  if ($wordToComplete -ne '') { $count = $count - 1 }
  if ($count -ge 2 -and $parts[$count - 1] -eq '--permission-mode') { $candidates = @(${q(PERMISSION_MODES)}) }
  elseif ($count -le 1) { $candidates = $commands + $options }
  elseif ($subs.ContainsKey($parts[1])) { $candidates = $subs[$parts[1]] }
  else { return }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function completionScript(shell) {
  const name = String(shell || '').toLowerCase().replace(/^pwsh$/, 'powershell');
  if (name === 'bash') return bashScript();
  if (name === 'zsh') return zshScript();
  if (name === 'fish') return fishScript();
  if (name === 'powershell') return powershellScript();
  return null;
}

export function completionUsage() {
  return [
    'Usage: oasis completion bash|zsh|fish|powershell',
    '',
    'Turn on Tab completion for oasis commands and options:',
    '  bash        eval "$(oasis completion bash)"            add to ~/.bashrc',
    '  zsh         eval "$(oasis completion zsh)"             add to ~/.zshrc',
    '  fish        oasis completion fish > ~/.config/fish/completions/oasis.fish',
    '  PowerShell  oasis completion powershell | Out-String | Invoke-Expression   add to $PROFILE',
    ''
  ].join('\n');
}

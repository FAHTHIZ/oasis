"""OASIS as a Harbor installed agent.

Harbor (https://harborframework.com) is the runner behind Terminal-Bench and
also runs SWE-bench Verified and other datasets in sandboxes. Claude Code,
Codex CLI, Gemini/Antigravity CLI, OpenCode, Aider and Hermes ship as built-in
Harbor agents; this file lets OASIS be scored on exactly the same tasks, with
the same model, so results are comparable:

    pip install harbor
    export ANTHROPIC_API_KEY=...
    harbor run -d terminal-bench@2.0 \
      --agent-import-path bench.harbor.oasis_agent:Oasis \
      -m anthropic/claude-sonnet-5-5 -n 4

    # the same tasks with a built-in competitor, for the comparison row
    harbor run -d terminal-bench@2.0 -a claude-code -m anthropic/claude-sonnet-5-5 -n 4

Run from the repository root so `bench.harbor.oasis_agent` is importable, or
put this folder on PYTHONPATH. `scripts/bench-harbor.sh` wraps both runs.

Model names use Harbor's `provider/model` form. Supported providers map onto
OASIS's own protocols:

    anthropic/…   Anthropic Messages API           ANTHROPIC_API_KEY
    openai/…      OpenAI Responses API             OPENAI_API_KEY
    gemini/…      Gemini OpenAI-compatible API     GEMINI_API_KEY (or GOOGLE_API_KEY)
    openrouter/…  OpenRouter                       OPENROUTER_API_KEY
    deepseek/…    DeepSeek                         DEEPSEEK_API_KEY
    moonshot/…    Moonshot (Kimi)                  MOONSHOT_API_KEY
    zai/…         Z.ai (GLM)                       ZAI_API_KEY
    xai/…         xAI (Grok)                       XAI_API_KEY
    groq/…        Groq                             GROQ_API_KEY
    mistral/…     Mistral                          MISTRAL_API_KEY
    together/…    Together                         TOGETHER_API_KEY
    fireworks/…   Fireworks                        FIREWORKS_API_KEY
    local/…       any OpenAI-compatible server     OASIS_BASE_URL (+ OASIS_LOCAL_API_KEY)

OASIS_BASE_URL / OASIS_PROTOCOL / OASIS_API_KEY on the host override the
mapping. Install source: OASIS_INSTALL_SPEC (default github:FAHTHIZ/oasis, or
github:FAHTHIZ/oasis#<ref> with --agent-kwarg version=<ref>).
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

try:  # Harbor >= 0.20 ships the shared nvm snippet; keep a fallback.
    from harbor.agents.installed.node_install import nvm_node_install_snippet
except Exception:  # pragma: no cover - older Harbor
    def nvm_node_install_snippet(node_major: int = 22) -> str:
        return (
            "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | env -u NODE_VERSION bash && "
            'export NVM_DIR="$HOME/.nvm" && \\. "$NVM_DIR/nvm.sh" || true && '
            f"nvm install {node_major} && nvm alias default {node_major} && npm -v"
        )


# provider -> (OASIS protocol, base URL or None for the protocol default, key env names)
PROVIDERS: dict[str, tuple[str, str | None, tuple[str, ...]]] = {
    "anthropic": ("anthropic", None, ("ANTHROPIC_API_KEY",)),
    "openai": ("openai-responses", None, ("OPENAI_API_KEY",)),
    "gemini": ("openai-compatible", "https://generativelanguage.googleapis.com/v1beta/openai", ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
    "google": ("openai-compatible", "https://generativelanguage.googleapis.com/v1beta/openai", ("GEMINI_API_KEY", "GOOGLE_API_KEY")),
    "openrouter": ("openai-compatible", "https://openrouter.ai/api/v1", ("OPENROUTER_API_KEY",)),
    "deepseek": ("openai-compatible", "https://api.deepseek.com/v1", ("DEEPSEEK_API_KEY",)),
    "moonshot": ("openai-compatible", "https://api.moonshot.ai/v1", ("MOONSHOT_API_KEY",)),
    "kimi": ("openai-compatible", "https://api.moonshot.ai/v1", ("MOONSHOT_API_KEY", "KIMI_API_KEY")),
    "zai": ("openai-compatible", "https://api.z.ai/api/paas/v4", ("ZAI_API_KEY",)),
    "xai": ("openai-compatible", "https://api.x.ai/v1", ("XAI_API_KEY",)),
    "groq": ("openai-compatible", "https://api.groq.com/openai/v1", ("GROQ_API_KEY",)),
    "mistral": ("openai-compatible", "https://api.mistral.ai/v1", ("MISTRAL_API_KEY",)),
    "together": ("openai-compatible", "https://api.together.xyz/v1", ("TOGETHER_API_KEY", "TOGETHERAI_API_KEY")),
    "fireworks": ("openai-compatible", "https://api.fireworks.ai/inference/v1", ("FIREWORKS_API_KEY",)),
    "local": ("openai-compatible", None, ()),
}

DEFAULT_INSTALL_SPEC = "github:FAHTHIZ/oasis"
RESULT_PATH = "/logs/agent/oasis-result.json"
LOG_PATH = "/logs/agent/oasis.txt"


def model_environment(model_name: str | None, env: dict[str, str] | None = None) -> dict[str, str]:
    """Translate Harbor's provider/model into the environment OASIS reads."""
    env = dict(os.environ if env is None else env)
    if not model_name or "/" not in model_name:
        raise ValueError("OASIS needs a model in provider/model form, for example anthropic/claude-sonnet-5-5")
    provider, model = model_name.split("/", 1)
    provider = provider.strip().lower()
    if provider not in PROVIDERS:
        raise ValueError(f"Unknown provider {provider!r} for OASIS; use one of {', '.join(sorted(PROVIDERS))}, or local/<model> with OASIS_BASE_URL")
    protocol, base_url, key_names = PROVIDERS[provider]
    out = {"OASIS_MODEL": model, "OASIS_PROTOCOL": env.get("OASIS_PROTOCOL") or protocol}
    chosen_base = env.get("OASIS_BASE_URL") or base_url
    if provider == "local" and not chosen_base:
        raise ValueError("local/<model> needs OASIS_BASE_URL, for example http://host.docker.internal:11434/v1")
    if chosen_base:
        out["OASIS_BASE_URL"] = chosen_base
    key = env.get("OASIS_API_KEY") or next((env[name] for name in key_names if env.get(name)), "")
    if provider == "local":
        if env.get("OASIS_LOCAL_API_KEY"):
            out["OASIS_LOCAL_API_KEY"] = env["OASIS_LOCAL_API_KEY"]
    elif not key:
        raise ValueError(f"Set {' or '.join(key_names)} (or OASIS_API_KEY) to run OASIS with {provider}")
    elif protocol == "anthropic":
        out["ANTHROPIC_API_KEY"] = key
    else:
        out["OASIS_API_KEY"] = key
    for name in ("OASIS_MAX_STEPS", "OASIS_MAX_TOOL_CALLS", "OASIS_MAX_TOKENS", "OASIS_REASONING_EFFORT"):
        if env.get(name):
            out[name] = env[name]
    return out


def run_command(instruction: str, *, max_turns: int | None = None, budget_usd: float | None = None) -> str:
    """The shell command that runs one task headless inside the task container."""
    # Benchmark tasks need pipes, redirects and heredocs, so the shell tool is on;
    # the task container is the sandbox.
    flags = ["--output-format", "json", "--dangerously-skip-permissions", "--permission-prompts", "none",
             "--settings", json.dumps({"shell": {"enabled": True}}, separators=(",", ":"))]
    if max_turns:
        flags += ["--max-turns", str(int(max_turns))]
    if budget_usd:
        flags += ["--max-budget-usd", str(float(budget_usd))]
    return (
        'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
        "mkdir -p /logs/agent; "
        # Benchmark containers have no Git identity; OASIS checkpoints with Git.
        "git config --global user.name >/dev/null 2>&1 || git config --global user.name OASIS; "
        "git config --global user.email >/dev/null 2>&1 || git config --global user.email oasis@localhost; "
        f"oasis -p {shlex.quote(instruction)} {' '.join(shlex.quote(f) for f in flags)} "
        f"< /dev/null > {RESULT_PATH} 2> >(stdbuf -oL tee {LOG_PATH} >&2); "
        # A failed or turn-limited run is still graded by the task tests, so the
        # exit status goes into the log instead of failing the trial.
        f"status=$?; cat {RESULT_PATH}; echo \"oasis exit status $status\" >> {LOG_PATH}; exit 0"
    )


def parse_result(text: str) -> dict[str, Any] | None:
    """The last JSON object OASIS printed (the run summary)."""
    for line in reversed((text or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("type") == "result":
                return value
    return None


class Oasis(BaseInstalledAgent):
    """OASIS (https://github.com/FAHTHIZ/oasis) running headless in the task container."""

    DEFAULT_SETUP_TIMEOUT_SEC = 600.0

    def __init__(self, *args: Any, max_turns: int | None = None, max_budget_usd: float | None = None, install_spec: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._max_turns = int(max_turns) if max_turns else None
        self._max_budget_usd = float(max_budget_usd) if max_budget_usd else None
        spec = install_spec or os.environ.get("OASIS_INSTALL_SPEC") or DEFAULT_INSTALL_SPEC
        if self._version and "#" not in spec and spec.startswith("github:"):
            spec = f"{spec}#{self._version}"
        self._install_spec = spec

    @staticmethod
    def name() -> str:
        return "oasis"

    def get_version_command(self) -> str | None:
        return 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; oasis --version'

    def parse_version(self, stdout: str) -> str:
        text = (stdout or "").strip().splitlines()
        return text[-1].replace("oasis", "").strip() if text else ""

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "bash", "git", "coreutils", "ca_certificates"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                'if command -v node >/dev/null 2>&1 && [ "$(node -p "process.versions.node.split(\'.\')[0]")" -ge 22 ]; then node --version; '
                f"else {nvm_node_install_snippet(22)}; fi && "
                'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
                f"npm install -g --no-fund --no-audit {shlex.quote(self._install_spec)} && oasis --version"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        env = model_environment(self.model_name, {**os.environ, **self._extra_env})
        result = await self.exec_as_agent(
            environment,
            command="bash -c " + shlex.quote(run_command(instruction, max_turns=self._max_turns, budget_usd=self._max_budget_usd)),
            env=env,
        )
        summary = parse_result(getattr(result, "stdout", "") or "")
        if summary:
            self._apply_summary(summary, context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = Path(self.logs_dir) / "oasis-result.json"
        if context.n_input_tokens is None and path.exists():
            summary = parse_result(path.read_text(errors="replace"))
            if summary:
                self._apply_summary(summary, context)

    @staticmethod
    def _apply_summary(summary: dict[str, Any], context: AgentContext) -> None:
        usage = summary.get("usage") or {}
        cached = int(usage.get("cache_read_input_tokens") or 0)
        context.n_input_tokens = int(usage.get("input_tokens") or 0) + cached + int(usage.get("cache_creation_input_tokens") or 0)
        context.n_cache_tokens = cached
        context.n_output_tokens = int(usage.get("output_tokens") or 0)
        if summary.get("total_cost_usd") is not None:
            context.cost_usd = float(summary["total_cost_usd"])

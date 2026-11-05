"""End-to-end check of the Harbor adapter without Docker or an API key.

Runs the adapter's real install() and run() commands on this machine against a
stand-in Harbor environment, with OASIS talking to a scripted OpenAI-compatible
model. The scripted model writes a file and runs it; the check then confirms
the file exists, the command ran, and token usage reached the AgentContext.

    python3 bench/harbor/smoke_test.py            # needs harbor (pip install harbor) and Node >= 22 on PATH

Exits non-zero on failure.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from harbor.environments.base import ExecResult  # noqa: E402
from harbor.models.agent.context import AgentContext  # noqa: E402

from bench.harbor import oasis_agent  # noqa: E402
from bench.harbor.oasis_agent import Oasis, model_environment, parse_result  # noqa: E402

REQUESTS: list[dict] = []


def tool_call(call_id: str, name: str, args: dict) -> dict:
    return {"content": None, "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}


SCRIPT = [
    tool_call("c1", "write_file", {"path": "hello.py", "content": "print('harbor smoke ok')\n"}),
    # A whole command line in run_command, as Bash-trained models send it.
    tool_call("c2", "run_command", {"command": "python3 hello.py"}),
    # Shell syntax needs run_shell, which the adapter enables.
    tool_call("c3", "run_shell", {"command": "python3 hello.py | tr a-z A-Z > upper.txt && cat upper.txt"}),
    {"content": "Created hello.py and ran it; it printed harbor smoke ok."},
]


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        REQUESTS.append(body)
        step = SCRIPT[min(len(REQUESTS) - 1, len(SCRIPT) - 1)]
        data = json.dumps({"choices": [{"message": {"role": "assistant", **step}, "finish_reason": "tool_calls" if step.get("tool_calls") else "stop"}],
                           "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class LocalEnvironment:
    """The parts of harbor's BaseEnvironment the adapter uses, run locally."""

    default_user = None

    def __init__(self, workdir: Path, logs: Path, base_env: dict[str, str]):
        self.workdir, self.logs, self.base_env = workdir, logs, base_env
        self.commands: list[str] = []

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None):
        command = command.replace("/logs/agent", str(self.logs))
        self.commands.append(command)
        proc = await asyncio.to_thread(subprocess.run, ["bash", "-c", command], cwd=cwd or self.workdir,
                                       env={**self.base_env, **(env or {})}, capture_output=True, text=True, timeout=timeout_sec or 300)
        return ExecResult(stdout=proc.stdout, stderr=proc.stderr, return_code=proc.returncode)


def check_model_mapping() -> None:
    env = {"ANTHROPIC_API_KEY": "a", "OPENAI_API_KEY": "o", "GEMINI_API_KEY": "g", "OPENROUTER_API_KEY": "r"}
    assert model_environment("anthropic/claude-x", env) == {"OASIS_MODEL": "claude-x", "OASIS_PROTOCOL": "anthropic", "ANTHROPIC_API_KEY": "a"}
    assert model_environment("openai/gpt-x", env)["OASIS_PROTOCOL"] == "openai-responses"
    gem = model_environment("gemini/gemini-x", env)
    assert gem["OASIS_BASE_URL"].startswith("https://generativelanguage") and gem["OASIS_API_KEY"] == "g"
    assert model_environment("openrouter/qwen/qwen3-coder", env)["OASIS_MODEL"] == "qwen/qwen3-coder"
    for bad in ("nomodel", "unknown/x", "local/x"):
        try:
            model_environment(bad, {})
        except ValueError:
            continue
        raise AssertionError(f"{bad} should be rejected")
    try:
        model_environment("deepseek/x", {})
        raise AssertionError("a missing key should be rejected")
    except ValueError:
        pass


async def main() -> int:
    check_model_mapping()
    assert parse_result('noise\n{"type":"result","usage":{"input_tokens":3}}\n')["usage"]["input_tokens"] == 3

    server = HTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = Path(tempfile.mkdtemp(prefix="oasis-harbor-"))
    try:
        work, logs, home, prefix = tmp / "app", tmp / "logs", tmp / "home", tmp / "prefix"
        for p in (work, logs, home, prefix):
            p.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=work, check=True)
        node_bin = Path(shutil.which("node") or "").parent
        base_env = {"PATH": f"{prefix / 'bin'}:{node_bin}:/usr/local/bin:/usr/bin:/bin", "HOME": str(home), "NPM_CONFIG_PREFIX": str(prefix),
                    "OASIS_NO_UPDATE_CHECK": "1", "OASIS_TELEMETRY": "0"}
        env = LocalEnvironment(work, logs, base_env)

        os.environ["OASIS_BASE_URL"] = f"http://127.0.0.1:{server.server_address[1]}/v1"
        agent = Oasis(logs_dir=logs, model_name="local/fixture", install_spec=str(ROOT), max_turns=6)

        async def no_system_packages(*_args, **_kwargs):
            return None

        agent.ensure_system_dependencies = no_system_packages  # the task image normally provides these
        await agent.install(env)
        context = AgentContext()
        await agent.run("Create hello.py that prints 'harbor smoke ok' and run it.", env, context)
        agent.populate_context_post_run(context)

        out = (work / "hello.py").read_text() if (work / "hello.py").exists() else ""
        summary = parse_result((logs / "oasis-result.json").read_text()) or {}
        ran = any(m.get("role") == "tool" and "harbor smoke ok" in str(m.get("content")) for r in REQUESTS for m in (r.get("messages") or []))
        checks = {
            "hello.py written": "harbor smoke ok" in out,
            "run_command output returned to the model": ran,
            "run_shell pipeline ran": (work / "upper.txt").exists() and "HARBOR SMOKE OK" in (work / "upper.txt").read_text(),
            "summary is success": summary.get("subtype") == "success",
            "tokens recorded": (context.n_input_tokens or 0) >= 400 and (context.n_output_tokens or 0) >= 80,
            # OASIS may spend one more request on its own verification nudge.
            "model requests": 4 <= len(REQUESTS) <= 7,
        }
        if os.environ.get("DUMP"):
            print(json.dumps(REQUESTS[-1].get("messages")[-4:], indent=1)[:4000])
        for name, ok in checks.items():
            print(("PASS " if ok else "FAIL ") + name)
        if not all(checks.values()):
            print("summary:", json.dumps(summary)[:2000])
            log = logs / "oasis.txt"
            print("log:", log.read_text()[-3000:] if log.exists() else "(none)")
            return 1
        print(f"Harbor adapter smoke test passed ({oasis_agent.__name__}, {len(env.commands)} environment commands).")
        return 0
    finally:
        server.shutdown()
        if os.environ.get("KEEP"): print("kept", tmp)
        else: shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

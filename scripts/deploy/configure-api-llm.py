#!/usr/bin/env python3
"""Apply GitHub secret/optional variables from stdin; never print credentials."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run as root")
    supplied = json.loads(sys.stdin.read(32769))
    names = {
        "WRITER_AGENT_LLM_API_KEY", "WRITER_AGENT_LLM_PROVIDER",
        "WRITER_AGENT_LLM_BASE_URL", "WRITER_AGENT_LLM_MODEL",
        "WRITER_AGENT_LLM_RESPONSE_FORMAT", "WRITER_AGENT_LLM_TOKEN_PARAMETER",
        "WRITER_AGENT_LLM_TIMEOUT_SECONDS", "WRITER_AGENT_LLM_MAX_OUTPUT_TOKENS",
        "WRITER_AGENT_REVIEW_MAX_CONTEXT_TOKENS", "WRITER_AGENT_LLM_MAX_CONTEXT_BYTES",
    }
    if not isinstance(supplied, dict) or set(supplied) - names:
        raise RuntimeError("Invalid setting names")
    if any(not isinstance(v, str) or len(v) > 4096 or any(c in v for c in "\r\n\x00") for v in supplied.values()):
        raise RuntimeError("Invalid setting values")
    if not supplied.get("WRITER_AGENT_LLM_API_KEY", "").strip():
        raise RuntimeError("Model secret is missing")
    config = Path("/etc/writer-agent/api.env")
    previous = config.read_bytes()
    backup = Path(tempfile.mkdtemp(prefix="llm-", dir="/var/backups/writer-agent"))
    (backup / "api.env").write_bytes(previous)
    (backup / "api.env").chmod(0o600)
    # Empty optional variables are removed, allowing the Go service to own defaults.
    lines = [line for line in previous.decode().splitlines() if line.split("=", 1)[0] not in names]
    for name, value in sorted(supplied.items()):
        if value:
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{name}="{escaped}"')

    def replace(data):
        fd, staging = tempfile.mkstemp(dir=config.parent, prefix=".api.env-")
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(staging, config)
        finally:
            if os.path.exists(staging):
                os.unlink(staging)

    try:
        replace(("\n".join(lines) + "\n").encode())
        subprocess.run(["systemctl", "restart", "writer-agent-api"], check=True, stdout=subprocess.DEVNULL)
        token = Path("/etc/writer-agent/auth-token").read_text().strip()
        for _ in range(20):
            try:
                req = urllib.request.Request("http://127.0.0.1:8787/v1/projects/local/workspace", headers={"Authorization": "Bearer " + token})
                with urllib.request.urlopen(req, timeout=2) as response:
                    workspace = json.load(response)
                if not workspace.get("capabilities", {}).get("evidenceReview"):
                    raise RuntimeError("Review capability did not activate")
                print("Model configuration activated; previous config backup: " + str(backup))
                return
            except (OSError, ValueError):
                time.sleep(1)
        raise RuntimeError("API did not become healthy")
    except Exception:
        replace(previous)
        subprocess.run(["systemctl", "restart", "writer-agent-api"], check=False, stdout=subprocess.DEVNULL)
        raise RuntimeError("Configuration failed; previous configuration restored") from None


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not expose input, provider responses, or exception objects in Actions logs.
        print("Model configuration failed. Previous configuration is retained/restored.", file=sys.stderr)
        sys.exit(1)

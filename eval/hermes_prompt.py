"""Fail closed when a matched local campaign loses the host toolchain probe."""


def require_toolchain_probe(probe):
    line = probe.get_environment_probe_line()
    if not line.startswith("Python toolchain: "):
        raise RuntimeError("Missing local Python-toolchain probe; check terminal Python/PATH before evaluation")
    return line


def verify_toolchain_prompt(agent, line):
    if line not in agent._build_system_prompt().splitlines():
        raise RuntimeError("Hermes system prompt omitted the Python-toolchain probe")

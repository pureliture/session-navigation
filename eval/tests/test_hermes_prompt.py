from types import SimpleNamespace
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hermes_prompt import require_toolchain_probe, verify_toolchain_prompt


class HermesPromptTests(unittest.TestCase):
    def test_historical_toolchain_text_is_present_and_not_reworded(self):
        line = "Python toolchain: python3=3.12.15 (no pip module), pip=missing, PEP 668=yes (use venv or uv), uv=installed."
        probe = SimpleNamespace(get_environment_probe_line=lambda: line)
        observed = require_toolchain_probe(probe)
        self.assertEqual(observed, line)
        verify_toolchain_prompt(SimpleNamespace(_build_system_prompt=lambda: "Stock host prompt\n\n" + line + "\n\nPlugin context"), observed)

    def test_missing_or_clean_probe_refuses_matched_campaign(self):
        with self.assertRaisesRegex(RuntimeError, "Missing local Python-toolchain probe"):
            require_toolchain_probe(SimpleNamespace(get_environment_probe_line=lambda: ""))
        with self.assertRaisesRegex(RuntimeError, "omitted"):
            verify_toolchain_prompt(SimpleNamespace(_build_system_prompt=lambda: "Stock host prompt"), "Python toolchain: value")

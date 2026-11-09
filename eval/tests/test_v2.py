import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proxy import serve
from v2_fixtures import build, component, document
from v2_run import child_environment


class V2Tests(unittest.TestCase):
    def test_distinct_long_fixtures_and_separate_obligations(self):
        with tempfile.TemporaryDirectory() as tmp:
            cases = build(Path(tmp))
            for case in cases:
                self.assertEqual(len(case["turns"]), 25)
                self.assertEqual(len(case["answers"]), 25)
                self.assertEqual(len({document(case["id"], i)[0] for i in range(1, 21)}), 20)
                eligible = [item for item in case["results"] if not item["protected"]]
                self.assertEqual(sum(item["announced"] for item in eligible), 3)
                self.assertEqual(sum(item["surprise_probe"] for item in eligible), 1)
                self.assertEqual(case["fixture_sha256"], build(Path(tmp))[cases.index(case)]["fixture_sha256"])
            self.assertIn("Do not clean", component("hide")["turns"][0])

    def test_child_does_not_receive_key_and_uses_versioned_core(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-secret", "OTHER_KEY": "other-secret"}):
            env = child_environment(Path("home"), Path("versioned"), Path("work"), Path("workspace"))
            self.assertNotIn("OPENROUTER_API_KEY", env)
            self.assertNotIn("OTHER_KEY", env)
            self.assertEqual(env["PYTHONPATH"], "versioned/src")

    def test_one_model_and_forced_provider_no_fallback(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-secret"}):
            server = serve(Path(tmp), model="stealth/crouton-alpha", provider="Stealth")
            try:
                def post(body):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", "/test", json.dumps(body))
                    response = connection.getresponse()
                    value = response.read()
                    connection.close()
                    return response.status, value
                with patch("urllib.request.urlopen") as upstream:
                    self.assertEqual(post({"model": "z-ai/glm-5.3-flash"})[0], 400)
                    upstream.assert_not_called()
                    upstream.return_value.__enter__.return_value.read.return_value = json.dumps({"choices": [{"message": {"content": "OK", "reasoning_details": [{"type": "reasoning.encrypted", "data": "opaque"}]}}]}).encode()
                    code, value = post({"model": "stealth/crouton-alpha", "provider": {"order": ["wrong"]}, "stream": True})
                    self.assertEqual(code, 200)
                    self.assertIn(b"opaque", value)
                    self.assertEqual(json.loads(upstream.call_args.args[0].data)["provider"], {"order": ["Stealth"], "allow_fallbacks": False})
            finally:
                server.shutdown()
                server.server_close()

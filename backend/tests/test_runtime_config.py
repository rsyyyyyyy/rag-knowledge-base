"""Startup configuration must apply before importing clients, without exposing keys."""
import contextlib
import io
import os
import unittest
from unittest.mock import patch

import run


class RuntimeConfigTests(unittest.TestCase):
    def test_parameters_override_environment(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "previous"}, clear=True):
            with patch("run.getpass.getpass") as prompt:
                args = run.configure(["--api-key", "test-placeholder", "--model", "chosen-model",
                                      "--base-url", "https://example.test/v1/", "--port", "8010"])
            prompt.assert_not_called()
            self.assertEqual(args.port, 8010)
            self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "test-placeholder")
            self.assertEqual(os.environ["DEEPSEEK_MODEL"], "chosen-model")
            self.assertEqual(os.environ["DEEPSEEK_BASE_URL"], "https://example.test/v1")

    def test_environment_avoids_prompt(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "env-placeholder",
                                    "DEEPSEEK_MODEL": "env-model"}, clear=True):
            with patch("run.getpass.getpass") as prompt:
                run.configure([])
            prompt.assert_not_called()
            self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "env-placeholder")
            self.assertEqual(os.environ["DEEPSEEK_MODEL"], "env-model")

    def test_interactive_prompt_is_not_printed(self):
        output = io.StringIO()
        with patch.dict(os.environ, {}, clear=True), patch("run.sys.stdin.isatty", return_value=True):
            with patch("run.getpass.getpass", return_value="hidden-placeholder") as prompt:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    run.configure([])
            prompt.assert_called_once()
            self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "hidden-placeholder")
        self.assertNotIn("hidden-placeholder", output.getvalue())

    def test_noninteractive_missing_key_fails_without_importing_app(self):
        with patch.dict(os.environ, {}, clear=True), patch("run.sys.stdin.isatty", return_value=False):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                run.configure([])
            self.assertEqual(error.exception.code, 2)

    def test_console_without_hidden_input_fails_closed(self):
        with patch.dict(os.environ, {}, clear=True), patch("run.sys.stdin.isatty", return_value=True):
            with patch("run.getpass.getpass", side_effect=run.getpass.GetPassWarning):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    run.configure([])
            self.assertNotIn("DEEPSEEK_API_KEY", os.environ)

    def test_model_adapter_uses_endpoint_and_keeps_key_private(self):
        import llm

        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "private-placeholder",
                                    "DEEPSEEK_BASE_URL": "https://example.test/v1"}, clear=True):
            with patch.object(llm, "DEFAULT_DEEPSEEK_MODEL", "configured-model"):
                spec = llm._deepseek_spec()
            self.assertEqual(spec.base_url, "https://example.test/v1")
            self.assertEqual(spec.model, "configured-model")
            self.assertEqual(spec.api_key, "private-placeholder")
            self.assertNotIn("private-placeholder", str(spec.public()))

    def test_rejects_invalid_inputs_without_echoing_credentials(self):
        for arguments in (["--port", "0"], ["--api-key", " "], ["--model", " "],
                          ["--base-url", "https://user:private-value@example.test"]):
            with self.subTest(arguments=arguments), patch.dict(os.environ, {}, clear=True):
                output = io.StringIO()
                with contextlib.redirect_stderr(output), self.assertRaises(SystemExit):
                    run.configure(arguments)
                self.assertNotIn("private-value", output.getvalue())

    def test_main_passes_configuration_to_single_worker(self):
        with patch.dict(os.environ, {}, clear=True), patch("uvicorn.run") as serve:
            run.main(["--api-key", "test-placeholder", "--port", "8011"])
            serve.assert_called_once()
            self.assertEqual(serve.call_args.args, ("app:app",))
            self.assertEqual(serve.call_args.kwargs["workers"], 1)
            self.assertEqual(serve.call_args.kwargs["port"], 8011)


if __name__ == "__main__":
    unittest.main()

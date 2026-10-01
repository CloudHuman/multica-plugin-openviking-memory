#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path

import yaml

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-memory-policy.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class PolicyInstallation(unittest.TestCase):
    def test_preserves_native_schema_identity_fields_and_merge_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "native", Path(directory) / "custom"
            source.mkdir()
            originals = {}
            for kind in ["entities", "preferences", "events", "soul"]:
                schema = {"memory_type": kind, "description": "native rule", "filename_template": "{{ category }}/{{ name }}.md", "directory": "viking://user/{{ user_space }}/memories/" + kind, "fields": [{"name": "content", "type": "string", "description": "Native shape and exact values.", "merge_op": "patch"}], "enabled": True}
                originals[kind] = schema
                (source / (kind + ".yaml")).write_text(yaml.safe_dump(schema))
            installed = installer.install(source, output, {"common": ["Do not learn one-run controls."], "types": {"entities": ["Retain authoritative updates."]}})
            self.assertEqual(set(installed), {"entities", "preferences", "events"})
            self.assertFalse((output / "soul.yaml").exists())
            for kind in installed:
                generated = yaml.safe_load((output / (kind + ".yaml")).read_text())
                original = yaml.safe_load((source / (kind + ".yaml")).read_text())
                self.assertEqual(original, originals[kind], "bundled templates must not change")
                for key in ["memory_type", "filename_template", "directory", "enabled"]:
                    self.assertEqual(generated[key], original[key])
                self.assertIn("native rule", generated["description"])
                self.assertIn("Do not learn one-run controls", generated["description"])
                self.assertEqual(generated["fields"][0]["merge_op"], "patch")
                self.assertIn("Native shape and exact values", generated["fields"][0]["description"])

    def test_refuses_to_modify_bundled_templates(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                installer.install(directory, directory, {"common": [], "types": {}})


if __name__ == "__main__":
    unittest.main()

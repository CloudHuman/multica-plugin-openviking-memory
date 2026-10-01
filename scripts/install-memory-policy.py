#!/usr/bin/env python3
"""Generate overrides from the installed OV schemas, preserving their formats.

Run with the same Python environment as OpenViking (PyYAML is its dependency).
No upstream code/templates are vendored or modified. Set memory.custom_templates_dir
to the output directory and restart OV to load the generated overrides.
"""
import argparse
import json
from pathlib import Path

import yaml


def install(source, output, policy):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output or source in output.parents:
        raise ValueError("Output must be outside OpenViking's bundled template directory")
    output.mkdir(parents=True, exist_ok=True)
    installed = []
    for template in sorted(source.glob("*.yaml")):
        schema = yaml.safe_load(template.read_text())
        kind = schema["memory_type"]
        # Bootstrap personality is outside the plugin's business-memory policy.
        if kind in {"identity", "soul"}:
            continue
        rules = policy["common"] + policy["types"].get(kind, [])
        extra = "\n\n## Multica business-memory quality\n" + "\n".join("- " + rule for rule in rules)
        schema["description"] = schema.get("description", "") + extra
        for field in schema.get("fields", []):
            if field.get("name") == "content" and kind in policy["types"]:
                # Global rules already appear in the type description; avoid
                # repeating them in every field's schema and inflating prompts.
                field["description"] = field.get("description", "") + "\n" + "\n".join(policy["types"][kind])
            if kind == "entities" and field.get("name") in {"category", "name"}:
                field["description"] = field.get("description", "") + "\nReuse this exact subject's existing identity/category from prefetched/read cards; do not create a category alias copy."
        (output / template.name).write_text(yaml.safe_dump(schema, allow_unicode=True, sort_keys=False))
        installed.append(kind)
    if not {"entities", "preferences", "events"}.issubset(installed):
        raise ValueError("Installed OpenViking is missing required memory schemas")
    return installed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source", help="Bundled memory-template directory; defaults to installed OpenViking")
    parser.add_argument("--policy", default=str(Path(__file__).resolve().parent.parent / "deploy" / "memory-policy.json"))
    args = parser.parse_args()
    if args.source:
        template_source = Path(args.source)
    else:
        import openviking
        template_source = Path(openviking.__file__).parent / "prompts" / "templates" / "memory"
    result = install(template_source, args.output, json.loads(Path(args.policy).read_text()))
    print(json.dumps({"output": str(Path(args.output).resolve()), "memory_types": result}))

#!/usr/bin/env python3
"""Generate ~/.codex/opencode-catalog.json from bundled Codex models.

Fixes `Model metadata for opencode/mimo-v2.5-free not found` which disables
`apply_patch` (fallback has apply_patch_tool_type=None).

Usage:
  codex debug models --bundled > /tmp/b.json
  python3 scripts/generate-codex-catalog.py /tmp/b.json ~/.codex/opencode-catalog.json
  # then set in ~/.codex/config.toml: model_catalog_json = "~/.codex/opencode-catalog.json"
"""
import json, sys, pathlib

if len(sys.argv) != 3:
    print(f"Usage: {sys.argv[0]} <bundled.json> <out.json>", file=sys.stderr)
    sys.exit(1)

bundled_path, out_path = sys.argv[1], sys.argv[2]
with open(bundled_path) as f:
    data = json.load(f)

template = data["models"][0]  # e.g. gpt-6-astra
proxy_ids = [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/muse-spark-1.2-contributor-free",
    "opencode/mimo-v2.5-free",
    "opencode/ling-3.0-flash-fin-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/big-pickle",
]

new_models = []
for pid in proxy_ids:
    m = json.loads(json.dumps(template))
    m["slug"] = pid
    m["display_name"] = pid.split("/")[-1] + " (via proxy)"
    m["description"] = f"Opencode proxy {pid} (cloned from {template['slug']})"
    m["priority"] = 10
    m["visibility"] = "list"
    m["supported_in_api"] = True
    new_models.append(m)
    # alias without provider for find_model_by_namespaced_suffix
    suffix = pid.split("/")[-1]
    m2 = json.loads(json.dumps(m))
    m2["slug"] = suffix
    m2["display_name"] = suffix + " (alias)"
    m2["priority"] = 99
    new_models.append(m2)

out = {"models": data["models"] + new_models}
path = pathlib.Path(out_path).expanduser()
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(out, indent=2))
print(f"Wrote {len(out['models'])} models to {path} ({len(new_models)} new)")

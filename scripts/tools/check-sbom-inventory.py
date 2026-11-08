"""Compare a live CycloneDX inventory with the frozen Ubuntu reference."""
import json
import pathlib
import re
import sys

archived = json.loads(pathlib.Path(sys.argv[1]).read_text())
sbom = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert {k: v for k, v in archived.items() if k != "components"} == {k: v for k, v in sbom.items() if k != "components"}, "SBOM metadata changed"
assert len(archived["components"]) == len(sbom["components"]), "SBOM component count changed"
for recorded, live in zip(archived["components"], sbom["components"]):
    if recorded == live:
        continue
    name = recorded["name"]
    assert name in {"bubblewrap", "poppler-utils"} and recorded["type"] == "application", f"unexpected SBOM drift: {name}"
    assert {k: v for k, v in recorded.items() if k not in {"version", "bom-ref", "purl"}} == {k: v for k, v in live.items() if k not in {"version", "bom-ref", "purl"}}, f"{name} metadata or license changed"
    old, new = (re.fullmatch(r"(.+ubuntu0)\.(\d+)", entry["version"]) for entry in (recorded, live))
    assert old and new and old[1] == new[1] and int(new[2]) >= int(old[2]), f"{name} changed outside the allowed Ubuntu update series"
    version = live["version"]
    assert live["bom-ref"] == f"deb:{name}@{version}" and live["purl"] == f"pkg:deb/ubuntu/{name}@{version}", f"{name} identity does not match its installed version"
    print(f"SBOM INFO: {name} Ubuntu revision {recorded['version']} -> {version}")

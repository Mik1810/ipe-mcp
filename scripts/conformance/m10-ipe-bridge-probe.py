"""Probe an actual Ipe Qt model, using only a disposable copy of a fixture."""
import os
import shutil
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
IPE = Path("/usr/bin/ipe")
PACKAGE_VERSION = "7.2.30-1build2"


def wait_for(process, log, outcome):
    deadline = time.monotonic() + 5
    marker = ("IPE_BRIDGE_PROBE: " + outcome + "\n").encode()
    while time.monotonic() < deadline and process.poll() is None:
        with log.open("rb") as stream:
            if marker in stream.read(32 * 1024):
                return
        time.sleep(0.025)
    raise RuntimeError("Ipe did not emit " + outcome)


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)


def run_probe():
    observed = subprocess.run(
        ["/usr/bin/dpkg-query", "-W", "-f=${Status} ${Version}", "ipe"],
        text=True, capture_output=True, timeout=3, check=True,
    )
    owner = subprocess.run(
        ["/usr/bin/dpkg-query", "-S", str(IPE)], text=True, capture_output=True, timeout=3, check=True,
    )
    if observed.stdout != "install ok installed " + PACKAGE_VERSION or owner.stdout.strip() != "ipe: " + str(IPE):
        raise RuntimeError("Verified Ipe 7.2.30 package required")

    fixture = ROOT / "fixtures/conformance/minimal.ipe"
    original = fixture.read_bytes()
    with tempfile.TemporaryDirectory(prefix="ipe-bridge-probe-") as temporary:
        directory = Path(temporary)
        plugins = directory / "ipelets"
        plugins.mkdir()
        shutil.copyfile(Path(__file__).with_suffix(".lua"), plugins / "bridge-probe.lua")
        document = directory / "document.ipe"
        document.write_bytes(original)
        snapshot, proceed, log = (directory / name for name in ("snapshot.ipe", "continue", "diagnostics"))
        environment = os.environ | {
            "QT_QPA_PLATFORM": "offscreen",
            "IPELETPATH": str(plugins),
            "IPESTYLES": "_",
            "XDG_CONFIG_HOME": str(directory / "config"),
            "XDG_DATA_HOME": str(directory / "data"),
            "IPE_BRIDGE_PROBE_SNAPSHOT": str(snapshot),
            "IPE_BRIDGE_PROBE_CONTINUE": str(proceed),
        }
        with log.open("wb") as stderr:
            process = subprocess.Popen([str(IPE), str(document)], cwd=directory, env=environment,
                                       stdout=subprocess.DEVNULL, stderr=stderr)
            try:
                wait_for(process, log, "DIRTY_SNAPSHOT_PASS")
                assert document.read_bytes() == original, "snapshot touched the open source"
                xml = snapshot.read_text()
                assert ET.fromstring(xml).find("info").get("title") == "Live probe"
                replacement = directory / "replacement.ipe"
                replacement.write_text(xml.replace('title="Live probe"', 'title="Disk probe"', 1))
                replacement.replace(document)
                proceed.touch()
                wait_for(process, log, "DISK_CONFLICT_AND_UNDO_PASS")
                assert ET.parse(document).getroot().find("info").get("title") == "Disk probe"
            finally:
                stop(process)
        assert fixture.read_bytes() == original, "source fixture changed"
    print("M10 IPE BRIDGE PASS: Ipe 7.2.30 Qt model, dirty snapshot, external replacement isolation, native undo, unchanged fixture and private cleanup")


if __name__ == "__main__":
    try:
        run_probe()
    except (AssertionError, OSError, RuntimeError, subprocess.SubprocessError, ET.ParseError) as failure:
        outcome = str(failure) if type(failure) is RuntimeError else type(failure).__name__
        raise SystemExit("M10 IPE BRIDGE FAIL: " + outcome) from None

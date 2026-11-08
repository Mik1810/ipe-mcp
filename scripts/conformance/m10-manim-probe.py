"""Render a bounded MIT fixture twice and compare both endpoints with native Ipe."""
import argparse
import hashlib
import json
from importlib.metadata import version
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
CORPUS = ROOT / "fixtures/conformance/m10/manim"
SCENE = Path(__file__).with_name("m10-manim-scene.py")
TEX_ENV = {"openin_any": "p", "openout_any": "p", "shell_escape": "0"}


def controlled(directory, label, command, timeout=45):
    env = {
        "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TMPDIR": str(directory),
        "XDG_CONFIG_HOME": str(directory / "config"), "XDG_CACHE_HOME": str(directory / "cache"),
        "MPLCONFIGDIR": str(directory / "mpl"), "OPENBLAS_NUM_THREADS": "1", "OMP_NUM_THREADS": "1",
        "IPE_MANIM_SPIKE_INPUT": str(CORPUS / "translation.ipe"), **TEX_ENV,
    }
    args = [
        "/usr/bin/bwrap", "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "--new-session",
        "--ro-bind", "/", "/", "--bind", str(directory), str(directory), "--dev", "/dev", "--proc", "/proc",
        "--chdir", str(directory), "--", "/usr/bin/prlimit", "--as=2147483648", "--nproc=256", "--fsize=67108864",
        "--", *map(str, command),
    ]
    with (directory / (label + ".log")).open("wb") as log:
        started = time.monotonic()
        result = subprocess.run(args, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        elapsed = time.monotonic() - started
    if result.returncode:
        raise RuntimeError(f"{label} failed with exit {result.returncode}")
    return round(1000 * elapsed)


def bytes_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixels(path):
    with Image.open(path) as image:
        result = np.array(image.convert("RGB"), dtype=np.int16)
    assert result.shape == (180, 320, 3)
    return result


def measure(path):
    image = pixels(path)
    red, green, blue = image.transpose(2, 0, 1)
    masks = {
        "moving": (red > 135) & (green < 105) & (blue < 105),
        "reference": (red < 100) & (green < 130) & (blue > 115),
        "tex": (red < 55) & (green < 55) & (blue < 55),
    }
    result = {}
    for name, mask in masks.items():
        y, x = np.where(mask)
        assert len(x)
        box = [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1]
        inner = image[mask]
        result[name] = {"bbox": box, "centerX": (box[0] + box[2]) / 2,
                        "rgb": np.median(inner, axis=0).astype(int).tolist()}
    return result


def comparison_sheet(native, rendered, destination):
    sheet = Image.new("RGB", (676, 641), "white")
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 9), "Ipe 7.2.30 native reference", fill="#172536")
    draw.text((344, 9), "Manim 0.22.1 Cairo / H.264", fill="#172536")
    for index, label in enumerate(("Start", "Midpoint", "End")):
        y = 35 + 202 * index
        draw.text((12, y), label, fill="#172536")
        for x, path in ((12, native[index]), (344, rendered[index])):
            if path is None:
                draw.rectangle((x, y + 15, x + 319, y + 194), fill="#f4f6f8", outline="#bcc6ce")
                draw.text((x + 24, y + 82), "No native intermediate view", fill="#172536")
                continue
            with Image.open(path) as image:
                sheet.paste(image.convert("RGB"), (x, y + 15))
            draw.rectangle((x - 1, y + 14, x + 320, y + 195), outline="#bcc6ce")
    sheet.save(destination)


def run(destination):
    assert version("manim") == "0.22.1"
    with tempfile.TemporaryDirectory(prefix="ipe-manim-gate-") as directory:
        work = Path(directory)
        native_pdf = work / "native.pdf"
        native_times = [
            controlled(work, "native compile", ["/usr/bin/ipetoipe", "-pdf", CORPUS / "translation.ipe", native_pdf]),
        ]
        controlled(work, "native fonts", ["/usr/bin/pdffonts", native_pdf])
        native_fonts = sorted({line.split()[0].split("+")[-1] for line in (work / "native fonts.log").read_text().splitlines()[2:] if line.strip()})
        controlled(work, "pango fonts", [sys.executable, "-c",
            "from manimpango import list_fonts; import json; print(json.dumps({'DejaVu Sans': 'DejaVu Sans' in list_fonts()}))"])
        pango_fonts = json.loads((work / "pango fonts.log").read_text())
        assert pango_fonts["DejaVu Sans"]
        native_frames = [work / "native-start.png", work / "native-end.png"]
        for index, frame in enumerate(native_frames, 1):
            native_times.append(controlled(work, "native view " + str(index), [
                "/usr/bin/iperender", "-png", "-nocrop", "-view", str(index), native_pdf, frame,
            ]))
        movies, times = [], []
        for index in (1, 2):
            media = work / ("media-" + str(index))
            times.append(controlled(work, "manim run " + str(index), [
                sys.executable, "-m", "manim", "render", "--disable_caching", "--media_dir", media, "-o", "probe.mp4", SCENE, "IpeTranslation",
            ]))
            (movie,) = list(media.rglob("probe.mp4"))
            movies.append(movie)

        controlled(work, "encoding", ["/usr/bin/ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", movies[0]])
        streams = json.loads((work / "encoding.log").read_text())["streams"]
        assert len(streams) == 1
        stream = streams[0]
        frames = int(stream["nb_frames"])
        assert (stream["codec_name"], stream["width"], stream["height"], stream["avg_frame_rate"], frames) == ("h264", 320, 180, "20/1", 24)
        frame_numbers = (0, 12, frames - 1)
        select = "select=" + "+".join(f"eq(n\\,{number})" for number in frame_numbers)
        controlled(work, "extract", [
            "/usr/bin/ffmpeg", "-v", "error", "-threads", "1", "-filter_threads", "1", "-i", movies[0],
            "-vf", select, "-fps_mode", "vfr", "-threads", "1", work / "manim-%02d.png",
        ])
        rendered = [work / f"manim-{i:02d}.png" for i in (1, 2, 3)]
        native = [measure(frame) for frame in native_frames]
        manim = [measure(frame) for frame in rendered]
        endpoint_error, channel_error = 0, 0
        for reference, actual in zip(native, (manim[0], manim[2])):
            for name in ("moving", "reference"):
                endpoint_error = max(endpoint_error, *(abs(a-b) for a, b in zip(reference[name]["bbox"], actual[name]["bbox"])))
                channel_error = max(channel_error, *(abs(a-b) for a, b in zip(reference[name]["rgb"], actual[name]["rgb"])))
        midpoint = manim[1]["moving"]["centerX"]
        expected_mid = (native[0]["moving"]["centerX"] + native[1]["moving"]["centerX"]) / 2
        assert endpoint_error <= 1 and channel_error <= 8 and abs(midpoint - expected_mid) <= 1
        movie_digests = [bytes_hash(movie) for movie in movies]
        assert movie_digests[0] == movie_digests[1]
        omissions = {}
        source = (CORPUS / "translation.ipe").read_text()
        variants = {
            "clip": (source.replace('<path layer="moving"', '<group layer="moving" clip="44 80 m 64 80 l 64 114 l 44 114 l h"><path layer="moving"')
                .replace('44 114 l h</path>', '44 114 l h</path></group>'), "UNSUPPORTED_CLIP"),
            "gradient": (source.replace('fill="0.8 0.15 0.1"', 'fill="0.8 0.15 0.1" gradient="sample"'), "UNSUPPORTED_GRADIENT"),
            "affine": (source.replace("1 0 0 1 144 0", "2 0 0 1 144 0"), "UNSUPPORTED_AFFINE_TRANSFORM"),
            "transition": (source.replace('<view layers="reference moving" active="moving"><transform', '<view layers="reference moving" active="moving" effect="fade"><transform'), "UNSUPPORTED_VIEW_SEQUENCE"),
        }
        inspect_fixture = (
            "import runpy, sys; from pathlib import Path\n"
            "scene = runpy.run_path(sys.argv[1])\n"
            "try: scene['fixture'](Path(sys.argv[2]))\n"
            "except ValueError as e: print(e)\n"
            "else: sys.exit(2)\n"
        )
        for case, (xml, expected) in variants.items():
            path = work / (case + ".ipe")
            path.write_text(xml)
            controlled(work, case, [sys.executable, "-c", inspect_fixture, SCENE, path])
            outcome = (work / (case + ".log")).read_text().strip()
            assert outcome == expected
            omissions[case] = outcome

        decision = {
            "case": "two-view-linear-translation", "native": native, "manim": manim,
            "pixelTolerance": {"endpointBBox": 1, "colorChannel": 8, "midpointCenterX": 1},
            "measured": {"endpointBBox": endpoint_error, "colorChannel": channel_error, "midpointCenterX": abs(midpoint - expected_mid)},
            "encoding": {"codec": "h264", "frames": frames, "frameRate": 20, "durationSeconds": float(stream["duration"]),
                         "audioStreams": 0, "bytes": movies[0].stat().st_size, "sameBytesOnRepeat": True, "sha256": movie_digests[0]},
            "fonts": {"nativePdf": native_fonts, "pangoAvailability": pango_fonts},
            "rejected": omissions,
            "costMs": {"nativeCompilationAndTwoFrames": sum(native_times), "manimRenders": times},
            "diagnostics": ["TEX_LABEL_GEOMETRY_APPROXIMATED", "NO_NATIVE_MIDPOINT", "NO_AUDIO"],
        }
        comparison_sheet([native_frames[0], None, native_frames[1]], rendered, destination / "side-by-side.png")
        (destination / "evidence.json").write_text(json.dumps(decision, indent=2) + "\n")
        print(json.dumps({"status": "PASS", "geometry": decision["measured"], "frames": frames, "sha256": movie_digests[0]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    try:
        run(args.output)
    except (RuntimeError, AssertionError, OSError, subprocess.SubprocessError) as error:
        print(f"M10 MANIM FAIL: {type(error).__name__}: {str(error) if type(error) is RuntimeError else ''}", file=sys.stderr)
        sys.exit(1)

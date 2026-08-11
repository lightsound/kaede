"""ffmpeg / ffprobe wrappers shared by the factory lanes.

One canonical set: the walk lane (run_avatar), the fal replace lane and the
spike CLI all extract frames and probe clips; keeping a single frame-exact
implementation is what makes their frame indices comparable (the replace
lane's phase math assumes extraction is 1 png per stream frame — `-vsync 0`).
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import NamedTuple


class VideoInfo(NamedTuple):
    frames: int
    duration: float
    fps: float


def run_quiet(cmd: list[str]) -> str:
    """Run a media tool, failing loud with its stderr tail on error."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"{cmd[0]} failed: {result.stderr[-800:]}")
    return result.stdout


def probe(video: Path) -> VideoInfo:
    """(frame count, duration seconds, fps) of a local video."""
    import json

    out = run_quiet([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-count_frames", "-show_entries",
        "stream=nb_read_frames,duration,r_frame_rate",
        "-of", "json", str(video),
    ])
    stream = json.loads(out)["streams"][0]
    num, _, den = stream["r_frame_rate"].partition("/")
    return VideoInfo(
        frames=int(stream["nb_read_frames"]),
        duration=float(stream["duration"]),
        fps=float(num) / float(den or 1),
    )


def extract_frames(video: Path, out_dir: Path) -> list[Path]:
    """Losslessly extract every stream frame to frame_%04d.png (1-based)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("frame_*.png"):
        old.unlink()
    run_quiet([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(video),
        "-vsync", "0", str(out_dir / "frame_%04d.png"),
    ])
    frames = sorted(out_dir.glob("frame_*.png"))
    if not frames:
        raise SystemExit(f"no frames extracted from {video}")
    return frames


def trim(video: Path, start: int, end: int, fps: float, dest: Path) -> None:
    """Frame-exact re-encode of frames [start, end] (0-based, inclusive)."""
    run_quiet([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(video),
        "-vf", f"select=between(n\\,{start}\\,{end}),setpts=N/{fps:g}/TB",
        "-r", f"{fps:g}", "-an", "-c:v", "libx264", "-crf", "12",
        "-pix_fmt", "yuv420p", str(dest),
    ])

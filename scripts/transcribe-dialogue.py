# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper>=1.1"]
# ///
"""Transcribe a conversation recorded one speaker per file, and merge the lines into one timed dialogue.

Each speaker's own recording is transcribed locally with Whisper (faster-whisper), so a line's speaker
is the file it came from, and its start is the time Whisper aligned to its first word. Lines are cut at
sentence ends and at pauses, and ordered by start time across speakers. While it runs, stderr gets a
line such as "Teacher: 512/1458s" each time Whisper finishes a stretch of that recording.

    uv run scripts/transcribe-dialogue.py --track Teacher=teacher.mp3 --track Student=student.mp3 --out dialogue.json
"""

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time

import numpy as np
from faster_whisper import WhisperModel


def load_audio(file, sampling_rate=16000):
    """Mono float samples decoded by ffmpeg; faster-whisper's own decoder does not work with current PyAV."""
    pcm = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", str(sampling_rate), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0


# Silence between two words, in seconds, that starts a new line even without a sentence end.
PAUSE = 0.8

# Whisper writes in the style of its prompt. Without a punctuated one it can write a whole recording in
# lowercase without punctuation, which leaves no sentence ends to cut lines at.
STYLE = "Hello! How are you today? I'm good, thanks. Let's get started."


def spoken_lines(segments, speaker):
    """Lines cut at sentence ends and at pauses, timed by the words Whisper aligned to the audio."""
    words = []
    for segment in segments:
        for word in segment.words or []:
            if words and word.start - words[-1].end >= PAUSE:
                yield line(words, speaker)
                words = []
            words.append(word)
            if re.search(r"[.?!]$", word.word.strip()):
                yield line(words, speaker)
                words = []
    if words:
        yield line(words, speaker)


def reported(segments, speaker, seconds):
    """Passes the segments on, printing how far into the recording each one ends."""
    for segment in segments:
        print(f"{speaker}: {segment.end:.0f}/{seconds:.0f}s", file=sys.stderr, flush=True)
        yield segment


def line(words, speaker):
    return {
        "speaker": speaker,
        "start": round(words[0].start, 2),
        "end": round(words[-1].end, 2),
        "text": "".join(w.word for w in words).strip(),
        "words": [[round(w.start, 2), round(w.end, 2), w.word.strip()] for w in words],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--track", action="append", required=True, metavar="NAME=FILE", help="one speaker's recording")
    parser.add_argument(
        "--prompt", action="append", default=[], metavar="NAME=TEXT", help="style hint for a speaker (default: a punctuated greeting)"
    )
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--language", default="en")
    parser.add_argument("--out", required=True, type=pathlib.Path)
    args = parser.parse_args()

    prompts = dict(p.split("=", 1) for p in args.prompt)
    # CTranslate2 runs best with one thread per physical core.
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=max(1, (os.cpu_count() or 2) // 2))
    tracks, lines = [], []
    for spec in args.track:
        speaker, file = spec.split("=", 1)
        began = time.monotonic()
        segments, info = model.transcribe(
            load_audio(file),
            language=args.language,
            vad_filter=True,
            word_timestamps=True,
            initial_prompt=prompts.get(speaker, STYLE),
        )
        spoken = list(spoken_lines(reported(segments, speaker, info.duration), speaker))
        seconds = time.monotonic() - began
        print(
            f"{speaker}: {len(spoken)} lines from {info.duration:.0f}s of audio "
            f"({info.duration_after_vad:.0f}s of speech) in {seconds:.0f}s",
            file=sys.stderr,
        )
        tracks.append({"speaker": speaker, "file": file, "seconds": info.duration, "speech": info.duration_after_vad})
        lines += spoken
    lines.sort(key=lambda l: l["start"])
    args.out.write_text(
        json.dumps({"model": args.model, "tracks": tracks, "lines": lines}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

"""
Download individual MAESTRO v3.0.0 pieces (audio + exact performance MIDI) WITHOUT fetching the
101 GB archive: HTTP range requests into the public zip on storage.googleapis.com (remotezip).

    server/.venv/bin/python tests/accuracy/fetch_maestro.py OUT_DIR AUDIO_FILENAME [...]

AUDIO_FILENAME is the `audio_filename` column of maestro-v3.0.0.csv (e.g. 2011/MIDI-...wav).
MAESTRO is CC BY-NC-SA 4.0 (Hawthorne et al., ICLR 2019) — keep it out of the repository.
"""
import os
import sys

from remotezip import RemoteZip

URL = "https://storage.googleapis.com/magentadata/datasets/maestro/v3.0.0/maestro-v3.0.0.zip"


def main() -> None:
    out_dir, names = sys.argv[1], sys.argv[2:]
    os.makedirs(out_dir, exist_ok=True)
    with RemoteZip(URL) as z:
        for audio in names:
            stem = audio[: -len(".wav")]
            for member in (f"maestro-v3.0.0/{audio}", f"maestro-v3.0.0/{stem}.midi"):
                dest = os.path.join(out_dir, os.path.basename(member))
                if os.path.exists(dest):
                    continue
                with z.open(member) as src, open(dest + ".part", "wb") as dst:
                    while chunk := src.read(1 << 20):
                        dst.write(chunk)
                os.replace(dest + ".part", dest)
                print("ok", dest, os.path.getsize(dest), flush=True)


if __name__ == "__main__":
    main()

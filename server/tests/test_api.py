"""API: health, upload -> two stems, YouTube-free paths, error cases. SCNet is mocked (no model needed)."""
import io
import json
import subprocess
import time
import wave

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import main, model, separation

SR = 44100


def _wav(seconds: float = 5.0) -> bytes:
    t = np.arange(int(seconds * SR)) / SR
    left = 0.4 * np.sin(2 * np.pi * 261.63 * t)
    right = 0.4 * np.sin(2 * np.pi * 392.0 * t)
    pcm = (np.stack([left, right], 1) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return buf.getvalue()


@pytest.fixture()
def client(monkeypatch):
    calls = []

    def fake_separate(audio, on_progress=None, step=None, run=None):
        calls.append(audio.shape)
        for k in range(1, 4):
            on_progress and on_progress(k, 3)
        mono = audio.mean(0)
        return {"vocals": (0.25 * mono).astype(np.float32), "accomp": (0.75 * mono).astype(np.float32)}

    monkeypatch.setattr(separation, "available", lambda: True)
    monkeypatch.setattr(separation, "separate", fake_separate)
    c = TestClient(main.app)
    c.calls = calls
    return c


def _wait(c, job_id, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        j = c.get(f"/api/jobs/{job_id}").json()
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.1)
    raise AssertionError("job did not finish")


def _probe(data: bytes, tmp_path) -> dict:
    p = tmp_path / "x.flac"
    p.write_bytes(data)
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
                          "-of", "json", str(p)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def test_health_reports_stems(client):
    h = client.get("/api/health").json()
    assert h["ok"] and h["version"].startswith("2.")
    assert h["features"]["separation"] is True and h["features"]["stems"] is True


def test_separation_job_returns_two_aligned_stems(client, tmp_path):
    r = client.post("/api/jobs/separate", files={"file": ("tone.wav", _wav(5.0), "audio/wav")})
    assert r.status_code == 200, r.text
    j = _wait(client, r.json()["id"])
    assert j["status"] == "done", j
    assert j["stems"] == ["accomp", "vocals"] and j["progress"] == 1.0
    assert client.calls == [(2, 5 * SR)]
    for stem in ("vocals", "accomp"):
        res = client.get(f"/api/jobs/{j['id']}/audio", params={"stem": stem})
        assert res.status_code == 200 and res.headers["content-type"] == "audio/flac"
        info = _probe(res.content, tmp_path)
        s = info["streams"][0]
        assert (s["codec_name"], s["sample_rate"], s["channels"]) == ("flac", "22050", 1)
        assert abs(float(info["format"]["duration"]) - 5.0) < 0.01
    default = client.get(f"/api/jobs/{j['id']}/audio")
    assert default.status_code == 200
    assert default.content == client.get(f"/api/jobs/{j['id']}/audio", params={"stem": "accomp"}).content
    assert client.get(f"/api/jobs/{j['id']}/audio", params={"stem": "mix"}).status_code == 404
    assert client.get(f"/api/jobs/{j['id']}/audio", params={"stem": "drums"}).status_code == 400


def test_rejects_non_audio_and_unknown_jobs(client):
    r = client.post("/api/jobs/separate", files={"file": ("x.wav", b"not audio at all", "audio/wav")})
    assert r.status_code == 400
    assert client.get("/api/jobs/deadbeef").status_code == 404
    assert client.get("/api/jobs/deadbeef/audio").status_code == 404


def test_separation_disabled_without_model(monkeypatch):
    monkeypatch.setattr(separation, "available", lambda: False)
    c = TestClient(main.app)
    assert c.get("/api/health").json()["features"]["separation"] is False
    r = c.post("/api/jobs/separate", files={"file": ("tone.wav", _wav(1.0), "audio/wav")})
    assert r.status_code == 501


def test_model_hash_check(tmp_path):
    bad = tmp_path / "scnet.int8.onnx"
    bad.write_bytes(b"not the model")
    with pytest.raises(model.ModelError, match="SHA-256"):
        model.ensure(str(bad), allow_download=False)
    with pytest.raises(model.ModelError, match="not found"):
        model.ensure(str(tmp_path / "missing.onnx"), allow_download=False)


def test_auth_still_required_when_not_anonymous(client):
    import base64
    import hashlib
    import hmac

    from app.config import settings

    def b64(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    old = (settings.allow_anonymous, settings.shared_secret)
    object.__setattr__(settings, "allow_anonymous", False)
    object.__setattr__(settings, "shared_secret", "test-secret")
    try:
        assert client.get("/api/jobs/x").status_code == 401
        payload = b64(json.dumps({"exp": time.time() + 60, "nonce": "n"}).encode())
        sig = b64(hmac.new(b"test-secret", payload.encode(), hashlib.sha256).digest())
        assert client.get("/api/jobs/x", headers={"Authorization": f"Bearer {payload}.{sig}"}).status_code == 404
        assert client.get("/api/jobs/x", headers={"Authorization": f"Bearer {payload}.{sig[:-2]}AA"}).status_code == 401
    finally:
        object.__setattr__(settings, "allow_anonymous", old[0])
        object.__setattr__(settings, "shared_secret", old[1])


def test_youtube_job_with_separation_has_mix_and_stems(client, monkeypatch, tmp_path):
    from app import youtube

    def fake_download(url, out_dir, on_progress):
        on_progress(1.0)
        p = f"{out_dir}/source.wav"
        with open(p, "wb") as fh:
            fh.write(_wav(3.0))
        return {"path": p, "title": "Tone", "artist": "Test", "duration": 3.0}

    monkeypatch.setattr(youtube, "available", lambda: True)
    monkeypatch.setattr(youtube, "download_audio", fake_download)
    assert client.post("/api/jobs/youtube", json={"url": "https://example.com/watch?v=x"}).status_code == 400
    plain = _wait(client, client.post("/api/jobs/youtube", json={"url": "https://youtu.be/abc"}).json()["id"])
    assert plain["status"] == "done" and plain["stems"] == ["mix"]
    assert client.get(f"/api/jobs/{plain['id']}/audio").headers["content-type"] == "audio/mp4"
    j = _wait(client, client.post("/api/jobs/youtube", json={"url": "https://youtu.be/abc", "separate": True}).json()["id"])
    assert j["status"] == "done", j
    assert j["stems"] == ["accomp", "mix", "vocals"] and j["title"] == "Tone"
    assert client.get(f"/api/jobs/{j['id']}/audio", params={"stem": "mix"}).headers["content-type"] == "audio/mp4"
    assert client.get(f"/api/jobs/{j['id']}/audio").headers["content-type"] == "audio/flac"  # default = accomp

"""Compare the browser SCNet separation (tests/e2e/separation.mjs output) with the python reference
(numpy STFT + onnxruntime CPU, same segmenting), and the JS vocal-presence gate with this python port.

  python separation_compare.py SEP_OUT_DIR TAG MODEL.onnx SCNET_ORT_DIR      # excerpt run: SDR vs python on the same input
  python separation_compare.py --gate NPZ_OR_DIR...                          # python gate on python stems (full_sep .npz)
  python separation_compare.py --gate-js SEP_OUT_DIR TAG                     # python gate on the browser's own 22.05 kHz stems

SDR is computed on the 22.05 kHz mono outputs (the python stems go through the same half-band decimator).
"""
import sys, os, json, glob, numpy as np

K, BETA = 64, 8.6
def halfband():
    j = np.arange(-K, K + 1)
    sinc = np.where(j == 0, 0.5, np.sin(np.pi * j / 2) / (np.pi * np.where(j == 0, 1, j)))
    h = sinc * np.kaiser(2 * K + 1, BETA)
    return h / h.sum()

def decimate2(x):
    y = np.convolve(x, halfband(), mode='same')
    return y[: (len(x) // 2) * 2 : 2]

# mirror of PRESENCE in src/lib/separation/dsp.ts
P = dict(frame=0.1, rel_db=-10, abs_floor=0.00316, mix_floor=0.001, min_active=0.05)
def presence(v, m, sr):
    n = min(len(v), len(m)); hop = max(1, round(P['frame'] * sr)); cnt = max(1, n // hop)
    v = v[: cnt * hop].astype(np.float64) if n >= hop else v[:n].astype(np.float64)
    m = m[: cnt * hop].astype(np.float64) if n >= hop else m[:n].astype(np.float64)
    fv = (v.reshape(cnt, -1) ** 2).mean(1) ** 0.5; fm = (m.reshape(cnt, -1) ** 2).mean(1) ** 0.5
    ok = fm >= P['mix_floor']; act = ok & (fv >= fm * 10 ** (P['rel_db'] / 20)) & (fv >= P['abs_floor'])
    frac = act.sum() / max(1, ok.sum())
    return dict(activeFraction=float(frac), relDb=float(10 * np.log10(((v ** 2).sum() + 1e-20) / (m ** 2).sum())), present=bool(frac >= P['min_active']))

def sdr(ref, est):
    return float(10 * np.log10((ref ** 2).sum() / ((ref - est) ** 2).sum()))

f32 = lambda p: np.fromfile(p, dtype=np.float32)

if __name__ == '__main__':
    if sys.argv[1] == '--gate':
        files = [f for a in sys.argv[2:] for f in (sorted(glob.glob(a + '/*.npz')) if os.path.isdir(a) else [a])]
        for f in files:
            z = np.load(f); v, m = decimate2(z['vocals'].astype(np.float64)), decimate2(z['mix'].astype(np.float64))
            print(json.dumps({'song': os.path.basename(f)[:-4], 'seconds': round(len(z['mix']) / 44100, 1), **presence(v, m, 22050)}))
    elif sys.argv[1] == '--gate-js':
        d, tag = sys.argv[2:4]
        js = json.load(open(f'{d}/{tag}.json'))['vocalPresence']
        # the app gates on its own decimated mono mixture; the runner saves the browser 22.05 kHz decode, close enough here
        print(json.dumps({'tag': tag, 'js': js, 'python_on_js_stems': presence(f32(f'{d}/{tag}.vocals22.f32'), f32(f'{d}/{tag}.mix22.f32'), 22050)}))
    else:
        d, tag, onnx, ref_dir = sys.argv[1:5]
        sys.path.insert(0, ref_dir)
        import scnet_ort as S
        x = np.stack([f32(f'{d}/{tag}.input44.L.f32'), f32(f'{d}/{tag}.input44.R.f32')]).astype(np.float64)
        cache = f'{d}/{tag}.py_stems.npy'
        if os.path.exists(cache): est = np.load(cache)
        else:
            est, _ = S.separate(S.session(onnx), x, 0.9); np.save(cache, est.astype(np.float32))
        pv = decimate2(est[3].mean(0)); pa = decimate2((est[1] + est[2]).mean(0))
        jv, ja = f32(f'{d}/{tag}.vocals22.f32'), f32(f'{d}/{tag}.accomp22.f32')
        mix22 = decimate2(x.mean(0))
        js = json.load(open(f'{d}/{tag}.json'))
        print(json.dumps({'tag': tag, 'len': [len(pv), len(jv)], 'sdr_vocals_db': round(sdr(pv, jv), 1), 'sdr_accomp_db': round(sdr(pa, ja), 1),
                          'presence_js': js['vocalPresence'], 'presence_py_on_py_stems': presence(pv, mix22, 22050)}))

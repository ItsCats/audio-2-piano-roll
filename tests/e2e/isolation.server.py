"""Serve a production build like Netlify does, with the [[headers]] of netlify.toml.

    python3 tests/e2e/isolation.server.py DIST NETLIFY_TOML PORT

Netlify semantics reproduced (checked against the live site: a missing /assets/x.js that falls back
to index.html still gets the /assets/* Cache-Control, so rules match the *requested* path, and
different header names from several matching rules are merged):
  - existing files are served as-is; anything else is the SPA rewrite to /index.html (status 200);
  - every [[headers]] rule whose `for` matches the request path applies (`*` matches anything,
    including '/'; `:name` matches one non-empty path segment);
  - if two matching rules set the same header, both values are sent comma-joined (one possible
    Netlify behaviour, and the harmful one for COOP/COEP); the server logs it on stderr as
    "DUPLICATE" so tests/e2e/isolation.mjs fails on such a config.
Range requests are not supported (not needed by the app).
"""
import http.server
import os
import re
import sys
import tomllib

root, toml_path, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
conf = tomllib.load(open(toml_path, 'rb'))


def pattern(p: str) -> re.Pattern:
    out = ''
    for part in re.split(r'(\*|:[A-Za-z_][A-Za-z0-9_]*)', p):
        if part == '*':
            out += '.*'
        elif part.startswith(':') and len(part) > 1:
            out += '[^/]+'
        else:
            out += re.escape(part)
    return re.compile(f'^{out}$')


rules = [(pattern(h['for']), h['for'], h.get('values', {})) for h in conf.get('headers', [])]


def headers_for(path: str):
    merged: dict[str, tuple[str, list[str]]] = {}
    for rx, src, values in rules:
        if not rx.match(path):
            continue
        for k, v in values.items():
            key = k.lower()
            if key in merged:
                sys.stderr.write(f'DUPLICATE {k} for {path}: rules {merged[key][1]} + {src}\n')
                merged[key] = (merged[key][0] + ', ' + v, merged[key][1] + [src])
            else:
                merged[key] = (v, [src])
    return {k: v for k, (v, _) in merged.items()}


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.webmanifest': 'application/manifest+json'}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=root, **k)

    def end_headers(self):
        path = getattr(self, 'requested', self.path).split('?', 1)[0].split('#', 1)[0]
        for k, v in headers_for(path).items():
            self.send_header(k, v)
        super().end_headers()

    def send_head(self):
        # headers match the requested path; only the served file is rewritten (SPA fallback)
        self.requested = self.path
        if not os.path.isfile(self.translate_path(self.path)):
            self.path = '/index.html'
        return super().send_head()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()

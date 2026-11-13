"""Clean-room-ish re-implementation of the Sheet Music Transformer (SMT) inference path, written from the
reviewed upstream modeling_smt.py (MIT, Antonio Rios-Vila) so no downloaded code is executed.

Based on https://github.com/antoniorv6/SMT: Copyright (c) 2023 Antonio Rios-Vila. MIT License; the full
licence text and permission notice are in public/models/omr/LICENSE (a verbatim copy of the upstream file).

Adds a KV cache for the decoder (the upstream predict() recomputes the whole prefix every step).

Weights: model.safetensors + config.json from Hugging Face (PRAIG/smt-fp-grandstaff, antoniorv6/smt-grandstaff,
antoniorv6/smt-camera-grandstaff; MIT).
"""
import json
import math
from pathlib import Path

import torch
import torch.nn as nn
import torch.nn.functional as F
from safetensors.torch import load_file
from transformers import ConvNextConfig, ConvNextModel


def pe2d(dim, h_max, w_max):
    pe = torch.zeros((dim, h_max, w_max))
    div = torch.exp(-torch.arange(0., dim // 2, 2) / dim * torch.log(torch.tensor(1e+4))).unsqueeze(1)
    w_pos = torch.arange(0., w_max) * div
    h_pos = torch.arange(0., h_max) * div
    pe[:dim // 2:2] = torch.sin(h_pos).unsqueeze(2).repeat(1, 1, w_max)
    pe[1:dim // 2:2] = torch.cos(h_pos).unsqueeze(2).repeat(1, 1, w_max)
    pe[dim // 2::2] = torch.sin(w_pos).unsqueeze(1).repeat(1, h_max, 1)
    pe[dim // 2 + 1::2] = torch.cos(w_pos).unsqueeze(1).repeat(1, h_max, 1)
    return pe


def pe2d_dyn(dim, h, w, like):
    # same values as pe2d(dim, H, W)[:, :h, :w], computed in-graph (keeps ONNX small)
    div = torch.exp(-torch.arange(0, dim // 2, 2, dtype=torch.float32) / dim * math.log(1e4)).unsqueeze(1)  # [dim/4,1]
    hp = torch.arange(h, dtype=torch.float32).unsqueeze(0) * div  # [dim/4,h]
    wp = torch.arange(w, dtype=torch.float32).unsqueeze(0) * div  # [dim/4,w]
    q = dim // 4
    pe = torch.zeros(dim, h, w, dtype=like.dtype)
    hs = torch.stack([torch.sin(hp), torch.cos(hp)], 1).reshape(2 * q, h)  # interleave sin/cos rows
    ws = torch.stack([torch.sin(wp), torch.cos(wp)], 1).reshape(2 * q, w)
    top = hs.unsqueeze(2).expand(2 * q, h, w)
    bot = ws.unsqueeze(1).expand(2 * q, h, w)
    return torch.cat([top, bot], 0)


def pe1d(dim, len_max):
    pe = torch.zeros((len_max, dim))
    div = torch.exp(-torch.arange(0., dim, 2) / dim * torch.log(torch.tensor(1e+4)))
    l_pos = torch.arange(0., len_max).unsqueeze(1) * div
    pe[:, ::2] = torch.sin(l_pos)
    pe[:, 1::2] = torch.cos(l_pos)
    return pe


class MHA(nn.Module):
    def __init__(self, d, h, legacy=False):
        super().__init__()
        self.h, self.dh = h, d // h
        self.scale = 1.0 if legacy else self.dh ** -0.5  # the 2024 checkpoints were trained without scaling
        self.q_proj, self.k_proj, self.v_proj, self.out_proj = (nn.Linear(d, d) for _ in range(4))

    def split(self, x):
        b, n, _ = x.shape
        return x.view(b, n, self.h, self.dh).transpose(1, 2)

    def attend(self, q, k, v):
        o = F.scaled_dot_product_attention(q, k, v, scale=self.scale)
        b, h, n, dh = o.shape
        return self.out_proj(o.transpose(1, 2).reshape(b, n, h * dh))


class Layer(nn.Module):
    def __init__(self, d, h, ff, legacy=False):
        super().__init__()
        self.self_attn = MHA(d, h, legacy)
        self.cross_attn = MHA(d, h, legacy)
        self.ffn = nn.Sequential(nn.Linear(d, ff), nn.ReLU(), nn.Identity(), nn.Linear(ff, d))
        self.norm_layers = nn.ModuleList([nn.LayerNorm(d) for _ in range(3)])

    def step(self, x, cache, ck, cv):
        sa = self.self_attn
        q, k, v = sa.split(sa.q_proj(x)), sa.split(sa.k_proj(x)), sa.split(sa.v_proj(x))
        if cache is not None:
            k = torch.cat([cache[0], k], 2)
            v = torch.cat([cache[1], v], 2)
        x = self.norm_layers[0](x + sa.attend(q, k, v))
        ca = self.cross_attn
        x = self.norm_layers[1](x + ca.attend(ca.split(ca.q_proj(x)), ck, cv))
        x = self.norm_layers[2](x + self.ffn(x))
        return x, (k, v)


class SMT(nn.Module):
    def __init__(self, cfg, legacy=False):
        super().__init__()
        self.cfg = cfg
        self.legacy = legacy
        d = cfg['d_model']
        self.encoder = ConvNextModel(ConvNextConfig(num_channels=cfg['in_channels'], num_stages=3,
                                                    hidden_sizes=[64, 128, 256], depths=[3, 3, 9]))
        self.layers = nn.ModuleList([Layer(d, cfg['num_attn_heads'], cfg['dim_ff'], legacy) for _ in range(cfg['num_dec_layers'])])
        self.embedding = nn.Embedding(cfg['out_categories'], d)
        self.vocab_projection = nn.Linear(d, cfg['out_categories'])
        self.register_buffer('pe1', pe1d(d, cfg['maxlen']), persistent=False)
        self.i2w = {int(k): v for k, v in cfg['i2w'].items()}
        self.w2i = cfg['w2i']

    @classmethod
    def load(cls, model_dir):
        cfg = json.loads((Path(model_dir) / 'config.json').read_text())
        sd = load_file(str(Path(model_dir) / 'model.safetensors'))
        legacy = 'decoder.out_layer.weight' in sd
        m = cls(cfg, legacy)
        new = {}
        for k, v in sd.items():
            if legacy:
                k = k.replace('input_attention.', 'self_attn.').replace('cross_attention.', 'cross_attn.') \
                     .replace('.lq.', '.q_proj.').replace('.lk.', '.k_proj.').replace('.lv.', '.v_proj.') \
                     .replace('.ffNet.', '.ffn.').replace('.norm1.', '.norm_layers.0.').replace('.norm2.', '.norm_layers.1.') \
                     .replace('.norm3.', '.norm_layers.2.').replace('decoder.out_layer.', 'decoder.vocab_projection.')
                if k == 'decoder.vocab_projection.weight':
                    v = v[:, :, 0]
            k2 = k.replace('decoder.decoder.layers.', 'layers.').replace('decoder.embedding.', 'embedding.') \
                  .replace('decoder.vocab_projection.', 'vocab_projection.')
            new[k2] = v
        missing, unexpected = m.load_state_dict(new, strict=False)
        missing = [k for k in missing if not k.startswith('pe')]
        assert not missing and not unexpected, (missing, unexpected)
        return m.eval()

    def encode(self, x):
        f = self.encoder(pixel_values=x).last_hidden_state  # B,256,H/16,W/16
        h, w = f.shape[-2:]
        f2 = f + pe2d_dyn(f.shape[1], h, w, f)
        raw = f.flatten(2).permute(0, 2, 1)
        pos = f2.flatten(2).permute(0, 2, 1)
        cross = []
        for L in self.layers:
            ca = L.cross_attn
            cross.append((ca.split(ca.k_proj(pos)), ca.split(ca.v_proj(raw))))
        return cross

    @torch.no_grad()
    def predict(self, x, max_len=None):
        cross = self.encode(x)
        max_len = max_len or self.cfg['maxlen'] - 1
        tok = self.w2i['<bos>']
        eos = self.w2i['<eos>']
        caches = [None] * len(self.layers)
        out = []
        for i in range(max_len):
            h = self.embedding(torch.tensor([[tok]])) + self.pe1[i:i + 1]
            for j, L in enumerate(self.layers):
                h, caches[j] = L.step(h, caches[j], *cross[j])
            hh = torch.relu(h[:, -1]) if self.legacy else h[:, -1]
            tok = int(self.vocab_projection(hh).argmax(-1))
            if tok == eos:
                break
            out.append(self.i2w[tok])
        return out

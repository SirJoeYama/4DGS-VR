"""Minimal stand-in for mmcv 1.x: only Config.fromfile, which is all 4DGaussians uses.

Supports python config files with an optional `_base_` (str or list, relative to the file),
where dict values are merged recursively over the base, like mmcv does.
"""
import os
import runpy


def _merge(base, override):
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


class Config(dict):
    @staticmethod
    def fromfile(path):
        path = os.path.abspath(path)
        ns = {k: v for k, v in runpy.run_path(path).items() if not k.startswith("__")}
        bases = ns.pop("_base_", [])
        if isinstance(bases, str):
            bases = [bases]
        merged = {}
        for b in bases:
            merged = _merge(merged, Config.fromfile(os.path.join(os.path.dirname(path), b)))
        return Config(_merge(merged, ns))

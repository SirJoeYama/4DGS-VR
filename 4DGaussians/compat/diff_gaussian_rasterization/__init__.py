"""Drop-in replacement for (depth-)diff-gaussian-rasterization backed by gsplat.

Keeps the Inria API that 4DGaussians calls, so no CUDA toolkit / compiler is needed.
Returns (image [3,H,W], radii [N], depth [1,H,W]) like the depth fork.
"""
from typing import NamedTuple

import torch
from gsplat import rasterization


class GaussianRasterizationSettings(NamedTuple):
    image_height: int
    image_width: int
    tanfovx: float
    tanfovy: float
    bg: torch.Tensor
    scale_modifier: float
    viewmatrix: torch.Tensor
    projmatrix: torch.Tensor
    sh_degree: int
    campos: torch.Tensor
    prefiltered: bool
    debug: bool = False


class GaussianRasterizer(torch.nn.Module):
    def __init__(self, raster_settings):
        super().__init__()
        self.raster_settings = raster_settings

    def forward(self, means3D, means2D, opacities, shs=None, colors_precomp=None,
                scales=None, rotations=None, cov3D_precomp=None):
        s = self.raster_settings
        W, H = int(s.image_width), int(s.image_height)
        dev = means3D.device
        # Inria matrices are stored transposed (row-vector convention).
        viewmat = s.viewmatrix.to(dev).T.contiguous()[None]
        fx = W / (2.0 * s.tanfovx)
        fy = H / (2.0 * s.tanfovy)
        K = torch.tensor([[fx, 0, W / 2.0], [0, fy, H / 2.0], [0, 0, 1]], device=dev)[None]

        if colors_precomp is not None:
            colors, sh_degree = colors_precomp, None
        else:
            colors, sh_degree = shs, s.sh_degree

        kwargs = {}
        if cov3D_precomp is not None:
            kwargs["covars"] = cov3D_precomp
            quats = scl = None
        else:
            quats = rotations
            scl = scales * s.scale_modifier

        rgbd, alpha, info = rasterization(
            means3D, quats, scl, opacities.reshape(-1), colors, viewmat, K, W, H,
            sh_degree=sh_degree, packed=False, render_mode="RGB+ED", **kwargs)

        rgb = rgbd[0, ..., :3] + (1.0 - alpha[0]) * s.bg.to(dev)[:3]
        depth = rgbd[0, ..., 3:4]

        radii = info["radii"][0]
        if radii.dim() == 2:  # gsplat >= 1.5 returns per-axis radii
            radii = radii.max(dim=-1).values

        m2d = info["means2d"]
        if means2D is not None and m2d.requires_grad:
            scale = torch.tensor([W * 0.5, H * 0.5], device=dev)

            def _to_viewspace(g):
                # Inria's means2D gradient is w.r.t. NDC; gsplat's is in pixels.
                grad = torch.zeros_like(means2D)
                grad[:, :2] = g[0] * scale
                means2D.grad = grad if means2D.grad is None else means2D.grad + grad

            m2d.register_hook(_to_viewspace)

        return rgb.permute(2, 0, 1), radii, depth.permute(2, 0, 1)

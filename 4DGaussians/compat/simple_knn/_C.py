"""Drop-in for simple_knn._C.distCUDA2: mean squared distance to the 3 nearest neighbours."""
import torch


def distCUDA2(points, chunk=4096):
    pts = points.float().cuda()
    out = torch.empty(pts.shape[0], device=pts.device)
    for i in range(0, pts.shape[0], chunk):
        d2 = torch.cdist(pts[i:i + chunk], pts).square_()
        # k=4 includes the point itself (distance 0)
        out[i:i + chunk] = d2.topk(min(4, pts.shape[0]), largest=False).values[:, 1:].mean(1)
    return out

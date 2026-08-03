#!/usr/bin/env python3
"""FINAL sky -> all-topic-scores model (operator 2026-07-20):

    y_j(t) = sum_i  a_ij * exp( -wrap(theta_i(t) - p_j)^2 )  +  b_j

  a_ij >= 0 (NNLS constraint via softplus) — per-topic body weights, free parameters
  p_j        per-topic phase (2-vector -> atan2, seam-free)
  b_j        per-topic bias
  ALL parameters optimized jointly by gradient descent (Adam, full batch) on the raw series.
  NO validation set — the final model fits ALL 210 months; the metric is R².

Given only the astro inputs (the 12 body angles theta(t), from the ephemeris), the model emits the
search score of all 3,021 topics at that time together. Fitted parameters are saved to
analysis/adstopics/astro_forward_final.npz (a, p, b, per-topic R², topic names).

Legacy modes kept for comparison: softmax | pos (attention-computed a_ij, see WORKING.md 2026-07-20).

  python3 analysis/adstopics/astro_forward.py [free|softmax|pos]
"""
import importlib.util as u, os, sys
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(REPO)
def _load(p, n):
    s = u.spec_from_file_location(n, p); m = u.module_from_spec(s); s.loader.exec_module(m); return m
rc = _load("analysis/adstopics/ratechange.py", "rc")
sf = _load("analysis/adstopics/svm_furnace.py", "sf")


def r2_rows(Y, Yh):
    res = ((Y - Yh) ** 2).sum(1)
    tot = ((Y - Y.mean(1, keepdims=True)) ** 2).sum(1) + 1e-9
    return 1.0 - res / tot


def r2_xsec(Y, Yh):
    res = ((Y - Yh) ** 2).sum(0)
    tot = ((Y - Y.mean(0, keepdims=True)) ** 2).sum(0) + 1e-9
    return 1.0 - res / tot


def phase_init(Y, TH):
    """Coarse 5° grid: per-topic phase maximizing correlation under uniform weights."""
    P = 72; phases = np.deg2rad(np.arange(P) * 5.0)
    d = TH[:, None, :] - phases[None, :, None]
    GU = np.exp(-(np.arctan2(np.sin(d), np.cos(d)) ** 2)).mean(2).T
    GUc = GU - GU.mean(1, keepdims=True)
    Yc = Y - Y.mean(1, keepdims=True)
    score = (Yc @ GUc.T) / (np.linalg.norm(GUc, axis=1)[None] + 1e-9)
    return phases[score.argmax(1)]


def fit(Y, TH, mode="free", seed=7, dq=16, steps=12000, lr=2e-2, device="cpu"):
    import torch as T
    T.manual_seed(seed); rng = np.random.RandomState(seed); Tn, n = Y.shape
    p0 = phase_init(Y, TH)
    U = T.tensor(np.stack([np.sin(p0), np.cos(p0)], 1), dtype=T.float32, device=device, requires_grad=True)
    Bp = T.tensor(Y.mean(1), dtype=T.float32, device=device, requires_grad=True)
    params = [U, Bp]
    if mode == "free":
        Araw = T.full((Tn, 12), -2.0, device=device, requires_grad=True)   # softplus(-2)≈0.13 start
        params.append(Araw)
    else:
        Q = T.tensor(rng.randn(Tn, dq) * 0.05, dtype=T.float32, device=device, requires_grad=True)
        K = T.tensor(rng.randn(12, dq) * 0.05, dtype=T.float32, device=device, requires_grad=True)
        s_raw = T.tensor(5.0, device=device, requires_grad=True)
        params += [Q, K, s_raw]
    THd = T.tensor(TH.T, dtype=T.float32, device=device)
    Yt = T.tensor(Y, dtype=T.float32, device=device)
    opt = T.optim.Adam(params, lr=lr)

    def forward():
        p = T.atan2(U[:, 0], U[:, 1])
        dphi = THd[None] - p[:, None, None]
        g = T.exp(-(T.atan2(T.sin(dphi), T.cos(dphi)) ** 2))               # (Tn,12,n)
        if mode == "free":
            A = T.nn.functional.softplus(Araw)                             # a_ij >= 0 (NNLS)
            return (A[:, :, None] * g).sum(1) + Bp[:, None], A, p
        sc = Q @ K.T / dq ** 0.5
        A = T.softmax(sc, 1) if mode == "softmax" else T.nn.functional.softplus(sc)
        amp = T.nn.functional.softplus(s_raw) if mode == "softmax" else 1.0
        return amp * (A[:, :, None] * g).sum(1) + Bp[:, None], A, p

    best, stall, state = np.inf, 0, None
    for it in range(steps):
        yh, _, _ = forward()
        loss = ((yh - Yt) ** 2).mean()
        opt.zero_grad(); loss.backward(); opt.step()
        if it % 200 == 199:
            l = loss.item()
            if l < best - 1e-7: best, stall, state = l, 0, [x.detach().clone() for x in params]
            else:
                stall += 1
                if stall >= 10: break
    with T.no_grad():
        for x, sv in zip(params, state): x.copy_(sv)
        Yh, A, p = forward()
    return Yh.cpu().numpy(), A.cpu().numpy(), p.cpu().numpy(), Bp.detach().cpu().numpy()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "free"
    dev = "cpu"
    try:
        import torch as T
        if T.backends.mps.is_available(): dev = "mps"
    except Exception: pass
    names, Y = rc.bal.load_all(); b = rc.BenchR(Y); Y = Y.astype(np.float64)
    Tn, n = Y.shape; TH = sf.sky12(n)
    print(f"  FINAL model [{mode}] · y_j(t)=Σ_i a_ij·exp(-wrap(θ_i(t)-p_j)²)+b_j · a>=0 · "
          f"all params by gradient descent · fit on ALL {n} months · dev {dev}", flush=True)
    Yh, A, p, bias = fit(Y, TH, mode=mode, device=dev)
    pt = r2_rows(Y, Yh); xs = r2_xsec(Y, Yh)
    print(f"    R² per-topic mean {pt.mean():+.4f} · median {np.median(pt):+.4f} · "
          f"xsec/month mean {xs.mean():+.4f} · topics R²>0: {(pt > 0).mean()*100:.1f}%", flush=True)
    mass = A.mean(0); topm = sorted(zip(sf.BODIES, mass), key=lambda x: -x[1])
    print(f"    body weight mass: {', '.join(f'{k} {v:.3f}' for k, v in topm[:6])}", flush=True)
    hist = np.bincount(((np.rad2deg(p) % 360) // 30).astype(int), minlength=12)
    print("    phases by sign: " + " ".join(f"{sf.SIGNS[i][:3]} {hist[i]}" for i in range(12)), flush=True)
    if mode == "free":
        out = "analysis/adstopics/astro_forward_final.npz"
        np.savez_compressed(out, a=A.astype(np.float32), p=p.astype(np.float32),
                            b=bias.astype(np.float32), r2=pt.astype(np.float32),
                            bodies=np.array(sf.BODIES), names=np.array(names))
        print(f"    saved -> {out}", flush=True)


if __name__ == "__main__":
    main()

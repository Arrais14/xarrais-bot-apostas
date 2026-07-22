#!/usr/bin/env python3
# ===== Backtest histórico do modelo Xarrais — independente da app web (Vite/TS) =====
# As fórmulas aqui (no-vig MPTO, blend forma+mercado, Kelly fracionário) são uma tradução
# 1:1 das de src/quant.ts — qualquer alteração num dos dois lados tem de ser replicada no
# outro, senão o backtest deixa de validar o que a app realmente decide ao vivo.
#
# Dependências: pip install pandas numpy matplotlib
# Opcional (se já tiveres um model.onnx treinado, o mesmo usado por src/api.ts): pip install onnxruntime
#
# Uso:
#   python backtest.py --csv historico.csv
#   python backtest.py --csv historico.csv --kelly-frac 0.25 --ev-min 0.08 --bankroll 1000
#
# Esquema esperado do CSV (colunas mínimas):
#   date, league, home_team, away_team, result        (result: "H" | "D" | "A")
#   odds_home, odds_draw, odds_away                    (odds a que terias efetivamente apostado)
#   pinn_home, pinn_draw, pinn_away                    (odds de FECHO da Pinnacle — referência sharp)
# Colunas opcionais (ativam a heurística forma+mercado; sem elas cai-se para no-vig puro da Pinnacle,
# exatamente como modelProbs() em quant.ts faz quando não há pontos/forma disponíveis):
#   home_ppg, away_ppg                                 (pontos por jogo, 0-3)
#   home_form_pts, away_form_pts                        (pontos de forma normalizados, 0-1 — ver form_points())

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

# ===== Constantes — espelham src/config.ts; mantém os dois ficheiros em sincronia =====
EV_MIN_DEFAULT = 0.08
KELLY_FRAC_DEFAULT = 0.25
STAKE_CAP_FRAC_DEFAULT = 0.05
MIN_ODD = 1.30


# ===== No-vig: Margin Proportional to Odds (normalização multiplicativa) =====
# Idêntico a noVig() em src/quant.ts — não alterar sem alterar os dois lados.
def no_vig(o_h: float, o_d: float, o_a: float) -> tuple[float, float, float]:
    s = 1 / o_h + 1 / o_d + 1 / o_a
    return (1 / o_h) / s, (1 / o_d) / s, (1 / o_a) / s


# ===== Modelo forma+mercado: idêntico a modelProbs() em src/quant.ts =====
# nv = no-vig da odd de referência (aqui: Pinnacle de fecho, a "sharp" do sistema);
# quando não há pontos/forma disponíveis, devolve-se o no-vig puro (heur=False), tal como no TS.
def model_probs(
    nv_h: float, nv_d: float, nv_a: float,
    home_ppg: float | None, away_ppg: float | None,
    home_form: float | None, away_form: float | None,
) -> tuple[dict[str, float], bool]:
    if home_ppg is None or away_ppg is None or home_form is None or away_form is None:
        return {"h": nv_h, "d": nv_d, "a": nv_a}, False

    sH = 0.55 * home_ppg + 0.45 * home_form + 0.12   # vantagem casa
    sA = 0.55 * away_ppg + 0.45 * away_form
    k = 4
    eh, ea = math.exp(k * sH), math.exp(k * sA)
    diff = abs(sH - sA)
    pd_ = min(0.32, max(0.15, 0.30 - 0.5 * diff))
    ph = (1 - pd_) * eh / (eh + ea)
    pa = (1 - pd_) - ph

    w = 0.35
    ph_blend = (1 - w) * nv_h + w * ph
    pd_blend = (1 - w) * nv_d + w * pd_
    pa_blend = (1 - w) * nv_a + w * pa
    s = ph_blend + pd_blend + pa_blend
    return {"h": ph_blend / s, "d": pd_blend / s, "a": pa_blend / s}, True


# ppg a partir de pontos por jogo já vem pronto no CSV (home_ppg/away_ppg); se só tiveres o
# registo V-E-D bruto, converte com esta função antes de gerar o CSV (mesma fórmula do ppg() em
# quant.ts: (3*V + E) / (3*jogos)).
def ppg_from_record(wins: int, draws: int, losses: int) -> float | None:
    n = wins + draws + losses
    if n == 0:
        return None
    return (3 * wins + draws) / (3 * n)


# fpts a partir de string de forma "WWLWD" (mesma fórmula do fpts() em quant.ts).
def form_points(form: str | None) -> float | None:
    if not form:
        return None
    m = {"W": 3, "D": 1, "L": 0}
    pts = [m[c] for c in form if c in m]
    if not pts:
        return None
    return sum(pts) / (3 * len(pts))


# ===== Kelly Criterion fracionário — idêntico a computeStake() em src/quant.ts =====
def kelly_stake_frac(p: float, odd: float, kelly_frac: float, stake_cap: float) -> float:
    b = odd - 1
    if b <= 0:
        return 0.0
    kf = (b * p - (1 - p)) / b
    return min(max(kf, 0.0) * kelly_frac, stake_cap)


@dataclass
class BacktestResult:
    dates: list = field(default_factory=list)
    bankroll_curve: list = field(default_factory=list)
    n_bets: int = 0
    n_wins: int = 0
    total_staked: float = 0.0
    total_profit: float = 0.0

    @property
    def roi(self) -> float:
        return self.total_profit / self.total_staked if self.total_staked else 0.0

    @property
    def hit_rate(self) -> float:
        return self.n_wins / self.n_bets if self.n_bets else 0.0

    @property
    def max_drawdown(self) -> float:
        if not self.bankroll_curve:
            return 0.0
        peak = self.bankroll_curve[0]
        max_dd = 0.0
        for v in self.bankroll_curve:
            peak = max(peak, v)
            max_dd = max(max_dd, (peak - v) / peak if peak > 0 else 0.0)
        return max_dd


def run_backtest(df: pd.DataFrame, ev_min: float, kelly_frac: float, stake_cap: float, bankroll0: float) -> BacktestResult:
    df = df.sort_values("date").reset_index(drop=True)
    bankroll = bankroll0
    res = BacktestResult()

    for _, row in df.iterrows():
        try:
            nv_h, nv_d, nv_a = no_vig(row["pinn_home"], row["pinn_draw"], row["pinn_away"])
        except (KeyError, ZeroDivisionError, ValueError):
            continue

        home_ppg = row.get("home_ppg")
        away_ppg = row.get("away_ppg")
        home_form = row.get("home_form_pts")
        away_form = row.get("away_form_pts")
        home_ppg = None if pd.isna(home_ppg) else home_ppg
        away_ppg = None if pd.isna(away_ppg) else away_ppg
        home_form = None if pd.isna(home_form) else home_form
        away_form = None if pd.isna(away_form) else away_form

        p, _heur = model_probs(nv_h, nv_d, nv_a, home_ppg, away_ppg, home_form, away_form)

        candidates = [
            ("H", p["h"], row["odds_home"]),
            ("D", p["d"], row["odds_draw"]),
            ("A", p["a"], row["odds_away"]),
        ]
        best = None
        best_ev = -1.0
        for key, prob, odd in candidates:
            if not odd or odd < MIN_ODD:
                continue
            ev = prob * odd - 1
            if ev > best_ev:
                best, best_ev = (key, prob, odd), ev

        if best is None or best_ev < ev_min:
            continue

        key, prob, odd = best
        frac = kelly_stake_frac(prob, odd, kelly_frac, stake_cap)
        if frac <= 0:
            continue
        stake = frac * bankroll
        won = row["result"] == key
        bankroll += stake * (odd - 1) if won else -stake

        res.n_bets += 1
        res.n_wins += 1 if won else 0
        res.total_staked += stake
        res.total_profit += stake * (odd - 1) if won else -stake
        res.dates.append(row["date"])
        res.bankroll_curve.append(bankroll)

    return res


def plot_bankroll(res: BacktestResult, bankroll0: float, output_path: str) -> None:
    plt.figure(figsize=(10, 5))
    plt.plot([bankroll0] + res.bankroll_curve, linewidth=1.5, color="#d4af37")
    plt.axhline(bankroll0, color="#888", linestyle="--", linewidth=0.8, label="Banca inicial")
    plt.title("Evolução da banca — backtest Xarrais")
    plt.xlabel("Aposta nº")
    plt.ylabel("Banca")
    plt.legend()
    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    print(f"Gráfico guardado em {output_path}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Backtest histórico do modelo Xarrais (Kelly fracionário, no-vig Pinnacle).")
    ap.add_argument("--csv", required=True, help="CSV histórico (ver esquema de colunas no topo deste ficheiro).")
    ap.add_argument("--model", default=None, help="Caminho para model.onnx (opcional — se omitido, usa a heurística forma+mercado).")
    ap.add_argument("--ev-min", type=float, default=EV_MIN_DEFAULT, help=f"EV mínimo para apostar (default {EV_MIN_DEFAULT}).")
    ap.add_argument("--kelly-frac", type=float, default=KELLY_FRAC_DEFAULT, help=f"Fração de Kelly (default {KELLY_FRAC_DEFAULT} = 1/4).")
    ap.add_argument("--stake-cap", type=float, default=STAKE_CAP_FRAC_DEFAULT, help=f"Teto de stake por aposta, fração da banca (default {STAKE_CAP_FRAC_DEFAULT}).")
    ap.add_argument("--bankroll", type=float, default=1000.0, help="Banca inicial (default 1000).")
    ap.add_argument("--output", default="bankroll_evolution.png", help="Ficheiro do gráfico de evolução da banca.")
    args = ap.parse_args()

    df = pd.read_csv(args.csv, parse_dates=["date"])
    required = {"date", "home_team", "away_team", "result", "odds_home", "odds_draw", "odds_away", "pinn_home", "pinn_draw", "pinn_away"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"CSV sem colunas obrigatórias: {sorted(missing)}")

    ort_session = None
    if args.model:
        try:
            import onnxruntime as ort
            ort_session = ort.InferenceSession(args.model)
            print(f"Modelo ONNX carregado de {args.model} (nota: este backtest ainda usa a heurística "
                  "forma+mercado para o blend — liga aqui a tua própria chamada a ort_session.run(...) "
                  "com o mesmo vetor de features de src/api.ts:runMLInference antes de correr em produção).")
        except Exception as e:
            print(f"Aviso: não consegui carregar {args.model} ({e}) — a usar a heurística forma+mercado.")

    res = run_backtest(df, args.ev_min, args.kelly_frac, args.stake_cap, args.bankroll)

    print("\n===== Resultado do backtest =====")
    print(f"Apostas colocadas : {res.n_bets}")
    print(f"Taxa de acerto    : {100 * res.hit_rate:.1f}%")
    print(f"Total apostado    : {res.total_staked:.2f}")
    print(f"Lucro/Prejuízo    : {res.total_profit:+.2f}")
    print(f"Yield (ROI)       : {100 * res.roi:+.1f}%")
    print(f"Banca final       : {(args.bankroll + res.total_profit):.2f} (inicial {args.bankroll:.2f})")
    print(f"Max drawdown      : {100 * res.max_drawdown:.1f}%")

    if res.bankroll_curve:
        plot_bankroll(res, args.bankroll, args.output)
    else:
        print("Nenhuma aposta qualificada — sem gráfico para gerar.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# ===== Backtest histórico do modelo Praxis — independente da app web (Vite/TS) =====
# As fórmulas aqui (no-vig MPTO, Kelly fracionário) são uma tradução 1:1 das de src/quant.ts —
# qualquer alteração num dos dois lados tem de ser replicada no outro, senão o backtest deixa de
# validar o que a app realmente decide ao vivo. A app confia 100% no no-vig da Pinnacle (sem
# heurística forma/PPG — removida a pedido: o mercado já é eficiente o suficiente). O modelo
# Poisson bottom-up abaixo (--model poisson) é só uma exploração alternativa, não usada pela app.
#
# Dependências: pip install pandas numpy matplotlib
#
# Uso:
#   python backtest.py --csv historico.csv
#   python backtest.py --csv historico.csv --kelly-frac 0.25 --ev-min 0.08 --bankroll 1000
#   python backtest.py --csv historico_poisson.csv --model poisson
#
# Esquema esperado do CSV (colunas mínimas):
#   date, league, home_team, away_team, result        (result: "H" | "D" | "A")
#   odds_home, odds_draw, odds_away                    (odds a que terias efetivamente apostado)
#   pinn_home, pinn_draw, pinn_away                    (odds de FECHO da Pinnacle — referência sharp)
# Colunas adicionais obrigatórias só com --model poisson (ver poisson_1x2()):
#   home_goals_for_avg, home_goals_against_avg         (média de golos marcados/sofridos, casa)
#   away_goals_for_avg, away_goals_against_avg         (média de golos marcados/sofridos, fora)
#   league_avg_home_goals, league_avg_away_goals       (média da liga, golos marcados em casa/fora)

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


# ===== Modelo Poisson bottom-up (attack/defense strength) — exploração alternativa, à parte =====
# Deriva a força ofensiva/defensiva de cada equipa relativa à média da liga (o mesmo princípio
# usado pela indústria para golos esperados/xG), calcula os golos esperados (lambda) de cada
# equipa, e soma a matriz de Poisson para as probabilidades 1X2. Ao contrário do no-vig da
# Pinnacle, não depende de nenhuma odd de mercado — só de médias de golos marcados/sofridos.
def poisson_p(lam: float, k: int) -> float:
    return (lam ** k) * math.exp(-lam) / math.factorial(k)


def poisson_1x2(
    home_gf: float, home_ga: float, away_gf: float, away_ga: float,
    league_avg_home_goals: float, league_avg_away_goals: float,
    max_goals: int = 10,
) -> dict[str, float]:
    home_attack = home_gf / league_avg_home_goals
    home_defense = home_ga / league_avg_away_goals
    away_attack = away_gf / league_avg_away_goals
    away_defense = away_ga / league_avg_home_goals

    lambda_home = home_attack * away_defense * league_avg_home_goals
    lambda_away = away_attack * home_defense * league_avg_away_goals

    p_home = p_draw = p_away = 0.0
    for i in range(max_goals + 1):
        pi = poisson_p(lambda_home, i)
        for j in range(max_goals + 1):
            pij = pi * poisson_p(lambda_away, j)
            if i > j:
                p_home += pij
            elif i == j:
                p_draw += pij
            else:
                p_away += pij
    total = p_home + p_draw + p_away   # a cauda > max_goals é residual — normaliza para somar 1
    return {"h": p_home / total, "d": p_draw / total, "a": p_away / total}


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


def run_backtest(df: pd.DataFrame, ev_min: float, kelly_frac: float, stake_cap: float, bankroll0: float, model: str = "pinnacle") -> BacktestResult:
    df = df.sort_values("date").reset_index(drop=True)
    bankroll = bankroll0
    res = BacktestResult()

    for _, row in df.iterrows():
        try:
            nv_h, nv_d, nv_a = no_vig(row["pinn_home"], row["pinn_draw"], row["pinn_away"])
        except (KeyError, ZeroDivisionError, ValueError):
            continue

        if model == "poisson":
            try:
                p = poisson_1x2(
                    row["home_goals_for_avg"], row["home_goals_against_avg"],
                    row["away_goals_for_avg"], row["away_goals_against_avg"],
                    row["league_avg_home_goals"], row["league_avg_away_goals"],
                )
            except (KeyError, ZeroDivisionError, ValueError):
                continue
        else:
            p = {"h": nv_h, "d": nv_d, "a": nv_a}

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
    plt.title("Evolução da banca — backtest Praxis")
    plt.xlabel("Aposta nº")
    plt.ylabel("Banca")
    plt.legend()
    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    print(f"Gráfico guardado em {output_path}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Backtest histórico do modelo Praxis (Kelly fracionário, no-vig Pinnacle).")
    ap.add_argument("--csv", required=True, help="CSV histórico (ver esquema de colunas no topo deste ficheiro).")
    ap.add_argument("--model", choices=["pinnacle", "poisson"], default="pinnacle",
                    help="'pinnacle' (default) = no-vig da Pinnacle, igual à app ao vivo. "
                         "'poisson' = modelo bottom-up alternativo por médias de golos (ver poisson_1x2()), exige colunas extra no CSV.")
    ap.add_argument("--ev-min", type=float, default=EV_MIN_DEFAULT, help=f"EV mínimo para apostar (default {EV_MIN_DEFAULT}).")
    ap.add_argument("--kelly-frac", type=float, default=KELLY_FRAC_DEFAULT, help=f"Fração de Kelly (default {KELLY_FRAC_DEFAULT} = 1/4).")
    ap.add_argument("--stake-cap", type=float, default=STAKE_CAP_FRAC_DEFAULT, help=f"Teto de stake por aposta, fração da banca (default {STAKE_CAP_FRAC_DEFAULT}).")
    ap.add_argument("--bankroll", type=float, default=1000.0, help="Banca inicial (default 1000).")
    ap.add_argument("--output", default="bankroll_evolution.png", help="Ficheiro do gráfico de evolução da banca.")
    args = ap.parse_args()

    df = pd.read_csv(args.csv, parse_dates=["date"])
    required = {"date", "home_team", "away_team", "result", "odds_home", "odds_draw", "odds_away", "pinn_home", "pinn_draw", "pinn_away"}
    if args.model == "poisson":
        required |= {"home_goals_for_avg", "home_goals_against_avg", "away_goals_for_avg", "away_goals_against_avg", "league_avg_home_goals", "league_avg_away_goals"}
    missing = required - set(df.columns)
    if missing:
        raise SystemExit(f"CSV sem colunas obrigatórias para --model {args.model}: {sorted(missing)}")

    res = run_backtest(df, args.ev_min, args.kelly_frac, args.stake_cap, args.bankroll, model=args.model)

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

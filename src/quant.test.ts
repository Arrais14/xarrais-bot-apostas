// ===== Testes unitários do motor quantitativo (src/quant.ts) =====
// Cada caso tem o cálculo manual no comentário, para servir de documentação viva das fórmulas —
// se uma fórmula em quant.ts mudar sem ser de propósito, estes números fixos apanham a regressão.

import { describe, expect, it } from "vitest";
import {
  applyCalib, autoDecide, calibInfo, calibration, computeStake, lineMovement,
  modelProbs, noVig, stopLossStatus
} from "./quant";
import { EV_MIN_ALT_SHARP, EV_MIN_ALT_SHARP_FRIENDLY, EV_MIN_SHARP, EV_MIN_SHARP_FRIENDLY } from "./config";
import type { Bet, CalibInfo, DecisionContext, Game, StakeContext } from "./types";

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "g1", lg: "Liga Teste", d: "2026-01-01T20:00Z",
    h: { n: "Casa", f: "", r: "0-0-0", s: null },
    a: { n: "Fora", f: "", r: "0-0-0", s: null },
    o: { h: 2.0, d: 3.5, a: 3.8 },
    dt: new Date("2026-01-01T20:00Z"),
    ...overrides
  };
}

function makeBet(overrides: Partial<Bet> = {}): Bet {
  return {
    id: "b1", gameId: "g1", selKey: "1", sel: "1", game: "Casa vs Fora",
    odd: 2.0, stake: 10, status: "win", prob: 0.5, loggedAt: "2026-01-01T00:00Z",
    ...overrides
  };
}

const noRisk: StakeContext = { bank: 1000, kellyFrac: 0.25, pendingStake: 0, riskMult: 1 };
const noCalib: CalibInfo = { active: false, bias: 0, n: 0 };

describe("noVig — Margin Proportional to Odds (normalização multiplicativa)", () => {
  it("odds sem margem (soma das probabilidades implícitas = 1) devolvem as próprias probabilidades implícitas", () => {
    // h=d=a=3.0 -> 1/3 cada, soma=1, margem=0
    const r = noVig({ h: 3, d: 3, a: 3 });
    expect(r).not.toBeNull();
    expect(r!.h).toBeCloseTo(1 / 3, 10);
    expect(r!.d).toBeCloseTo(1 / 3, 10);
    expect(r!.a).toBeCloseTo(1 / 3, 10);
    expect(r!.margin).toBeCloseTo(0, 10);
  });

  it("odds com margem: h=2.00 d=3.00 a=4.00 -> soma implícita 13/12, margem 1/12 (~8.33%)", () => {
    // 1/2 + 1/3 + 1/4 = 6/12 + 4/12 + 3/12 = 13/12 = 1.08333...
    // no-vig: h=6/13≈0.461538, d=4/13≈0.307692, a=3/13≈0.230769 (somam 1)
    const r = noVig({ h: 2, d: 3, a: 4 });
    expect(r).not.toBeNull();
    expect(r!.h).toBeCloseTo(6 / 13, 10);
    expect(r!.d).toBeCloseTo(4 / 13, 10);
    expect(r!.a).toBeCloseTo(3 / 13, 10);
    expect(r!.h + r!.d + r!.a).toBeCloseTo(1, 10);
    expect(r!.margin).toBeCloseTo(1 / 12, 10);
  });

  it("devolve null quando faltam odds ou o objeto é null/undefined", () => {
    expect(noVig(null)).toBeNull();
    expect(noVig(undefined)).toBeNull();
    expect(noVig({ h: 0, d: 3, a: 4 })).toBeNull();   // h=0 é falsy -> inválido
    expect(noVig({ h: 2, d: 3, a: 0 } as any)).toBeNull();
    expect(noVig({} as any)).toBeNull();
  });
});

describe("computeStake — Kelly fracionário, teto de 5%, corte por risco pendente/CLV", () => {
  it("Kelly normal, sem cap, sem reduções: p=0.55 od=2.20 kellyFrac=0.25 -> frac=4.375%", () => {
    // b=1.2; kf=(1.2*0.55-0.45)/1.2=(0.66-0.45)/1.2=0.21/1.2=0.175 (Kelly completo=17.5%)
    // frac = 0.175 * 0.25 (kellyFrac) * 1 (riskMult) = 0.04375 (4.375% da banca), abaixo do cap de 5%
    const r = computeStake(0.55, 2.2, noRisk);
    expect(r.frac).toBeCloseTo(0.04375, 6);
    expect(parseFloat(r.txt)).toBeCloseTo(43.75, 2);
    expect(r.reducedForRisk).toBe(false);
    expect(r.reducedForClv).toBe(false);
  });

  it("Kelly agressivo estoura o teto de 5% e fica limitado: p=0.70 od=3.00 -> kf completo=55%, cortado a 5%", () => {
    // b=2.0; kf=(2*0.7-0.3)/2=(1.4-0.3)/2=1.1/2=0.55 -> *0.25=0.1375, mas o teto STAKE_CAP_FRAC=0.05 vence
    const r = computeStake(0.7, 3.0, noRisk);
    expect(r.frac).toBeCloseTo(0.05, 10);
    expect(parseFloat(r.txt)).toBeCloseTo(50.0, 2);
  });

  it("edge negativo (Kelly < 0) nunca aposta valores negativos: p=0.30 od=2.00 -> frac=0", () => {
    // b=1.0; kf=(1*0.3-0.7)/1=-0.4 -> max(kf,0)=0 -> frac=0
    const r = computeStake(0.3, 2.0, noRisk);
    expect(r.frac).toBe(0);
    expect(parseFloat(r.txt)).toBeCloseTo(0, 2);
  });

  it("reduz a metade quando há muito risco pendente (>15% da banca)", () => {
    // mesmo caso do 1º teste (frac base 0.04375) mas pendingStake=200 > 0.15*1000=150 -> frac/2
    const ctx: StakeContext = { bank: 1000, kellyFrac: 0.25, pendingStake: 200, riskMult: 1 };
    const r = computeStake(0.55, 2.2, ctx);
    expect(r.frac).toBeCloseTo(0.04375 / 2, 6);
    expect(r.reducedForRisk).toBe(true);
    expect(r.reducedForClv).toBe(false);
  });

  it("aplica o multiplicador de risco do CLV (riskMult<1) e marca reducedForClv", () => {
    // mesmo caso base, mas riskMult=0.5 (gate de CLV sem edge) -> frac = 0.04375 * 0.5
    const ctx: StakeContext = { bank: 1000, kellyFrac: 0.25, pendingStake: 0, riskMult: 0.5 };
    const r = computeStake(0.55, 2.2, ctx);
    expect(r.frac).toBeCloseTo(0.04375 * 0.5, 6);
    expect(r.reducedForClv).toBe(true);
    expect(r.reducedForRisk).toBe(false);
  });

  it("sem banca definida, mostra a stake em % da banca em vez de euros", () => {
    const ctx: StakeContext = { bank: 0, kellyFrac: 0.25, pendingStake: 500, riskMult: 1 };
    const r = computeStake(0.55, 2.2, ctx);
    expect(r.txt.endsWith("% banca")).toBe(true);
    expect(parseFloat(r.txt)).toBeCloseTo(4.375, 2);
  });
});

describe("autoDecide — baseline obrigatória (Pinnacle ou Betclic), thresholds por tier, jogos amigáveis", () => {
  // Fixa a probabilidade de mercado via "sharp" limpa: h=2.00 d=4.00 a=4.00 -> soma implícita
  // exatamente 1 (sem margem), logo no-vig = implícita: p.h=0.50, p.d=0.25, p.a=0.25 — e é
  // exatamente essa a probabilidade que modelProbs devolve (100% Pinnacle/no-vig) quando há sharp,
  // tornando o EV 100% calculável à mão.
  const sharp = { h: 2.0, d: 4.0, a: 4.0, tier: "sharp" as const };
  const ctx: DecisionContext = { calib: noCalib, stake: noRisk };

  it("sem baseline nenhuma, devolve a mensagem de indisponibilidade e NUNCA bet:true — mesmo com odd 'boa'", () => {
    // Odd de referência claramente vantajosa (2.30 vs 2.00 "justa") não importa: sem sharp nem
    // alt não há probabilidade do modelo nenhuma para comparar — este é exatamente o bug do EV
    // circular que esta correção elimina (nunca mais comparar a odd de referência com ela própria).
    const g = makeGame({ o: { h: 2.3, d: 3.0, a: 3.0 } });
    const dec = autoDecide(g, ctx, null);
    expect(dec.bet).toBe(false);
    expect(dec.msg).toBe("Sem baseline sharp (Pinnacle) nem alternativa (Betclic) — decisão automática indisponível");
  });

  it("sem baseline sharp, dec.best fica undefined — garante que trackRejectedIfEnabled (main.ts) nunca regista uma 'não-aposta' para uma decisão apenas indisponível", () => {
    // trackRejectedIfEnabled só grava quando `dec.best` existe (ver main.ts: "if (dec.bet || !dec.best) return;").
    // A "indisponibilidade" não passa por nenhum candidato avaliado (cands fica [] antes de sequer
    // se calcular EV), logo dec.best nunca é definido neste caminho — a não-aposta nunca é
    // confundida com uma rejeição real por EV insuficiente, o que poluiria as estatísticas.
    const g = makeGame({ o: { h: 2.3, d: 3.0, a: 3.0 } });
    const dec = autoDecide(g, ctx, null);
    expect(dec.best).toBeUndefined();
    expect(dec.cands).toEqual([]);
  });

  it("sharp igual à odd de referência: EV negativo em todas as seleções (≈ −margem), não aposta", () => {
    // sharp === g.o (mesmas odds) -> nv(sharp) é o mesmo no-vig de g.o, logo EV = nv.h*o.h - 1 =
    // 1/S - 1 = -margem/(1+margem) para TODAS as seleções (a mesma álgebra que causava o bug
    // circular) — a diferença agora é que isto só acontece quando o utilizador tem sharp de
    // verdade e ela calha a bater com a referência, não porque falta a Pinnacle e se cai para a
    // referência às escondidas.
    const oddsRef = { h: 2.0, d: 3.5, a: 3.8 };
    const g = makeGame({ o: oddsRef });
    const dec = autoDecide(g, ctx, { ...oddsRef, tier: "sharp" });
    const nv = noVig(oddsRef)!;
    const expectedEvH = nv.h * oddsRef.h - 1;
    expect(expectedEvH).toBeLessThan(0);
    expect(expectedEvH).toBeCloseTo(-nv.margin / (1 + nv.margin), 10);
    expect(dec.bet).toBe(false);
    expect(dec.msg).toBe("Não apostar — sem valor às odds de referência");
  });

  it("sharp que torna a odd de referência 4% acima da justa: aposta com EV_MIN_SHARP=0.03; não aposta se amigável (limiar 6%)", () => {
    // fair(h) = 1/nv.h = 2.00 (a partir do sharp acima); odd de referência 4% acima -> 2.08.
    // EV = nv.h*2.08 - 1 = 0.5*2.08-1 = 0.04 exatamente (4%), acima de EV_MIN_SHARP (3%) mas
    // abaixo de EV_MIN_SHARP_FRIENDLY (6%) — o mesmo EV muda de decisão consoante friendly.
    expect(EV_MIN_SHARP).toBeLessThan(0.04);
    expect(EV_MIN_SHARP_FRIENDLY).toBeGreaterThan(0.04);
    const oddsCasa = { h: 2.08, d: 3.0, a: 3.0 };
    const decOficial = autoDecide(makeGame({ o: oddsCasa, friendly: false }), ctx, sharp);
    const decAmigavel = autoDecide(makeGame({ o: oddsCasa, friendly: true }), ctx, sharp);
    expect(decOficial.bestKey).toBe("1");
    expect(decOficial.ev).toBeCloseTo(0.04, 10);
    expect(decOficial.bet).toBe(true);
    // stake: b=1.08; kf=(1.08*0.5-0.5)/1.08=0.04/1.08≈0.037037; frac=kf*0.25≈0.0092593 (< cap 5%)
    expect(decOficial.stakeFrac).toBeCloseTo((0.04 / 1.08) * 0.25, 4);
    // em bet:false o EV vive em dec.best.ev, não em dec.ev (só a decisão bet:true guarda .ev direto)
    expect(decAmigavel.best?.ev).toBeCloseTo(0.04, 10);
    expect(decAmigavel.bet).toBe(false);
    expect(decAmigavel.msg).toMatch(/^Valor marginal/);
  });

  it("com tier 'alt' (Betclic, fallback), o mesmo EV de 4% NÃO chega — precisa de EV_MIN_ALT_SHARP (5%), mais exigente que com sharp", () => {
    // Mesmo cenário do teste anterior (EV=4%, exatamente o mesmo cálculo), mas agora a quote vem
    // marcada tier:"alt" — o limiar sobe de EV_MIN_SHARP (3%) para EV_MIN_ALT_SHARP (5%), por isso
    // o EV de 4% deixa de bater o limiar (fica "valor marginal" em vez de "apostar").
    expect(EV_MIN_ALT_SHARP).toBeGreaterThan(0.04);
    const altSharp = { h: 2.0, d: 4.0, a: 4.0, tier: "alt" as const };
    const oddsCasa = { h: 2.08, d: 3.0, a: 3.0 };
    const dec = autoDecide(makeGame({ o: oddsCasa, friendly: false }), ctx, altSharp);
    expect(dec.bet).toBe(false);
    expect(dec.msg).toMatch(/^Valor marginal/);
    expect(dec.best?.ev).toBeCloseTo(0.04, 10);
  });

  it("com tier 'alt', um EV de 6% já bate o EV_MIN_ALT_SHARP (5%) e aposta", () => {
    // fair(h)=2.00; odd de referência 6% acima -> 2.12. EV = 0.5*2.12-1 = 0.06.
    expect(EV_MIN_ALT_SHARP).toBeLessThan(0.06);
    const altSharp = { h: 2.0, d: 4.0, a: 4.0, tier: "alt" as const };
    const oddsCasa = { h: 2.12, d: 3.0, a: 3.0 };
    const dec = autoDecide(makeGame({ o: oddsCasa, friendly: false }), ctx, altSharp);
    expect(dec.bet).toBe(true);
    expect(dec.ev).toBeCloseTo(0.06, 10);
  });

  it("com tier 'alt' e jogo amigável, precisa de EV_MIN_ALT_SHARP_FRIENDLY (9%) — 6% ainda não chega", () => {
    expect(EV_MIN_ALT_SHARP_FRIENDLY).toBeGreaterThan(0.06);
    const altSharp = { h: 2.0, d: 4.0, a: 4.0, tier: "alt" as const };
    const oddsCasa = { h: 2.12, d: 3.0, a: 3.0 };
    const dec = autoDecide(makeGame({ o: oddsCasa, friendly: true }), ctx, altSharp);
    expect(dec.bet).toBe(false);
    expect(dec.best?.ev).toBeCloseTo(0.06, 10);
  });
});

describe("calibration — compara probabilidades previstas com o que realmente aconteceu", () => {
  // Dataset fixo: 3 apostas resolvidas + 2 excluídas (pending/void não contam).
  // win  prob=0.6 (bin [0.6,0.8)) -> y=1
  // loss prob=0.6 (bin [0.6,0.8)) -> y=0
  // win  prob=0.3 (bin [0.2,0.4)) -> y=1
  const bets = [
    makeBet({ id: "b1", status: "win", prob: 0.6 }),
    makeBet({ id: "b2", status: "loss", prob: 0.6 }),
    makeBet({ id: "b3", status: "win", prob: 0.3 }),
    makeBet({ id: "b4", status: "pending", prob: 0.9 }),
    makeBet({ id: "b5", status: "void", prob: 0.5 })
  ];

  it("ignora pending/void e calcula avgPred/avgActual/brier só sobre as 3 resolvidas", () => {
    const c = calibration(bets);
    expect(c.n).toBe(3);
    // avgPred = (0.6+0.6+0.3)/3 = 1.5/3 = 0.5
    expect(c.avgPred).toBeCloseTo(0.5, 10);
    // avgActual = (1+0+1)/3 = 2/3
    expect(c.avgActual).toBeCloseTo(2 / 3, 10);
    // brier = [(0.6-1)^2 + (0.6-0)^2 + (0.3-1)^2] / 3 = [0.16+0.36+0.49]/3 = 1.01/3
    expect(c.brier).toBeCloseTo(1.01 / 3, 10);
    // brierBase = baseRate*(1-baseRate) = (2/3)*(1/3) = 2/9
    expect(c.brierBase).toBeCloseTo(2 / 9, 10);
  });

  it("agrupa corretamente por faixa: [0.6,0.8) tem as 2 apostas de 0.6, [0.2,0.4) tem a de 0.3", () => {
    const c = calibration(bets);
    const bin68 = c.bins.find(b => b.lo === 0.6 && b.hi === 0.8)!;
    expect(bin68.n).toBe(2);
    expect(bin68.predSum).toBeCloseTo(1.2, 10);
    expect(bin68.wins).toBe(1);
    const bin24 = c.bins.find(b => b.lo === 0.2 && b.hi === 0.4)!;
    expect(bin24.n).toBe(1);
    expect(bin24.predSum).toBeCloseTo(0.3, 10);
    expect(bin24.wins).toBe(1);
  });

  it("calibInfo só ativa com amostra >= CALIB_MIN_N; com poucas apostas o viés fica em 0", () => {
    const info = calibInfo(bets);
    expect(info.active).toBe(false);
    expect(info.bias).toBe(0);
    expect(info.n).toBe(3);
  });
});

describe("modelProbs — no-vig puro da Pinnacle/Betclic, ÚNICOS caminhos suportados (sem heurística, sem fallback para g.o)", () => {
  it("com sharp (tier Pinnacle), devolve o no-vig da sharp, com heur=false e tier propagado, independentemente de forma/registo", () => {
    const sharp = { h: 2.0, d: 4.0, a: 4.0, tier: "sharp" as const };   // no-vig limpo: h=0.5, d=0.25, a=0.25
    const g = makeGame({
      h: { n: "Casa", f: "WWWWW", r: "10-0-0", s: null },
      a: { n: "Fora", f: "LLLLL", r: "0-0-10", s: null }
    });
    const mp = modelProbs(g, sharp);
    expect(mp).not.toBeNull();
    expect(mp!.heur).toBe(false);
    expect(mp!.sharp).toBe(true);
    expect(mp!.tier).toBe("sharp");
    expect(mp!.p).toEqual({ h: 0.5, d: 0.25, a: 0.25, margin: 0 });
  });

  it("com tier 'alt' (Betclic), propaga tier:'alt' no resultado", () => {
    const alt = { h: 2.0, d: 4.0, a: 4.0, tier: "alt" as const };
    const g = makeGame();
    const mp = modelProbs(g, alt);
    expect(mp!.tier).toBe("alt");
  });

  it("SEM sharp, devolve null — nunca cai para o no-vig de g.o (elimina o bug do EV circular)", () => {
    // Antes desta correção, sem sharp caía-se para noVig(g.o) — o motor de decisão comparava então
    // essa MESMA odd de referência consigo própria (EV = -margem sempre), dizendo "não apostar" em
    // todos os jogos por construção. Agora, sem baseline sharp, não há probabilidade nenhuma.
    const g = makeGame({ o: { h: 2, d: 4, a: 4 } });
    expect(modelProbs(g, null)).toBeNull();
    expect(modelProbs(g, undefined)).toBeNull();
  });

  it("sem odds nenhumas (nem sharp nem g.o), devolve null", () => {
    const g = makeGame({ o: null });
    expect(modelProbs(g, null)).toBeNull();
  });
});

describe("lineMovement — variação percentual entre a odd de abertura e a atual", () => {
  it("odd casa encolheu de 2.00 para 1.80: (1.80-2.00)/2.00 = -10%", () => {
    const r = lineMovement({ h: 1.8, d: 3.5, a: 4.0, oh: 2.0 });
    expect(r.h).toBeCloseTo(-0.10, 10);
  });

  it("odd fora alargou de 3.00 para 3.60: (3.60-3.00)/3.00 = +20%", () => {
    const r = lineMovement({ h: 1.8, d: 3.5, a: 3.6, oa: 3.0 });
    expect(r.a).toBeCloseTo(0.20, 10);
  });

  it("sem odd de abertura ou sem odds, devolve null para esse lado", () => {
    expect(lineMovement({ h: 1.8, d: 3.5, a: 4.0 })).toEqual({ h: null, a: null });
    expect(lineMovement(null)).toEqual({ h: null, a: null });
  });
});

describe("stopLossStatus — trava novas sugestões após um drawdown recente acima do limiar", () => {
  // "now" fixo em 2026-01-10T00:00Z; janela de 7 dias -> cutoff em 2026-01-03T00:00Z.
  const now = Date.parse("2026-01-10T00:00:00Z");

  it("ignora apostas fora da janela e pending: drawdown de 10% fica abaixo do limiar de 15%", () => {
    // dentro da janela: win stake=100 odd=2.0 (+100), loss stake=200 (-200) -> profit=-100 -> 10% de 1000
    // fora da janela (2026-01-01, antes do cutoff): loss stake=500 -> ignorada
    const bets = [
      makeBet({ id: "b1", status: "win", stake: 100, odd: 2.0, loggedAt: "2026-01-08T12:00:00Z" }),
      makeBet({ id: "b2", status: "loss", stake: 200, odd: 2.0, loggedAt: "2026-01-09T12:00:00Z" }),
      makeBet({ id: "b3", status: "loss", stake: 500, odd: 2.0, loggedAt: "2026-01-01T12:00:00Z" }),
      makeBet({ id: "b4", status: "pending", stake: 50, odd: 2.0, loggedAt: "2026-01-09T12:00:00Z" })
    ];
    const r = stopLossStatus(bets, 1000, 7, 0.15, now);
    expect(r.n).toBe(2);
    expect(r.profit).toBeCloseTo(-100, 6);
    expect(r.drawdownFrac).toBeCloseTo(0.10, 6);
    expect(r.halted).toBe(false);
  });

  it("ativa o halt quando o drawdown da janela ultrapassa o limiar (20% > 15%)", () => {
    const bets = [
      makeBet({ id: "b1", status: "win", stake: 100, odd: 2.0, loggedAt: "2026-01-08T12:00:00Z" }),
      makeBet({ id: "b2", status: "loss", stake: 300, odd: 2.0, loggedAt: "2026-01-09T12:00:00Z" })
    ];
    // profit = 100 - 300 = -200 -> drawdown = 200/1000 = 20%
    const r = stopLossStatus(bets, 1000, 7, 0.15, now);
    expect(r.drawdownFrac).toBeCloseTo(0.20, 6);
    expect(r.halted).toBe(true);
  });

  it("sem banca definida (bank=0) nunca ativa o halt (não há como calcular fração)", () => {
    const bets = [makeBet({ status: "loss", stake: 300, odd: 2.0, loggedAt: "2026-01-09T12:00:00Z" })];
    const r = stopLossStatus(bets, 0, 7, 0.15, now);
    expect(r.halted).toBe(false);
    expect(r.drawdownFrac).toBe(0);
  });
});

describe("applyCalib — ajusta a probabilidade do modelo pelo viés medido", () => {
  it("sem calibração ativa, devolve a probabilidade inalterada", () => {
    const r = applyCalib(0.6, { active: false, bias: 0.05, n: 10 });
    expect(r.p).toBe(0.6);
    expect(r.applied).toBe(false);
  });

  it("com calibração ativa, subtrai o viés: p=0.6 bias=0.05 -> 0.55", () => {
    const r = applyCalib(0.6, { active: true, bias: 0.05, n: 40 });
    expect(r.p).toBeCloseTo(0.55, 10);
    expect(r.applied).toBe(true);
  });

  it("limita o resultado a [0.01, 0.99] (clamp): p=0.03 bias=0.10 -> ajuste bruto -0.07, fica 0.01", () => {
    const r = applyCalib(0.03, { active: true, bias: 0.10, n: 40 });
    expect(r.p).toBeCloseTo(0.01, 10);
    expect(r.applied).toBe(true);
  });

  it("viés muito pequeno (<0.0005 de diferença) não conta como 'aplicado'", () => {
    const r = applyCalib(0.6, { active: true, bias: 0.0001, n: 40 });
    expect(r.p).toBeCloseTo(0.5999, 10);
    expect(r.applied).toBe(false);
  });
});

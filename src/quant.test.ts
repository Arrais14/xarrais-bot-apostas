// ===== Testes unitários do motor quantitativo (src/quant.ts) =====
// Cada caso tem o cálculo manual no comentário, para servir de documentação viva das fórmulas —
// se uma fórmula em quant.ts mudar sem ser de propósito, estes números fixos apanham a regressão.

import { describe, expect, it } from "vitest";
import {
  applyCalib, autoDecide, blendFormMarket, calibInfo, calibration, computeStake, lineMovement,
  modelProbs, noVig, scoreMatrix, stopLossStatus, suggestModelWeights
} from "./quant";
import { DIXON_COLES_RHO, EV_MIN, EV_MIN_FRIENDLY, RECALIB_MIN_N } from "./config";
import type { Bet, CalibInfo, DecisionContext, Game, ModelInputsSnapshot, StakeContext } from "./types";

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

describe("autoDecide — seleção do melhor candidato, threshold de EV, jogos amigáveis", () => {
  // Fixa a probabilidade de mercado via "sharp" limpa: h=2.00 d=4.00 a=4.00 -> soma implícita
  // exatamente 1 (sem margem), logo no-vig = implícita: p.h=0.50, p.d=0.25, p.a=0.25.
  // h.f="" força modelProbs a saltar a heurística forma+mercado (fpts("")=null) e devolver
  // exatamente essa probabilidade de mercado, tornando o EV 100% calculável à mão.
  const sharp = { h: 2.0, d: 4.0, a: 4.0 };
  const ctx: DecisionContext = { calib: noCalib, stake: noRisk };

  it("escolhe o candidato com melhor EV e aposta quando o EV está bem acima do limiar", () => {
    // odd local casa=2.30: EV = 0.50*2.30-1 = 0.15 (15%, >> EV_MIN=0.08)
    // empate/fora a odd 3.00 com p=0.25: EV = 0.25*3.00-1 = -0.25 (bem pior) -> "1" tem de ganhar
    const g = makeGame({ o: { h: 2.3, d: 3.0, a: 3.0 } });
    const dec = autoDecide(g, ctx, sharp);
    expect(dec.bestKey).toBe("1");
    expect(dec.bet).toBe(true);
    expect(dec.ev).toBeCloseTo(0.15, 10);
    expect(dec.p).toBeCloseTo(0.5, 10);
    // stake: b=1.3; kf=(1.3*0.5-0.5)/1.3=0.15/1.3≈0.115385; frac=kf*0.25≈0.0288462 (< cap 5%)
    expect(dec.stakeFrac).toBeCloseTo(0.115385 * 0.25, 4);
  });

  it("EV positivo mas abaixo do limiar (EV_MIN) fica marcado como 'valor marginal', não aposta", () => {
    // odd local casa=2.10: EV = 0.50*2.10-1 = 0.05 (5%, < EV_MIN=0.08 mas > 0)
    const g = makeGame({ o: { h: 2.1, d: 3.0, a: 3.0 } });
    const dec = autoDecide(g, ctx, sharp);
    expect(dec.bet).toBe(false);
    expect(dec.msg).toMatch(/^Valor marginal/);
    expect(dec.best?.k).toBe("1");
  });

  it("EV negativo (odd abaixo da odd justa) não aposta e não guarda 'valor marginal'", () => {
    // odd local casa=1.90: EV = 0.50*1.90-1 = -0.05
    const g = makeGame({ o: { h: 1.9, d: 3.0, a: 3.0 } });
    const dec = autoDecide(g, ctx, sharp);
    expect(dec.bet).toBe(false);
    expect(dec.msg).toBe("Não apostar — sem valor às odds de referência");
  });

  it("jogo amigável exige um limiar de EV mais alto (EV_MIN_FRIENDLY=0.12): o mesmo EV=0.10 muda de decisão", () => {
    // odd local casa=2.20: EV = 0.50*2.20-1 = 0.10 -> bate EV_MIN (0.08) mas não EV_MIN_FRIENDLY (0.12)
    expect(EV_MIN).toBeLessThan(0.10);
    expect(EV_MIN_FRIENDLY).toBeGreaterThan(0.10);
    const oddsCasa = { h: 2.2, d: 3.0, a: 3.0 };
    const decOficial = autoDecide(makeGame({ o: oddsCasa, friendly: false }), ctx, sharp);
    const decAmigavel = autoDecide(makeGame({ o: oddsCasa, friendly: true }), ctx, sharp);
    expect(decOficial.ev).toBeCloseTo(0.10, 10);
    expect(decOficial.bet).toBe(true);
    // em bet:false o EV vive em dec.best.ev, não em dec.ev (só a decisão bet:true guarda .ev direto)
    expect(decAmigavel.best?.ev).toBeCloseTo(0.10, 10);
    expect(decAmigavel.bet).toBe(false);
    expect(decAmigavel.msg).toMatch(/^Valor marginal/);
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

describe("modelProbs — blend forma+mercado com pesos MODEL_BLEND_W/MODEL_HOME_ADV", () => {
  it("com forma real (não vazia), usa o caminho heurístico e devolve os inputs brutos para recalibração", () => {
    // ppg/fpts ficam normalizados a 0-1 (não 0-3): (3*V+E)/(3*jogos). "10-0-0" (10 vitórias) -> 1.
    // Casa domina em pontos e forma (WWWWW -> 1); Fora não pontuou nada (0-0-10, LLLLL -> 0).
    // Não é preciso calcular a exponencial à mão: o que importa é que o resultado é coerente
    // (casa larga favorita) e que os inputs ficam gravados tal como entraram.
    const sharp = { h: 2.0, d: 4.0, a: 4.0 };   // no-vig limpo: h=0.5, d=0.25, a=0.25
    const g = makeGame({
      h: { n: "Casa", f: "WWWWW", r: "10-0-0", s: null },
      a: { n: "Fora", f: "LLLLL", r: "0-0-10", s: null }
    });
    const mp = modelProbs(g, sharp);
    expect(mp).not.toBeNull();
    expect(mp!.heur).toBe(true);
    expect(mp!.p.h + mp!.p.d + mp!.p.a).toBeCloseTo(1, 8);
    expect(mp!.p.h).toBeGreaterThan(mp!.p.d);
    expect(mp!.p.h).toBeGreaterThan(mp!.p.a);
    expect(mp!.inputs).toEqual({ nvH: 0.5, nvD: 0.25, nvA: 0.25, sH0: 1, sA0: 0, fH: 1, fA: 0 });
  });

  it("sem forma (f vazio) cai para o no-vig puro e não guarda inputs (heur=false)", () => {
    const g = makeGame({ h: { n: "Casa", f: "", r: "0-0-0", s: null } });
    const mp = modelProbs(g, { h: 2, d: 4, a: 4 });
    expect(mp!.heur).toBe(false);
    expect(mp!.inputs).toBeUndefined();
  });
});

describe("suggestModelWeights — grid-search de pesos otimizado para Brier score (nunca P&L)", () => {
  // Forma claramente mais favorável à casa do que o mercado sugere, para que w (peso da forma)
  // tenha um impacto real em p — se ph e nv.h fossem parecidos, mudar w quase não moveria nada.
  const inputs: ModelInputsSnapshot = { nvH: 0.40, nvD: 0.30, nvA: 0.30, sH0: 2.2, sA0: 0.8, fH: 0.8, fA: 0.3 };

  it("fica inativo com amostra abaixo de RECALIB_MIN_N", () => {
    const bets = Array.from({ length: 10 }, (_, i) => makeBet({ id: "b" + i, status: i % 2 === 0 ? "win" : "loss", selKey: "1", modelInputs: inputs }));
    const s = suggestModelWeights(bets);
    expect(s.active).toBe(false);
    expect(s.n).toBe(10);
  });

  it("ignora apostas de handicap/golos (só olha a 1X2 simples) e as sem modelInputs guardados", () => {
    const bets = [
      makeBet({ id: "b1", status: "win", selKey: "HH", modelInputs: inputs }),
      makeBet({ id: "b2", status: "win", selKey: "D:GOV", modelInputs: inputs }),
      makeBet({ id: "b3", status: "win", selKey: "1" })   // sem modelInputs
    ];
    const s = suggestModelWeights(bets);
    expect(s.n).toBe(0);
    expect(s.active).toBe(false);
  });

  it("encontra a combinação (w, vantagem casa) usada para gerar os dados — é a única que minimiza o Brier", () => {
    // Para uma previsão constante p sobre uma amostra binária, Brier(p) = (p-taxaEmpirica)² +
    // taxaEmpirica·(1-taxaEmpirica) — decomposição bias-variância — logo é minimizado exatamente
    // quando p = taxa empírica. Gerando a amostra para que a taxa de acerto bata precisamente com
    // blendFormMarket(trueW,trueHomeAdv), essa combinação da grelha vence matematicamente todas as
    // outras (nenhuma outra produz o mesmo p para estes inputs).
    const trueW = 0.20, trueHomeAdv = 0.18;   // extremos da grelha, bem longe do default (0.35/0.12)
    const pTrue = blendFormMarket({ h: inputs.nvH, d: inputs.nvD, a: inputs.nvA }, inputs.sH0, inputs.sA0, inputs.fH, inputs.fA, trueW, trueHomeAdv).h;
    // n grande para que o arredondamento de "wins" a um inteiro não desloque a taxa empírica o
    // suficiente para empatar com a grelha vizinha (passo de 0.05/0.02) — sem isto, o teste ficava
    // sensível a qual dos dois lados o arredondamento caía.
    const n = 100000;
    const wins = Math.round(pTrue * n);
    const bets: Bet[] = Array.from({ length: n }, (_, i) => makeBet({ id: "b" + i, status: i < wins ? "win" : "loss", selKey: i % 2 === 0 ? "1" : "AUTO:1", modelInputs: inputs }));
    const s = suggestModelWeights(bets);
    expect(s.active).toBe(true);
    expect(s.n).toBe(n);
    expect(s.bestW).toBeCloseTo(trueW, 6);
    expect(s.bestHomeAdv).toBeCloseTo(trueHomeAdv, 6);
    expect(s.improved).toBe(true);
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

// BTTS (ambas marcam) = soma de todas as células (i,j) com i>0 e j>0 — mesma definição de matBTTS
// em quant.ts, recalculada aqui para não depender de exportar mais internos do que o necessário.
function bttsYes(m: number[][]): number {
  let yes = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (i > 0 && j > 0) yes += m[i][j];
  return yes;
}

describe("scoreMatrix — ajuste Dixon-Coles ao Poisson independente (exceção deliberada à REGRA DE OURO)", () => {
  it("a matriz de placares soma sempre 1 (com e sem o ajuste Dixon-Coles)", () => {
    const withDC = scoreMatrix(1.4, 1.1);          // rho = DIXON_COLES_RHO por omissão
    const pure = scoreMatrix(1.4, 1.1, 0);          // rho=0 -> Poisson independente puro, sem correção
    const sum = (m: number[][]) => m.flat().reduce((a, b) => a + b, 0);
    expect(sum(withDC)).toBeCloseTo(1, 9);
    expect(sum(pure)).toBeCloseTo(1, 9);
  });

  it("com rho negativo (valor usado em produção), o BTTS sobe ligeiramente vs Poisson puro — não desce", () => {
    // Verificado numericamente (não assumido): com a fórmula original de Dixon & Coles (1997) e
    // rho negativo, tau(1,1)=1-rho>1 e tau(0,0)=1-lh*la*rho>1 aumentam 0-0 e 1-1 relativamente ao
    // Poisson independente — como 1-1 conta para BTTS "sim", o efeito líquido é um BTTS ligeiramente
    // MAIOR, não menor, para lh/la realistas (~0.7-1.8). Documentado também em DIXON_COLES_RHO.
    expect(DIXON_COLES_RHO).toBeLessThan(0);
    const casos: [number, number][] = [[1.3, 1.3], [1.5, 1.1], [0.9, 0.9], [1.8, 1.5]];
    for (const [lh, la] of casos) {
      const bttsPure = bttsYes(scoreMatrix(lh, la, 0));
      const bttsDC = bttsYes(scoreMatrix(lh, la));
      expect(bttsDC).toBeGreaterThan(bttsPure);
      expect(bttsDC - bttsPure).toBeLessThan(0.03);   // efeito "ligeiro", não uma distorção grande
    }
  });
});

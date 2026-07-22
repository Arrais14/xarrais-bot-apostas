// ===== Motor quantitativo: no-vig, modelo forma+mercado, Poisson, Kelly, calibração, decisão =====
// REGRA DE OURO: nenhuma fórmula ou heurística deste ficheiro foi alterada em relação ao
// monólito original — só se tornaram funções puras com parâmetros explícitos (banca, perfil,
// risco pendente, calibração) em vez de lerem localStorage/globais diretamente. Isto é o que
// torna este ficheiro testável isoladamente (e pronto para, no futuro, correr num backend).

import type {
  Bet, Candidate, CalibAdjustment, CalibInfo, CalibrationBin, CalibrationResult,
  ClvGate, CompareOption, DecisionContext, Game, GoalModel, LineMovement, ModelDecision,
  ModelProbs, NoVigProbs, Odds, PoissonMatrix, SharpQuote, StakeContext,
  StakeInfo, StopLossStatus
} from "./types";
import {
  CALIB_MIN_N, CLV_MIN_N, CLV_RISK_MULT, EV_MIN_SHARP, EV_MIN_SHARP_FRIENDLY, MIN_ODD,
  PENDING_RISK_FRAC, STAKE_CAP_FRAC, STOP_LOSS_DRAWDOWN_FRAC, STOP_LOSS_WINDOW_DAYS
} from "./config";
import { avgCLV } from "./storage";
import { fmt2, num } from "./utils";

// ===== No-vig: probabilidades sem margem do bookmaker, a partir das odds 1X2 =====
// Método "Margin Proportional to Odds" / normalização multiplicativa: cada probabilidade implícita
// (1/odd) é dividida pela soma de todas — a mesma fórmula que a literatura de apostas chama MPTO.
// Não mudar: é o método padrão da indústria e o que já validávamos antes deste upgrade.
export function noVig(o: Odds | null | undefined): NoVigProbs | null {
  if (!o || !o.h || !o.d || !o.a) return null;
  const s = 1 / o.h + 1 / o.d + 1 / o.a;
  return { h: (1 / o.h) / s, d: (1 / o.d) / s, a: (1 / o.a) / s, margin: s - 1 };
}

// ===== Movimento de mercado: variação % entre a odd de abertura e a atual =====
// Um movimento grande pode ser sinal de informação nova (lesão, onze) que o modelo — que só vê
// forma e registo — não tem forma de captar. Não altera nenhuma decisão, é só um alerta informativo.
export function lineMovement(o: Odds | null | undefined): LineMovement {
  if (!o) return { h: null, a: null };
  const h = (o.oh && o.h) ? (o.h - o.oh) / o.oh : null;
  const a = (o.oa && o.a) ? (o.a - o.oa) / o.oa : null;
  return { h, a };
}

// ===== Modelo automático: no-vig puro da Pinnacle/"sharp" — ÚNICO caminho suportado =====
// A heurística forma+PPG que existia aqui foi removida a pedido explícito: o mercado (Pinnacle) já
// é eficiente o suficiente para não valer a pena somar ruído de uma heurística simples de pontos/
// forma por cima. O scaffolding de ML (ONNX) já tinha sido removido antes pelo mesmo motivo (nada
// por trás validado).
// SEM sharp, devolve-se null — nunca se cai para o no-vig da odd de referência (g.o, DraftKings/
// ESPN). Essa era precisamente a odd que o motor de decisão depois compara para calcular o EV: usar
// a MESMA odd como "probabilidade do modelo" e como "odd apostada" faz EV = −margem sempre,
// garantindo "não apostar" em todos os jogos por construção (bug circular corrigido aqui). Sem
// baseline sharp, autoDecide() produz uma decisão honesta de indisponibilidade em vez de um "sem
// valor" enganoso — ver comparador manual (buildOpts) para o único sítio que ainda aceita a
// referência como estimativa fraca, sinalizada como tal.
export function modelProbs(g: Game, sharp?: SharpQuote | null): ModelProbs | null {
  if (!sharp) return null;
  const nv = noVig({ h: sharp.h, d: sharp.d, a: sharp.a });
  if (!nv) return null;
  return { p: nv, heur: false, sharp: true };
}

// Usado por segmentedPerformancePanels (main.ts) para separar 1X2/handicap principal da segunda
// oportunidade de golos (prefixo "D:") — independente do modelo de probabilidade em si.
export function stripAutoPrefix(selKey: string): string {
  return selKey.startsWith("AUTO:") ? selKey.slice(5) : selKey;
}

// ===== Motor de golos esperados (Poisson) para mercados derivados =====
// Deriva λ (golos esperados de cada equipa) das probabilidades 1X2 do modelo,
// ancorado no total de golos que o mercado Over/Under implica. Assim os mercados
// BTTS / Over-Under / par-ímpar ficam consistentes com a decisão 1X2 já mostrada.
function poissonP(l: number, k: number): number {
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return Math.pow(l, k) * Math.exp(-l) / f;
}
function scoreMatrix(lh: number, la: number): PoissonMatrix {
  const MG = 10, m: number[][] = [];
  let tot = 0;
  for (let i = 0; i <= MG; i++) {
    const row: number[] = [];
    for (let j = 0; j <= MG; j++) {
      const pr = poissonP(lh, i) * poissonP(la, j);
      row.push(pr); tot += pr;
    }
    m.push(row);
  }
  if (tot > 0 && Math.abs(tot - 1) > 1e-9) {
    for (let i = 0; i <= MG; i++) for (let j = 0; j <= MG; j++) m[i][j] /= tot;
  }
  return m;
}
function matBTTS(m: PoissonMatrix): { yes: number; no: number } {
  let yes = 0, no = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
    if (i > 0 && j > 0) yes += m[i][j]; else no += m[i][j];
  }
  return { yes, no };
}
function matOverUnder(m: PoissonMatrix, line: number): { over: number; under: number } {
  let over = 0, under = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
    const tot = i + j;
    if (tot > line) over += m[i][j]; else under += m[i][j];
  }
  return { over, under };
}
function matOddEven(m: PoissonMatrix): { odd: number; even: number } {
  let odd = 0, even = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
    const tot = i + j;
    if (tot % 2 === 0) even += m[i][j]; else odd += m[i][j];
  }
  return { odd, even };
}
function matHandicap(m: PoissonMatrix, side: "h" | "a", line: number): number {
  // side "h" ou "a"; line ex. -0.5 (a equipa tem de ganhar) ou +0.5/+1.5 (não pode perder por essa margem)
  let cover = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
    const marg = side === "h" ? (i - j) : (j - i);
    if (marg + line > 0) cover += m[i][j];
  }
  return cover;
}
function poissonOverProb(total: number, line: number): number {
  const k0 = Math.ceil(line);
  let cum = 0;
  for (let k = 0; k < k0; k++) cum += poissonP(total, k);
  return 1 - cum;
}
function totalFromOverProb(line: number, pOver: number): number {
  let lo = 0.2, hi = 6.5;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    const p = poissonOverProb(mid, line);
    if (p < pOver) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Reparte o total de golos entre casa/fora de acordo com a diferença de força implícita
// nas probabilidades 1X2 do modelo (mesma leitura de jogo, sem inventar uma segunda fonte).
// Nota: a linha de Over/Under e os handicaps vêm sempre de g.o (DraftKings/ESPN) — a The-Odds-API
// só nos dá o mercado h2h da Pinnacle aqui, não totais/handicaps dela.
export function goalModel(g: Game, sharp?: SharpQuote | null): GoalModel | null {
  const mp = modelProbs(g, sharp);
  if (!mp) return null;
  const p = mp.p;
  let total = 2.6;
  const o = g.o;
  if (o && o.l != null && o.ov && o.un) {
    const s2 = 1 / o.ov + 1 / o.un;
    const pOver = (1 / o.ov) / s2;
    total = totalFromOverProb(o.l, pOver);
  }
  const diff = p.h - p.a;
  const share = Math.max(0.25, Math.min(0.75, 0.5 + diff * 0.5));
  const lh = total * share, la = total * (1 - share);
  return { lh, la, total, matrix: scoreMatrix(lh, la) };
}

export function parseLineOdd(str: string | null | undefined): { line: string; od: number } | null {
  const m = (str || "").split("@");
  const od = parseFloat((m[1] || "").trim());
  return isNaN(od) ? null : { line: (m[0] || "").trim().replace(",", "."), od };
}

// ===== Gestão de stake: Kelly Criterion fracionário, teto de segurança, corte se há muito risco
// pendente ou se o CLV não mostra edge =====
// frac = fração de Kelly completo (kf) que o utilizador escolhe assumir (0.25 = "Quarter Kelly" por
// defeito) × kf × riskMult (gate de CLV, já resolvido por quem chama — ver quant.clvGate), sempre
// limitada a STAKE_CAP_FRAC da banca por aposta como rede de segurança independente de tudo o resto.
export function computeStake(p: number, od: number, ctx: StakeContext): StakeInfo {
  const bank = ctx.bank;
  const b = od - 1, kf = (b * p - (1 - p)) / b;
  let frac = Math.min(Math.max(kf, 0) * ctx.kellyFrac * ctx.riskMult, STAKE_CAP_FRAC);
  let reducedForRisk = false;
  if (bank) {
    if (ctx.pendingStake > PENDING_RISK_FRAC * bank) { frac = frac / 2; reducedForRisk = true; }
  }
  const txt = bank ? (frac * bank).toFixed(2) + " €" : (frac * 100).toFixed(2) + "% banca";
  return { frac, txt, reducedForRisk, reducedForClv: ctx.riskMult < 1 };
}

// Mercados de golos (Over/Under + handicap) avaliados contra as odds reais desses mercados —
// só entram aqui os que TÊM odd de referência; BTTS/par-ímpar ficam só no comparador manual.
export function derivedCandidates(g: Game, sharp?: SharpQuote | null): { cands: Candidate[]; gm: GoalModel } | null {
  const gm = goalModel(g, sharp);
  if (!gm) return null;
  const m = gm.matrix, o = g.o, cands: Candidate[] = [];
  if (o && o.l != null && o.ov && o.un) {
    const ou = matOverUnder(m, o.l);
    cands.push({ k: "GOV", lbl: "Mais de " + o.l + " golos", p: ou.over, od: o.ov });
    cands.push({ k: "GUN", lbl: "Menos de " + o.l + " golos", p: ou.under, od: o.un });
  }
  const H = parseLineOdd(o && o.sh), A = parseLineOdd(o && o.sa);
  if (H) { const line = parseFloat(H.line); cands.push({ k: "GHH", lbl: "Handicap golos " + g.h.n + " " + H.line, p: matHandicap(m, "h", line), od: H.od }); }
  if (A) { const line = parseFloat(A.line); cands.push({ k: "GHA", lbl: "Handicap golos " + g.a.n + " " + A.line, p: matHandicap(m, "a", line), od: A.od }); }
  return cands.length ? { cands, gm } : null;
}

// ===== Calibração: as probabilidades do modelo merecem confiança? =====
// Agrupa apostas resolvidas por faixa de probabilidade e compara o previsto com o que aconteceu.
// Não precisa de conhecer a "probabilidade real" — mede a fiabilidade no conjunto.
export function calibration(bets: Bet[]): CalibrationResult {
  const bins: [number, number][] = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
  const out: CalibrationBin[] = bins.map(([lo, hi]) => ({ lo, hi, n: 0, predSum: 0, wins: 0 }));
  let brierSum = 0, n = 0, predSumAll = 0, winSumAll = 0;
  for (const b of bets) {
    if (b.status !== "win" && b.status !== "loss") continue;
    const p = b.prob;
    if (isNaN(p) || p <= 0 || p > 1) continue;
    const y = b.status === "win" ? 1 : 0;
    const bin = out.find(o => p >= o.lo && p < o.hi);
    if (bin) { bin.n++; bin.predSum += p; bin.wins += y; }
    brierSum += (p - y) * (p - y); n++;
    predSumAll += p; winSumAll += y;
  }
  const brier = n ? brierSum / n : null;
  const baseRate = n ? winSumAll / n : 0;
  const brierBase = n ? baseRate * (1 - baseRate) : null;   // Brier de prever sempre a média
  const avgPred = n ? predSumAll / n : null;
  return { bins: out, brier, brierBase, n, avgPred, avgActual: baseRate };
}

// ===== Fecho do loop: usa o viés de calibração para ajustar a prob. do modelo =====
// Só depois de haver amostra suficiente (CALIB_MIN_N) — antes disso o viés medido é ruído.
export function calibInfo(bets: Bet[]): CalibInfo {
  const c = calibration(bets);
  if (c.n < CALIB_MIN_N) return { active: false, bias: 0, n: c.n };
  return { active: true, bias: (c.avgPred as number) - c.avgActual, n: c.n };
}

export function applyCalib(p: number, calib: CalibInfo): CalibAdjustment {
  if (!calib.active) return { p, applied: false };
  const adj = Math.min(0.99, Math.max(0.01, p - calib.bias));
  return { p: adj, applied: Math.abs(adj - p) > 0.0005 };
}

// ===== Gate de risco por CLV: reduz o Kelly quando o histórico mostra falta de edge sobre o
// fecho do mercado — NUNCA o aumenta acima do que o utilizador escolheu em kellyFrac. Mesmo
// padrão de calibInfo: só ativa com amostra suficiente (CLV_MIN_N); antes disso o sinal é ruído.
// CLV fica fiável bem antes do P&L (~50 apostas vs. centenas), por isso serve de gate precoce.
export function clvGate(bets: Bet[]): ClvGate {
  const clv = avgCLV(bets);
  const n = clv ? clv.n : 0;
  const avg = clv ? clv.avg : null;
  if (n < CLV_MIN_N) return { active: false, mult: 1, n, avg };
  if (avg != null && avg <= 0) return { active: true, mult: CLV_RISK_MULT, n, avg };
  return { active: true, mult: 1, n, avg };
}

// ===== Stop-loss por período: trava novas sugestões depois de uma sequência má recente =====
// Olha só para as apostas resolvidas (win/loss) das últimas windowDays dias — void/pending não
// entram, tal como em computePnL/bankCurveData. "now" é injetável para tornar a função pura e
// testável sem depender do relógio do sistema no momento da chamada.
export function stopLossStatus(
  bets: Bet[], bank: number,
  windowDays: number = STOP_LOSS_WINDOW_DAYS,
  drawdownThreshold: number = STOP_LOSS_DRAWDOWN_FRAC,
  now: number = Date.now()
): StopLossStatus {
  const cutoff = now - windowDays * 86400000;
  const windowBets = bets.filter(b => (b.status === "win" || b.status === "loss") && new Date(b.loggedAt).getTime() >= cutoff);
  let profit = 0;
  for (const b of windowBets) {
    const stake = num(b.stake) || 0, odd = num(b.odd) || 0;
    profit += b.status === "win" ? stake * (odd - 1) : -stake;
  }
  const drawdownFrac = bank > 0 ? Math.max(0, -profit) / bank : 0;
  const halted = bank > 0 && drawdownFrac >= drawdownThreshold;
  return { halted, profit, drawdownFrac, windowDays, n: windowBets.length };
}

// Se a decisão principal e a segunda oportunidade forem ambas "apostar", os mercados do mesmo
// jogo estão correlacionados — limita a exposição combinada ao cap de UMA aposta, dividindo
// proporcionalmente pelo peso de cada uma.
function capCorrelatedStakes(dec: ModelDecision, ctx: StakeContext): void {
  const derived = dec.derived;
  if (!derived) return;
  const cap = STAKE_CAP_FRAC;
  const total = (dec.stakeFrac as number) + (derived.stakeFrac as number);
  if (total > cap) {
    const scale = cap / total;
    const newDecFrac = (dec.stakeFrac as number) * scale;
    const newDerivedFrac = (derived.stakeFrac as number) * scale;
    dec.stakeFrac = newDecFrac;
    derived.stakeFrac = newDerivedFrac;
    const bank = ctx.bank;
    dec.stakeTxt = bank ? (newDecFrac * bank).toFixed(2) + " €" : (newDecFrac * 100).toFixed(2) + "% banca";
    derived.stakeTxt = bank ? (newDerivedFrac * bank).toFixed(2) + " €" : (newDerivedFrac * 100).toFixed(2) + "% banca";
  }
  derived.correlatedNote = true;
}

// ===== Decisão automática: mercado 1X2/handicap + segunda oportunidade (golos) =====
export function autoDecide(g: Game, ctx: DecisionContext, sharp?: SharpQuote | null): ModelDecision {
  const o = g.o;
  let dec: ModelDecision | null = null;
  const mp = modelProbs(g, sharp);
  // mp só existe quando há baseline sharp (ver modelProbs) — por isso este é sempre o limiar
  // "com sharp", mais baixo que EV_MIN/EV_MIN_FRIENDLY (reservados para um eventual caminho sem
  // sharp que hoje não existe: sem baseline, a decisão é "indisponível", nunca uma comparação de EV).
  const evMin = g.friendly ? EV_MIN_SHARP_FRIENDLY : EV_MIN_SHARP;
  const calib = ctx.calib;
  if (o && mp) {
    const p = mp.p;
    const H = parseLineOdd(o.sh), A = parseLineOdd(o.sa);
    const cands: Candidate[] = [
      { k: "1", lbl: "1 (" + g.h.n + ")", pRaw: p.h, p: p.h, od: o.h },
      { k: "X", lbl: "X (Empate)", pRaw: p.d, p: p.d, od: o.d },
      { k: "2", lbl: "2 (" + g.a.n + ")", pRaw: p.a, p: p.a, od: o.a }
    ];
    if (H && Math.abs(parseFloat(H.line)) === 0.5) {
      const raw = H.line.startsWith("-") ? p.h : p.h + p.d;
      cands.push({ k: "HH", lbl: "Handicap " + g.h.n + " " + H.line, pRaw: raw, p: raw, od: H.od });
    }
    if (A && Math.abs(parseFloat(A.line)) === 0.5) {
      const raw = A.line.startsWith("-") ? p.a : p.d + p.a;
      cands.push({ k: "HA", lbl: "Handicap " + g.a.n + " " + A.line, pRaw: raw, p: raw, od: A.od });
    }
    for (const c of cands) {
      const ci = applyCalib(c.pRaw as number, calib);
      c.p = ci.p; c.calibApplied = ci.applied; c.pBefore = c.pRaw;
    }
    let best: Candidate | null = null;
    for (const c of cands) {
      if (!c.od || c.od < MIN_ODD) continue;
      c.ev = c.p * c.od - 1;
      if (!best || (c.ev as number) > (best.ev as number)) best = c;
    }
    if (best) {
      const bestEv = best.ev as number;
      if (bestEv >= evMin) {
        const stakeInfo = computeStake(best.p, best.od as number, ctx.stake);
        dec = {
          bet: true, lbl: best.lbl, od: best.od, ev: best.ev, p: best.p, pBefore: best.pBefore,
          calibApplied: best.calibApplied, stakeTxt: stakeInfo.txt, stakeFrac: stakeInfo.frac,
          reducedForRisk: stakeInfo.reducedForRisk, reducedForClv: stakeInfo.reducedForClv,
          cands, heur: mp.heur, bestKey: best.k
        };
      } else if (bestEv > 0) {
        dec = { bet: false, msg: "Valor marginal: " + best.lbl + " @ " + fmt2(best.od) + " (EV +" + (100 * bestEv).toFixed(1) + "%) — só observar", cands, best, heur: mp.heur, bestKey: best.k };
      } else {
        dec = { bet: false, msg: "Não apostar — sem valor às odds de referência", cands, best, heur: mp.heur, bestKey: best.k };
      }
    }
  }
  if (!dec) {
    if (!o) dec = { bet: false, msg: "Sem odds — decisão indisponível", cands: [] };
    else if (!sharp) dec = { bet: false, msg: "Sem baseline sharp (Pinnacle) — decisão automática indisponível", cands: [] };
    else dec = { bet: false, msg: "Dados insuficientes para decisão automática", cands: [] };
  }

  // Segunda oportunidade (mercados de golos, motor de Poisson)
  const dc = derivedCandidates(g, sharp);
  if (dc) {
    for (const c of dc.cands) {
      const ci = applyCalib(c.p, calib);
      c.pBefore = c.p; c.p = ci.p; c.calibApplied = ci.applied;
    }
    let dbest: Candidate | null = null;
    for (const c of dc.cands) {
      if (!c.od || c.od < MIN_ODD) continue;
      c.ev = c.p * c.od - 1;
      if (!dbest || (c.ev as number) > (dbest.ev as number)) dbest = c;
    }
    if (dbest) {
      const dbestEv = dbest.ev as number;
      if (dbestEv >= evMin) {
        const stakeInfo = computeStake(dbest.p, dbest.od as number, ctx.stake);
        dec.derived = {
          bet: true, lbl: dbest.lbl, od: dbest.od, ev: dbest.ev, p: dbest.p, pBefore: dbest.pBefore,
          calibApplied: dbest.calibApplied, stakeTxt: stakeInfo.txt, stakeFrac: stakeInfo.frac,
          reducedForRisk: stakeInfo.reducedForRisk, reducedForClv: stakeInfo.reducedForClv,
          bestKey: dbest.k, cands: dc.cands
        };
      } else {
        dec.derived = { bet: false, best: dbest, cands: dc.cands };
      }
    }
  }

  // Exposição correlacionada: ambas as decisões do mesmo jogo a apostar → limitar ao cap de 1 aposta
  if (dec.bet && dec.derived && dec.derived.bet) capCorrelatedStakes(dec, ctx.stake);

  return dec;
}

// ===== Opções do comparador de casas (dropdown "Melhor odd e stake") =====
export function buildOpts(g: Game, calib: CalibInfo, sharp?: SharpQuote | null): CompareOption[] {
  const o = g.o, nv = noVig(o), opts: CompareOption[] = [];
  if (!o || !nv) return opts;
  const mp = modelProbs(g, sharp);
  // Sem sharp, modelProbs devolve null (ver comentário lá) — mas o comparador MANUAL continua a
  // precisar de uma probabilidade para calcular EV contra as odds reais que o utilizador insere,
  // por isso aqui (só aqui) cai-se para o no-vig da odd de referência (nv) como estimativa fraca.
  // Quem chama (main.ts) tem de sinalizar isto ao utilizador — ver getSharp(g) em detailHtml/
  // compareOdds — e nunca mostrar um veredito automático "APOSTAR" com esta base.
  const p0 = mp ? mp.p : nv;
  const adjP = (raw: number) => applyCalib(raw, calib).p;
  const p = { h: adjP(p0.h), d: adjP(p0.d), a: adjP(p0.a) };
  opts.push({ k: "1", lbl: "1 — " + g.h.n, p: p.h, ref: o.h });
  opts.push({ k: "X", lbl: "X — Empate", p: p.d, ref: o.d });
  opts.push({ k: "2", lbl: "2 — " + g.a.n, p: p.a, ref: o.a });
  opts.push({ k: "1X", lbl: "1X (dupla hipótese)", p: p.h + p.d, ref: null });
  opts.push({ k: "12", lbl: "12 (dupla hipótese)", p: p.h + p.a, ref: null });
  opts.push({ k: "X2", lbl: "X2 (dupla hipótese)", p: p.d + p.a, ref: null });
  const gm = goalModel(g, sharp);
  if (gm) {
    const m = gm.matrix;
    if (o.l != null && o.ov && o.un) {
      const ou = matOverUnder(m, o.l);
      opts.push({ k: "GOV", lbl: "Mais de " + o.l + " golos", p: adjP(ou.over), ref: o.ov });
      opts.push({ k: "GUN", lbl: "Menos de " + o.l + " golos", p: adjP(ou.under), ref: o.un });
    }
    const btts = matBTTS(m);
    opts.push({ k: "BTS", lbl: "Ambas marcam — Sim", p: adjP(btts.yes), ref: null });
    opts.push({ k: "BTN", lbl: "Ambas marcam — Não", p: adjP(btts.no), ref: null });
    const oe = matOddEven(m);
    opts.push({ k: "GOD", lbl: "Total de golos — Ímpar", p: adjP(oe.odd), ref: null });
    opts.push({ k: "GEV", lbl: "Total de golos — Par", p: adjP(oe.even), ref: null });
  }
  const H = parseLineOdd(o.sh), A = parseLineOdd(o.sa);
  if (H && Math.abs(parseFloat(H.line)) === 0.5) opts.push({ k: "HH", lbl: "Handicap " + g.h.n + " " + H.line, p: adjP(H.line.startsWith("-") ? p0.h : p0.h + p0.d), ref: H.od });
  if (A && Math.abs(parseFloat(A.line)) === 0.5) opts.push({ k: "HA", lbl: "Handicap " + g.a.n + " " + A.line, p: adjP(A.line.startsWith("-") ? p0.a : p0.d + p0.a), ref: A.od });
  if (gm) {
    if (H) opts.push({ k: "GHH", lbl: "Handicap golos " + g.h.n + " " + H.line, p: adjP(matHandicap(gm.matrix, "h", parseFloat(H.line))), ref: H.od });
    if (A) opts.push({ k: "GHA", lbl: "Handicap golos " + g.a.n + " " + A.line, p: adjP(matHandicap(gm.matrix, "a", parseFloat(A.line))), ref: A.od });
  }
  return opts;
}

// ===== Ponto de entrada: liga os módulos, gere o DOM, renderiza o HTML dinâmico =====
// Esta é a única camada que sabe de elementos concretos da página. quant/storage/api
// não tocam no DOM — tudo o que aqui se vê é orquestração e apresentação.

import * as quant from "./quant";
import * as storage from "./storage";
import * as api from "./api";
import { LS } from "./storage";
import { PRELOADED_FALLBACK } from "./data-fallback";
import {
  BACKUP_STALE_DAYS, CARD_ODDS_REFRESH_MS, CLOSE_ODDS_CAPTURE_MS, CLOSE_ODDS_WINDOW_H, CLV_MIN_N,
  CMP_ODDS_REFRESH_MS, CMP_ODDS_TICK_MS, EV_MIN, EV_MIN_FRIENDLY, LINE_MOVEMENT_ALERT,
  MODEL_BLEND_W, MODEL_HOME_ADV, PENDING_RISK_FRAC, RECALIB_MIN_N, SETTLE_REMINDER_H, STAKE_CAP_FRAC,
  STOP_LOSS_DRAWDOWN_FRAC
} from "./config";
import { esc, fmt2, fmtDate, formHtml, num, pct, ymd } from "./utils";
import { icon } from "./icons";
import type { Bet, BetStatus, DecisionContext, FinalScore, Game, ModelDecision, PreloadedData, SharpQuote, StopLossStatus } from "./types";

// ===== Estado da aplicação (em memória, não persistido) =====
let curDate = new Date();
curDate.setHours(12, 0, 0, 0);   // ancora a meio-dia local para o nav de dias não escorregar em mudanças de hora (DST)
// Populados de forma assíncrona por loadPreloadedData() antes de bootstrapInner() correr —
// começam vazios (nunca lidos antes disso, ver bootstrap()).
let preloaded: PreloadedData = PRELOADED_FALLBACK;
let games: Game[] = [];

// Vai buscar os jogos/odds do dia a public/data.json (regenerado pela tarefa diária, ver
// scripts/update-daily-data.mjs) em vez de os importar estaticamente do bundle — assim uma
// atualização de dados não obriga a um rebuild/redeploy do JS. Cai para o snapshot embutido
// (PRELOADED_FALLBACK, desatualizado por definição) só se o fetch falhar de vez — rede em baixo,
// ficheiro ausente/corrompido — para a app nunca ficar com um ecrã vazio/partido.
async function loadPreloadedData(): Promise<PreloadedData> {
  try {
    const url = import.meta.env.BASE_URL + "data.json";
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("http-" + r.status);
    const data = await r.json();
    if (!data || !Array.isArray(data.games)) throw new Error("formato-invalido");
    return data as PreloadedData;
  } catch (e) {
    console.warn("Falha ao carregar data.json em runtime — a usar o snapshot embutido (desatualizado):", e);
    return PRELOADED_FALLBACK;
  }
}

let curTab: "games" | "log" = "games";
let gameFilter: "all" | "value" | "hideFriendly" = "all";
let currentOpts: Record<string, ReturnType<typeof quant.buildOpts>> = {};
const aiCache = new Map<string, string>();
let bankChart: unknown = null;

// ===== Frescura de odds ao vivo — card fechado (Pinnacle) e comparador aberto (Betclic) =====
// Só a data do último fetch BEM SUCEDIDO por jogo; se um pedido falhar, não se atualiza — o
// indicador fica a envelhecer sozinho (nunca mostramos um erro que interrompa o resto da página).
const cardOddsFreshness = new Map<string, number>();
const cmpOddsFreshness = new Map<string, number>();
let cardOddsTimer: ReturnType<typeof setInterval> | null = null;
let cmpOddsTimer: ReturnType<typeof setInterval> | null = null;
let closeOddsTimer: ReturnType<typeof setInterval> | null = null;

function freshLabel(ts: number | undefined): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? "há " + s + "s" : "há " + Math.round(s / 60) + " min";
}

// ===== Contexto de decisão: banca/perfil/risco pendente + calibração, recalculado por render =====
// autoDecide é uma função pura — recalcular por chamada é barato para a escala desta app e evita
// ter de invalidar manualmente uma cache sempre que uma aposta é registada/liquidada (como no
// monólito original, que geria isto à mão com window._dec = {}).
function buildDecisionContext(): DecisionContext {
  const bets = LS.bets;
  const calib = quant.calibInfo(bets);
  const bank = parseFloat(LS.bank) || 0;
  const kellyFrac = LS.kellyFrac;
  const pendingStake = storage.computePnL(bets).pendingStake;
  // Gate de risco por CLV: resolvido aqui (main.ts decide), quant.computeStake só multiplica.
  const riskMult = quant.clvGate(bets).mult;
  return { calib, stake: { bank, kellyFrac, pendingStake, riskMult } };
}
// Odd "sharp" (Pinnacle) desta função: síncrona, cache-or-trigger — ver api.getSharpOdds.
// Primeira chamada devolve null e dispara o fetch em segundo plano; quando chega, onSharpResult
// (wired em bootstrap) força um re-render, tal como já acontecia com a inferência ONNX.
function getSharp(g: Game): SharpQuote | null {
  return api.getSharpOdds(g);
}
// Nome amigável da casa de apostas por trás da odd de referência — normalmente DraftKings; ver
// Odds.src (script diário) para quando a DraftKings não tinha linha e se caiu para a Betclic.
function referenceBookLabel(g: Game): string {
  return g.o?.src === "betclic_fr" ? "Betclic" : "DraftKings";
}
// Nota de transparência: de onde veio a probabilidade de mercado usada no no-vig deste jogo.
function marketSourceNote(g: Game): string {
  return getSharp(g) ? " · mercado: Pinnacle (sharp)" : " · mercado: " + referenceBookLabel(g) + "/ESPN (referência)";
}
function getDecision(g: Game): ModelDecision {
  return quant.autoDecide(g, buildDecisionContext(), getSharp(g));
}

// Stop-loss por período: recalculado por chamada (barato, mesmo padrão de buildDecisionContext) —
// trava o registo de novas sugestões depois de uma sequência má recente, sem tocar no Kelly/EV
// em si (a decisão continua a ser mostrada, só o botão de registo fica bloqueado).
function currentStopLoss(): StopLossStatus {
  return quant.stopLossStatus(LS.bets, parseFloat(LS.bank) || 0);
}

function pendingBetsFor(gameId: string): Bet[] {
  return LS.bets.filter(b => b.gameId === gameId && b.status === "pending");
}

// Só chega a mostrar-se para apostas que autoSettlePending não conseguiu liquidar sozinho — mercado
// não reconhecido ou linha que não deu para extrair do texto da label (ver quant.resolveBetOutcome).
// A esmagadora maioria (1X2, dupla hipótese, BTTS, mais/menos golos, handicap 1X2 e de golos) já vem
// liquidada antes de qualquer card/detalhe ser construído (ver renderInner/renderLog).
function finalScoreBox(g: Game): string {
  const pending = pendingBetsFor(g.id);
  if (!pending.length) return "";
  const score = api.getFinalScore(g);
  if (!score) return "";
  const lines = pending.map(b =>
    '<div class="kv" style="margin-top:6px">' + esc(b.sel) + ' — não consegui ler o resultado desta seleção automaticamente: confirma manualmente na aba "Os meus resultados".</div>'
  ).join("");
  return '<div class="banner">' + icon("check") + ' Resultado final: <b>' + esc(g.h.n) + " " + score.home + "-" + score.away + " " + esc(g.a.n) + '</b> (ESPN)' + lines + '</div>';
}

// Resolve o resultado de uma aposta pendente independentemente de o Game original ainda estar em
// `games` — usa os campos denormalizados (Bet.lg/kickoff/homeTeam/awayTeam, ver types.ts) quando
// presentes; cai para o comportamento antigo (procurar em `games`) para apostas antigas que ainda
// não os têm gravados.
function resolveScoreForBet(b: Bet): FinalScore | null {
  if (b.lg && b.kickoff && b.homeTeam && b.awayTeam) {
    return api.getFinalScoreFor(b.gameId, b.lg, b.kickoff, b.homeTeam, b.awayTeam);
  }
  const g = games.find(x => x.id === b.gameId);
  return g ? api.getFinalScore(g) : null;
}

// ===== Liquidação automática de TODAS as apostas pendentes (reais, automáticas e "não-apostas") —
// sem clique. O resultado (Ganhou/Perdeu/Anulada) é lido diretamente do placar final (ESPN) via
// quant.resolveBetOutcome, que cobre 1X2, dupla hipótese, BTTS, mais/menos de N golos e handicap
// (1X2 e de golos) — só fica pendente para confirmação manual quando o mercado não é reconhecido ou
// a linha não dá para extrair do texto da label (nunca arrisca uma leitura errada a corromper o
// P&L). Chamada a cada render (ver renderInner/renderLog) — idempotente, só toca em bets "pending".
// Os botões manuais (settleBetUI) continuam sempre visíveis como override; uma correção manual limpa
// Bet.autoSettled (ver storage.settleBet) mesmo que reverta um status posto automaticamente.
// Continua a incluir bets rejected:true de propósito (não são apostas reais, mas já se liquidavam
// sozinhas antes desta função existir — storage.computeRejectedStats depende disso para chegar a
// win/loss; excluí-las aqui seria uma regressão silenciosa, não uma melhoria).
function autoSettlePending(bets: Bet[]): void {
  let settled = false;
  for (const b of bets) {
    if (b.status !== "pending") continue;
    const score = resolveScoreForBet(b);
    if (!score) continue;
    const outcome = quant.resolveBetOutcome(b, score);
    if (outcome) { storage.settleBet(b.id, outcome, true); settled = true; }
  }
  if (settled) void autoSyncExternalIfEnabled();
}

// ===== Registo automático e não enviesado das sugestões do modelo =====
// Se o utilizador só registasse manualmente as apostas que "sente" serem boas, a calibração/CLV
// passariam a medir o julgamento dele, não o do modelo. Com "Registar sugestões automaticamente"
// ativo, toda a sugestão bet:true é gravada sozinha, com auto:true, usando um selKey com prefixo
// "AUTO:" (mesma técnica do prefixo "D:" da segunda oportunidade) para nunca colidir com o registo
// manual real do utilizador nem com ele próprio ser registado duas vezes.
function autoRegisterIfEnabled(g: Game, dec: ModelDecision): void {
  if (!LS.autoRegister) return;
  if (g.dt.getTime() <= Date.now()) return;   // nunca registar/re-registar decisões de jogos já começados (ver card())
  const bank = parseFloat(LS.bank) || 0;
  let saved = false;
  if (dec.bet) {
    const key = "AUTO:" + (dec.bestKey as string);
    if (!storage.betAlreadyLogged(g.id, key)) {
      const stakeVal = bank ? (dec.stakeFrac as number) * bank : (dec.stakeFrac as number) * 100;
      storage.saveBet({ gameId: g.id, selKey: key, sel: dec.lbl as string, game: g.h.n + " vs " + g.a.n, odd: dec.od as number, stake: stakeVal.toFixed(2), prob: dec.p as number, auto: true, lg: g.lg, modelInputs: dec.modelInputs, homeTeam: g.h.n, awayTeam: g.a.n, kickoff: g.d });
      saved = true;
    }
  }
  const d2 = dec.derived;
  if (d2 && d2.bet) {
    const key2 = "AUTO:D:" + (d2.bestKey as string);
    if (!storage.betAlreadyLogged(g.id, key2)) {
      const stakeVal2 = bank ? (d2.stakeFrac as number) * bank : (d2.stakeFrac as number) * 100;
      storage.saveBet({ gameId: g.id, selKey: key2, sel: d2.lbl as string, game: g.h.n + " vs " + g.a.n, odd: d2.od as number, stake: stakeVal2.toFixed(2), prob: d2.p as number, auto: true, lg: g.lg, homeTeam: g.h.n, awayTeam: g.a.n, kickoff: g.d });
      saved = true;
    }
  }
  if (saved) updLogCount();
}

// ===== Rastreio de "não-apostas": candidatos com EV insuficiente (marginal ou negativo) — guardados
// com rejected:true, stake=0€ risco real nenhum, só para medir depois se "não apostar" foi a decisão
// certa (ver storage.computeRejectedStats). Prefixo "REJ:" novo, na mesma família de "AUTO:"/"D:",
// para nunca colidir com apostas reais/automáticas no dedup de betAlreadyLogged.
function trackRejectedIfEnabled(g: Game, dec: ModelDecision): void {
  if (!LS.trackRejected) return;
  if (g.dt.getTime() <= Date.now()) return;   // mesmo guard de autoRegisterIfEnabled — nunca em jogos já começados
  if (dec.bet || !dec.best) return;
  // Só rastreia candidatos 1X2 simples — quant.resolveBetOutcome resolve-os com confiança direta
  // do placar, garantindo que toda entrada rejeitada acaba por se liquidar sozinha.
  if (dec.best.k !== "1" && dec.best.k !== "X" && dec.best.k !== "2") return;
  const key = "REJ:" + (dec.best.k as string);
  if (storage.betAlreadyLogged(g.id, key)) return;
  const bank = parseFloat(LS.bank) || 0;
  const ctx = buildDecisionContext();
  const stakeInfo = quant.computeStake(dec.best.p, dec.best.od as number, ctx.stake);
  const stakeVal = bank ? stakeInfo.frac * bank : stakeInfo.frac * 100;
  storage.saveBet({
    gameId: g.id, selKey: key, sel: dec.best.lbl, game: g.h.n + " vs " + g.a.n,
    odd: dec.best.od as number, stake: stakeVal.toFixed(2), prob: dec.best.p,
    rejected: true, lg: g.lg, homeTeam: g.h.n, awayTeam: g.a.n, kickoff: g.d
  });
  updLogCount();
}

// ===== Toasts: substitui alert()s invasivos por notificações flutuantes =====
function showToast(msg: string, type?: "success" | "error" | "info"): void {
  const t = type === "success" || type === "error" ? type : "info";
  const wrap = document.getElementById("toastwrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = "toast " + t;
  el.textContent = msg;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// ===== Lembretes passivos: aparecem quando abres a app, nada de notificações push =====
// (os dados só existem no localStorage do browser, por isso não há como avisar-te fora dela)
function reminderBanner(): string {
  const bets = LS.bets;
  const now = Date.now();
  const settleMs = SETTLE_REMINDER_H * 3600000, closeMs = CLOSE_ODDS_WINDOW_H * 3600000;
  let toSettle = 0, toClose = 0;
  for (const b of bets) {
    const g = games.find(x => x.id === b.gameId);
    if (!g) continue;
    const kickoff = g.dt.getTime();
    if (b.status === "pending" && (now - kickoff) > settleMs) toSettle++;
    if (!b.oddClose && (kickoff - now) < closeMs) toClose++;
  }
  if (!toSettle && !toClose) return "";
  const parts: string[] = [];
  if (toSettle) parts.push(toSettle + (toSettle === 1 ? " aposta" : " apostas") + " de jogos já terminados por resolver");
  if (toClose) parts.push(toClose + (toClose === 1 ? " aposta" : " apostas") + " sem odd de fecho registada");
  return '<div class="banner">⏰ Tens ' + parts.join(" e ") + '. <button class="btn copy" style="margin-left:6px;padding:3px 8px" onclick="switchTab(\'log\')">Ver</button></div>';
}

// ===== Resultado de ontem: aparece uma vez por dia ao abrir a app =====
// Agrupa pela data do JOGO (via games.find), não pela data em que a aposta foi registada — é
// o que corresponde a "ontem" no sentido de "os jogos de ontem", mesmo que a aposta tenha sido
// registada dias antes. Cai para loggedAt só se o jogo já não existir em memória (fora de época).
// Marca-se como já mostrado em LS assim que devolve conteúdo — não é um popup, é um banner que
// simplesmente deixa de aparecer depois da primeira vez nesse dia (sem alert()/modal bloqueante).
function yesterdayResultBanner(): string {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const todayKey = ymd(today);
  if (LS.lastYesterdayBannerDate === todayKey) return "";
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const yKey = ymd(yesterday);
  const bets = LS.bets.filter(b => {
    const g = games.find(x => x.id === b.gameId);
    const d = g ? g.dt : new Date(b.loggedAt);
    return ymd(d) === yKey;
  });
  if (!bets.length) return "";
  const real = bets.filter(b => !b.paper && !b.auto);   // mesmo critério de P&L "real" usado em renderLog
  const resolved = real.filter(b => b.status === "win" || b.status === "loss");
  const pending = real.filter(b => b.status === "pending");
  if (!resolved.length && !pending.length) return "";
  const s = storage.computePnL(real);
  const cur = LS.bank ? "€" : "u";
  const money = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2) + (cur === "€" ? " €" : " u");
  let txt = "Ontem: ";
  const parts: string[] = [];
  if (resolved.length) parts.push(resolved.length + (resolved.length === 1 ? " aposta resolvida, " : " apostas resolvidas, ") + money(s.profit));
  if (pending.length) parts.push(pending.length + (pending.length === 1 ? " por liquidar" : " por liquidar"));
  txt += parts.join(" · ");
  LS.lastYesterdayBannerDate = todayKey;
  return '<div class="banner">' + txt + ' <button class="btn copy" style="margin-left:6px;padding:3px 8px" onclick="switchTab(\'log\')">Ver</button></div>';
}

function updLogCount(): void {
  const el = document.getElementById("logCount");
  if (el) el.textContent = String(LS.bets.length);
}

// ===== Painel de calibração (dentro da aba "Os meus resultados") =====
function calibrationPanel(bets: Bet[]): string {
  const c = quant.calibration(bets);
  if (c.n < 1) return "";   // nada resolvido ainda com probabilidade

  let h = '<h3 style="font-size:14px;letter-spacing:.5px;color:var(--accent);margin:22px 0 4px">CALIBRAÇÃO DO MODELO</h3>';
  h += '<div class="kv" style="margin-bottom:10px">As tuas probabilidades merecem confiança? Isto compara o que o modelo <b>previu</b> com o que <b>realmente aconteceu</b>. Não precisa de saber a probabilidade "real" de cada jogo — mede a fiabilidade no conjunto.</div>';

  if (c.n < 30) {
    const calibPct = Math.min(100, (c.n / 30) * 100);
    h += '<div class="warnbox">' + icon("alert") + ' Só <b>' + c.n + '</b> aposta(s) resolvida(s) com probabilidade registada. A calibração só ganha significado a partir de ~30-50, e fica sólida acima de 100. Até lá, lê isto como indicativo, não como veredito.'
      + '<div class="calibbar"><div class="calibbar-fill" style="width:' + calibPct + '%"></div></div>'
      + '<div class="kv" style="margin-top:4px">' + c.n + ' / 30 apostas até a calibração começar a ser fiável</div>'
      + '</div>';
  }

  // Viés global
  const bias = ((c.avgPred as number) - c.avgActual) * 100;
  const biasAbs = Math.abs(bias);
  let biasTxt: string, biasCls: string;
  if (biasAbs < 3) { biasTxt = "bem calibrado — o modelo prevê perto do que acontece"; biasCls = "pos"; }
  else if (bias > 0) { biasTxt = "otimista — infla as probabilidades em ~" + biasAbs.toFixed(0) + " pontos. Desconta isto antes de confiar em qualquer EV"; biasCls = "neg"; }
  else { biasTxt = "pessimista — subestima as probabilidades em ~" + biasAbs.toFixed(0) + " pontos"; biasCls = "neg"; }

  // Brier + skill vs base
  const skill = (c.brier != null && c.brierBase != null) ? (c.brier < c.brierBase) : null;
  const brierTxt = c.brier == null ? "—" : c.brier.toFixed(3);
  const skillTxt = skill === null ? "" : (skill
    ? "melhor que apostar sempre na média (tem informação real)"
    : "não bate apostar sempre na média — o modelo não está a acrescentar sinal");

  h += '<div class="stats" style="margin-bottom:10px">'
    + '<div class="stat"><div class="lbl">Viés global</div><div class="val ' + biasCls + '" style="font-size:18px">' + (bias >= 0 ? "+" : "") + bias.toFixed(1) + ' pts</div><div class="sub2">previu ' + (100 * (c.avgPred as number)).toFixed(0) + '%, aconteceu ' + (100 * c.avgActual).toFixed(0) + '%</div></div>'
    + '<div class="stat"><div class="lbl">Brier score</div><div class="val ' + (skill ? "pos" : "neg") + '" style="font-size:18px">' + brierTxt + '</div><div class="sub2">' + (skill === null ? "" : (skill ? "< base " + (c.brierBase as number).toFixed(3) + " ✓" : "≥ base " + (c.brierBase as number).toFixed(3))) + '</div></div>'
    + '</div>';

  h += '<div class="kv" style="margin-bottom:6px"><b>Leitura:</b> o modelo está ' + biasTxt + '.' + (skillTxt ? ' Quanto ao Brier, ' + skillTxt + '.' : '') + '</div>';

  // Gráfico previsto vs real por faixa (SVG)
  const active = c.bins.filter(b => b.n > 0);
  if (active.length) {
    const W = 440, rowH = 34, padL = 70, padR = 90, top = 8, chartW = W - padL - padR;
    const H = top + active.length * rowH + 6;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:' + W + 'px;margin-top:4px" font-family="inherit">';
    for (let t = 0; t <= 100; t += 25) {
      const x = padL + chartW * t / 100;
      svg += '<line x1="' + x + '" y1="' + top + '" x2="' + x + '" y2="' + (H - 6) + '" stroke="#2a2f3a" stroke-width="1"/>';
      svg += '<text x="' + x + '" y="' + (H - 0) + '" fill="#7a8291" font-size="8" text-anchor="middle">' + t + '%</text>';
    }
    active.forEach((b, i) => {
      const y = top + i * rowH;
      const pred = 100 * b.predSum / b.n, act = 100 * b.wins / b.n;
      const xPred = padL + chartW * pred / 100, xAct = padL + chartW * act / 100;
      const faixa = (100 * b.lo).toFixed(0) + "-" + (100 * b.hi > 100 ? 100 : 100 * b.hi).toFixed(0) + "%";
      svg += '<text x="' + (padL - 6) + '" y="' + (y + 15) + '" fill="#c9d1dc" font-size="10" text-anchor="end">' + faixa + '</text>';
      svg += '<line x1="' + xPred + '" y1="' + (y + 12) + '" x2="' + xAct + '" y2="' + (y + 12) + '" stroke="#3a4150" stroke-width="2"/>';
      svg += '<circle cx="' + xPred + '" cy="' + (y + 12) + '" r="4.5" fill="var(--accent)"/>';
      const worse = act < pred - 2;
      svg += '<circle cx="' + xAct + '" cy="' + (y + 12) + '" r="4.5" fill="' + (worse ? "#e88" : "#6dd18e") + '"/>';
      svg += '<text x="' + (W - padR + 6) + '" y="' + (y + 15) + '" fill="#7a8291" font-size="9">n=' + b.n + '</text>';
    });
    svg += '</svg>';
    h += '<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 10px 4px">' + svg
      + '<div class="kv" style="margin-top:6px"><span style="color:var(--accent)">●</span> previsto pelo modelo &nbsp; <span style="color:#6dd18e">●</span> aconteceu (na meta) &nbsp; <span style="color:#e88">●</span> aconteceu menos que o previsto. Idealmente os dois pontos coincidem.</div></div>';
  }

  h += '<div class="note" style="margin-top:8px">Como usar: se o viés for muito otimista, sobe o teu limiar de EV ou desconfia dos sinais fracos. Um modelo pode dar lucro por sorte num período curto e continuar mal calibrado — por isso olha para isto <b>e</b> para o yield, com muitas apostas.</div>';

  h += weightSuggestionPanel(bets);

  return h;
}

// ===== Recalibração periódica dos pesos (sugestão textual, nunca aplicada sozinha) =====
function weightSuggestionPanel(bets: Bet[]): string {
  const s = quant.suggestModelWeights(bets);
  if (!s.active) {
    if (s.n > 0) {
      return '<div class="note" style="margin-top:6px">Recalibração de pesos: ' + s.n + ' / ' + RECALIB_MIN_N + ' apostas 1X2 com dados guardados — ainda insuficiente para sugerir novos pesos com confiança.</div>';
    }
    return "";
  }
  if (!s.improved) {
    return '<div class="kv" style="margin-top:6px">' + icon("check") + ' Recalibração de pesos (' + s.n + ' apostas): os pesos atuais (w=' + MODEL_BLEND_W.toFixed(2) + ', vantagem casa ' + MODEL_HOME_ADV.toFixed(2) + ') já são os melhores desta grelha de pesquisa para o teu histórico.</div>';
  }
  return '<div class="banner" style="margin-top:6px">' + icon("alert") + ' <b>Recalibração de pesos</b> — com base nas tuas últimas ' + s.n + ' apostas 1X2, pesos w=' + s.bestW.toFixed(2)
    + ' / vantagem casa ' + s.bestHomeAdv.toFixed(2) + ' teriam dado um Brier score melhor (' + s.bestBrier.toFixed(4) + ' vs ' + (s.currentBrier as number).toFixed(4) + ' atual) — considera ajustar manualmente '
    + 'MODEL_BLEND_W/MODEL_HOME_ADV em config.ts. Isto não é aplicado automaticamente.</div>';
}

// ===== Segmentação por mercado e por liga — reaproveita computePnL/avgCLV, só com filtros
// diferentes (nenhuma lógica de cálculo duplicada). Amostras < SEGMENT_MIN_N ficam marcadas como
// "amostra insuficiente" em vez de mostrarem um ROI enganosamente preciso. =====
const SEGMENT_MIN_N = 15;

function segmentStatsHtml(label: string, segBets: Bet[]): string {
  const s = storage.computePnL(segBets);
  const clv = storage.avgCLV(segBets);
  const insufficient = s.settled < SEGMENT_MIN_N;
  const cur = LS.bank ? "€" : "u";
  const money = (v: number) => (v >= 0 ? "" : "−") + Math.abs(v).toFixed(2) + (cur === "€" ? " €" : " u");
  const pc = s.profit > 0 ? "pos" : s.profit < 0 ? "neg" : "neu";
  const rc = insufficient ? "neu" : (s.roi > 0 ? "pos" : s.roi < 0 ? "neg" : "neu");
  const roiTxt = insufficient ? "—" : ((s.roi >= 0 ? "+" : "") + (100 * s.roi).toFixed(1) + "%");
  return '<div style="margin-bottom:10px">'
    + '<div class="kv" style="margin-bottom:4px"><b>' + esc(label) + '</b>'
    + (insufficient ? ' — <span style="color:#e0b080">' + icon("alert") + ' amostra insuficiente (' + s.settled + '/' + SEGMENT_MIN_N + ')</span>' : '')
    + '</div>'
    + '<div class="stats">'
    + '<div class="stat"><div class="lbl">Lucro/Prejuízo</div><div class="val ' + pc + '">' + money(s.profit) + '</div><div class="sub2">' + s.settled + ' resolvidas</div></div>'
    + '<div class="stat"><div class="lbl">Yield (ROI)</div><div class="val ' + rc + '">' + roiTxt + '</div><div class="sub2">' + (insufficient ? "mín. " + SEGMENT_MIN_N + " para ROI fiável" : "lucro ÷ apostado") + '</div></div>'
    + '<div class="stat"><div class="lbl">Taxa de acerto</div><div class="val neu">' + (s.settled ? (100 * s.hitRate).toFixed(0) : "—") + '%</div><div class="sub2">' + s.wins + 'V · ' + s.losses + 'D</div></div>'
    + '<div class="stat"><div class="lbl">CLV médio</div><div class="val neu">' + (clv ? ((clv.avg >= 0 ? "+" : "") + (100 * clv.avg).toFixed(1) + "%") : "—") + '</div><div class="sub2">' + (clv ? clv.n + " c/ fecho" : "sem fecho") + '</div></div>'
    + '</div></div>';
}

function segmentedPerformancePanels(realBets: Bet[]): string {
  if (!realBets.length) return "";
  let html = "";

  html += '<h3 style="font-size:13px;letter-spacing:.5px;color:var(--accent);margin:20px 0 8px">DESEMPENHO POR MERCADO</h3>';
  const marketSegments: [string, (b: Bet) => boolean][] = [
    ["1X2 / dupla hipótese / handicap principal", b => !quant.stripAutoPrefix(b.selKey).startsWith("D:")],
    ["Golos / handicap (segunda oportunidade)", b => quant.stripAutoPrefix(b.selKey).startsWith("D:")]
  ];
  for (const [label, filter] of marketSegments) {
    const segBets = realBets.filter(filter);
    if (segBets.length) html += segmentStatsHtml(label, segBets);
  }

  const leagues = Array.from(new Set(realBets.map(b => b.lg).filter((lg): lg is string => !!lg))).sort();
  if (leagues.length) {
    html += '<h3 style="font-size:13px;letter-spacing:.5px;color:var(--accent);margin:20px 0 8px">DESEMPENHO POR LIGA</h3>';
    for (const liga of leagues) {
      html += segmentStatsHtml(liga, realBets.filter(b => b.lg === liga));
    }
    const noLg = realBets.length - realBets.filter(b => b.lg).length;
    if (noLg) html += '<div class="note">' + noLg + ' aposta(s) sem liga registada (de antes desta funcionalidade existir).</div>';
  }

  return html;
}

function renderLog(): void {
  const lv = document.getElementById("logview");
  if (!lv) return;
  const allBets = LS.bets.slice().sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime());
  if (!allBets.length) {
    lv.innerHTML = '<div class="empty">Ainda não registaste nenhuma aposta.<br><br>'
      + 'Quando o dashboard sugerir uma aposta (ou fizeres a tua própria escolha), carrega em <b>"Registei esta aposta"</b>. '
      + 'Aqui vais ver o teu <b>lucro/prejuízo real</b> — a única métrica que diz a verdade sobre se a estratégia funciona.</div>';
    return;
  }
  // Modo papel e registo automático: ambos alimentam calibração/CLV/Brier na mesma (mais amostra,
  // mais cedo fiável, e sem o viés de só se registar o que "parece bom"), mas ficam fora do P&L
  // "real" — computePnL/avgCLV recebem o filtro que os separa, sem precisar de duas funções.
  const isReal = (b: Bet) => !b.paper && !b.auto && !b.rejected;
  const realBets = allBets.filter(isReal);
  const paperBets = allBets.filter(b => b.paper);
  const autoBets = allBets.filter(b => b.auto);
  const s = storage.computePnL(allBets, isReal);
  const clv = storage.avgCLV(allBets);
  const gate = quant.clvGate(allBets);

  autoSettlePending(allBets);

  // Lembrete de backup: se já lá vão BACKUP_STALE_DAYS dias sem exportar, oferece um botão de 1
  // clique bem visível (não escondido num menu) — nunca dispara o download sozinho fora de um
  // clique real do utilizador (browsers bloqueiam/inconsistem downloads sem gesto direto).
  let autoBackupMsg = "";
  const lastExp = LS.lastExport ? new Date(LS.lastExport).getTime() : 0;
  const daysSinceExport = lastExp ? (Date.now() - lastExp) / 86400000 : Infinity;
  if (daysSinceExport >= BACKUP_STALE_DAYS) {
    autoBackupMsg = '<div class="warnbox" style="margin-bottom:10px">📦 <b>Já lá vão mais de ' + BACKUP_STALE_DAYS + ' dias sem exportar</b> — todo o histórico vive só neste browser; um "limpar dados" apagava-o. '
      + '<button class="btn copy" style="margin-left:8px" onclick="exportJSON()">' + icon("download") + ' Exportar agora (JSON)</button></div>';
  }
  const pc = s.profit > 0 ? "pos" : s.profit < 0 ? "neg" : "neu";
  const rc = s.roi > 0 ? "pos" : s.roi < 0 ? "neg" : "neu";
  const cc = clv ? (clv.avg > 0 ? "pos" : clv.avg < 0 ? "neg" : "neu") : "neu";
  const cur = LS.bank ? "€" : "u";  // se sem banca, mostra em unidades abstratas
  const money = (v: number) => (v >= 0 ? "" : "−") + Math.abs(v).toFixed(2) + (cur === "€" ? " €" : " u");

  let html = '<h2 style="font-size:16px;letter-spacing:1px;color:var(--accent);margin:4px 0 12px">DESEMPENHO REAL</h2>';

  html += '<div class="btns" style="margin-bottom:14px">'
    + '<button class="btn copy" onclick="exportCSV()">' + icon("download") + ' Exportar CSV</button>'
    + '<button class="btn copy" onclick="exportJSON()">' + icon("download") + ' Exportar JSON</button>'
    + '<button class="btn copy" onclick="document.getElementById(\'importFile\').click()">⬆️ Importar JSON</button>'
    + '<input type="file" id="importFile" accept="application/json" style="display:none" onchange="importJSON(this.files[0])">'
    + (canSyncExternal() ? '<button class="btn copy" onclick="syncExternal(this)">' + icon("refresh") + ' Sincronizar com Google Sheets/Notion</button>' : '')
    + '</div>';

  html += autoBackupMsg;

  // Aviso honesto quando a amostra é pequena
  if (s.settled < 30) {
    html += '<div class="warnbox">' + icon("alert") + ' Só tens <b>' + s.settled + ' aposta(s) resolvida(s)</b>. '
      + 'Com uma amostra tão pequena, qualquer lucro ou prejuízo é sobretudo sorte, não indicação de que a estratégia ganha. '
      + 'São precisas <b>centenas</b> de apostas para saber alguma coisa com confiança. Regista tudo, sê honesto nos resultados, e olha para estes números a frio.</div>';
  }

  const bankCurve = storage.bankCurveData(realBets);
  if (bankCurve.length >= 2) {
    html += '<div style="background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:16px"><canvas id="bankChart" height="70"></canvas></div>';
  }

  // CLV médio é promovido a par do P&L — é o sinal de edge que fica fiável primeiro (~50 apostas),
  // muito antes do P&L (que precisa de centenas). Ver quant.clvGate(): já está a travar/libertar
  // stake automaticamente, isto só o torna visível em vez de "um número solto".
  html += '<div class="stats stats-headline" style="grid-template-columns:1fr 1fr;margin-bottom:10px">'
    + '<div class="stat"><div class="lbl">Lucro / Prejuízo (real)</div><div class="val ' + pc + '" style="font-size:26px">' + money(s.profit) + '</div><div class="sub2">' + s.settled + ' apostas · só fiável com centenas</div></div>'
    + '<div class="stat"><div class="lbl">CLV médio — sinal de edge</div><div class="val ' + cc + '" style="font-size:26px">' + (clv ? ((clv.avg >= 0 ? "+" : "") + (100 * clv.avg).toFixed(1) + "%") : "—") + '</div><div class="sub2">' + (clv ? clv.n + " aposta(s) c/ fecho · fiável a partir de ~" + CLV_MIN_N : "sem odds de fecho registadas") + '</div></div>'
    + '</div>';

  if (gate.active && gate.mult < 1) {
    html += '<div class="warnbox">📉 <b>CLV médio de ' + (100 * (gate.avg as number)).toFixed(1) + '%</b> em ' + gate.n + ' apostas com odd de fecho — o histórico sugere que não estás a bater o fecho do mercado (sem edge real confirmado). As stakes novas estão automaticamente reduzidas para ' + (100 * gate.mult).toFixed(0) + '% do Kelly normal até o CLV melhorar.</div>';
  } else if (gate.active && gate.mult === 1 && (gate.avg as number) > 0) {
    html += '<div class="kv" style="margin-bottom:10px">' + icon("check") + ' CLV médio positivo em ' + gate.n + ' apostas — o histórico sustenta usar a fração de Kelly completa que escolheste.</div>';
  }

  html += '<div class="stats">'
    + '<div class="stat"><div class="lbl">Yield (ROI)</div><div class="val ' + rc + '">' + (s.roi >= 0 ? "+" : "") + (100 * s.roi).toFixed(1) + '%</div><div class="sub2">lucro ÷ total apostado</div></div>'
    + '<div class="stat"><div class="lbl">Taxa de acerto</div><div class="val neu">' + (100 * s.hitRate).toFixed(0) + '%</div><div class="sub2">' + s.wins + 'V · ' + s.losses + 'D' + (s.voids ? " · " + s.voids + " anul." : "") + '</div></div>'
    + '<div class="stat"><div class="lbl">Total apostado</div><div class="val neu">' + s.staked.toFixed(2) + (cur === "€" ? " €" : " u") + '</div><div class="sub2">odd média ' + (s.avgOdd ? s.avgOdd.toFixed(2) : "—") + '</div></div>'
    + '<div class="stat"><div class="lbl">Por resolver</div><div class="val neu">' + s.pending + '</div><div class="sub2">' + s.pendingStake.toFixed(2) + (cur === "€" ? " € em risco" : " u em risco") + '</div></div>'
    + '</div>';

  html += '<div class="note" style="margin-bottom:10px">CLV = quanto a tua odd bateu a odd de fecho (o preço mais eficiente do mercado, mesmo antes do jogo começar). Bater a linha de fecho consistentemente é o melhor indicador precoce de vantagem — fica fiável com umas ~50 apostas, ao contrário do lucro/prejuízo, que só ganha significado com centenas. Regista a odd de fecho de cada aposta na coluna abaixo assim que o mercado fechar. Quando a amostra chega a ' + CLV_MIN_N + ' apostas, o CLV médio passa a ajustar automaticamente a stake (ver aviso acima quando ativo).</div>';

  if (paperBets.length) {
    const paperStats = storage.computePnL(paperBets);
    const paperClv = storage.avgCLV(paperBets);
    const paperCalib = quant.calibration(paperBets);
    const paperMoney = (v: number) => (v >= 0 ? "" : "−") + Math.abs(v).toFixed(2) + (cur === "€" ? " €" : " u");
    const readyToGoLive = paperBets.length >= 50 && !!paperClv && paperClv.avg > 0;
    html += '<div class="banner">📝 <b>Apostas em papel:</b> ' + paperBets.length
      + ' · P&L papel: ' + paperMoney(paperStats.profit)
      + ' · Brier: ' + (paperCalib.brier != null ? paperCalib.brier.toFixed(3) : "—")
      + ' · CLV médio: ' + (paperClv ? ((paperClv.avg >= 0 ? "+" : "") + (100 * paperClv.avg).toFixed(1) + "%") : "—")
      + '<br>' + (readyToGoLive
        ? icon("check") + " Já tens 50+ apostas em papel com CLV médio positivo — é um bom momento para considerares desligar o Modo Papel."
        : "Sugestão: só desligues o Modo Papel depois de 50+ apostas em papel com CLV médio positivo.")
      + '</div>';
  }

  if (autoBets.length) {
    html += '<div class="kv" style="margin-bottom:10px">🤖 <b>' + autoBets.length + '</b> sugestão(ões) registada(s) automaticamente (amostra não enviesada para calibração/CLV) — fora do P&L real. Linhas com opacidade reduzida na tabela abaixo.</div>';
  }

  // Rastreio de "não-apostas": mede se rejeitar estes candidatos (EV insuficiente) foi a decisão
  // certa. hypotheticalProfit é sempre hipotético — nunca dinheiro real, nunca misturado no P&L acima.
  const rejStats = storage.computeRejectedStats(allBets);
  if (rejStats.n > 0) {
    const rejPc = rejStats.hypotheticalProfit > 0 ? "neg" : rejStats.hypotheticalProfit < 0 ? "pos" : "neu";
    html += '<div class="banner" style="margin-bottom:10px">🚫 <b>Não-apostas rastreadas:</b> ' + rejStats.n + ' resolvidas · teriam ganho ' + (100 * rejStats.wouldWinRate).toFixed(0) + '% das vezes'
      + ' · <span class="' + rejPc + '">se as tivesses apostado (stake hipotético): ' + (rejStats.hypotheticalProfit >= 0 ? "+" : "−") + Math.abs(rejStats.hypotheticalProfit).toFixed(2) + (cur === "€" ? " €" : " u") + '</span>'
      + '<br><span class="kv">' + (rejStats.hypotheticalProfit < 0
        ? "Não apostar nestas oportunidades salvou-te dinheiro (hipotético) até agora."
        : "Estas oportunidades rejeitadas teriam dado lucro (hipotético) — vale a pena rever se o limiar de EV está calibrado corretamente.") + '</span></div>';
  }

  html += segmentedPerformancePanels(realBets);

  html += calibrationPanel(allBets);

  html += '<table class="log"><tr><th>Data</th><th>Jogo / Seleção</th><th class="num">Odd</th><th class="num">Stake</th><th>Resultado</th><th class="num">Odd fecho</th><th class="num">CLV</th><th></th></tr>';
  for (const b of allBets) {
    const d = new Date(b.loggedAt).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
    const stat = b.status;
    const bClv = (num(b.oddClose) > 0) ? (num(b.odd) / num(b.oddClose) - 1) : null;
    const rowClasses = [b.paper ? "paper-row" : "", b.auto ? "auto-row" : "", b.rejected ? "rejected-row" : ""].filter(Boolean).join(" ");
    html += '<tr' + (rowClasses ? ' class="' + rowClasses + '"' : '') + '>'
      + '<td>' + d + '</td>'
      + '<td><b>' + esc(b.sel) + '</b>' + (b.paper ? ' <span class="pill pend">📝 papel</span>' : '') + (b.auto ? ' <span class="pill pend">🤖 auto</span>' : '') + (b.rejected ? ' <span class="pill pend">🚫 não-aposta</span>' : '') + '<br><span class="kv">' + esc(b.game) + '</span></td>'
      + '<td class="num">' + (num(b.odd) || 0).toFixed(2) + '</td>'
      + '<td class="num">' + (num(b.stake) || 0).toFixed(2) + '</td>'
      + '<td><div class="settle">'
      + '<button type="button" class="pill win ' + (stat === "win" ? "on" : "") + '" onclick="settleBet(\'' + b.id + '\',\'win\')" aria-label="Marcar aposta como ganha">Ganhou</button>'
      + '<button type="button" class="pill loss ' + (stat === "loss" ? "on" : "") + '" onclick="settleBet(\'' + b.id + '\',\'loss\')" aria-label="Marcar aposta como perdida">Perdeu</button>'
      + '<button type="button" class="pill void ' + (stat === "void" ? "on" : "") + '" onclick="settleBet(\'' + b.id + '\',\'void\')" aria-label="Marcar aposta como anulada">Anulada</button>'
      // Só aparece em apostas já resolvidas cujo status veio de quant.resolveBetOutcome (ver
      // autoSettlePending), nunca escolhido à mão — os botões acima continuam sempre disponíveis
      // para corrigir, o que limpa esta marca (ver storage.settleBet).
      + (b.autoSettled && stat !== "pending" ? ' <span class="pill pend" title="Liquidado automaticamente a partir do placar final (ESPN) — corrige acima se estiver errado">🔄 auto</span>' : "")
      + '</div></td>'
      + '<td class="num"><input type="number" step="0.01" min="1" value="' + (b.oddClose ? b.oddClose : "") + '" style="width:64px;padding:4px;border:1px solid var(--line);border-radius:6px;background:#1d2129;color:var(--ink);font-size:11px;text-align:right" onchange="setOddClose(\'' + b.id + '\', this.value)" aria-label="Odd de fecho"></td>'
      + '<td class="num" style="' + (bClv != null ? ('color:' + (bClv >= 0 ? "#6dd18e" : "var(--bad)") + ';font-weight:700') : 'color:var(--muted)') + '">' + (bClv != null ? ((bClv >= 0 ? "+" : "") + (100 * bClv).toFixed(1) + "%") : "—") + '</td>'
      + '<td><button type="button" class="delx" onclick="deleteBet(\'' + b.id + '\')" aria-label="Apagar aposta">✕</button></td>'
      + '</tr>';
  }
  html += '</table>';
  html += '<div class="note" style="margin-top:14px">Marca cada aposta como Ganhou / Perdeu / Anulada assim que o jogo termina. '
    + 'Os dados ficam guardados só neste dispositivo (localStorage) — usa "Exportar" regularmente para teres uma cópia de segurança. '
    + 'Se o yield ficar negativo ao fim de muitas apostas, a mensagem é clara: a estratégia não está a bater o mercado — e isso é informação valiosa, não fracasso.</div>';

  lv.innerHTML = html;
  if (bankCurve.length >= 2) renderBankChart(bankCurve);
}

// ===== Gráfico de evolução da banca (Chart.js) =====
function renderBankChart(points: number[]): void {
  const canvas = document.getElementById("bankChart") as HTMLCanvasElement | null;
  if (!canvas || typeof Chart === "undefined") return;
  if (bankChart) { (bankChart as { destroy: () => void }).destroy(); bankChart = null; }
  const final = points[points.length - 1];
  const lineColor = final >= 0 ? "#6dd18e" : "#e05252";
  bankChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: points.map((_, i) => i + 1),
      datasets: [{
        data: points,
        borderColor: lineColor,
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          grid: { color: "#272b34" },
          ticks: { color: "#9099a6", font: { family: "'JetBrains Mono', monospace", size: 10 } }
        }
      }
    }
  });
}

// render() propriamente dito fica isolado em renderInner() para que um erro em qualquer ponto
// (ex. um jogo malformado vindo da tarefa diária que gera data.ts) não deixe a página em branco
// sem explicação — o wrapper público apanha a exceção, regista-a e mostra um aviso claro.
function render(): void {
  try {
    renderInner();
  } catch (e) {
    console.error("Erro ao renderizar os jogos do dia:", e);
    const content = document.getElementById("content");
    if (content) content.innerHTML = '<div class="warnbox">' + icon("alert") + ' Erro ao carregar os jogos de hoje — os dados de origem podem estar malformados. Recarrega a página; se persistir, confirma o ficheiro de dados gerado pela tarefa diária.</div>';
  }
}

function renderInner(): void {
  autoSettlePending(LS.bets);   // liquida sozinho o que já der para ler do placar, mesmo fora da aba "log"
  const curDEl = document.getElementById("curD");
  if (curDEl) curDEl.textContent = fmtDate(curDate);
  const key = ymd(curDate);
  const dayGames = games.filter(g => ymd(g.dt) === key).sort((x, y) => x.dt.getTime() - y.dt.getTime());
  let todays = dayGames;
  if (gameFilter === "value") todays = todays.filter(g => getDecision(g).bet);
  else if (gameFilter === "hideFriendly") todays = todays.filter(g => !g.friendly);
  const content = document.getElementById("content");
  if (!content) return;
  const fetched = new Date(preloaded.fetchedAt);
  const ageH = (Date.now() - fetched.getTime()) / 3600000;
  const ageWarn = ageH > 6
    ? ' <span style="color:#e0b080">' + icon("alert") + ' odds com ' + Math.floor(ageH) + 'h — podem estar desatualizadas; confirma antes de apostar</span>'
    : '';
  const loadedAtEl = document.getElementById("loadedAt");
  if (loadedAtEl) loadedAtEl.innerHTML = "Dados de " + fetched.toLocaleString("pt-PT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " · atualização automática diária às 08:00 · odds DraftKings (ou Betclic, quando a DraftKings ainda não tem linha) via ESPN" + ageWarn;
  let html = "";
  // Acima de 24h a idade dos dados merece mais destaque do que uma cor de texto — decisões
  // (e stakes) baseadas nisto ficam cada vez menos fiáveis quanto mais velhas as odds forem.
  if (ageH > 24) {
    html += '<div class="warnbox">⏰ <b>Odds com ' + Math.floor(ageH) + 'h</b> — muito mais velhas do que a atualização diária habitual (08:00). Podem já não refletir o mercado real; confirma as odds antes de confiar em qualquer decisão desta página.</div>';
  }
  const stopLoss = currentStopLoss();
  if (stopLoss.halted) {
    html += '<div class="warnbox">🛑 <b>Stop-loss ativo</b> — prejuízo de ' + Math.abs(stopLoss.profit).toFixed(2)
      + ' (' + (100 * stopLoss.drawdownFrac).toFixed(1) + '% da banca) nos últimos ' + stopLoss.windowDays
      + ' dias, acima do limiar de ' + (100 * STOP_LOSS_DRAWDOWN_FRAC).toFixed(0) + '%. O registo de novas apostas fica bloqueado '
      + 'até essa janela deixar de mostrar este drawdown — usa este tempo para rever o que correu mal, não para "recuperar" com stakes maiores.</div>';
  }
  html += yesterdayResultBanner();
  html += reminderBanner();
  if (preloaded.note) html += '<div class="banner">' + esc(preloaded.note) + "</div>";
  if (!todays.length && dayGames.length) {
    html += '<div class="status">Nenhum jogo corresponde ao filtro atual. <button class="btn copy" onclick="setGameFilter(\'all\')">Mostrar todos</button></div>';
    content.innerHTML = html;
    return;
  }
  if (!todays.length) {
    const days: Record<string, { d: Date; n: number }> = {};
    games.forEach(g => { const k = ymd(g.dt); if (k >= ymd(new Date())) { days[k] = days[k] || { d: g.dt, n: 0 }; days[k].n++; } });
    const keys = Object.keys(days).sort();
    html += '<div class="status">Sem jogos carregados para <b>' + fmtDate(curDate) + "</b>.";
    if (keys.length) {
      html += '<div style="margin-top:14px;font-size:13px"><b>Dias com jogos:</b></div>';
      for (const k of keys) {
        html += '<div style="margin-top:8px"><button class="btn copy" onclick="jumpTo(' + days[k].d.getTime() + ')">📅 ' + fmtDate(days[k].d) + " — " + days[k].n + " jogo(s)</button></div>";
      }
    } else {
      html += '<div class="note">A tarefa diária de amanhã às 08:00 carrega os próximos jogos.</div>';
    }
    html += "</div>";
    content.innerHTML = html;
    return;
  }
  const byLg: Record<string, Game[]> = {};
  todays.forEach(g => { (byLg[g.lg] = byLg[g.lg] || []).push(g); });
  for (const lg in byLg) {
    html += '<div class="leaguehdr">' + esc(lg) + "</div>";
    for (const g of byLg[lg]) html += card(g);
  }
  content.innerHTML = html;
}

function card(g: Game): string {
  const t = g.dt.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  const o = g.o;
  // A caixinha 1/X/2 mostra sempre a odd de referência (g.o) — é a odd real avaliada pela decisão
  // abaixo (dec.od vem da mesma fonte). A Pinnacle/"sharp" NUNCA aparece aqui: é só um input para
  // calcular a probabilidade justa, não uma odd onde se aposta — misturar as duas confundia mais
  // do que ajudava (dois números diferentes lado a lado a description a mesma coisa).
  const mini = o ? '<div class="oddsmini" data-gid="' + g.id + '">'
    + '<div class="ob"><small>1</small>' + fmt2(o.h) + "</div>"
    + '<div class="ob"><small>X</small>' + fmt2(o.d) + "</div>"
    + '<div class="ob"><small>2</small>' + fmt2(o.a) + "</div></div>" : "";
  // Jogos já começados (navegação para "ontem"/"anteontem" — ver DAYS_BEHIND no script diário) só
  // mostram o resultado final, nunca uma sugestão de aposta nova: getDecision/autoRegisterIfEnabled/
  // trackRejectedIfEnabled ficam de fora por completo para não recalcular EV sobre odds já fechadas
  // nem re-registar a mesma decisão sempre que o utilizador visita esse dia.
  const started = g.dt.getTime() <= Date.now();
  const pending = pendingBetsFor(g.id);
  let valClass: string;
  let decLine: string;
  let scoreHint = "";
  let freshNote = "";
  // A cor da barra lateral reflete sempre a última decisão do modelo, mesmo em jogos já começados
  // (ver histórico/navegação por dias) — só o texto principal (decLine) é que muda para mostrar o
  // resultado em vez de recalcular EV sobre odds já fechadas.
  const dec = getDecision(g);
  if (dec.bet) valClass = "val-good";              // verde: apostar (EV >= limiar no mercado principal)
  else if (dec.derived?.bet) valClass = "val-second"; // laranja: segunda hipótese decente (golos)
  else valClass = "val-bad";                          // vermelho: não apostar
  if (started) {
    const score = api.getFinalScore(g);
    decLine = score
      ? '<div class="dec no">' + icon("check") + ' Terminado: ' + score.home + "-" + score.away + "</div>"
      : '<div class="dec no">' + icon("target") + ' A decorrer / resultado ainda não disponível</div>';
    if (pending.length && score) scoreHint = '<div class="kv">' + icon("check") + ' Resultado: ' + score.home + "-" + score.away + " — abre o jogo para confirmar</div>";
  } else {
    autoRegisterIfEnabled(g, dec);
    trackRejectedIfEnabled(g, dec);
    decLine = dec.bet
      ? '<div class="dec bet">' + icon("target") + ' ' + esc(dec.lbl) + " @ " + fmt2(dec.od) + " · EV +" + (100 * (dec.ev as number)).toFixed(1) + "% · " + (dec.stakeTxt as string) + "</div>"
      : '<div class="dec no">' + icon("target") + ' ' + esc(dec.msg) + "</div>";
    if (pending.length) {
      const score = api.getFinalScore(g);
      if (score) scoreHint = '<div class="kv">' + icon("check") + ' Resultado: ' + score.home + "-" + score.away + " — abre o jogo para confirmar</div>";
    }
    // Nota de frescura: quando a Pinnacle já refrescou pelo menos uma vez para este jogo, a decisão
    // acima (EV/probabilidade) já reflete isso — este texto só explica PORQUÊ pode ter mudado sozinha.
    const freshTs = cardOddsFreshness.get(g.id);
    freshNote = freshTs ? '<div class="kv" style="margin-top:2px">' + icon("refresh") + ' Modelo (Pinnacle) atualizado ' + freshLabel(freshTs) + '</div>' : "";
  }
  return '<div class="card ' + valClass + '"><div class="row" onclick="toggle(\'' + g.id + '\')">'
    + '<div class="time">' + t + (g.friendly ? '<span class="fchip">amigável</span>' : "") + "</div>"
    + '<div class="teams">'
    + '<div class="tline"><span class="tname">' + esc(g.h.n) + "</span>" + formHtml(g.h.f) + "</div>"
    + '<div class="tline"><span class="tname">' + esc(g.a.n) + "</span>" + formHtml(g.a.f) + "</div>"
    + decLine + freshNote + scoreHint
    + "</div>" + mini + "</div>"
    + '<div class="detail" id="d' + g.id + '"></div></div>';
}

// ===== Refresco periódico da probabilidade "sharp" (Pinnacle) dos jogos visíveis — só liga com
// Odds API key configurada; cada visitante usa só a sua própria quota. Não faz nenhum patch manual
// do DOM: fetchLiveOdds já dispara onSharpResult (ver bootstrapInner) sempre que encontra uma odd
// Pinnacle nova, que já faz um render() completo — decisão, EV, stake e a nota de frescura acima
// ficam todos coerentes entre si automaticamente, em vez de sobrepor só um número solto. =====
async function refreshCardOdds(g: Game): Promise<void> {
  await api.fetchLiveOdds(g);
}

function stopCardOddsTimer(): void {
  if (cardOddsTimer) { clearInterval(cardOddsTimer); cardOddsTimer = null; }
}
function startCardOddsTimer(): void {
  stopCardOddsTimer();
  if (!LS.oddsApiKey) return;   // sem chave própria, nem vale a pena agendar nada
  cardOddsTimer = setInterval(() => {
    document.querySelectorAll<HTMLElement>(".oddsmini[data-gid]").forEach(el => {
      const gid = el.dataset.gid as string;
      const g = games.find(x => x.id === gid);
      if (g && g.dt.getTime() > Date.now()) void refreshCardOdds(g);   // jogos já começados não precisam de mais refresco
    });
  }, CARD_ODDS_REFRESH_MS);
}

// ===== Captura automática da odd de fecho (CLV) — corre independentemente da aba/jogo aberto,
// porque as apostas a apanhar não têm relação nenhuma com o que está visível no ecrã neste momento.
// Janela simétrica (± CLOSE_ODDS_WINDOW_H à volta do kickoff): antes disso o mercado ainda está a
// mover-se (não seria "o fecho"); muito depois disso o mercado pré-jogo já pode ter sido suspenso/
// removido, sem ganho em continuar a tentar. Corre para QUALQUER estado da aposta (pending/win/
// loss/void) — o fecho aconteceu no kickoff, independentemente de quando a aposta acabou por ser
// liquidada (com a liquidação automática de apostas reais, isso pode ser quase de imediato após o
// jogo acabar, bem dentro desta janela). oddCloseAuto !== false inclui tanto as que nunca tiveram
// oddClose (undefined) como as já capturadas automaticamente (true) — estas continuam a atualizar-se
// a cada tick dentro da janela, convergindo para o valor mais próximo do kickoff real; só uma edição
// manual (oddCloseAuto === false, ver storage.setOddClose) as tira desta lista para sempre.
async function autoCaptureCloseOdds(): Promise<void> {
  if (!LS.oddsApiKey) return;
  const now = Date.now();
  const windowMs = CLOSE_ODDS_WINDOW_H * 3600000;
  const candidates = LS.bets.filter(b =>
    b.oddCloseAuto !== false && b.lg && b.kickoff && b.homeTeam && b.awayTeam
    && Math.abs(new Date(b.kickoff).getTime() - now) <= windowMs
  );
  if (!candidates.length) return;
  let captured = 0;
  for (const b of candidates) {
    const odd = await api.fetchClosingOdd(b.lg as string, b.homeTeam as string, b.awayTeam as string, b.selKey);
    if (odd) { storage.setOddClose(b.id, String(odd), true); captured++; }
  }
  if (captured && curTab === "log") renderLog();
}

function stopCloseOddsTimer(): void {
  if (closeOddsTimer) { clearInterval(closeOddsTimer); closeOddsTimer = null; }
}
function startCloseOddsTimer(): void {
  stopCloseOddsTimer();
  if (!LS.oddsApiKey) return;
  void autoCaptureCloseOdds();   // primeira tentativa já, sem esperar pelo primeiro tick
  closeOddsTimer = setInterval(() => void autoCaptureCloseOdds(), CLOSE_ODDS_CAPTURE_MS);
}

function toggle(id: string): void {
  const d = document.getElementById("d" + id);
  if (!d) return;
  if (d.classList.contains("open")) { d.classList.remove("open"); stopCmpOddsTimer(); return; }
  document.querySelectorAll(".detail.open").forEach(x => x.classList.remove("open"));
  stopCmpOddsTimer();   // só um jogo aberto de cada vez — nunca mais do que um intervalo do comparador ativo
  const g = games.find(x => x.id === id);
  if (!g) return;
  d.innerHTML = detailHtml(g);
  d.classList.add("open");
  const sel = document.getElementById("sel" + id) as HTMLSelectElement | null;
  if (sel) {
    sel.onchange = () => prefillCmp(id);
    const dec = getDecision(g);
    const opts = currentOpts[id];
    if (dec.bestKey && opts) {
      const i = opts.findIndex(o => o.k === dec.bestKey);
      if (i >= 0) sel.value = String(i);
    }
    prefillCmp(id);
    void autoFillOddsSilent(id);
    startCmpOddsTimer(id);
  }
}

function toggleAI(id: string, btn: HTMLElement): void {
  const out = document.getElementById("ai" + id);
  if (!out) return;
  const showing = out.classList.toggle("show");
  btn.textContent = showing ? "📝 Esconder nota de análise" : "📝 Ver nota de análise (Aníbal Pascoal)";
  if (showing) void aiAnalyse(id);
}

function refreshDetail(id: string): void {
  const d = document.getElementById("d" + id);
  const g = games.find(x => x.id === id);
  if (d && g && d.classList.contains("open")) d.innerHTML = detailHtml(g);
}

function prefillCmp(id: string): void {
  const opts = currentOpts[id];
  const sel = document.getElementById("sel" + id) as HTMLSelectElement | null;
  if (!opts || !sel) return;
  const opt = opts[parseInt(sel.value)];
  ["bb", "bt", "bc"].forEach(p => {
    const el = document.getElementById(p + id) as HTMLInputElement | null;
    if (el) el.value = opt.ref ? opt.ref.toFixed(2) : "";
  });
  const out = document.getElementById("cmp" + id);
  if (out && opt.ref) compareOdds(id);
  else if (out) showModelBase(id);
}

// Mostra a base do modelo (prob., odd justa, odd mínima para valer) quando ainda não há odds reais.
// Mesma informação para TODOS os mercados — só falta a odd, que o utilizador insere.
function showModelBase(id: string): void {
  const g = games.find(x => x.id === id);
  const opts = currentOpts[id];
  const sel = document.getElementById("sel" + id) as HTMLSelectElement | null;
  const out = document.getElementById("cmp" + id);
  if (!out || !opts || !sel) return;
  const opt = opts[parseInt(sel.value)];
  out.classList.add("show");
  const evMin = (g && g.friendly) ? EV_MIN_FRIENDLY : EV_MIN;
  const p = opt.p, fair = 1 / p, minOdd = (1 + evMin) / p;
  let html = '<div style="font-size:14px"><b>' + esc(opt.lbl) + '</b> — prob. do modelo <b>' + pct(p) + '</b></div>';
  html += '<div class="oddgrid"><div class="oddrow"><span class="house">Odd justa (sem margem)</span><span class="oddval">' + fmt2(fair) + '</span></div>'
    + '<div class="oddrow best"><span class="house">➤ Odd mínima para valer a pena</span><span class="oddval">' + fmt2(minOdd) + '</span></div></div>';
  html += '<div class="kv" style="margin-top:6px">Sem odd no feed de referência para este mercado — insere a odd real acima e carrega em <b>Calcular</b>.</div>';
  out.innerHTML = html;
}

function derivedDecBox(g: Game, dec: ModelDecision): string {
  const d2 = dec.derived;
  if (!d2) return "";
  const evMin = g.friendly ? EV_MIN_FRIENDLY : EV_MIN;
  const selKey2 = d2.bet ? ("D:" + (d2.bestKey as string)) : null;
  if (d2.bet) {
    const minOdd = (1 + evMin) / (d2.p as number);
    const logged = storage.betAlreadyLogged(g.id, selKey2);
    let extra = "";
    if (d2.calibApplied) extra += "<br>📐 prob. ajustada por calibração: " + pct(d2.pBefore) + " → " + pct(d2.p);
    if (d2.correlatedNote) extra += '<br><span class="kv">' + icon("alert") + ' Mercados correlacionados — stake combinada com a decisão principal limitada ao cap de 1 aposta.</span>';
    if (d2.reducedForRisk) extra += '<br><span class="kv" style="color:#e0b080">' + icon("alert") + ' Stake reduzida a metade — mais de ' + (100 * PENDING_RISK_FRAC).toFixed(0) + '% da banca em apostas por resolver.</span>';
    if (d2.reducedForClv) extra += '<br><span class="kv" style="color:#e0b080">📉 Stake reduzida — o teu CLV médio não mostra edge sobre o fecho do mercado (ver aba "Os meus resultados").</span>';
    const halted = currentStopLoss().halted;
    return '<div class="decbox derived"><span style="font-size:15px" class="best">' + icon("check") + ' SEGUNDA OPORTUNIDADE — APOSTAR ' + (d2.stakeTxt as string) + ' — ' + esc(d2.lbl) + ' @ ' + fmt2(d2.od) + '</span> <span class="kv">(mín. ' + fmt2(minOdd) + ')</span><br>'
      + "Prob. modelo (golos): " + pct(d2.p) + " · EV: +" + (100 * (d2.ev as number)).toFixed(1) + "% · Kelly " + LS.kellyFrac.toFixed(2) + "x" + extra + "<br>"
      + '<button class="logbtn' + (logged ? ' done' : halted ? ' halted' : '') + '" ' + (logged || halted ? 'disabled' : '')
      + ' onclick="logFromDerived(\'' + g.id + '\')">' + (logged ? '✓ Registada nos teus resultados' : halted ? '🔒 Registo bloqueado (stop-loss)' : '＋ Registei esta aposta')
      + '</button></div>';
  }
  // Sem aposta com valor no grupo derivado: mostra a melhor candidata de forma discreta
  if (d2.best) {
    return '<div class="decbox no"><b>Segunda oportunidade:</b> sem valor às odds de referência. '
      + 'Melhor candidata: ' + esc(d2.best.lbl) + ' — só com odd ≥ <b>' + fmt2((1 + evMin) / d2.best.p) + '</b> (ref. ' + fmt2(d2.best.od) + ').</div>';
  }
  return '<div class="decbox no"><b>Segunda oportunidade:</b> mercados de golos (BTTS, mais/menos) disponíveis no comparador abaixo — insere odds reais para ver se há valor.</div>';
}

function detailHtml(g: Game): string {
  const o = g.o, nv = quant.noVig(o);
  const friendlyWarn = g.friendly
    ? '<div class="warnbox">🤝 <b>Jogo amigável</b> — forma pouco fiável; limiar sobe para EV ≥ +' + (100 * EV_MIN_FRIENDLY).toFixed(0) + '%. Aposta com stakes reduzidas, se apostares.</div>'
    : "";
  let oddsT = "<p class='kv'>Sem odds disponíveis nesta fonte para este jogo — pede a análise no chat para eu procurar odds atuais.</p>";
  if (o) {
    const rows: [string, number, number | null, number | undefined][] = [
      ["1 — " + g.h.n, o.h, nv ? nv.h : null, o.oh],
      ["X — Empate", o.d, nv ? nv.d : null, undefined],
      ["2 — " + g.a.n, o.a, nv ? nv.a : null, o.oa]
    ];
    oddsT = '<table class="odds"><tr><th>Mercado</th><th>Odd</th><th>Prob. implícita</th><th>Prob. justa (no-vig)</th><th>Odd justa</th><th>Abertura</th></tr>'
      + rows.map(r => "<tr><td>" + esc(r[0]) + "</td><td><b>" + fmt2(r[1]) + "</b></td><td>" + pct(r[1] ? 1 / r[1] : null) + "</td><td>" + pct(r[2]) + "</td><td>" + (r[2] ? fmt2(1 / r[2]) : "—") + "</td><td>" + fmt2(r[3] ?? null) + "</td></tr>").join("")
      + "</table>";
    const extra: string[] = [];
    if (o.src === "betclic_fr") extra.push("Casa: Betclic (a DraftKings ainda não tinha linha para este jogo)");
    if (o.l != null) extra.push("Total " + o.l + ": Mais " + fmt2(o.ov) + " / Menos " + fmt2(o.un));
    if (o.sh) extra.push("Handicap casa " + esc(o.sh) + " · fora " + esc(o.sa || ""));
    if (nv) extra.push("Margem do bookmaker: " + (100 * nv.margin).toFixed(1) + "%");
    if (extra.length) oddsT += '<p class="kv">' + extra.join(" &nbsp;·&nbsp; ") + "</p>";
    const mov = quant.lineMovement(o);
    const movParts: string[] = [];
    if (mov.h != null && Math.abs(mov.h) >= LINE_MOVEMENT_ALERT) movParts.push(esc(g.h.n) + " " + (mov.h >= 0 ? "+" : "") + (100 * mov.h).toFixed(1) + "%");
    if (mov.a != null && Math.abs(mov.a) >= LINE_MOVEMENT_ALERT) movParts.push(esc(g.a.n) + " " + (mov.a >= 0 ? "+" : "") + (100 * mov.a).toFixed(1) + "%");
    if (movParts.length) {
      oddsT += '<div class="warnbox">' + icon("alert") + ' Mercado moveu-se desde a abertura: ' + movParts.join(" · ") + " — pode indicar informação nova (lesão, onze) que o modelo não vê.</div>";
    }
  }
  const info: string[] = [];
  if (g.v) info.push("🏟 " + esc(g.v));
  info.push("🗓 " + g.dt.toLocaleString("pt-PT", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }));
  info.push(esc(g.h.n) + " — forma " + esc(g.h.f || "?") + ", V-E-D " + esc(g.h.r || "?") + (g.h.s ? ", ⚽ " + esc(g.h.s) : ""));
  info.push(esc(g.a.n) + " — forma " + esc(g.a.f || "?") + ", V-E-D " + esc(g.a.r || "?") + (g.a.s ? ", ⚽ " + esc(g.a.s) : ""));
  let cmp = "";
  const opts = quant.buildOpts(g, buildDecisionContext().calib, getSharp(g));
  if (opts.length) {
    currentOpts[g.id] = opts;
    cmp = "<h4>Melhor odd e stake — Blockbet · Betano · Betclic</h4>"
      + '<div class="cmp">'
      + '<select id="sel' + g.id + '">' + opts.map((o, i) => '<option value="' + i + '">' + esc(o.lbl) + " (justa " + fmt2(1 / o.p) + ")</option>").join("") + "</select>"
      + '<label class="h">Blockbet (manual)<input type="number" step="0.01" min="1" id="bb' + g.id + '" placeholder="odd"></label>'
      + '<label class="h">Betano (manual)<input type="number" step="0.01" min="1" id="bt' + g.id + '" placeholder="odd"></label>'
      + '<label class="h">Betclic<input type="number" step="0.01" min="1" id="bc' + g.id + '" placeholder="odd"></label>'
      + '<button class="btn copy" onclick="autoFillOdds(\'' + g.id + '\', this)">' + icon("refresh") + ' Atualizar agora</button>'
      + '<button class="btn copy" onclick="compareOdds(\'' + g.id + '\')">Calcular</button>'
      + "</div>"
      + '<div class="kv" style="margin-top:4px" id="cmpFresh' + g.id + '"></div>'
      + '<div class="cmpout" id="cmp' + g.id + '"></div>';
  }
  const dec = getDecision(g);
  autoRegisterIfEnabled(g, dec);
  let decBox = "";
  if (dec.bet) {
    const evMinG = g.friendly ? EV_MIN_FRIENDLY : EV_MIN;
    const minOdd = (1 + evMinG) / (dec.p as number);
    const logged = storage.betAlreadyLogged(g.id, dec.bestKey);
    let extra = "";
    if (dec.calibApplied) extra += "<br>📐 prob. ajustada por calibração: " + pct(dec.pBefore) + " → " + pct(dec.p);
    if (dec.derived && dec.derived.bet) extra += '<br><span class="kv">' + icon("alert") + ' Há também uma segunda oportunidade neste jogo — stake combinada limitada ao cap de 1 aposta (mercados correlacionados).</span>';
    if (dec.reducedForRisk) extra += '<br><span class="kv" style="color:#e0b080">' + icon("alert") + ' Stake reduzida a metade — mais de ' + (100 * PENDING_RISK_FRAC).toFixed(0) + '% da banca em apostas por resolver.</span>';
    if (dec.reducedForClv) extra += '<br><span class="kv" style="color:#e0b080">📉 Stake reduzida — o teu CLV médio não mostra edge sobre o fecho do mercado (ver aba "Os meus resultados").</span>';
    const halted = currentStopLoss().halted;
    decBox = '<div class="decbox"><span style="font-size:15px" class="best">' + icon("check") + ' APOSTAR ' + (dec.stakeTxt as string) + ' — ' + esc(dec.lbl) + ' @ ' + fmt2(dec.od) + '</span> <span class="kv">(melhor odd entre as 3 casas · mín. ' + fmt2(minOdd) + ')</span><br>'
      + "Prob. modelo: " + pct(dec.p) + " · EV: +" + (100 * (dec.ev as number)).toFixed(1) + "% · Kelly " + LS.kellyFrac.toFixed(2) + "x" + marketSourceNote(g) + extra + "<br>"
      + '<button class="logbtn' + (logged ? ' done' : halted ? ' halted' : '') + '" ' + (logged || halted ? 'disabled' : '')
      + ' onclick="logFromDecision(\'' + g.id + '\')">' + (logged ? '✓ Registada nos teus resultados' : halted ? '🔒 Registo bloqueado (stop-loss)' : '＋ Registei esta aposta')
      + '</button>'
      + '</div>';
  } else {
    const evMinG = g.friendly ? EV_MIN_FRIENDLY : EV_MIN;
    decBox = '<div class="decbox no"><span style="font-size:15px"><b>' + icon("x") + ' NÃO APOSTAR — ' + esc(dec.msg) + "</b></span>"
      + (dec.best ? "<br>Melhor candidata: " + esc(dec.best.lbl) + " — só com odd ≥ <b>" + fmt2((1 + evMinG) / dec.best.p) + "</b> (ref. " + fmt2(dec.best.od) + ")." : "") + "</div>";
  }
  const decBox2 = derivedDecBox(g, dec);
  return finalScoreBox(g) + friendlyWarn + '<div class="kv">' + info.join("<br>") + "</div>"
    + decBox
    + decBox2
    + '<button class="btn copy" style="margin-top:8px" onclick="toggleAI(\'' + g.id + '\', this)">📝 Ver nota de análise (Aníbal Pascoal)</button>'
    + '<div class="aiout" id="ai' + g.id + '"></div>'
    + '<details class="adv"><summary>' + icon("settings") + ' Detalhes: odds, comparador de casas e análise 30 passos</summary>'
    + "<h4>Odds e probabilidades</h4>" + oddsT
    + cmp
    + '<div class="btns"><button class="btn copy" onclick="copyPrompt(\'' + g.id + '\', this)">' + icon("copy") + ' Copiar pedido de análise 30 passos (validação com lesões/onzes/xG)</button></div>'
    + "</details>";
}

function fallbackNote(g: Game, dec: ModelDecision): string {
  const nv = quant.noVig(g.o);
  let t = g.h.n + " (forma " + (g.h.f || "?") + ", V-E-D " + (g.h.r || "?") + ") recebe o " + g.a.n + " (forma " + (g.a.f || "?") + ", V-E-D " + (g.a.r || "?") + ").";
  if (nv) t += " O mercado sem margem dá " + pct(nv.h) + " / " + pct(nv.d) + " / " + pct(nv.a) + " (1/X/2).";
  if (dec.bet) t += " O modelo (forma+registo com vantagem casa, misturado com o mercado) atribui " + pct(dec.p) + " à seleção " + (dec.lbl as string) + ", acima do que a odd " + fmt2(dec.od) + " paga — daí a decisão de apostar (EV +" + (100 * (dec.ev as number)).toFixed(1) + "%).";
  else if (dec.best) t += " Nenhuma seleção do mercado de resultado paga acima do que o modelo estima valer (melhor candidata: " + dec.best.lbl + ", EV " + (100 * (dec.best.ev || 0)).toFixed(1) + "%) — por isso não apostar aí.";
  const gm = quant.goalModel(g);
  if (gm) t += " O modelo de golos esperados aponta para " + (gm.lh + gm.la).toFixed(2) + " golos no total (" + gm.lh.toFixed(2) + " casa, " + gm.la.toFixed(2) + " fora).";
  const d2 = dec.derived;
  if (d2 && d2.bet) t += " Como segunda oportunidade, esse perfil de golos dá valor a " + (d2.lbl as string) + " @ " + fmt2(d2.od) + " (EV +" + (100 * (d2.ev as number)).toFixed(1) + "%).";
  else if (gm) t += " Nos mercados de golos e handicap, nenhuma seleção paga acima do estimado às odds de referência.";
  t += " Riscos: o modelo não vê lesões, onzes nem xG real, e a estimativa de golos é probabilística — a validação final faz-se pedindo a análise de 30 passos no chat.";
  return t;
}

async function aiAnalyse(id: string): Promise<void> {
  const g = games.find(x => x.id === id);
  const out = document.getElementById("ai" + id);
  if (!g || !out) return;
  if (aiCache.has(id)) { out.textContent = aiCache.get(id) as string; return; }
  const dec = getDecision(g);
  out.textContent = "A redigir análise…";
  const nv = quant.noVig(g.o);
  const evMinG = g.friendly ? EV_MIN_FRIENDLY : EV_MIN;
  const decTxt = dec.bet
    ? "APOSTAR " + (dec.stakeTxt as string) + " em " + (dec.lbl as string) + " @ " + fmt2(dec.od) + " (prob. modelo " + pct(dec.p) + ", EV +" + (100 * (dec.ev as number)).toFixed(1) + "%), na casa (Blockbet/Betano/Betclic) com a odd mais alta, mínimo " + fmt2((1 + evMinG) / (dec.p as number))
    : "NÃO APOSTAR (" + (dec.msg || "sem dados") + ")";
  const d2 = dec.derived;
  const dec2Txt = d2 && d2.bet
    ? "APOSTAR " + (d2.stakeTxt as string) + " em " + (d2.lbl as string) + " @ " + fmt2(d2.od) + " (prob. modelo de golos " + pct(d2.p) + ", EV +" + (100 * (d2.ev as number)).toFixed(1) + "%)"
    : "sem valor nos mercados de golos/handicap às odds de referência";
  const gm = quant.goalModel(g);
  const data = {
    jogo: g.h.n + " vs " + g.a.n, competicao: g.lg, data: g.d, estadio: g.v,
    tipo_jogo: g.friendly ? "AMIGÁVEL (pré-época) — forma e registo têm baixo valor preditivo; treinadores rodam planteis e poupam titulares" : "oficial",
    casa: g.h, fora: g.a, odds_referencia: g.o, prob_mercado_no_vig: nv,
    decisao_principal_do_modelo: decTxt,
    segunda_oportunidade_do_modelo: dec2Txt,
    golos_esperados: gm ? { casa: gm.lh.toFixed(2), fora: gm.la.toFixed(2), total: (gm.lh + gm.la).toFixed(2) } : null,
    ev_selecoes: (dec.cands || []).map(c => c.lbl + ": EV " + (100 * (c.ev || 0)).toFixed(1) + "%")
  };
  const prompt = "És um analista profissional de apostas de futebol. As decisões finais JÁ ESTÃO TOMADAS por um modelo quantitativo: a principal (mercado de resultado) no campo 'decisao_principal_do_modelo' e uma segunda oportunidade independente (mercados de golos/handicap, derivados de uma distribuição de Poisson sobre os golos esperados) no campo 'segunda_oportunidade_do_modelo'. NÃO contraries nem proponhas outras apostas. Escreve em português de Portugal a NOTA DE ANÁLISE (150-230 palavras, prosa corrida, sem títulos nem listas) que fundamenta AMBAS as decisões quando existem: primeiro a leitura do jogo (forma, registo casa/fora, marcadores) e a decisão principal; depois, se a segunda oportunidade for para apostar, explica em 1-2 frases porque é que o perfil de golos esperados (campo 'golos_esperados') sustenta esse mercado (ex: muitos/poucos golos, jogo equilibrado ou desnível). Se uma das decisões for não apostar, di-lo com naturalidade sem inventar valor. Termina com 2-3 riscos concretos (o modelo não vê lesões, onzes nem xG real; a estimativa de golos é probabilística) e uma frase a lembrar que a validação final se faz pedindo a análise de 30 passos no chat. Tom sóbrio; nunca digas que é garantido. Se o campo 'tipo_jogo' indicar AMIGÁVEL, dedica uma frase a alertar que a leitura de forma e registo é pouco fiável nestes jogos e que qualquer aposta deve ser cautelosa e com stake reduzida.";
  try {
    let txt = await api.requestAiNote(prompt, JSON.stringify(data));
    txt += "\n\n— Nota de análise por: Aníbal Pascoal";
    aiCache.set(id, txt);
    out.textContent = txt;
  } catch {
    const txt = fallbackNote(g, dec) + "\n\n— Nota de análise por: Aníbal Pascoal (gerada localmente — IA indisponível)";
    aiCache.set(id, txt);
    out.textContent = txt;
  }
}

function copyPrompt(id: string, btn: HTMLButtonElement): void {
  const g = games.find(x => x.id === id);
  if (!g) return;
  const txt = "Analisa ao detalhe para apostas: " + g.h.n + " vs " + g.a.n + " — " + g.lg + ", " + g.dt.toLocaleString("pt-PT") + ". Aplica o framework completo de 30 passos (pesquisa web atual: forma, xG, lesões, onzes prováveis, táticas, árbitro, meteorologia, odds Pinnacle/Betano/Betclic, probabilidades no-vig, EV, stakes em unidades). Fração de Kelly: " + LS.kellyFrac + "x" + (LS.bank ? ", banca " + LS.bank + " EUR" : "") + ". Se nada qualificar, conclui SEM APOSTA QUALIFICADA.";
  const done = (ok: boolean) => {
    // innerHTML (não textContent) para poder incluir o ícone SVG — texto sempre fixo/nosso, sem risco de XSS.
    btn.innerHTML = ok ? icon("check") + " Copiado — cola no chat" : icon("alert") + " Copia o texto abaixo";
    if (!ok) { const o = document.getElementById("ai" + id); if (o) { o.classList.add("show"); o.textContent = txt; } }
    setTimeout(() => { btn.innerHTML = icon("copy") + " Copiar pedido de análise 30 passos"; }, 5000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => done(true), () => done(false));
  } else done(false);
}

function jumpTo(ts: number): void { curDate = new Date(ts); curDate.setHours(12, 0, 0, 0); render(); }

function compareOdds(id: string): void {
  const g = games.find(x => x.id === id);
  const opts = currentOpts[id];
  const sel = document.getElementById("sel" + id) as HTMLSelectElement | null;
  const out = document.getElementById("cmp" + id);
  if (!g || !opts || !sel || !out) return;
  const opt = opts[parseInt(sel.value)];
  out.classList.add("show");
  const evMin = g.friendly ? EV_MIN_FRIENDLY : EV_MIN;
  const houses = ([["Blockbet", "bb"], ["Betano", "bt"], ["Betclic", "bc"]] as [string, string][])
    .map(([n, pfx]) => ({ n, od: parseFloat((document.getElementById(pfx + id) as HTMLInputElement | null)?.value || "") }))
    .filter(h => h.od > 1)
    .map(h => ({ ...h, ev: opt.p * h.od - 1 }));
  if (!houses.length) { out.innerHTML = '<div class="kv">Insere pelo menos uma odd (>1.00) de uma das casas.</div>'; return; }
  const p = opt.p, fair = 1 / p;
  houses.sort((x, y) => y.od - x.od);
  const best = houses[0];
  let html = "";
  if (opt.k === "BTS" || opt.k === "BTN") {
    html += '<div class="kv" style="margin-bottom:8px">' + icon("alert") + ' BTTS estimado com correção de correlação (Dixon-Coles) sobre o modelo de golos — usa como referência, não como edge garantido.</div>';
  }
  if (opt.ref && houses.length === 3 && houses.every(h => Math.abs(h.od - (opt.ref as number)) < 0.005)) {
    html += '<div class="banner" style="margin-bottom:8px">' + icon("alert") + ' Estás a ver a <b>odd de referência</b> nas 3 casas — ainda não inseriste as odds reais. O veredito abaixo baseia-se na referência; substitui pelos valores reais de cada casa para saberes onde está a melhor odd.</div>';
  }
  if (best.ev >= evMin) {
    const stakeInfo = quant.computeStake(p, best.od, buildDecisionContext().stake);
    html += '<div style="font-size:14px" class="best">' + icon("check") + ' DECISÃO FINAL: APOSTAR ' + stakeInfo.txt + " na " + esc(best.n) + "</div>"
      + "<b>" + esc(opt.lbl) + " @ " + fmt2(best.od) + "</b> · EV +" + (100 * best.ev).toFixed(1) + "% · prob. modelo " + pct(p) + " · Kelly " + LS.kellyFrac.toFixed(2) + "x<br>";
    if (stakeInfo.reducedForRisk) html += '<div class="kv" style="color:#e0b080">' + icon("alert") + ' Stake reduzida a metade — tens mais de ' + (100 * PENDING_RISK_FRAC).toFixed(0) + '% da banca em apostas por resolver.</div>';
    if (stakeInfo.reducedForClv) html += '<div class="kv" style="color:#e0b080">📉 Stake reduzida — o teu CLV médio não mostra edge sobre o fecho do mercado (ver aba "Os meus resultados").</div>';
  } else if (best.ev > 0) {
    html += '<div style="font-size:14px"><b>' + icon("alert") + ' DECISÃO FINAL: NÃO APOSTAR</b> — valor marginal (EV +' + (100 * best.ev).toFixed(1) + "%, abaixo do mínimo de +" + (100 * evMin).toFixed(0) + "%). Só apostar se a " + esc(best.n) + " subir a odd para " + fmt2((1 + evMin) / p) + "+.</div>";
  } else {
    html += '<div style="font-size:14px"><b>' + icon("x") + ' DECISÃO FINAL: NÃO APOSTAR nesta seleção</b> — EV negativo a estas odds. Só haveria valor com odd ≥ <b>' + fmt2((1 + evMin) / p) + "</b>.</div>";
    const dec = getDecision(g);
    if (dec.bet && dec.bestKey !== opt.k) {
      html += '<div class="best" style="margin-top:4px">👉 A melhor aposta deste jogo é outra: ' + esc(dec.lbl) + " @ " + fmt2(dec.od) + " (EV +" + (100 * (dec.ev as number)).toFixed(1) + "%) — muda a seleção em cima.</div>";
    }
  }
  html += '<div class="oddgrid">' + houses.map(h => '<div class="oddrow' + (h === best ? ' best' : '') + '"><span class="house">' + esc(h.n) + '</span><span class="oddval">' + fmt2(h.od) + '</span><span class="evtag">EV ' + (h.ev >= 0 ? "+" : "") + (100 * h.ev).toFixed(1) + '%' + (h === best ? ' — melhor odd' : '') + '</span></div>').join("") + '</div>';
  html += '<div class="kv" style="margin-top:4px">Prob. do modelo: ' + pct(p) + " · odd justa " + fmt2(fair) + '</div>';
  out.innerHTML = html;
}

type AutoFillResult = { ok: true; filled: number } | { ok: false; reason: string };

// Lógica partilhada entre o preenchimento automático (silencioso, ao abrir o jogo) e o botão manual
// "🔄 Buscar Betclic automaticamente" (com feedback de erro) — só o chamador decide se mostra
// mensagens. Só tenta a Betclic (api.AUTO_BOOKMAKER_KEYS) — Blockbet/Betano nunca aparecem na
// resposta desta API, por isso nem vale a pena tentar preenchê-las (ver nota no comparador).
async function performAutoFill(id: string): Promise<AutoFillResult> {
  const g = games.find(x => x.id === id);
  const opts = currentOpts[id];
  const sel = document.getElementById("sel" + id) as HTMLSelectElement | null;
  if (!g || !opts || !sel) return { ok: false, reason: "sem-contexto" };
  const opt = opts[parseInt(sel.value)];
  if (opt.k !== "1" && opt.k !== "X" && opt.k !== "2") return { ok: false, reason: "mercado-nao-suportado" };
  const res = await api.fetchLiveOdds(g);
  if (!res.ok) return { ok: false, reason: res.reason };
  let filled = 0;
  Object.keys(res.odds).forEach(code => {
    const el = document.getElementById(code + id) as HTMLInputElement | null;
    if (el && res.odds[code]) { el.value = res.odds[code].toFixed(2); filled++; }
  });
  return { ok: true, filled };
}

// Ao abrir um jogo (ver toggle()), tenta preencher Betano/Betclic sozinho e recalcula — sem
// mostrar erros: se falhar, os campos ficam com a odd de referência já pré-preenchida por
// prefillCmp, e o utilizador pode sempre usar o botão manual abaixo para tentar de novo com feedback.
// Reaproveitada também pelo timer periódico do comparador (startCmpOddsTimer) — mesma função,
// chamada repetidamente enquanto o jogo estiver aberto, em vez de só uma vez.
async function autoFillOddsSilent(id: string): Promise<void> {
  if (!LS.oddsApiKey) return;
  const res = await performAutoFill(id);
  if (res.ok && res.filled) { cmpOddsFreshness.set(id, Date.now()); compareOdds(id); }
  updateCmpFreshLabel(id);
}

function updateCmpFreshLabel(id: string): void {
  const el = document.getElementById("cmpFresh" + id);
  if (!el) return;
  const ts = cmpOddsFreshness.get(id);
  const quota = api.getOddsApiQuota();
  el.innerHTML = icon("refresh") + ' A atualizar a Betclic automaticamente enquanto o jogo estiver aberto · Blockbet e Betano continuam manuais.'
    + (ts ? " Última atualização: " + freshLabel(ts) + "." : "")
    + (quota.remaining != null ? ' <span class="kv">· Odds API: ' + quota.remaining + " pedidos restantes" + (quota.used != null ? " (" + quota.used + " usados)" : "") + "</span>" : "");
}

function stopCmpOddsTimer(): void {
  if (cmpOddsTimer) { clearInterval(cmpOddsTimer); cmpOddsTimer = null; }
}
function startCmpOddsTimer(id: string): void {
  stopCmpOddsTimer();
  if (!LS.oddsApiKey) return;
  cmpOddsTimer = setInterval(() => {
    updateCmpFreshLabel(id);
    const last = cmpOddsFreshness.get(id);
    if (!last || Date.now() - last >= CMP_ODDS_REFRESH_MS) void autoFillOddsSilent(id);
  }, CMP_ODDS_TICK_MS);
}

async function autoFillOdds(id: string, btn: HTMLButtonElement): Promise<void> {
  const out = document.getElementById("cmp" + id);
  const orig = btn.textContent;
  btn.textContent = "A procurar…"; btn.disabled = true;
  const res = await performAutoFill(id);
  btn.disabled = false; btn.textContent = orig;
  if (!res.ok) {
    // Estas mensagens descrevem a tentativa de ir buscar a Betclic (a única casa local coberta por
    // esta API) — nunca a Blockbet/Betano, que são sempre manuais e não passam por aqui.
    const msgs: Record<string, string> = {
      "sem-chave": 'Sem Odds API key — define-a em "' + icon("settings") + ' APIs externas" no topo. Blockbet/Betano preenche-se sempre à mão.',
      "liga-nao-mapeada": "Esta liga ainda não está mapeada para a Odds API. Preenche as 3 casas manualmente.",
      "jogo-nao-encontrado": "Não encontrei este jogo na Odds API para a Betclic — preenche manualmente.",
      "erro-rede": "Falha de rede ao contactar a Odds API — tenta de novo ou preenche a Betclic manualmente.",
      "mercado-nao-suportado": "Fetch automático só suporta o mercado 1X2 por agora — usa os campos manuais para este mercado."
    };
    if (out) { out.classList.add("show"); out.innerHTML = '<div class="kv">' + icon("alert") + ' ' + (msgs[res.reason] || ("Sem odds automáticas (" + res.reason + ")")) + "</div>"; }
    return;
  }
  if (res.filled) { cmpOddsFreshness.set(id, Date.now()); updateCmpFreshLabel(id); compareOdds(id); }
  else if (out) { out.classList.add("show"); out.innerHTML = '<div class="kv">' + icon("alert") + ' Jogo encontrado, mas nenhuma das 3 casas voltou na resposta — preenche manualmente.</div>'; }
}

function logFromDecision(id: string): void {
  if (currentStopLoss().halted) return;   // defesa extra — o botão já fica disabled na UI
  const g = games.find(x => x.id === id);
  if (!g) return;
  const dec = getDecision(g);
  if (!dec.bet) return;
  const bank = parseFloat(LS.bank) || 0;
  const stakeVal = bank ? (dec.stakeFrac as number) * bank : (dec.stakeFrac as number) * 100;
  storage.saveBet({ gameId: g.id, selKey: dec.bestKey as string, sel: dec.lbl as string, game: g.h.n + " vs " + g.a.n, odd: dec.od as number, stake: stakeVal.toFixed(2), prob: dec.p as number, lg: g.lg, modelInputs: dec.modelInputs, homeTeam: g.h.n, awayTeam: g.a.n, kickoff: g.d });
  updLogCount();
  refreshDetail(id);
}
function logFromDerived(id: string): void {
  if (currentStopLoss().halted) return;   // defesa extra — o botão já fica disabled na UI
  const g = games.find(x => x.id === id);
  if (!g) return;
  const dec = getDecision(g);
  const d2 = dec.derived;
  if (!d2 || !d2.bet) return;
  const bank = parseFloat(LS.bank) || 0;
  const stakeVal = bank ? (d2.stakeFrac as number) * bank : (d2.stakeFrac as number) * 100;
  storage.saveBet({ gameId: g.id, selKey: "D:" + (d2.bestKey as string), sel: d2.lbl as string, game: g.h.n + " vs " + g.a.n, odd: d2.od as number, stake: stakeVal.toFixed(2), prob: d2.p as number, lg: g.lg, homeTeam: g.h.n, awayTeam: g.a.n, kickoff: g.d });
  updLogCount();
  refreshDetail(id);
}

// ===== Wrappers de UI para as ações de persistência (storage.ts é puro; aqui decide-se o que
// re-renderizar depois de cada uma, à semelhança do que o monólito fazia inline) =====
function settleBetUI(id: string, status: BetStatus): void { storage.settleBet(id, status); void autoSyncExternalIfEnabled(); renderLog(); }
function deleteBetUI(id: string): void { storage.deleteBet(id); updLogCount(); renderLog(); }
function setOddCloseUI(id: string, val: string): void { storage.setOddClose(id, val); renderLog(); }
function exportJSONUI(): void { storage.exportJSON(ymd(new Date())); }
function exportCSVUI(): void { storage.exportCSV(ymd(new Date())); }

// Sincronização externa (extra, opcional — ver api.syncBetsToExternalSheet): só aparece o botão
// quando há um nome de ferramenta MCP configurado E a ponte window.cowork.callMcpTool existe
// nesta sessão; caso contrário fica simplesmente invisível, nunca um botão morto.
function canSyncExternal(): boolean {
  return !!LS.mcpSyncTool && typeof window.cowork?.callMcpTool === "function";
}
function resolvedBetsForSync(): Bet[] {
  return LS.bets.filter(b => (b.status === "win" || b.status === "loss") && !b.paper && !b.auto);
}
// Espelha o histórico automaticamente depois de QUALQUER liquidação (manual ou automática, ver
// settleBetTracked) quando há uma ferramenta MCP configurada — sem isto, sincronizar dependia de
// alguém se lembrar de clicar no botão manual, o que na prática significava nunca ficar realmente
// espelhado. Silencioso de propósito (sem toast/erro visível): falha do mesmo jeito gracioso que
// api.syncBetsToExternalSheet já garante, e o botão manual continua disponível para diagnosticar.
async function autoSyncExternalIfEnabled(): Promise<void> {
  if (!canSyncExternal()) return;
  await api.syncBetsToExternalSheet(resolvedBetsForSync());
}
async function syncExternal(btn: HTMLButtonElement): Promise<void> {
  const resolved = resolvedBetsForSync();
  const orig = btn.innerHTML;
  btn.setAttribute("disabled", "true");
  btn.innerHTML = icon("refresh") + " A sincronizar…";
  const res = await api.syncBetsToExternalSheet(resolved);
  btn.removeAttribute("disabled");
  btn.innerHTML = orig;
  if (res.ok) {
    showToast("Sincronizadas " + resolved.length + " aposta(s) resolvida(s) para " + LS.mcpSyncTool + ".", "success");
  } else {
    showToast(res.reason === "sem-conector"
      ? 'Sem conector MCP disponível — confirma o nome da ferramenta em "APIs externas".'
      : "Falha ao sincronizar — ver consola do browser para detalhes.", "error");
  }
}
async function importJSONUI(file: File | undefined): Promise<void> {
  if (!file) return;
  const res = await storage.importBetsFromFile(file);
  const input = document.getElementById("importFile") as HTMLInputElement | null;
  if (input) input.value = "";
  if (!res.ok) {
    const msgs: Record<string, string> = {
      "invalid-json": "Ficheiro inválido — não é JSON válido.",
      "invalid-format": "Formato inválido — esperava uma lista de apostas.",
      "no-valid-bets": "Nenhuma aposta válida encontrada no ficheiro."
    };
    showToast(msgs[res.reason || ""] || "Falha ao importar.", "error");
    return;
  }
  updLogCount();
  renderLog();
  showToast("Importadas " + res.added + " aposta(s) nova(s). " + res.alreadyExisted + " já existiam (ignoradas).", "success");
}

function setGameFilter(f: "all" | "value" | "hideFriendly"): void {
  gameFilter = f;
  document.querySelectorAll<HTMLElement>(".filterbtn").forEach(b => b.classList.toggle("active", b.dataset.filter === f));
  render();
}
function switchTab(t: "games" | "log"): void {
  curTab = t;
  document.getElementById("tabGames")?.classList.toggle("active", t === "games");
  document.getElementById("tabLog")?.classList.toggle("active", t === "log");
  const contentEl = document.getElementById("content");
  if (contentEl) contentEl.style.display = t === "games" ? "" : "none";
  const datenav = document.querySelector<HTMLElement>(".datenav");
  if (datenav) datenav.style.visibility = t === "games" ? "" : "hidden";
  const cmpHint = document.getElementById("cmpHint");
  if (cmpHint) cmpHint.style.display = t === "games" ? "" : "none";
  const lv = document.getElementById("logview");
  if (lv) lv.style.display = t === "log" ? "" : "none";
  if (t === "log") {
    renderLog();
    stopCardOddsTimer(); stopCmpOddsTimer();   // sem cards/comparador visíveis, não há nada para atualizar
  } else {
    render();   // reflete stakes/EV recalculados (calibração, risco pendente) após registar/liquidar apostas
    startCardOddsTimer();
  }
}

function updUnit(): void {
  const b = parseFloat(LS.bank);
  const el = document.getElementById("unitInfo");
  if (!el) return;
  el.textContent = b
    ? ("Kelly " + LS.kellyFrac.toFixed(2) + "x · teto de segurança: " + (b * STAKE_CAP_FRAC).toFixed(2) + " €/jogo (" + (100 * STAKE_CAP_FRAC).toFixed(0) + "% da banca)")
    : "define a banca para calcular stakes";
}

// Mesma lógica do render(): isola o arranque numa função interna para que uma falha (ex. um
// elemento do DOM em falta, um dado malformado) não deixe a página completamente muda, sem
// nenhuma pista do que correu mal.
function bootstrap(): void {
  void loadPreloadedData().then(data => {
    try {
      preloaded = data;
      games = data.games.map(g => ({ ...g, dt: new Date(g.d) }));
      bootstrapInner();
    } catch (e) {
      console.error("Erro ao iniciar a aplicação:", e);
      const content = document.getElementById("content");
      if (content) content.innerHTML = '<div class="warnbox">' + icon("alert") + ' Erro ao iniciar a aplicação — recarrega a página. Se persistir, verifica a consola do browser (F12) para mais detalhes.</div>';
    }
  });
}

function bootstrapInner(): void {
  document.getElementById("prevD")?.addEventListener("click", () => { curDate.setDate(curDate.getDate() - 1); render(); });
  document.getElementById("nextD")?.addEventListener("click", () => { curDate.setDate(curDate.getDate() + 1); render(); });
  document.getElementById("todayD")?.addEventListener("click", () => { curDate = new Date(); curDate.setHours(12, 0, 0, 0); render(); });

  const bankEl = document.getElementById("bank") as HTMLInputElement;
  const kellyFracEl = document.getElementById("kellyFrac") as HTMLSelectElement;
  bankEl.value = LS.bank; kellyFracEl.value = String(LS.kellyFrac);
  bankEl.onchange = () => { LS.bank = bankEl.value; updUnit(); render(); };
  kellyFracEl.onchange = () => { LS.kellyFrac = parseFloat(kellyFracEl.value); updUnit(); render(); };

  const oddsApiKeyEl = document.getElementById("oddsApiKeyInput") as HTMLInputElement;
  const aiProviderEl = document.getElementById("aiProviderSel") as HTMLSelectElement;
  const aiKeyEl = document.getElementById("aiKeyInput") as HTMLInputElement;
  oddsApiKeyEl.value = LS.oddsApiKey; aiProviderEl.value = LS.aiProvider; aiKeyEl.value = LS.aiKey;
  oddsApiKeyEl.onchange = () => {
    LS.oddsApiKey = oddsApiKeyEl.value.trim();
    if (curTab === "games") startCardOddsTimer();   // liga/desliga o refresco consoante a chave ficou definida ou não
    startCloseOddsTimer();   // idem para a captura de odd de fecho — independente da aba, por isso sempre
  };
  aiProviderEl.onchange = () => { LS.aiProvider = aiProviderEl.value; aiCache.clear(); };
  aiKeyEl.onchange = () => { LS.aiKey = aiKeyEl.value.trim(); aiCache.clear(); };

  const mcpSyncToolEl = document.getElementById("mcpSyncToolInput") as HTMLInputElement;
  mcpSyncToolEl.value = LS.mcpSyncTool;
  mcpSyncToolEl.onchange = () => { LS.mcpSyncTool = mcpSyncToolEl.value.trim(); renderLog(); };

  // O checkbox é "Modo detalhado" (verbose) — o INVERSO de LS.focusMode. Modo Focus continua a
  // ser o default (LS.focusMode default true, ver storage.ts): a caixa começa por desmarcada, e
  // marcá-la é que liga a informação extra, não o contrário. A chave de armazenamento e a classe
  // CSS "focus-mode" mantêm-se — só a UI que a liga é que ficou invertida.
  const verboseEl = document.getElementById("verboseMode") as HTMLInputElement;
  verboseEl.checked = !LS.focusMode;
  document.body.classList.toggle("focus-mode", LS.focusMode);
  verboseEl.onchange = () => {
    LS.focusMode = !verboseEl.checked;
    document.body.classList.toggle("focus-mode", LS.focusMode);
  };

  const paperEl = document.getElementById("paperMode") as HTMLInputElement;
  paperEl.checked = LS.paperMode;
  paperEl.onchange = () => { LS.paperMode = paperEl.checked; };

  const autoRegEl = document.getElementById("autoRegister") as HTMLInputElement;
  autoRegEl.checked = LS.autoRegister;
  autoRegEl.onchange = () => { LS.autoRegister = autoRegEl.checked; render(); };

  const trackRejEl = document.getElementById("trackRejected") as HTMLInputElement;
  trackRejEl.checked = LS.trackRejected;
  trackRejEl.onchange = () => { LS.trackRejected = trackRejEl.checked; render(); };

  // Quando a odd sharp (Pinnacle) chega em segundo plano (ver api.getSharpOdds), o EV e o no-vig
  // já mudaram para este jogo — re-renderiza e reabre o painel se estava aberto.
  api.setOnSharpResult((gameId) => {
    cardOddsFreshness.set(gameId, Date.now());
    const d = document.getElementById("d" + gameId);
    const wasOpen = !!d && d.classList.contains("open");
    render();
    if (wasOpen) toggle(gameId);
  });

  // Quando o resultado final (ESPN) chega em segundo plano para um jogo com apostas pendentes —
  // mesma técnica de re-render das duas anteriores.
  api.setOnScoreResult((gameId) => {
    if (curTab === "log") { renderLog(); return; }
    const d = document.getElementById("d" + gameId);
    const wasOpen = !!d && d.classList.contains("open");
    render();
    if (wasOpen) toggle(gameId);
  });

  updUnit(); updLogCount(); render();
  startCardOddsTimer();   // arranca já — o tab por defeito é "games"
  startCloseOddsTimer();  // independente da aba — corre sempre que houver chave, ver switchTab
}

// Expostas no window porque o HTML gerado dinamicamente usa onclick="..." inline (mesma
// abordagem do monólito original) — um módulo ES não publica automaticamente os seus
// top-level no âmbito global.
Object.assign(window, {
  toggle, toggleAI, setGameFilter, switchTab, compareOdds, autoFillOdds,
  logFromDecision, logFromDerived, copyPrompt, jumpTo,
  exportJSON: exportJSONUI, exportCSV: exportCSVUI, importJSON: importJSONUI,
  settleBet: settleBetUI, deleteBet: deleteBetUI, setOddClose: setOddCloseUI,
  syncExternal
});

bootstrap();

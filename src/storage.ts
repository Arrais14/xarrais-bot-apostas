// ===== Persistência: localStorage, registo de apostas, import/export, P&L =====
// Camada pura de dados — não toca no DOM nem sabe nada da cache de decisões do motor
// quantitativo. Quem chama saveBet/settleBet/deleteBet é responsável por invalidar essa
// cache e voltar a renderizar (ver main.ts), à semelhança do que o monólito fazia inline.

import type { Bet, BetStatus, CLVResult, NewBet, PnLStats, RejectedStats } from "./types";
import { KELLY_FRAC_DEFAULT } from "./config";
import { num } from "./utils";

export const LS = {
  get bank(): string { return localStorage.getItem("jd_bank") || ""; },
  set bank(v: string) { localStorage.setItem("jd_bank", v); },
  get kellyFrac(): number {
    const v = parseFloat(localStorage.getItem("jd_kellyFrac") || "");
    return isNaN(v) ? KELLY_FRAC_DEFAULT : v;
  },
  set kellyFrac(v: number) { localStorage.setItem("jd_kellyFrac", String(v)); },
  get bets(): Bet[] { try { return JSON.parse(localStorage.getItem("jd_bets") || "[]"); } catch { return []; } },
  set bets(v: Bet[]) { localStorage.setItem("jd_bets", JSON.stringify(v)); },
  get lastExport(): string { return localStorage.getItem("jd_lastExport") || ""; },
  set lastExport(v: string) { localStorage.setItem("jd_lastExport", v); },
  get oddsApiKey(): string { return localStorage.getItem("jd_oddsApiKey") || ""; },
  set oddsApiKey(v: string) { localStorage.setItem("jd_oddsApiKey", v); },
  get aiProvider(): string { return localStorage.getItem("jd_aiProvider") || "cowork"; },
  set aiProvider(v: string) { localStorage.setItem("jd_aiProvider", v); },
  get aiKey(): string { return localStorage.getItem("jd_aiKey") || ""; },
  set aiKey(v: string) { localStorage.setItem("jd_aiKey", v); },
  // Default true na primeira visita (chave ainda não existe neste browser) — assim que o
  // utilizador mexe no toggle, o valor explícito fica gravado e passa a ser o que conta sempre.
  get focusMode(): boolean {
    const v = localStorage.getItem("jd_focusMode");
    return v === null ? true : v === "1";
  },
  set focusMode(v: boolean) { localStorage.setItem("jd_focusMode", v ? "1" : "0"); },
  get paperMode(): boolean { return localStorage.getItem("jd_paperMode") === "1"; },
  set paperMode(v: boolean) { localStorage.setItem("jd_paperMode", v ? "1" : "0"); },
  get autoRegister(): boolean { return localStorage.getItem("jd_autoRegister") === "1"; },
  set autoRegister(v: boolean) { localStorage.setItem("jd_autoRegister", v ? "1" : "0"); },
  get trackRejected(): boolean { return localStorage.getItem("jd_trackRejected") === "1"; },
  set trackRejected(v: boolean) { localStorage.setItem("jd_trackRejected", v ? "1" : "0"); },
  get mcpSyncTool(): string { return localStorage.getItem("jd_mcpSyncTool") || ""; },
  set mcpSyncTool(v: string) { localStorage.setItem("jd_mcpSyncTool", v); },
  get lastYesterdayBannerDate(): string { return localStorage.getItem("jd_lastYesterdayBannerDate") || ""; },
  set lastYesterdayBannerDate(v: string) { localStorage.setItem("jd_lastYesterdayBannerDate", v); }
};

// ===== Registo de apostas (a fonte de verdade sobre lucro/prejuízo) =====
// Com "Modo papel" ativo, a aposta é marcada com paper:true — continua a alimentar
// calibração/CLV/Brier normalmente, mas fica de fora do P&L "real" (ver computePnL/main.ts).
export function saveBet(bet: NewBet): Bet {
  const bets = LS.bets;
  const saved: Bet = {
    ...bet,
    id: "b" + Date.now() + Math.random().toString(36).slice(2, 6),
    status: "pending",
    loggedAt: new Date().toISOString(),
    ...(LS.paperMode ? { paper: true } : {})
  };
  bets.push(saved);
  LS.bets = bets;
  return saved;
}

// auto=true marca a liquidação como automática (ver quant.resolveBetOutcome/main.autoSettlePending)
// — uma chamada manual (auto=false, o default) limpa sempre essa marca, mesmo que reverta um status
// que tinha sido posto automaticamente: uma correção à mão deixa de ser "automática" por definição.
export function settleBet(id: string, status: BetStatus, auto = false): void {
  const bets = LS.bets;
  const b = bets.find(x => x.id === id);
  if (b) { b.status = status; b.autoSettled = auto; LS.bets = bets; }
}

export function deleteBet(id: string): void {
  LS.bets = LS.bets.filter(x => x.id !== id);
}

export function betAlreadyLogged(gameId: string, selKey: string | null | undefined): boolean {
  if (!selKey) return false;
  return LS.bets.some(b => b.gameId === gameId && b.selKey === selKey);
}

// auto=true (ver main.autoCaptureCloseOdds) marca oddCloseAuto=true, permitindo à captura automática
// continuar a atualizar este campo em execuções seguintes dentro da janela. Uma chamada manual
// (auto=false, o default — ver setOddCloseUI) marca sempre oddCloseAuto=false, mesmo que limpe o
// campo: a partir daí a captura automática ignora esta aposta para sempre, nunca sobrepõe a escolha
// do utilizador.
export function setOddClose(id: string, val: string, auto = false): void {
  const bets = LS.bets;
  const b = bets.find(x => x.id === id);
  if (!b) return;
  const oc = parseFloat(val);
  if (!isNaN(oc) && oc > 0) { b.oddClose = oc; b.clv = num(b.odd) / oc - 1; }
  else { delete b.oddClose; delete b.clv; }
  b.oddCloseAuto = auto;
  LS.bets = bets;
}

// filter opcional: permite ao chamador separar P&L "real" (ex. b => !b.paper && !b.auto) de
// P&L "papel" ou "automático" sem duplicar esta função — sem filtro, comporta-se como sempre.
export function computePnL(bets: Bet[], filter?: (b: Bet) => boolean): PnLStats {
  const relevant = filter ? bets.filter(filter) : bets;
  let staked = 0, returned = 0, settled = 0, wins = 0, losses = 0, voids = 0, pending = 0, pendingStake = 0;
  for (const b of relevant) {
    const stake = num(b.stake) || 0;
    const odd = num(b.odd) || 0;
    if (b.status === "pending") { pending++; pendingStake += stake; continue; }
    if (b.status === "void") { voids++; continue; }
    settled++; staked += stake;
    if (b.status === "win") { wins++; returned += stake * odd; }
    else { losses++; }
  }
  const profit = returned - staked;
  const roi = staked > 0 ? profit / staked : 0;           // yield sobre o total apostado
  const hitRate = settled > 0 ? wins / settled : 0;
  const avgOdd = settled > 0
    ? relevant.filter(b => b.status === "win" || b.status === "loss").reduce((s, b) => s + (num(b.odd) || 0), 0) / settled
    : 0;
  return { staked, returned, profit, roi, hitRate, avgOdd, settled, wins, losses, voids, pending, pendingStake };
}

// ===== Estatísticas dos candidatos rejeitados (EV insuficiente, ver Bet.rejected) =====
// Mesma matemática de computePnL, mas sobre o stake HIPOTÉTICO guardado no momento da rejeição —
// nunca dinheiro real. Serve só para responder "se tivesses apostado nestas oportunidades
// marginais/sem valor, terias ganho ou perdido?".
export function computeRejectedStats(bets: Bet[]): RejectedStats {
  const rej = bets.filter(b => b.rejected && (b.status === "win" || b.status === "loss"));
  let staked = 0, profit = 0, wins = 0;
  for (const b of rej) {
    const stake = num(b.stake) || 0, odd = num(b.odd) || 0;
    staked += stake;
    if (b.status === "win") { wins++; profit += stake * (odd - 1); } else { profit -= stake; }
  }
  return { n: rej.length, wouldWinRate: rej.length ? wins / rej.length : 0, hypotheticalStaked: staked, hypotheticalProfit: profit };
}

// ===== CLV (Closing Line Value) =====
// Não depende do resultado do jogo — mede se bateste o preço de fecho do mercado.
// Fica fiável com ~50 apostas, muito antes de o P&L (que exige centenas) dizer algo com confiança.
export function avgCLV(bets: Bet[], filter?: (b: Bet) => boolean): CLVResult | null {
  const relevant = filter ? bets.filter(filter) : bets;
  const withClose = relevant.filter(b => num(b.oddClose) > 0 && num(b.odd) > 0);
  if (!withClose.length) return null;
  const vals = withClose.map(b => num(b.odd) / num(b.oddClose) - 1);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  return { avg, n: withClose.length };
}

// ===== Gráfico de evolução da banca (dados) =====
// P&L acumulado, cronológico, só apostas resolvidas (win/loss) — void/pending não entram na curva.
export function bankCurveData(bets: Bet[]): number[] {
  const settled = bets.filter(b => b.status === "win" || b.status === "loss")
    .slice().sort((a, b) => new Date(a.loggedAt).getTime() - new Date(b.loggedAt).getTime());
  let cum = 0;
  return settled.map(b => {
    const stake = num(b.stake) || 0, odd = num(b.odd) || 0;
    cum += b.status === "win" ? stake * (odd - 1) : -stake;
    return cum;
  });
}

// ===== Backup/restauro do histórico de apostas =====
function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportJSON(filenameDate: string): void {
  downloadFile("apostas_" + filenameDate + ".json", JSON.stringify(LS.bets, null, 2), "application/json");
  LS.lastExport = new Date().toISOString();
}

export function exportCSV(filenameDate: string): void {
  const bets = LS.bets;
  const cols = ["id", "loggedAt", "game", "sel", "selKey", "odd", "stake", "status", "prob", "oddClose", "clv_pct"] as const;
  const esc2 = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  let csv = cols.join(";") + "\n";
  for (const b of bets) {
    const clvVal = num(b.oddClose) > 0 ? ((num(b.odd) / num(b.oddClose) - 1) * 100).toFixed(2) : "";
    csv += cols.map(c => esc2(c === "clv_pct" ? clvVal : (b as unknown as Record<string, unknown>)[c])).join(";") + "\n";
  }
  downloadFile("apostas_" + filenameDate + ".csv", csv, "text/csv");
  LS.lastExport = new Date().toISOString();
}

export interface ImportResult {
  ok: boolean;
  reason?: "invalid-json" | "invalid-format" | "no-valid-bets";
  added?: number;
  alreadyExisted?: number;
}

export function importBetsFromFile(file: File): Promise<ImportResult> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      let data: unknown;
      try { data = JSON.parse(String(e.target?.result ?? "")); }
      catch { resolve({ ok: false, reason: "invalid-json" }); return; }
      if (!Array.isArray(data)) { resolve({ ok: false, reason: "invalid-format" }); return; }
      const valid = (data as Bet[]).filter(b => b && typeof b === "object" && b.id && b.game && b.sel && b.odd != null && b.stake != null && b.status);
      if (!valid.length) { resolve({ ok: false, reason: "no-valid-bets" }); return; }
      const existing = LS.bets;
      const existingIds = new Set(existing.map(b => b.id));
      const merged = existing.slice();
      let added = 0;
      for (const b of valid) { if (!existingIds.has(b.id)) { merged.push(b); existingIds.add(b.id); added++; } }
      LS.bets = merged;
      resolve({ ok: true, added, alreadyExisted: valid.length - added });
    };
    reader.readAsText(file);
  });
}

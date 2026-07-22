// ===== Tipos centrais do domínio =====
// Espelham exatamente as formas de dados do monólito original — nenhuma fórmula ou
// heurística muda aqui, só se dá nome e forma explícita ao que já existia como objetos soltos.

export type BetStatus = "pending" | "win" | "loss" | "void";
export type AiProvider = "cowork" | "anthropic" | "openai";

/** Estatísticas de uma equipa tal como vêm no feed diário (PRELOADED). */
export interface TeamInfo {
  n: string;             // nome
  f: string;              // últimos resultados, ex. "WWLWW"
  r: string;              // registo V-E-D, ex. "7-3-8"
  s: string | null;       // melhor marcador
}

/** Odds de referência (DraftKings via ESPN) para um jogo. */
export interface Odds {
  h: number;               // odd casa (1)
  d: number;               // odd empate (X)
  a: number;               // odd fora (2)
  oh?: number;              // odd casa de abertura
  oa?: number;              // odd fora de abertura
  l?: number;               // linha de golos (over/under), ex. 2.5
  ov?: number;              // odd "mais de" l golos
  un?: number;              // odd "menos de" l golos
  sh?: string;              // handicap asiático casa, ex. "-0,5 @ 2.00"
  sa?: string;              // handicap asiático fora, ex. "+0,5 @ 1.69"
}

/** Forma como um jogo chega no feed diário (PRELOADED.games). */
export interface GameData {
  id: string;
  lg: string;               // liga/competição
  d: string;                 // data ISO
  v?: string;                // estádio/local
  h: TeamInfo;
  a: TeamInfo;
  o: Odds | null;
  friendly?: boolean;        // jogo amigável (limiar de EV mais alto)
}

/** Jogo em memória, com a data já convertida para Date local. */
export interface Game extends GameData {
  dt: Date;
}

export interface PreloadedData {
  fetchedAt: string;
  note?: string;
  games: GameData[];
}

/** Probabilidades sem margem do bookmaker (no-vig), a partir das odds 1X2. */
export interface NoVigProbs {
  h: number;
  d: number;
  a: number;
  margin: number;
}

/** Resultado do modelo automático de probabilidades (no-vig puro da odd de referência ou da
 * Pinnacle/"sharp" quando disponível — único caminho suportado; a heurística forma+PPG e o
 * scaffolding de ML/ONNX foram ambos removidos por não acrescentarem sinal validado). */
export interface ModelProbs {
  p: { h: number; d: number; a: number };
  heur: boolean;
  sharp?: boolean;   // true quando o componente de mercado veio de uma casa sharp/alternativa (ver tier), não do preload DraftKings/ESPN
  tier?: "sharp" | "alt";   // qual casa gerou o SharpQuote usado — "sharp" (Pinnacle) ou "alt" (Betclic, fallback) — ver quant.autoDecide
}

/** Variação percentual entre a odd de abertura e a atual (ver quant.lineMovement) — null quando
 * não há odd de abertura no feed. Negativo = a odd encolheu (mercado mais confiante nesse lado). */
export interface LineMovement {
  h: number | null;
  a: number | null;
}

/** Resultado final de um jogo (ver api.fetchFinalScore/getFinalScore). */
export interface FinalScore {
  home: number;
  away: number;
}

/** Odds 1X2 de uma casa sharp (Pinnacle) ou alternativa (Betclic, fallback quando falta a
 * Pinnacle — ver ALT_SHARP_BOOKMAKER_KEY) usadas como referência de mercado para o no-vig —
 * mesma forma que Odds, mas só o 1X2 (a The-Odds-API não devolve totais/handicaps destas casas
 * no mesmo pedido h2h que usamos aqui). */
export interface SharpQuote {
  h: number;
  d: number;
  a: number;
  tier: "sharp" | "alt";   // "sharp" = Pinnacle (mais fiável); "alt" = Betclic (fallback, sinal mais fraco)
}

export interface StakeInfo {
  frac: number;
  txt: string;
  reducedForRisk: boolean;
  reducedForClv: boolean;   // true quando riskMult < 1 (CLV médio sem edge) contribuiu para a stake
}

/** Contexto de banca/fração de Kelly/risco pendente/CLV necessário para calcular stakes.
 * riskMult vem já resolvido de fora (main.ts, via quant.clvGate) — quant.ts só multiplica, não decide. */
export interface StakeContext {
  bank: number;
  kellyFrac: number;   // fração de Kelly escolhida pelo utilizador (ex. 0.25 = "Quarter Kelly")
  pendingStake: number;
  riskMult: number;    // 1 = sem redução; <1 = redução por CLV médio sem edge sobre o fecho do mercado
}

/** Resultado do gate de risco por CLV (ver quant.clvGate) — nunca aumenta o multiplicador acima
 * de 1 (não amplifica o Kelly escolhido pelo utilizador), só o reduz quando o histórico mostra
 * falta de edge sobre o fecho do mercado. */
export interface ClvGate {
  active: boolean;      // false enquanto a amostra (CLV_MIN_N) for insuficiente
  mult: number;
  n: number;
  avg: number | null;
}

/** Candidato de mercado (1X2, dupla hipótese, handicap, golos, ...) avaliado pelo motor de decisão. */
export interface Candidate {
  k: string;
  lbl: string;
  od?: number;
  pRaw?: number;
  p: number;
  pBefore?: number;
  calibApplied?: boolean;
  ev?: number;
}

export interface DerivedDecision {
  bet: boolean;
  lbl?: string;
  od?: number;
  ev?: number;
  p?: number;
  pBefore?: number;
  calibApplied?: boolean;
  stakeTxt?: string;
  stakeFrac?: number;
  reducedForRisk?: boolean;
  reducedForClv?: boolean;
  bestKey?: string;
  cands?: Candidate[];
  best?: Candidate;
  correlatedNote?: boolean;
}

/** Decisão automática (mercado 1X2/handicap) devolvida por autoDecide, incluindo a segunda oportunidade. */
export interface ModelDecision {
  bet: boolean;
  lbl?: string;
  od?: number;
  ev?: number;
  p?: number;
  pBefore?: number;
  calibApplied?: boolean;
  stakeTxt?: string;
  stakeFrac?: number;
  reducedForRisk?: boolean;
  reducedForClv?: boolean;
  cands: Candidate[];
  heur?: boolean;
  bestKey?: string;
  msg?: string;
  best?: Candidate;
  derived?: DerivedDecision;
}

/** Contexto necessário para autoDecide/buildOpts: calibração + banca/perfil/risco pendente. */
export interface DecisionContext {
  calib: CalibInfo;
  stake: StakeContext;
}

export type PoissonMatrix = number[][];

export interface GoalModel {
  lh: number;     // golos esperados casa
  la: number;     // golos esperados fora
  total: number;
  matrix: PoissonMatrix;
}

/** Opção do comparador de casas (dropdown "Melhor odd e stake"). */
export interface CompareOption {
  k: string;
  lbl: string;
  p: number;
  ref: number | null;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  predSum: number;
  wins: number;
}

export interface CalibrationResult {
  bins: CalibrationBin[];
  brier: number | null;
  brierBase: number | null;
  n: number;
  avgPred: number | null;
  avgActual: number;
}

export interface CalibInfo {
  active: boolean;
  bias: number;
  n: number;
}

export interface CalibAdjustment {
  p: number;
  applied: boolean;
}

/** Aposta registada no histórico do utilizador (localStorage). */
export interface Bet {
  id: string;
  gameId: string;
  selKey: string;
  sel: string;
  game: string;
  odd: number | string;
  stake: number | string;
  status: BetStatus;
  prob: number;
  loggedAt: string;
  oddClose?: number | string;
  clv?: number;
  paper?: boolean;   // true quando registada com "Modo papel" ativo — conta para calibração/CLV, não para o P&L real
  auto?: boolean;    // true quando registada sozinha por "Registar sugestões automaticamente" — amostra
                      // não enviesada pela escolha do utilizador; também fora do P&L real (ver storage.ts)
  lg?: string;       // liga do jogo (g.lg no momento do registo) — evita fazer parsing de texto a partir de `game`
  rejected?: boolean;   // true = não é uma aposta real, é um candidato rejeitado (EV insuficiente) guardado
                         // só para medir se "não apostar" foi a decisão certa — ver storage.computeRejectedStats
  homeTeam?: string; awayTeam?: string; kickoff?: string;   // denormalizado do Game no momento do registo —
                                                              // permite resolver o resultado (api.getFinalScoreFor)
                                                              // mesmo depois de o jogo sair de `games` (ver Game/data.ts)
}

/** Aposta ainda por gravar (saveBet atribui id/status/loggedAt). */
export type NewBet = Omit<Bet, "id" | "status" | "loggedAt">;

export interface PnLStats {
  staked: number;
  returned: number;
  profit: number;
  roi: number;
  hitRate: number;
  avgOdd: number;
  settled: number;
  wins: number;
  losses: number;
  voids: number;
  pending: number;
  pendingStake: number;
}

export interface CLVResult {
  avg: number;
  n: number;
}

/** Estatísticas dos candidatos rejeitados (EV insuficiente) rastreados como Bet.rejected — ver
 * storage.computeRejectedStats. hypotheticalProfit usa o stake hipotético guardado no momento da
 * rejeição, nunca dinheiro real. */
export interface RejectedStats {
  n: number;
  wouldWinRate: number;
  hypotheticalStaked: number;
  hypotheticalProfit: number;
}

/** Resultado do stop-loss por período (ver quant.stopLossStatus) — trava novas apostas quando o
 * drawdown das últimas STOP_LOSS_WINDOW_DAYS ultrapassa STOP_LOSS_DRAWDOWN_FRAC da banca. */
export interface StopLossStatus {
  halted: boolean;
  profit: number;         // P&L realizado na janela (negativo se prejuízo)
  drawdownFrac: number;   // fração da banca perdida na janela (0 se neutro/lucro)
  windowDays: number;
  n: number;              // apostas resolvidas consideradas na janela
}

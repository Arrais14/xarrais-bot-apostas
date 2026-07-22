// ===== Constantes centrais (limiares de EV, calibração, risco) =====
// Valores idênticos ao monólito original — só ganharam um único sítio partilhado.

export const EV_MIN = 0.08;              // reservado para um eventual caminho automático futuro sem
                                          // baseline sharp — autoDecide() hoje só decide COM sharp
                                          // (ver EV_MIN_SHARP), nunca chega a usar esta constante
export const EV_MIN_FRIENDLY = 0.12;     // idem, reservado (par de EV_MIN para jogos amigáveis)

// ===== EV mínimo COM baseline sharp (Pinnacle) — usado por autoDecide() =====
// 8%/12% foram calibrados para o antigo modelo de forma (heurística ruidosa, já removida) — com
// no-vig puro da Pinnacle a discrepância típica entre ela e a odd de referência (DraftKings/ESPN)
// raramente passa de 3-5%, por isso um limiar de 8% deixava passar quase nenhum sinal.
export const EV_MIN_SHARP = 0.03;            // EV mínimo com baseline sharp (jogos oficiais)
export const EV_MIN_SHARP_FRIENDLY = 0.06;   // idem, jogos amigáveis (forma pouco fiável)
export const CALIB_MIN_N = 30;           // nº mínimo de apostas resolvidas c/ prob. para ativar o shrinkage de calibração
export const PENDING_RISK_FRAC = 0.15;   // % da banca em apostas por resolver a partir da qual reduzimos novas stakes
export const SETTLE_REMINDER_H = 3;      // horas após o kickoff a partir das quais uma aposta pendente é "para liquidar"
export const CLOSE_ODDS_WINDOW_H = 3;    // janela (antes/depois do kickoff) em que ainda faz sentido pedir a odd de fecho
export const BACKUP_STALE_DAYS = 7;      // dias sem exportar a partir dos quais disparamos um backup automático

export const MIN_ODD = 1.30;             // odd mínima considerada para qualquer seleção candidata

// ===== Kelly Criterion (gestão de banca) =====
export const KELLY_FRAC_DEFAULT = 0.25;  // fração de Kelly por defeito ("Quarter Kelly") — substitui os antigos perfis fixos
export const STAKE_CAP_FRAC = 0.05;      // teto de segurança por aposta, independente da fração de Kelly escolhida
                                          // (protege de stakes gigantes quando o EV estimado é exagerado por erro do modelo)

// ===== Stop-loss por período =====
// Trava novas sugestões depois de uma sequência má recente — complementa o cap por aposta
// (STAKE_CAP_FRAC) e o corte por risco pendente, que não olham para o passado próximo.
export const STOP_LOSS_WINDOW_DAYS = 7;        // janela de dias considerada para o drawdown
export const STOP_LOSS_DRAWDOWN_FRAC = 0.15;   // drawdown (fração da banca) que ativa o halt

// ===== Gate de risco por CLV (Closing Line Value) =====
// CLV positivo sustentado é o sinal mais fiável de edge real — fica significativo bem antes do
// P&L (que precisa de centenas de apostas, dominado por variância). Ver quant.clvGate().
export const CLV_MIN_N = 50;             // nº mínimo de apostas c/ odd de fecho para o gate atuar
export const CLV_RISK_MULT = 0.5;        // multiplicador do Kelly quando o CLV médio é <= 0 com amostra suficiente

// ===== Sinal de movimento de mercado (abertura vs atual) =====
export const LINE_MOVEMENT_ALERT = 0.08;   // variação (fração) a partir da qual se destaca o movimento

// ===== Frescura de odds ao vivo no card fechado e no comparador aberto (main.ts) =====
// Só corre quando o próprio utilizador tem uma Odds API key configurada — cada um usa só a sua
// própria quota (plano gratuito da The-Odds-API), nunca uma partilhada. Cadência conservadora de
// propósito: card fechado (visível para vários jogos ao mesmo tempo) atualiza mais devagar do que
// o comparador aberto (um único jogo de cada vez).
export const CARD_ODDS_TICK_MS = 30_000;          // frequência do texto "atualizado há Xs" no card
export const CARD_ODDS_REFRESH_MS = 12 * 60_000;  // frequência real de um novo pedido por jogo no card
export const CMP_ODDS_TICK_MS = 15_000;           // idem, no comparador aberto (só 1 jogo de cada vez)
export const CMP_ODDS_REFRESH_MS = 3 * 60_000;    // idem, pedido real (Betclic) no comparador aberto

// ===== Casa de referência "sharp" para o no-vig (ver src/api.ts) =====
// A Pinnacle normalmente exige o plano pago ("Business") da The-Odds-API; se a chave não tiver
// acesso, a resposta simplesmente não traz este bookmaker e o modelo cai de volta para a odd
// de referência (DraftKings/ESPN) pré-carregada — nunca bloqueia o resto da app.
export const SHARP_BOOKMAKER_KEY = "pinnacle";

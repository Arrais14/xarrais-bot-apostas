// ===== Constantes centrais (limiares de EV, calibração, risco) =====
// Valores idênticos ao monólito original — só ganharam um único sítio partilhado.

export const EV_MIN = 0.08;              // EV mínimo para sinalizar aposta (jogos oficiais)
export const EV_MIN_FRIENDLY = 0.12;     // EV mínimo em jogos amigáveis (forma pouco fiável)
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

// ===== Pesos do modelo heurístico forma+mercado (ver quant.ts: blendFormMarket/modelProbs) =====
// Ajustáveis manualmente aqui com base na sugestão do painel de calibração (quant.suggestModelWeights)
// — nunca aplicados automaticamente. Mudar estes valores muda o comportamento do modelo para TODOS
// os jogos a partir daí; faz isso de forma deliberada, não a meio de uma sequência má ou boa.
export const MODEL_BLEND_W = 0.35;       // peso do componente forma+registo (1-w = peso do mercado no-vig)
export const MODEL_HOME_ADV = 0.12;      // vantagem casa somada ao "score de força" da equipa da casa
export const RECALIB_MIN_N = 200;        // nº mínimo de apostas resolvidas c/ inputs guardados para sugerir novos pesos

// ===== Frescura de odds ao vivo no card fechado e no comparador aberto (main.ts) =====
// Só corre quando o próprio utilizador tem uma Odds API key configurada — cada um usa só a sua
// própria quota (plano gratuito da The-Odds-API), nunca uma partilhada. Cadência conservadora de
// propósito: card fechado (visível para vários jogos ao mesmo tempo) atualiza mais devagar do que
// o comparador aberto (um único jogo de cada vez).
export const CARD_ODDS_TICK_MS = 30_000;          // frequência do texto "atualizado há Xs" no card
export const CARD_ODDS_REFRESH_MS = 12 * 60_000;  // frequência real de um novo pedido por jogo no card
export const CMP_ODDS_TICK_MS = 10_000;           // idem, no comparador aberto (só 1 jogo de cada vez)
export const CMP_ODDS_REFRESH_MS = 60_000;        // idem, pedido real (Betclic) no comparador aberto —
                                                   // seguro porque fetchLiveOdds partilha 1 pedido por
                                                   // liga (cache de 55s, ver src/api.ts) entre todos os
                                                   // jogos dessa liga, não gasta 1 crédito por jogo

// Captura automática da odd de fecho (CLV, ver api.fetchClosingOdd/main.autoCaptureCloseOdds) —
// corre em segundo plano sempre que há Odds API key, independente da aba/jogo aberto. Barato:
// reaproveita o mesmo cache por liga de 55s dos timers acima, nunca gasta um pedido só para isto.
export const CLOSE_ODDS_CAPTURE_MS = 5 * 60_000;

// ===== Casa de referência "sharp" para o no-vig (ver src/api.ts) =====
// A Pinnacle normalmente exige o plano pago ("Business") da The-Odds-API; se a chave não tiver
// acesso, a resposta simplesmente não traz este bookmaker e o modelo cai de volta para a odd
// de referência (DraftKings/ESPN) pré-carregada — nunca bloqueia o resto da app.
export const SHARP_BOOKMAKER_KEY = "pinnacle";

// ===== Ajuste Dixon-Coles ao modelo de golos (ver quant.ts:scoreMatrix) =====
// Exceção deliberada à REGRA DE OURO de quant.ts (pedida explicitamente, não uma alteração de
// rotina): o Poisson independente (golos casa/fora tratados como não-correlacionados) não reflete
// bem os placares baixos reais do futebol — Dixon & Coles (1997) corrigem isto com um fator
// multiplicativo nas 4 células de placar baixo (0-0/0-1/1-0/1-1) antes de renormalizar a matriz.
// rho é tipicamente ~-0.1 a -0.2 na literatura (usa-se -0.1 aqui, o valor mais citado).
// NOTA IMPORTANTE (verificado numericamente, não assumido): com este sinal — o mesmo da fórmula
// original do paper — o efeito real é AUMENTAR ligeiramente 0-0 e 1-1 (portanto o BTTS sobe um
// pouco, não desce) e reduzir 1-0/0-1, refletindo que jogos reais têm mais empates "cautelosos"
// de baixo marcador do que a independência pura preveria. Se algum dia se quiser o efeito
// contrário (BTTS a descer), inverte-se o sinal para +0.1 — mas isso deixaria de ser o Dixon-Coles
// "de fábrica" citado na literatura.
export const DIXON_COLES_RHO = -0.1;

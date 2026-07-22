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

// ===== Casa de referência "sharp" para o no-vig (ver src/api.ts) =====
// A Pinnacle normalmente exige o plano pago ("Business") da The-Odds-API; se a chave não tiver
// acesso, a resposta simplesmente não traz este bookmaker e o modelo cai de volta para a odd
// de referência (DraftKings/ESPN) pré-carregada — nunca bloqueia o resto da app.
export const SHARP_BOOKMAKER_KEY = "pinnacle";

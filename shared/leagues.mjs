// ===== Mapas de ligas partilhados entre src/api.ts (app, TypeScript) e scripts/update-daily-data.mjs
// (tarefa diária, Node puro) — um único sítio para não haver duas cópias a divergir em silêncio.
// Fica em .mjs (não .ts) de propósito: o script diário corre fora do grafo Vite/TS sem passo de
// compilação nenhum (ver comentário no topo do próprio script), por isso este ficheiro tem de ser
// JavaScript executável diretamente pelo Node — src/api.ts importa-o na mesma (com "allowJs": true
// em tsconfig.json), sem precisar de o duplicar nem de o reescrever em TypeScript.

// ===== ESPN: scoreboard/standings/schedule (API pública não-oficial, sem chave) =====
// Confirmada em 2026-07-22 contra a documentação comunitária (github.com/pseudo-r/Public-ESPN-API/
// blob/main/docs/sports/soccer.md). Slugs de liga por época, não garantidos a longo prazo.
/** @type {Record<string, string>} */
export const ESPN_LEAGUE_SLUG = {
  "Brasileirão": "bra.1",
  "Liga MX": "mex.1",
  "Liga Portugal": "por.1",
  "Premier League": "eng.1",
  "La Liga": "esp.1",
  "Serie A": "ita.1",
  "Bundesliga": "ger.1",
  "Ligue 1": "fra.1",
  "Champions League": "uefa.champions",
  "Liga Europa": "uefa.europa",
  // Confirmados ao vivo em 2026-07-22/23 (pedidos reais ao scoreboard, não só documentação) —
  // devolveram jogos reais das rondas de qualificação em curso nesta altura do ano (julho-agosto).
  "Champions League (Qualificação)": "uefa.champions_qual",
  "Liga Europa (Qualificação)": "uefa.europa_qual",
  "Conference League (Qualificação)": "uefa.europa.conf_qual"
};

// ===== The-Odds-API: sport_key por liga (verifica/atualiza em /v4/sports?apiKey=..., mudam por
// época) =====
/** @type {Record<string, string>} */
export const ODDS_API_SPORT_MAP = {
  "Brasileirão": "soccer_brazil_campeonato",
  "Liga MX": "soccer_mexico_ligamx",
  "Liga Portugal": "soccer_portugal_primeira_liga",
  "Premier League": "soccer_epl",
  "La Liga": "soccer_spain_la_liga",
  "Serie A": "soccer_italy_serie_a",
  "Bundesliga": "soccer_germany_bundesliga",
  "Ligue 1": "soccer_france_ligue_one",
  "Champions League": "soccer_uefa_champs_league",
  "Liga Europa": "soccer_uefa_europa_league",
  // Só a Champions League tem key própria de qualificação confirmada (duas fontes independentes);
  // Europa/Conference não têm variante "_qualification" nenhuma — usam-se as keys da fase principal,
  // na aposta de que a The-Odds-API agrupa a pré-eliminatória sob o mesmo sport_key do torneio (ao
  // contrário da ESPN, que separa por slug). Ainda não testado contra uma chave real; confirma com
  // GET /v4/sports?apiKey=... antes de confiar às cegas. Se estiver errado, falha em segurança — o
  // jogo continua a aparecer, só sem odds pré-carregadas.
  "Champions League (Qualificação)": "soccer_uefa_champs_league_qualification",
  "Liga Europa (Qualificação)": "soccer_uefa_europa_league",
  "Conference League (Qualificação)": "soccer_uefa_europa_conference_league"
};

// ===== Casas de apostas confirmadas nesta API =====
// betclic_fr: doc oficial (the-odds-api.com/sports-odds-data/bookmaker-apis.html), 2026-07-22.
// betano_uk: confirmado ao vivo em 2026-07-24 via diagnóstico sem filtro (regions=eu,uk,fr) contra
// Brasileirão e Liga MX — a Betano aparece com esta key exata (não "betano" sozinho). "bwin" NÃO
// apareceu em nenhuma das duas listas (nem lá está o Blockbet) — sem essa key confirmada, não entra
// no fallback nenhum; fica só preenchimento manual no comparador, tal como Blockbet.
export const AUTO_BOOKMAKER_KEYS = { bc: "betclic_fr", bt: "betano_uk" };

// ===== Prioridade da odd de referência (g.o) quando há mais que uma casa disponível para o mesmo
// jogo — ver matchOdds em scripts/update-daily-data.mjs. Betclic e Betano (casas europeias
// "soccer-first") tendem a publicar linhas mais cedo e com mais profundidade que a DraftKings (US,
// coberta aqui só por ser a mais estável historicamente); DraftKings fica como último recurso, não
// como preferida. "bwin" ficaria a seguir à Betano se um dia aparecer confirmada numa destas ligas —
// por agora não existe na resposta real (ver comentário de AUTO_BOOKMAKER_KEYS), não é incluída.
export const REFERENCE_BOOKMAKER_PRIORITY = ["betclic_fr", "betano_uk", "draftkings"];

// ===== Aliases ESPN -> The-Odds-API (ambos os lados já normalizados por normTeam) =====
// Para os pares em que o fuzzy (includes bidirecional, ver teamMatches/findApiGame) não chega,
// porque as duas fontes usam nomes genuinamente diferentes para a mesma equipa. Alimentado a partir
// dos logs "[sem-match]" do script diário — quando aparecer um, acrescenta aqui o par normalizado.
export const TEAM_ALIASES = {
  // Brasileirão
  "atleticomg": "atleticomineiro",
  // Confirmado no diagnóstico de 2026-07-24 (candidato com score 1.00, "Atletico Paranaense" — SEM
  // "h", ao contrário do que se assumira antes ("athleticoparanaense" nunca batia com nada real).
  "athleticopr": "atleticoparanaense",
  "americamg": "americamineiro",
  // Confirmado no mesmo diagnóstico: a The-Odds-API chama-lhe "Bragantino-SP", não "Red Bull
  // Bragantino" (candidato "Bragantino-SP vs Coritiba", score 1.00, para "Red Bull Bragantino
  // vs Coritiba").
  "redbullbragantino": "bragantinosp",
  // Liga MX
  "atleticodesanluis": "atleticosanluis"
};

export function normTeam(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

// Fuzzy (includes bidirecional) + aliases — mesma lógica usada por src/api.ts:findApiGame e por
// scripts/update-daily-data.mjs:matchOdds, agora com uma só implementação para as duas.
export function teamMatches(espnNorm, apiNorm) {
  if (!espnNorm || !apiNorm) return false;
  if (espnNorm === apiNorm || espnNorm.includes(apiNorm) || apiNorm.includes(espnNorm)) return true;
  const alias = TEAM_ALIASES[espnNorm];
  return !!alias && (alias === apiNorm || alias.includes(apiNorm) || apiNorm.includes(alias));
}

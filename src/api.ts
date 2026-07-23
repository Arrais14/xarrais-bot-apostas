// ===== Chamadas de rede assíncronas: odds automáticas, resultado final, integrações LLM =====
// Nada neste ficheiro toca no DOM diretamente (exceto o fetch/localStorage inerentes à própria
// chamada) — quem invoca estas funções (main.ts) é que decide o que mostrar e quando re-renderizar.

import type { Bet, FinalScore, Game, SharpQuote } from "./types";
import { SETTLE_REMINDER_H, SHARP_BOOKMAKER_KEY } from "./config";
import { LS } from "./storage";

// ===== Odds API (fetch automático — ver painel "APIs externas" na UI para a chave) =====
export const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
// Chaves de sport da The-Odds-API por liga — verifica/atualiza em /v4/sports?apiKey=... (mudam por
// época). As chaves das ligas europeias abaixo foram confirmadas em 2026-07-22 contra
// the-odds-api.com/sports-odds-data/soccer-odds.html (não testadas contra uma chave real — faz essa
// verificação com GET /v4/sports?apiKey=... antes de confiar nelas às cegas na tua conta/plano).
export const ODDS_API_SPORT_MAP: Record<string, string> = {
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
  // "soccer_uefa_champs_league_qualification" confirmado (duas fontes independentes) como key
  // real e distinta da fase de grupos. NÃO existe key própria de qualificação para a Liga Europa
  // nem para a Conference (confirmado por ausência: o dropdown oficial do widget builder só lista
  // "soccer_uefa_europa_league" e "soccer_uefa_europa_conference_league", sem variante
  // "_qualification" para nenhuma das duas) — por isso usam-se as keys da fase principal, na
  // aposta de que a The-Odds-API agrupa a pré-eliminatória sob o mesmo sport_key do torneio
  // (ao contrário da ESPN, que separa por slug — ver ESPN_LEAGUE_SLUG). Ainda assim não
  // testado contra uma chave real; confirma com GET /v4/sports?apiKey=... antes de confiar às
  // cegas. Se estiver errado, fetchOddsForLeague/fetchLiveOdds falham em segurança — o jogo
  // continua a aparecer, só sem odds pré-carregadas.
  "Champions League (Qualificação)": "soccer_uefa_champs_league_qualification",
  "Liga Europa (Qualificação)": "soccer_uefa_europa_league",
  "Conference League (Qualificação)": "soccer_uefa_europa_conference_league"
};
// Verificado em 2026-07-22 contra a doc oficial (the-odds-api.com/sports-odds-data/bookmaker-apis.html):
// a Betclic aparece com a key "betclic_fr" (secções FR e EU) — "betclic" sozinho não existe e nunca
// devolvia nada. Betano e Blockbet NÃO constam em nenhuma região documentada (US/UK/EU/FR/SE/AU);
// não há forma de as pedir a esta API, por isso nem são tentadas — ficam só como preenchimento
// manual no comparador (ver "bb"/"bt" em main.ts). Se um dia passarem a ser cobertas, adiciona-as
// aqui com a key confirmada (idealmente testada com uma chave real, não só a partir da doc).
export const AUTO_BOOKMAKER_KEYS: Record<string, string> = { bc: "betclic_fr" };

// ===== Scoreboard da ESPN (a mesma fonte da odd de referência) — API pública não-oficial, sem
// chave. Confirmada em 2026-07-22 contra a documentação comunitária (github.com/pseudo-r/Public-
// ESPN-API/blob/main/docs/sports/soccer.md): endpoint scoreboard?dates=YYYYMMDD, com
// events[].competitions[].competitors[] (homeAway/team.displayName/score) e
// events[].status.type.completed. Slugs de liga por época, não garantidos a longo prazo.
export const ESPN_LEAGUE_SLUG: Record<string, string> = {
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
  // Confirmados ao vivo em 2026-07-22 (pedidos reais ao scoreboard, não só documentação) — ambos
  // devolveram jogos reais da ronda de qualificação em curso nesta altura do ano (meados de
  // julho a agosto).
  "Champions League (Qualificação)": "uefa.champions_qual",
  "Liga Europa (Qualificação)": "uefa.europa_qual",
  // Confirmado ao vivo em 2026-07-23: a Champions League não teve nenhum jogo de qualificação
  // agendado nesse dia (só a de Europa), mas a Conference teve — 40 jogos reais no mesmo pedido.
  "Conference League (Qualificação)": "uefa.europa.conf_qual"
};

function normTeam(s: string | null | undefined): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
}

interface ApiOutcome { name: string; price: number; }
interface ApiMarket { key: string; outcomes: ApiOutcome[]; }
interface ApiBookmaker { key: string; markets?: ApiMarket[]; }
interface ApiGame { home_team?: string; away_team?: string; bookmakers?: ApiBookmaker[]; }

function findApiGame(apiGames: ApiGame[] | undefined, g: Game): ApiGame | undefined {
  const nh = normTeam(g.h.n), na = normTeam(g.a.n);
  return (apiGames || []).find(ag => {
    const ah = normTeam(ag.home_team || ""), aa = normTeam(ag.away_team || "");
    return !!ah && !!aa && (ah.includes(nh) || nh.includes(ah)) && (aa.includes(na) || na.includes(aa));
  });
}

export type FetchOddsResult =
  | { ok: true; odds: Record<string, number> }
  | { ok: false; reason: string };

function extractSharpQuote(match: ApiGame, g: Game): SharpQuote | null {
  const bk = (match.bookmakers || []).find(b => b.key === SHARP_BOOKMAKER_KEY);
  const h2h = bk && (bk.markets || []).find(m => m.key === "h2h");
  if (!h2h) return null;
  const homeOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(g.h.n));
  const awayOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(g.a.n));
  const drawOc = h2h.outcomes.find(o => o.name === "Draw");
  if (!homeOc || !awayOc || !drawOc) return null;
  return { h: homeOc.price, d: drawOc.price, a: awayOc.price };
}

// Cache da odd "sharp" (Pinnacle) por jogo — alimentada como efeito secundário de fetchLiveOdds
// (mesmo pedido HTTP, sem gastar quota extra da API) e lida de forma síncrona por getSharpOdds
// (cache-or-trigger em segundo plano, mesmo padrão usado por getFinalScore mais abaixo).
const sharpCache = new Map<string, SharpQuote>();
const sharpPending = new Set<string>();
let onSharpResult: ((gameId: string) => void) | null = null;
export function setOnSharpResult(cb: ((gameId: string) => void) | null): void { onSharpResult = cb; }

// Substitui a cópia manual da odd da Betclic no comparador (a única casa local confirmada nesta
// API — ver AUTO_BOOKMAKER_KEYS). Se não houver chave, a liga não estiver mapeada, ou o jogo não
// for encontrado na API, cai-se sempre para os campos manuais — nunca bloqueia o resto da app.
// De caminho, se a Pinnacle vier na resposta, guarda-se em sharpCache para o motor quantitativo
// usar como referência "sharp".
export async function fetchLiveOdds(g: Game): Promise<FetchOddsResult> {
  const apiKey = LS.oddsApiKey;
  if (!apiKey) return { ok: false, reason: "sem-chave" };
  const sportKey = ODDS_API_SPORT_MAP[g.lg];
  if (!sportKey) return { ok: false, reason: "liga-nao-mapeada" };
  const bookmakers = [SHARP_BOOKMAKER_KEY, ...Object.values(AUTO_BOOKMAKER_KEYS)].join(",");
  const url = ODDS_API_BASE + "/sports/" + encodeURIComponent(sportKey) + "/odds/?apiKey=" + encodeURIComponent(apiKey)
    + "&regions=eu,fr&markets=h2h&oddsFormat=decimal&bookmakers=" + bookmakers;
  let data: ApiGame[];
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, reason: "http-" + r.status };
    data = await r.json();
  } catch {
    return { ok: false, reason: "erro-rede" };
  }
  const match = findApiGame(data, g);
  if (!match) return { ok: false, reason: "jogo-nao-encontrado" };
  const sharp = extractSharpQuote(match, g);
  if (sharp) { sharpCache.set(g.id, sharp); onSharpResult?.(g.id); }
  const out: Record<string, number> = {};
  for (const [code, bkKey] of Object.entries(AUTO_BOOKMAKER_KEYS)) {
    const bk = (match.bookmakers || []).find(b => b.key === bkKey);
    const h2h = bk && (bk.markets || []).find(m => m.key === "h2h");
    const homeOc = h2h && h2h.outcomes.find(o => normTeam(o.name) === normTeam(g.h.n));
    if (homeOc) out[code] = homeOc.price;
  }
  return { ok: true, odds: out };
}

// Interface síncrona: se já houver Pinnacle em cache devolve-a já; caso contrário dispara
// fetchLiveOdds em segundo plano (que também alimenta o comparador de Betano/Betclic) e devolve
// null nesta primeira chamada — o modelo cai para a odd de referência (DraftKings/ESPN)
// pré-carregada nesse intervalo.
export function getSharpOdds(g: Game): SharpQuote | null {
  const cached = sharpCache.get(g.id);
  if (cached) return cached;
  if (!LS.oddsApiKey || sharpPending.has(g.id)) return null;
  sharpPending.add(g.id);
  void fetchLiveOdds(g).finally(() => sharpPending.delete(g.id));
  return null;
}

// ===== Resultado final (ESPN scoreboard) — MVP, não minuto-a-minuto =====
interface EspnCompetitor { team?: { displayName?: string }; score?: string; homeAway?: string; }
interface EspnCompetition { competitors?: EspnCompetitor[]; }
interface EspnEvent { competitions?: EspnCompetition[]; status?: { type?: { completed?: boolean } }; }
interface EspnScoreboard { events?: EspnEvent[]; }

export type FetchScoreResult =
  | { ok: true; score: FinalScore }
  | { ok: false; reason: string };

// Só faz sentido tentar depois de SETTLE_REMINDER_H horas do kickoff (mesma referência usada para
// o lembrete de "por liquidar" em main.ts) — antes disso o jogo pode nem ter terminado. Recebe os
// dados em bruto (não um Game) para poder ser chamada tanto a partir de um jogo ainda em `games`
// como a partir de uma Bet já denormalizada (ver Bet.homeTeam/awayTeam/kickoff em types.ts) — uma
// aposta de há 1-2 dias já pode não ter Game correspondente, porque a tarefa diária substitui
// `src/data.ts` a cada corrida.
export async function fetchFinalScoreRaw(lg: string, kickoffIso: string, homeName: string, awayName: string): Promise<FetchScoreResult> {
  const kickoffMs = new Date(kickoffIso).getTime();
  const hoursSinceKickoff = (Date.now() - kickoffMs) / 3600000;
  if (hoursSinceKickoff < SETTLE_REMINDER_H) return { ok: false, reason: "cedo-demais" };
  const slug = ESPN_LEAGUE_SLUG[lg];
  if (!slug) return { ok: false, reason: "liga-nao-mapeada" };
  const dateStr = new Date(kickoffMs).toISOString().slice(0, 10).replace(/-/g, "");
  const url = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + encodeURIComponent(slug) + "/scoreboard?dates=" + dateStr;
  let data: EspnScoreboard;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, reason: "http-" + r.status };
    data = await r.json();
  } catch {
    return { ok: false, reason: "erro-rede" };
  }
  const match = (data.events || []).find(ev => {
    const comp = ev.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === "home");
    const away = comp?.competitors?.find(c => c.homeAway === "away");
    return !!home && !!away && normTeam(home.team?.displayName) === normTeam(homeName) && normTeam(away.team?.displayName) === normTeam(awayName);
  });
  if (!match) return { ok: false, reason: "jogo-nao-encontrado" };
  if (!match.status?.type?.completed) return { ok: false, reason: "ainda-a-decorrer" };
  const comp = match.competitions?.[0];
  const home = comp?.competitors?.find(c => c.homeAway === "home");
  const away = comp?.competitors?.find(c => c.homeAway === "away");
  const homeScore = home?.score != null ? parseInt(home.score, 10) : NaN;
  const awayScore = away?.score != null ? parseInt(away.score, 10) : NaN;
  if (isNaN(homeScore) || isNaN(awayScore)) return { ok: false, reason: "sem-resultado" };
  return { ok: true, score: { home: homeScore, away: awayScore } };
}

export async function fetchFinalScore(g: Game): Promise<FetchScoreResult> {
  return fetchFinalScoreRaw(g.lg, g.d, g.h.n, g.a.n);
}

const scoreCache = new Map<string, FinalScore>();
const scorePending = new Set<string>();
let onScoreResult: ((gameId: string) => void) | null = null;
export function setOnScoreResult(cb: ((gameId: string) => void) | null): void { onScoreResult = cb; }

// Mesmo padrão síncrono cache-or-trigger de getSharpOdds, mas indexado por um `id` genérico (não
// precisa de um Game vivo em `games`) — permite resolver o resultado de uma aposta antiga a partir
// só dos campos denormalizados nela (lg/kickoff/homeTeam/awayTeam).
export function getFinalScoreFor(id: string, lg: string, kickoffIso: string, homeName: string, awayName: string): FinalScore | null {
  const cached = scoreCache.get(id);
  if (cached) return cached;
  if (scorePending.has(id)) return null;
  scorePending.add(id);
  void fetchFinalScoreRaw(lg, kickoffIso, homeName, awayName)
    .then(res => { if (res.ok) { scoreCache.set(id, res.score); onScoreResult?.(id); } })
    .finally(() => scorePending.delete(id));
  return null;
}

// Só vale a pena chamar para jogos com apostas pendentes (ver pendingBetsFor em main.ts) — não faz
// sentido gastar pedidos à ESPN para todos os jogos do dia.
export function getFinalScore(g: Game): FinalScore | null {
  return getFinalScoreFor(g.id, g.lg, g.d, g.h.n, g.a.n);
}

// ===== Chamadas reais a LLMs externos (usadas só quando não há window.cowork disponível) =====
// As chaves vêm do LS (localStorage), nunca de uma constante no código — ver painel "APIs externas".
export async function callAnthropic(systemPrompt: string, userContent: string, apiKey: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Header exigido pela Anthropic para chamadas diretas do browser — o próprio nome
      // ("dangerous") é um aviso deles: a chave fica visível a quem inspecionar este browser.
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }]
    })
  });
  if (!r.ok) throw new Error("Anthropic API " + r.status);
  const data = await r.json();
  return (data.content && data.content[0] && data.content[0].text) || "";
}

export async function callOpenAI(systemPrompt: string, userContent: string, apiKey: string): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent }
      ]
    })
  });
  if (!r.ok) throw new Error("OpenAI API " + r.status);
  const data = await r.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

// Dispatcher usado pela nota de análise (aiAnalyse em main.ts): tenta a ponte cowork (artifact
// publicado no Claude, sem chave necessária), depois a chave própria configurada (Anthropic/OpenAI),
// e lança erro se não houver nenhuma integração disponível — o chamador cai então para fallbackNote.
export async function requestAiNote(prompt: string, dataJson: string): Promise<string> {
  if (window.cowork && window.cowork.askClaude) {
    // Caminho automático: quando isto corre como artifact publicado no Claude, esta ponte
    // já existe e trata da chamada ao modelo sem precisares de nenhuma chave.
    const r = await window.cowork.askClaude(prompt, [dataJson]);
    return typeof r === "string" ? r : (r && r.text) ? r.text : JSON.stringify(r);
  }
  if (LS.aiKey && LS.aiProvider === "anthropic") {
    return callAnthropic(prompt, dataJson, LS.aiKey);
  }
  if (LS.aiKey && LS.aiProvider === "openai") {
    return callOpenAI(prompt, dataJson, LS.aiKey);
  }
  throw new Error("sem-integracao-de-ia");
}

// ===== Sincronização opcional do histórico com Google Sheets/Notion (extra, não obrigatório) =====
// ESPECULATIVO: window.cowork.callMcpTool não está confirmado como existindo fora do contexto de
// artifact publicado no Claude (só window.cowork.askClaude, usado acima, é uma ponte já conhecida
// desta app) — por isso testa-se sempre a presença da função antes de a chamar, e qualquer falha
// (ausência do conector, erro na chamada) é tratada como "não disponível", nunca bloqueia o resto
// da app. O nome exato da ferramenta MCP (ex. o conector de Sheets/Notion que tiveres ligado) é
// configurável no painel "APIs externas" — não há forma de adivinhar isso à partida.
export type SyncResult = { ok: true } | { ok: false; reason: "sem-conector" | "erro-conector" };

export async function syncBetsToExternalSheet(bets: Bet[]): Promise<SyncResult> {
  const toolName = LS.mcpSyncTool;
  if (!toolName || !window.cowork || typeof window.cowork.callMcpTool !== "function") {
    return { ok: false, reason: "sem-conector" };
  }
  try {
    await window.cowork.callMcpTool(toolName, {
      rows: bets.map(b => ({
        data: b.loggedAt, jogo: b.game, selecao: b.sel, odd: b.odd, stake: b.stake,
        estado: b.status, prob: b.prob, oddFecho: b.oddClose ?? "", clv: b.clv ?? ""
      }))
    });
    return { ok: true };
  } catch (e) {
    console.warn("Sincronização externa (Sheets/Notion) falhou:", e);
    return { ok: false, reason: "erro-conector" };
  }
}

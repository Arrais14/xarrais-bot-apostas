// ===== Chamadas de rede assíncronas: odds automáticas, resultado final, integrações LLM =====
// Nada neste ficheiro toca no DOM diretamente (exceto o fetch/localStorage inerentes à própria
// chamada) — quem invoca estas funções (main.ts) é que decide o que mostrar e quando re-renderizar.

import type { Bet, FinalScore, Game, SharpQuote } from "./types";
import { SETTLE_REMINDER_H, SHARP_BOOKMAKER_KEY } from "./config";
import { LS } from "./storage";
import { stripSelKeyPrefix } from "./quant";
// Fonte única partilhada com scripts/update-daily-data.mjs (tarefa diária, Node puro sem passo de
// compilação) — ver shared/leagues.mjs para o porquê de ser .mjs e não .ts, e para o histórico de
// confirmação de cada slug/sport_key. allowJs em tsconfig.json permite este import.
import { AUTO_BOOKMAKER_KEYS, ESPN_LEAGUE_SLUG, ODDS_API_SPORT_MAP, normTeam, teamMatches } from "../shared/leagues.mjs";

export { AUTO_BOOKMAKER_KEYS, ESPN_LEAGUE_SLUG, ODDS_API_SPORT_MAP };

// ===== Odds API (fetch automático — ver painel "APIs externas" na UI para a chave) =====
export const ODDS_API_BASE = "https://api.the-odds-api.com/v4";

interface ApiOutcome { name: string; price: number; }
interface ApiMarket { key: string; outcomes: ApiOutcome[]; }
interface ApiBookmaker { key: string; markets?: ApiMarket[]; }
interface ApiGame { home_team?: string; away_team?: string; bookmakers?: ApiBookmaker[]; }

function findApiGame(apiGames: ApiGame[] | undefined, g: Game): ApiGame | undefined {
  const nh = normTeam(g.h.n), na = normTeam(g.a.n);
  return (apiGames || []).find(ag => teamMatches(nh, normTeam(ag.home_team || "")) && teamMatches(na, normTeam(ag.away_team || "")));
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

// ===== Cache partilhado por liga (não por jogo) — a resposta de uma liga serve todos os jogos
// abertos dessa liga na mesma janela de 55s, em vez de 1 pedido por jogo por tick (o comparador e o
// card já reduziram a cadência — ver CMP_ODDS_REFRESH_MS/CARD_ODDS_REFRESH_MS — mas com vários jogos
// da mesma liga abertos ao mesmo tempo isto ainda multiplicava pedidos desnecessariamente). Um mapa
// de promessas pendentes evita 2 pedidos em voo para a mesma liga se dois jogos pedirem ao mesmo
// tempo (ex.: o timer do card e o do comparador a disparar juntos). =====
type LeagueOddsFetch = { ok: true; data: ApiGame[] } | { ok: false; reason: string };
const leagueOddsCache = new Map<string, { data: ApiGame[]; ts: number }>();
const leagueOddsPending = new Map<string, Promise<LeagueOddsFetch>>();
const LEAGUE_ODDS_CACHE_MS = 55_000;

// Quota da The-Odds-API (plano grátis ≈ 500 créditos/mês) lida dos headers de resposta — só
// atualizada quando um pedido real sai (nunca em cache hits, que não têm headers novos), mas fica
// disponível globalmente para a UI mostrar mesmo que a leitura tenha vindo de outro jogo/liga.
let lastQuota: { remaining: number | null; used: number | null } = { remaining: null, used: null };
export function getOddsApiQuota(): { remaining: number | null; used: number | null } { return lastQuota; }

async function fetchLeagueOddsCached(sportKey: string, apiKey: string): Promise<LeagueOddsFetch> {
  const cached = leagueOddsCache.get(sportKey);
  if (cached && Date.now() - cached.ts < LEAGUE_ODDS_CACHE_MS) return { ok: true, data: cached.data };
  const pending = leagueOddsPending.get(sportKey);
  if (pending) return pending;
  const bookmakers = [SHARP_BOOKMAKER_KEY, ...Object.values(AUTO_BOOKMAKER_KEYS)].join(",");
  const url = ODDS_API_BASE + "/sports/" + encodeURIComponent(sportKey) + "/odds/?apiKey=" + encodeURIComponent(apiKey)
    + "&regions=eu,fr&markets=h2h&oddsFormat=decimal&bookmakers=" + bookmakers;
  const p = (async (): Promise<LeagueOddsFetch> => {
    try {
      const r = await fetch(url);
      const remaining = r.headers.get("x-requests-remaining");
      const used = r.headers.get("x-requests-used");
      if (remaining != null || used != null) {
        lastQuota = { remaining: remaining != null ? parseInt(remaining, 10) : null, used: used != null ? parseInt(used, 10) : null };
      }
      if (!r.ok) return { ok: false, reason: "http-" + r.status };
      const data: ApiGame[] = await r.json();
      leagueOddsCache.set(sportKey, { data, ts: Date.now() });
      return { ok: true, data };
    } catch {
      return { ok: false, reason: "erro-rede" };
    } finally {
      leagueOddsPending.delete(sportKey);
    }
  })();
  leagueOddsPending.set(sportKey, p);
  return p;
}

// Substitui a cópia manual da odd da Betclic/Betano no comparador (casas confirmadas nesta API —
// ver AUTO_BOOKMAKER_KEYS). Se não houver chave, a liga não estiver mapeada, ou o jogo não for
// encontrado na API, cai-se sempre para os campos manuais — nunca bloqueia o resto da app.
// De caminho, se a Pinnacle vier na resposta, guarda-se em sharpCache para o motor quantitativo
// usar como referência "sharp".
export async function fetchLiveOdds(g: Game): Promise<FetchOddsResult> {
  const apiKey = LS.oddsApiKey;
  if (!apiKey) return { ok: false, reason: "sem-chave" };
  const sportKey = ODDS_API_SPORT_MAP[g.lg];
  if (!sportKey) return { ok: false, reason: "liga-nao-mapeada" };
  const league = await fetchLeagueOddsCached(sportKey, apiKey);
  if (!league.ok) return { ok: false, reason: league.reason };
  const data = league.data;
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

// ===== Odd de fecho automática (CLV, ver main.autoCaptureCloseOdds) =====
// Só cobre "1"/"X"/"2" (com qualquer prefixo de proveniência — AUTO:/D:/REJ:/AUTO:D:, despidos por
// quant.stripSelKeyPrefix, a mesma normalização de resolveBetOutcome) — é a única leitura direta de
// preço que temos (h2h outcomes); dupla hipótese/handicap/golos exigiriam recompor um preço a partir
// de vários outcomes, o que já não é "a odd de fecho" no sentido estrito, e ficam de fora (o
// utilizador continua a poder preencher esses à mão). Usa a Pinnacle (SHARP_BOOKMAKER_KEY) como
// referência de fecho, não a casa onde a aposta foi realmente registada — é a convenção padrão da
// indústria para medir CLV (o "closing line" mais eficiente do mercado), e a mesma fonte já pedida
// para o modelo, por isso não gasta pedidos extra (reaproveita fetchLeagueOddsCached).
export async function fetchClosingOdd(lg: string, homeName: string, awayName: string, selKey: string): Promise<number | null> {
  const key = stripSelKeyPrefix(selKey);
  if (key !== "1" && key !== "X" && key !== "2") return null;
  const apiKey = LS.oddsApiKey;
  if (!apiKey) return null;
  const sportKey = ODDS_API_SPORT_MAP[lg];
  if (!sportKey) return null;
  const league = await fetchLeagueOddsCached(sportKey, apiKey);
  if (!league.ok) return null;
  const nh = normTeam(homeName), na = normTeam(awayName);
  const match = league.data.find(ag => teamMatches(nh, normTeam(ag.home_team || "")) && teamMatches(na, normTeam(ag.away_team || "")));
  if (!match) return null;
  const bk = (match.bookmakers || []).find(b => b.key === SHARP_BOOKMAKER_KEY);
  const h2h = bk && (bk.markets || []).find(m => m.key === "h2h");
  if (!h2h) return null;
  const homeOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(match.home_team || ""));
  const awayOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(match.away_team || ""));
  const drawOc = h2h.outcomes.find(o => o.name === "Draw");
  if (!homeOc || !awayOc || !drawOc) return null;
  return key === "1" ? homeOc.price : key === "2" ? awayOc.price : drawOc.price;
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
  // O scoreboard da ESPN agrupa jogos pela data US Eastern, não UTC — um jogo às 00:30Z do dia N
  // aparece no scoreboard do dia N-1 e "jogo-nao-encontrado" ficava permanente. Tentam-se até 3
  // datas (dia UTC do kickoff, anterior, seguinte), parando na primeira que devolve o jogo.
  const dayMs = 86400000;
  let lastReason = "jogo-nao-encontrado";
  for (const offset of [0, -1, 1]) {
    const dateStr = new Date(kickoffMs + offset * dayMs).toISOString().slice(0, 10).replace(/-/g, "");
    const url = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + encodeURIComponent(slug) + "/scoreboard?dates=" + dateStr;
    let data: EspnScoreboard;
    try {
      const r = await fetch(url);
      if (!r.ok) { lastReason = "http-" + r.status; continue; }
      data = await r.json();
    } catch {
      lastReason = "erro-rede";
      continue;
    }
    const match = (data.events || []).find(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === "home");
      const away = comp?.competitors?.find(c => c.homeAway === "away");
      return !!home && !!away && normTeam(home.team?.displayName) === normTeam(homeName) && normTeam(away.team?.displayName) === normTeam(awayName);
    });
    if (!match) continue;
    if (!match.status?.type?.completed) return { ok: false, reason: "ainda-a-decorrer" };
    const comp = match.competitions?.[0];
    const home = comp?.competitors?.find(c => c.homeAway === "home");
    const away = comp?.competitors?.find(c => c.homeAway === "away");
    const homeScore = home?.score != null ? parseInt(home.score, 10) : NaN;
    const awayScore = away?.score != null ? parseInt(away.score, 10) : NaN;
    if (isNaN(homeScore) || isNaN(awayScore)) return { ok: false, reason: "sem-resultado" };
    return { ok: true, score: { home: homeScore, away: awayScore } };
  }
  return { ok: false, reason: lastReason };
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

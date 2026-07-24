#!/usr/bin/env node
// ===== Tarefa diária: regenera public/data.json com jogos/odds reais (ESPN + The-Odds-API) =====
// A app faz fetch disto em runtime (ver loadPreloadedData em src/main.ts) — atualizar os dados não
// obriga a rebuild/redeploy do JS. src/data-fallback.ts é só um snapshot estático embutido no
// bundle, usado como último recurso se o fetch falhar; não é escrito por este script.
// Corre fora do grafo Vite/TS (Node puro, sem dependências) via .github/workflows/daily-data-update.yml.
// Falha graciosamente por liga/jogo — nunca deixa o ficheiro inteiro vazio (ver runLeague/main).
//
// Endpoints confirmados ao vivo em 2026-07-22 (não só documentação):
//   scoreboard : https://site.api.espn.com/apis/site/v2/sports/soccer/{liga}/scoreboard?dates=YYYYMMDD
//   standings  : https://site.api.espn.com/apis/v2/sports/soccer/{liga}/standings
//                -> children[0].standings.entries[].stats tem wins/ties/losses diretos
//   schedule   : https://site.api.espn.com/apis/site/v2/sports/soccer/{liga}/teams/{id}/schedule
//                -> competitions[0].competitors[].winner (bool) dá para derivar a forma recente
//
// ESPN_LEAGUE_SLUG / ODDS_API_SPORT_MAP / TEAM_ALIASES / normTeam vêm de ../shared/leagues.mjs —
// fonte única partilhada com src/api.ts, para as duas cópias nunca mais divergirem em silêncio.

import { readFile, writeFile } from "node:fs/promises";
import { ESPN_LEAGUE_SLUG, ODDS_API_SPORT_MAP, REFERENCE_BOOKMAKER_PRIORITY, normTeam, teamMatches } from "../shared/leagues.mjs";

const DAYS_AHEAD = 3;             // hoje + 3 dias, para cobrir efeitos de fuso horário
const DAYS_BEHIND = 2;            // + ontem/anteontem, para a app poder mostrar histórico recente
                                   // (ver "ver jogos dos últimos 1-2 dias" e liquidação automática)
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status + " em " + url);
  return r.json();
}

// ===== ESPN: fixtures de DAYS_BEHIND dias atrás até DAYS_AHEAD dias à frente =====
async function fetchFixtures(slug) {
  const events = [];
  const today = new Date();
  for (let i = -DAYS_BEHIND; i <= DAYS_AHEAD; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const url = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + encodeURIComponent(slug) + "/scoreboard?dates=" + ymd(d);
    try {
      const data = await fetchJson(url);
      for (const ev of data.events || []) events.push(ev);
    } catch (e) {
      console.warn("  [aviso] scoreboard falhou para " + slug + " em " + ymd(d) + ": " + e.message);
    }
  }
  return events;
}

// Constrói um mapa id-equipa -> registo a partir de uma resposta de standings já obtida (percorre
// TODOS os children[] — zonas/grupos, ver comentário de fetchStandingsMap), guardando também
// gamesPlayed (não vem em recordStr, mas é preciso para decidir o fallback de fase/época).
function standingsResponseToMap(data) {
  const map = new Map();
  for (const group of data?.children || []) {
    for (const entry of group?.standings?.entries || []) {
      const stats = Object.fromEntries((entry.stats || []).map(s => [s.name, s.value]));
      map.set(String(entry.team.id), {
        wins: Math.round(stats.wins || 0),
        ties: Math.round(stats.ties || 0),
        losses: Math.round(stats.losses || 0),
        gamesPlayed: Math.round(stats.gamesPlayed || 0)
      });
    }
  }
  return map;
}

// Encontra o season_type anterior (com standings) ao atualmente devolvido, usando os metadados de
// data.seasons[] — ex.: a Liga Argentina alterna "Torneo Apertura" (season_type 1, Jan-Mai) e
// "Torneo Clausura" (season_type 6, Jul-Nov); pedir standings sem parâmetros devolve sempre a fase
// ATUAL, que logo a seguir a começar tem quase todos os jogos em 0 — mesmo havendo uma época inteira
// de dados reais na fase anterior, já concluída. Devolve null se não houver fase anterior com
// standings (ligas de época única, como a maioria — aí não há fallback nenhum para tentar).
function findPreviousSeasonType(data) {
  const year = data?.children?.[0]?.standings?.season;
  const currentTypeId = data?.children?.[0]?.standings?.seasonType;
  if (!year || currentTypeId == null) return null;
  const season = (data.seasons || []).find(s => s.year === year);
  const types = (season?.types || []).filter(t => t.hasStandings && String(t.id) !== String(currentTypeId));
  const current = (season?.types || []).find(t => String(t.id) === String(currentTypeId));
  if (!current || !types.length) return null;
  const before = types.filter(t => new Date(t.startDate).getTime() < new Date(current.startDate).getTime());
  if (!before.length) return null;
  before.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
  return { year, typeId: before[0].id, name: before[0].name };
}

// ===== ESPN: registo V-E-D por equipa (standings) — cup competitions (Champions/Europa) podem não
// ter este formato; devolve mapa vazio em vez de rebentar. Algumas ligas (confirmado ao vivo em
// 2026-07-24: Liga Argentina) dividem a tabela em várias zonas/grupos (children[0]="Group A",
// children[1]="Group B", ...) em vez de uma tabela única — ler só children[0] deixava de fora
// TODAS as equipas dos outros grupos (ficavam com "0-0-0" por não terem entry nenhuma no mapa,
// não porque o registo real fosse esse). Percorre TODOS os children[], nunca só o primeiro.
//
// Fallback de fase/época: se a MAIORIA das equipas da fase atual tiver 0 jogos (sinal de fase
// recém-começada, ex.: Torneo Clausura argentino a poucas semanas do início), vai também buscar a
// fase anterior já concluída (ver findPreviousSeasonType) e usa esse registo para as equipas que
// continuam a 0 jogos na fase atual — sem isto, uma equipa como o River Plate aparecia com "0-0-0"
// mesmo tendo uma época inteira de jogos reais disputados há só 2 meses. =====
async function fetchStandingsMap(slug) {
  let map = new Map();
  let data;
  try {
    data = await fetchJson("https://site.api.espn.com/apis/v2/sports/soccer/" + encodeURIComponent(slug) + "/standings");
  } catch (e) {
    console.warn("  [aviso] standings falhou para " + slug + ": " + e.message);
    return map;
  }
  if (!(data?.children || []).length) {
    console.warn("  [aviso] standings sem nenhum grupo/zona (children[]) para " + slug + " — mapa de registos fica vazio (normal em taças/qualificações sem tabela).");
    return map;
  }
  map = standingsResponseToMap(data);

  const total = map.size;
  const semJogos = [...map.values()].filter(r => r.gamesPlayed === 0).length;
  if (total > 0 && semJogos / total > 0.5) {
    const prev = findPreviousSeasonType(data);
    if (prev) {
      try {
        const prevData = await fetchJson("https://site.api.espn.com/apis/v2/sports/soccer/" + encodeURIComponent(slug)
          + "/standings?season=" + encodeURIComponent(prev.year) + "&seasontype=" + encodeURIComponent(prev.typeId));
        const prevMap = standingsResponseToMap(prevData);
        let preenchidas = 0;
        for (const [id, rec] of map) {
          if (rec.gamesPlayed === 0 && prevMap.has(id) && prevMap.get(id).gamesPlayed > 0) {
            map.set(id, prevMap.get(id));
            preenchidas++;
          }
        }
        console.log("  [aviso] " + slug + ": fase atual só tinha " + (total - semJogos) + "/" + total + " equipa(s) com jogos — usada fase anterior (\"" + prev.name + "\") para preencher " + preenchidas + " equipa(s) a mais.");
      } catch (e) {
        console.warn("  [aviso] fallback de fase anterior falhou para " + slug + ": " + e.message);
      }
    } else {
      console.warn("  [aviso] " + slug + ": " + semJogos + "/" + total + " equipa(s) com 0 jogos na fase atual, sem fase anterior com standings para usar de fallback (normal em ligas de época única).");
    }
  }
  return map;
}

// ===== ESPN: forma recente (últimos 5 jogos completos) de uma equipa =====
async function fetchForm(slug, teamId) {
  try {
    const data = await fetchJson("https://site.api.espn.com/apis/site/v2/sports/soccer/" + encodeURIComponent(slug) + "/teams/" + teamId + "/schedule");
    const completed = (data.events || []).filter(ev => ev.competitions?.[0]?.status?.type?.completed);
    const last5 = completed.slice(-5);
    return last5.map(ev => {
      const comp = ev.competitions[0];
      const me = comp.competitors.find(c => String(c.team.id) === String(teamId));
      const opp = comp.competitors.find(c => String(c.team.id) !== String(teamId));
      if (!me || !opp) return "D";
      if (me.winner) return "W";
      if (opp.winner) return "L";
      return "D";
    }).join("");
  } catch (e) {
    console.warn("  [aviso] schedule falhou para equipa " + teamId + " (" + slug + "): " + e.message);
    return "";
  }
}

// ===== The-Odds-API: h2h + totais (pede todas as casas de REFERENCE_BOOKMAKER_PRIORITY na mesma
// chamada — ver matchOdds para a ordem em que são preferidas) =====
// Devolve o status/corpo da resposta em caso de falha (em vez de só []) — sem isto não dava para
// distinguir "liga sem cobertura nesta conta/plano" (401/403, sport_key inválido, etc.) de "a liga
// simplesmente não tem jogos publicados agora" — os dois pareciam o mesmo "[] sem explicação".
async function fetchOddsForLeague(sportKey) {
  if (!ODDS_API_KEY) return { ok: false, status: null, body: "ODDS_API_KEY não definida" };
  const url = "https://api.the-odds-api.com/v4/sports/" + encodeURIComponent(sportKey)
    + "/odds/?apiKey=" + encodeURIComponent(ODDS_API_KEY) + "&regions=us,eu,uk,fr&markets=h2h,totals&oddsFormat=decimal&bookmakers=" + REFERENCE_BOOKMAKER_PRIORITY.join(",");
  let bodyText;
  try {
    const r = await fetch(url);
    bodyText = await r.text();
    if (!r.ok) return { ok: false, status: r.status, body: bodyText.slice(0, 300) };
  } catch (e) {
    return { ok: false, status: null, body: "erro de rede: " + e.message };
  }
  try {
    return { ok: true, data: JSON.parse(bodyText) };
  } catch {
    return { ok: false, status: 200, body: "resposta 200 mas não é JSON válido: " + bodyText.slice(0, 200) };
  }
}

// teamMatches (fuzzy + TEAM_ALIASES) vem de ../shared/leagues.mjs — mesma função usada por
// src/api.ts:findApiGame, para os aliases nunca divergirem entre a app e o script diário.

// ===== Diagnóstico: candidatos mais parecidos quando nenhum jogo casa (para alimentar
// TEAM_ALIASES sem adivinhar) — similaridade por bigramas de caracteres, simples mas suficiente
// para apanhar variantes tipo "Atlético de San Luis" vs "Atletico San Luis". =====
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.max(A.size, B.size);
}
function closestCandidates(oddsGames, nh, na, n = 3) {
  return oddsGames
    .map(g => {
      const ah = normTeam(g.home_team || ""), aa = normTeam(g.away_team || "");
      return { label: (g.home_team || "?") + " vs " + (g.away_team || "?"), score: Math.max(similarity(nh, ah), similarity(na, aa)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(c => c.label + " (score " + c.score.toFixed(2) + ")");
}

// Prioridade REFERENCE_BOOKMAKER_PRIORITY (Betclic > Betano > DraftKings, ver shared/leagues.mjs):
// casas europeias "soccer-first" primeiro (publicam linhas mais cedo e com mais profundidade nas
// ligas já cobertas), DraftKings como último recurso — não porque seja pior, mas porque continua a
// ser a mais estável historicamente. DraftKings mantém-se a casa "por omissão" da UI (sem etiqueta
// de fonte); qualquer outra marca out.src (ver marketSourceNote/oddsT em main.ts). Percorre a lista
// por ordem e usa a PRIMEIRA que tiver h2h completo — nunca a que calhar estar primeiro no array da
// API, sempre a de maior prioridade que responda de facto.
// Devolve um resultado com motivo explícito de falha (nunca só null) — ver Fase 1 do diagnóstico:
// "sem-match-equipa" (nenhum jogo da API bate com este) vs "sem-bookmaker" (jogo encontrado, mas
// nenhuma casa da prioridade tem h2h publicado ainda) são causas bem diferentes.
function matchOdds(oddsGames, homeName, awayName) {
  const nh = normTeam(homeName), na = normTeam(awayName);
  const match = oddsGames.find(g => teamMatches(nh, normTeam(g.home_team)) && teamMatches(na, normTeam(g.away_team)));
  if (!match) return { ok: false, reason: "sem-match-equipa" };
  const bookmakers = match.bookmakers || [];
  for (const bkKey of REFERENCE_BOOKMAKER_PRIORITY) {
    const bk = bookmakers.find(b => b.key === bkKey);
    if (!bk) continue;
    const h2h = (bk.markets || []).find(m => m.key === "h2h");
    if (!h2h) continue;
    // Os outcomes h2h usam os nomes PRÓPRIOS da The-Odds-API (home_team/away_team verbatim), não os
    // da ESPN — comparar com o match, nunca com nh/na, senão o alias/fuzzy de cima seria desfeito aqui.
    const hOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(match.home_team));
    const aOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(match.away_team));
    const dOc = h2h.outcomes.find(o => o.name === "Draw");
    if (!hOc || !aOc || !dOc) continue;
    const out = { h: hOc.price, d: dOc.price, a: aOc.price };
    if (bkKey !== "draftkings") out.src = bkKey;
    const totals = (bk.markets || []).find(m => m.key === "totals");
    if (totals && totals.outcomes.length === 2) {
      const over = totals.outcomes.find(o => o.name === "Over");
      const under = totals.outcomes.find(o => o.name === "Under");
      if (over && under) { out.l = over.point; out.ov = over.price; out.un = under.price; }
    }
    return { ok: true, odds: out };
  }
  return { ok: false, reason: "sem-bookmaker" };
}

function recordStr(rec) {
  if (!rec) return "0-0-0";
  return rec.wins + "-" + rec.ties + "-" + rec.losses;
}

// ===== Odds já guardadas (por id de jogo ESPN, estável entre execuções) do último public/data.json —
// usadas como rede de segurança: sem isto, uma execução sem ODDS_API_KEY (ex.: teste local, como
// aconteceu por engano em 2026-07-22/23) ou uma falha transitória da The-Odds-API APAGAVA as odds
// reais já obtidas pela tarefa agendada, em vez de as preservar. Nunca sobrepõe odds novas e válidas,
// só preenche quando o fetch desta execução não encontrou nada para esse jogo específico. =====
async function loadOldOddsMap() {
  const map = new Map();
  try {
    const raw = await readFile(new URL("../public/data.json", import.meta.url), "utf8");
    const obj = JSON.parse(raw);
    for (const g of obj.games || []) if (g.o) map.set(g.id, g.o);
  } catch {
    // primeira execução (ainda sem public/data.json) ou ficheiro nalgum formato inesperado — segue sem rede de segurança
  }
  return map;
}

// ===== Monta uma liga inteira — nunca lança, devolve { games, diag } =====
// diag distingue as causas de "sem odds" (ver Fase 1 do diagnóstico pedido):
//  - semCoberturaLiga: o pedido à The-Odds-API falhou (HTTP/rede/JSON inválido) para o sportKey.
//  - semJogosNaApi: o pedido teve sucesso mas devolveu ZERO jogos — não é falta de match, é a
//    própria liga/sport_key não ter nenhum evento listado agora (ex.: torneio ainda não começou a
//    fase em que os bookmakers publicam odds). Distinto de semCoberturaLiga (chamada falhou) e de
//    semMatchEquipa (a resposta TEM jogos, só não tem ESTE) — confundir os dois dava falsos "sem
//    match" com "candidatos: nenhum na resposta" sempre, sem dizer que a causa é estrutural.
//  - semMatchEquipa: a liga respondeu com jogos mas nenhum bate com este (nome diferente OU o jogo
//    já começou e saiu do feed pré-jogo da API, ver candidatos logados para distinguir os dois).
//  - semBookmaker: jogo encontrado, mas nenhuma casa de REFERENCE_BOOKMAKER_PRIORITY tem h2h
//    publicado ainda (caso legítimo, não uma falha).
// recuperadoAnterior conta, à parte, quantos desses foram tapados pelo fallback do
// public/data.json anterior (ver loadOldOddsMap).
async function runLeague(lgName, oldOdds) {
  const slug = ESPN_LEAGUE_SLUG[lgName];
  const sportKey = ODDS_API_SPORT_MAP[lgName];
  console.log("A processar " + lgName + " (" + slug + ")...");
  const diag = { comOdds: 0, semCoberturaLiga: 0, semJogosNaApi: 0, semMatchEquipa: 0, semBookmaker: 0, recuperadoAnterior: 0 };

  const events = await fetchFixtures(slug);
  if (!events.length) return { games: [], diag };

  const standings = await fetchStandingsMap(slug);
  const oddsResult = sportKey ? await fetchOddsForLeague(sportKey) : { ok: false, status: null, body: "liga sem sport_key mapeado em ODDS_API_SPORT_MAP" };
  if (!oddsResult.ok) {
    console.log("  [sem-cobertura-liga] " + lgName + " (" + sportKey + "): status=" + oddsResult.status + " body=" + oddsResult.body);
  }
  const oddsGames = oddsResult.ok ? oddsResult.data : [];
  if (oddsResult.ok && !oddsGames.length) {
    console.log("  [sem-jogos-na-api] " + lgName + " (" + sportKey + "): pedido teve sucesso mas devolveu 0 jogos — sem cobertura automática nesta conta/época, não é falta de match.");
  }
  const formCache = new Map();

  const games = [];
  for (const ev of events) {
    try {
      const comp = ev.competitions?.[0];
      if (!comp) continue;
      const homeC = comp.competitors.find(c => c.homeAway === "home");
      const awayC = comp.competitors.find(c => c.homeAway === "away");
      if (!homeC || !awayC) continue;

      const homeId = String(homeC.team.id), awayId = String(awayC.team.id);
      if (!formCache.has(homeId)) formCache.set(homeId, await fetchForm(slug, homeId));
      if (!formCache.has(awayId)) formCache.set(awayId, await fetchForm(slug, awayId));

      let freshOdds = null;
      if (!oddsResult.ok) {
        diag.semCoberturaLiga++;
      } else if (!oddsGames.length) {
        diag.semJogosNaApi++;
      } else {
        const nh = normTeam(homeC.team.displayName), na = normTeam(awayC.team.displayName);
        const res = matchOdds(oddsGames, homeC.team.displayName, awayC.team.displayName);
        if (res.ok) {
          freshOdds = res.odds;
          diag.comOdds++;
        } else if (res.reason === "sem-match-equipa") {
          diag.semMatchEquipa++;
          const candidatos = closestCandidates(oddsGames, nh, na);
          console.log("  [sem-match-equipa] " + homeC.team.displayName + " (" + nh + ") vs " + awayC.team.displayName + " (" + na + ")"
            + " — candidatos mais próximos: " + (candidatos.length ? candidatos.join(" | ") : "nenhum na resposta"));
        } else {
          diag.semBookmaker++;
          console.log("  [sem-bookmaker] " + homeC.team.displayName + " vs " + awayC.team.displayName + " — jogo encontrado, sem h2h em nenhuma casa da prioridade ainda (normal a alguns dias do jogo)");
        }
      }

      const recovered = !freshOdds ? oldOdds.get(String(ev.id)) : null;
      if (recovered) diag.recuperadoAnterior++;
      const odds = freshOdds || recovered || null;

      games.push({
        id: String(ev.id),
        lg: lgName,
        d: ev.date,
        v: comp.venue?.fullName || undefined,
        h: { n: homeC.team.displayName, f: formCache.get(homeId), r: recordStr(standings.get(homeId)), s: null },
        a: { n: awayC.team.displayName, f: formCache.get(awayId), r: recordStr(standings.get(awayId)), s: null },
        o: odds
      });
    } catch (e) {
      console.warn("  [aviso] jogo ignorado (" + (ev.id || "?") + "): " + e.message);
    }
  }
  return { games, diag };
}

async function main() {
  const oldOdds = await loadOldOddsMap();
  if (!ODDS_API_KEY) console.warn("[aviso] ODDS_API_KEY não definida — só se preenchem odds a partir do public/data.json anterior (" + oldOdds.size + " jogo(s) com odds guardadas), nada novo é pedido à The-Odds-API.");

  const allGames = [];
  const okLeagues = [];
  const failedLeagues = [];
  const diagByLeague = new Map();

  for (const lgName of Object.keys(ESPN_LEAGUE_SLUG)) {
    try {
      const { games, diag } = await runLeague(lgName, oldOdds);
      if (games.length) { allGames.push(...games); okLeagues.push(lgName); diagByLeague.set(lgName, diag); }
    } catch (e) {
      console.warn("[aviso] liga " + lgName + " falhou por completo: " + e.message);
      failedLeagues.push(lgName);
    }
  }

  if (!allGames.length) {
    console.error("Nenhuma liga devolveu jogos — a manter public/data.json como estava (nada escrito).");
    process.exitCode = 1;
    return;
  }

  // Ligas em que NENHUM jogo teve sequer hipótese de odds — nem é falta de match, é o pedido à
  // The-Odds-API a falhar (semCoberturaLiga) ou a devolver 0 jogos (semJogosNaApi) para TODOS os
  // jogos dessa liga nesta execução. Distinto de uma liga só ter alguns jogos sem odds (normal —
  // já começaram ou ainda não têm linha); aqui é a liga inteira sem hipótese nenhuma agora.
  const semOddsAutomaticas = okLeagues.filter(lgName => {
    const d = diagByLeague.get(lgName);
    const lgTotal = allGames.filter(g => g.lg === lgName).length;
    return d && lgTotal > 0 && (d.semCoberturaLiga + d.semJogosNaApi) === lgTotal;
  });

  const note = okLeagues.length
    ? "Ligas atualizadas automaticamente: " + okLeagues.join(", ") + "."
      + (failedLeagues.length ? " Falharam (mantidas de fora hoje): " + failedLeagues.join(", ") + "." : "")
      + (semOddsAutomaticas.length ? " Sem odds automáticas nesta conta agora: " + semOddsAutomaticas.join(", ") + "." : "")
    : undefined;

  const payload = { fetchedAt: new Date().toISOString(), note, games: allGames };
  await writeFile(new URL("../public/data.json", import.meta.url), JSON.stringify(payload, null, 2) + "\n", "utf8");
  const withOdds = allGames.filter(g => g.o).length;
  console.log("public/data.json atualizado: " + allGames.length + " jogo(s) em " + okLeagues.length + " liga(s), " + withOdds + " com odds.");

  console.log("\n% de jogos com odds por liga:");
  for (const lgName of okLeagues) {
    const lgGames = allGames.filter(g => g.lg === lgName);
    const lgWithOdds = lgGames.filter(g => g.o).length;
    const pct = lgGames.length ? Math.round(100 * lgWithOdds / lgGames.length) : 0;
    console.log("  " + lgName + ": " + lgWithOdds + "/" + lgGames.length + " (" + pct + "%)");
  }

  console.log("\nDiagnóstico por liga (sem-cobertura-liga / sem-jogos-na-api / sem-match-equipa / sem-bookmaker / com-odds — recuperado do anterior à parte):");
  for (const lgName of okLeagues) {
    const d = diagByLeague.get(lgName);
    if (!d) continue;
    console.log("  " + lgName + ": sem-cobertura-liga=" + d.semCoberturaLiga
      + " sem-jogos-na-api=" + d.semJogosNaApi
      + " sem-match-equipa=" + d.semMatchEquipa
      + " sem-bookmaker=" + d.semBookmaker
      + " com-odds=" + d.comOdds
      + " (recuperado-do-anterior=" + d.recuperadoAnterior + ")");
  }
  if (semOddsAutomaticas.length) console.log("\nLigas sem odds automáticas nesta conta agora: " + semOddsAutomaticas.join(", "));

  // Equipas com registo "0-0-0" — sinal de fetchStandingsMap ter falhado ou ficado incompleto para
  // essa liga (ver comentário lá), MAS também pode ser genuíno (equipa mesmo sem jogos disputados
  // ainda nesta fase/zona/época) — reporta sempre, para decidir caso a caso, nunca assume às cegas.
  console.log("\nEquipas com registo 0-0-0 por liga (nem sempre é bug — confirma antes de assumir):");
  for (const lgName of okLeagues) {
    const lgGames = allGames.filter(g => g.lg === lgName);
    const allTeams = new Set(), zeroTeams = new Set();
    for (const g of lgGames) {
      allTeams.add(g.h.n); allTeams.add(g.a.n);
      if (g.h.r === "0-0-0") zeroTeams.add(g.h.n);
      if (g.a.r === "0-0-0") zeroTeams.add(g.a.n);
    }
    if (zeroTeams.size) {
      const amostra = [...zeroTeams].slice(0, 5).join(", ") + (zeroTeams.size > 5 ? ", ..." : "");
      console.log("  " + lgName + ": " + zeroTeams.size + "/" + allTeams.size + " equipa(s) — " + amostra);
    }
  }
}

main().catch(e => {
  console.error("Falha inesperada:", e);
  process.exitCode = 1;
});

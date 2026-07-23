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
import { ESPN_LEAGUE_SLUG, ODDS_API_SPORT_MAP, normTeam, teamMatches } from "../shared/leagues.mjs";

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

// ===== ESPN: registo V-E-D por equipa (standings) — cup competitions (Champions/Europa) podem não
// ter este formato; devolve mapa vazio em vez de rebentar. =====
async function fetchStandingsMap(slug) {
  const map = new Map();
  try {
    const data = await fetchJson("https://site.api.espn.com/apis/v2/sports/soccer/" + encodeURIComponent(slug) + "/standings");
    const entries = data?.children?.[0]?.standings?.entries || [];
    for (const entry of entries) {
      const stats = Object.fromEntries((entry.stats || []).map(s => [s.name, s.value]));
      map.set(String(entry.team.id), {
        wins: Math.round(stats.wins || 0),
        ties: Math.round(stats.ties || 0),
        losses: Math.round(stats.losses || 0)
      });
    }
  } catch (e) {
    console.warn("  [aviso] standings falhou para " + slug + ": " + e.message);
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

// ===== The-Odds-API: h2h + totais (DraftKings; Betclic incluída no mesmo pedido como fallback —
// ver matchOdds — para jogos a alguns dias em que a DraftKings ainda não publicou linha) =====
async function fetchOddsForLeague(sportKey) {
  if (!ODDS_API_KEY) return [];
  const url = "https://api.the-odds-api.com/v4/sports/" + encodeURIComponent(sportKey)
    + "/odds/?apiKey=" + encodeURIComponent(ODDS_API_KEY) + "&regions=us,eu,fr&markets=h2h,totals&oddsFormat=decimal&bookmakers=draftkings,betclic_fr";
  try {
    return await fetchJson(url);
  } catch (e) {
    console.warn("  [aviso] The-Odds-API falhou para " + sportKey + ": " + e.message);
    return [];
  }
}

// teamMatches (fuzzy + TEAM_ALIASES) vem de ../shared/leagues.mjs — mesma função usada por
// src/api.ts:findApiGame, para os aliases nunca divergirem entre a app e o script diário.

// Prioridade DraftKings -> Betclic: DraftKings mantém-se a casa "por omissão" (é a que a UI já
// rotula por defeito); Betclic só entra quando a DraftKings ainda não tem linha para este jogo em
// concreto — nesse caso out.src fica marcado para a UI anotar a fonte (ver marketSourceNote/oddsT
// em main.ts). Nunca prefere Betclic quando a DraftKings já responde, mesmo que a Betclic também exista.
function matchOdds(oddsGames, homeName, awayName) {
  const nh = normTeam(homeName), na = normTeam(awayName);
  const match = oddsGames.find(g => teamMatches(nh, normTeam(g.home_team)) && teamMatches(na, normTeam(g.away_team)));
  if (!match) return null;
  const bookmakers = match.bookmakers || [];
  let bk = bookmakers.find(b => b.key === "draftkings");
  let src = null;
  if (!bk) { bk = bookmakers.find(b => b.key === "betclic_fr"); src = "betclic_fr"; }
  if (!bk) return null;
  const h2h = (bk.markets || []).find(m => m.key === "h2h");
  const totals = (bk.markets || []).find(m => m.key === "totals");
  if (!h2h) return null;
  // Os outcomes h2h usam os nomes PRÓPRIOS da The-Odds-API (home_team/away_team verbatim), não os
  // da ESPN — comparar com o match, nunca com nh/na, senão o alias/fuzzy de cima seria desfeito aqui.
  const hOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(match.home_team));
  const aOc = h2h.outcomes.find(o => normTeam(o.name) === normTeam(match.away_team));
  const dOc = h2h.outcomes.find(o => o.name === "Draw");
  if (!hOc || !aOc || !dOc) return null;
  const out = { h: hOc.price, d: dOc.price, a: aOc.price };
  if (src) out.src = src;
  if (totals && totals.outcomes.length === 2) {
    const over = totals.outcomes.find(o => o.name === "Over");
    const under = totals.outcomes.find(o => o.name === "Under");
    if (over && under) { out.l = over.point; out.ov = over.price; out.un = under.price; }
  }
  return out;
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

// ===== Monta uma liga inteira — nunca lança, devolve { games, error } =====
async function runLeague(lgName, oldOdds) {
  const slug = ESPN_LEAGUE_SLUG[lgName];
  const sportKey = ODDS_API_SPORT_MAP[lgName];
  console.log("A processar " + lgName + " (" + slug + ")...");

  const events = await fetchFixtures(slug);
  if (!events.length) return { games: [], error: null };

  const standings = await fetchStandingsMap(slug);
  const oddsGames = sportKey ? await fetchOddsForLeague(sportKey) : [];
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

      const freshOdds = matchOdds(oddsGames, homeC.team.displayName, awayC.team.displayName);
      const odds = freshOdds || oldOdds.get(String(ev.id)) || null;
      // Diagnóstico para alimentar TEAM_ALIASES: só interessa quando a liga TEVE resposta da
      // The-Odds-API (oddsGames.length) mas este jogo em concreto não casou com nada nela — nesse
      // caso é quase sempre uma diferença de nome entre ESPN e The-Odds-API, não falta de mercado.
      if (!freshOdds && oddsGames.length) {
        console.log("  [sem-match] " + homeC.team.displayName + " (" + normTeam(homeC.team.displayName) + ") vs "
          + awayC.team.displayName + " (" + normTeam(awayC.team.displayName) + ")");
      }

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
  return { games, error: null };
}

async function main() {
  const oldOdds = await loadOldOddsMap();
  if (!ODDS_API_KEY) console.warn("[aviso] ODDS_API_KEY não definida — só se preenchem odds a partir do public/data.json anterior (" + oldOdds.size + " jogo(s) com odds guardadas), nada novo é pedido à The-Odds-API.");

  const allGames = [];
  const okLeagues = [];
  const failedLeagues = [];

  for (const lgName of Object.keys(ESPN_LEAGUE_SLUG)) {
    try {
      const { games } = await runLeague(lgName, oldOdds);
      if (games.length) { allGames.push(...games); okLeagues.push(lgName); }
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

  const note = okLeagues.length
    ? "Ligas atualizadas automaticamente: " + okLeagues.join(", ") + "."
      + (failedLeagues.length ? " Falharam (mantidas de fora hoje): " + failedLeagues.join(", ") + "." : "")
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
}

main().catch(e => {
  console.error("Falha inesperada:", e);
  process.exitCode = 1;
});

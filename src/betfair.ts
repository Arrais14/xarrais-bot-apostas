// ===== Betfair Exchange API — scaffolding dormant, NÃO ligado à UI =====
// Contexto (pesquisa de 2026-07-22): a Betfair Exchange é a única exceção séria na indústria de
// apostas com uma API pública, documentada e oficial que permite a um utilizador individual colocar
// apostas (back/lay) programaticamente na sua própria conta — https://developer.betfair.com/.
// Todas as outras casas (Blockbet, Betano, Betclic, Bet365, DraftKings, ...) só expõem APIs de odds
// para operadores (B2B); colocar apostas via bot viola os seus termos de serviço.
//
// MAS: a Betfair Exchange não está licenciada em Portugal — o regulador (SRIJ) não regula o modelo
// de "exchange betting" e a Betfair não pretende voltar ao mercado português enquanto isso não mudar.
// Este ficheiro fica pronto para o dia em que isso mude (ou para apostar a partir de uma conta/região
// onde a Exchange é legal) — não está importado em main.ts nem tem qualquer botão na UI.
//
// IMPORTANTE — porque isto não pode ser uma chamada direta do browser em produção:
// 1. Login: a Betfair espera login interativo (utilizador/password) ou login por certificado
//    cliente (recomendado para bots) contra identitysso(-cert).betfair.com. Guardar password ou um
//    certificado no browser é inseguro — isto tem de correr num backend/servidor que guarda as
//    credenciais em segurança e devolve só o resultado à UI.
// 2. CORS: os endpoints da Betfair não são pensados para ser chamados a partir de origens
//    arbitrárias no browser — um proxy de backend evita esse problema.
// Por isso as funções abaixo são "prontas a usar a partir de Node/servidor", não a partir do main.ts.

export interface BetfairSession {
  sessionToken: string;
  appKey: string;
}

interface BetfairLoginResponse {
  sessionToken?: string;
  loginStatus: string;   // "SUCCESS" | "INVALID_USERNAME_OR_PASSWORD" | ...
}

// Login interativo (não recomendado para automação — a Betfair prefere certlogin para bots, que
// exige um certificado cliente e só faz sentido implementar do lado do servidor).
export async function betfairInteractiveLogin(username: string, password: string, appKey: string): Promise<BetfairLoginResponse> {
  const r = await fetch("https://identitysso.betfair.com/api/login", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Application": appKey
    },
    body: "username=" + encodeURIComponent(username) + "&password=" + encodeURIComponent(password)
  });
  if (!r.ok) throw new Error("Betfair login " + r.status);
  return r.json();
}

const BETTING_JSONRPC_URL = "https://api.betfair.com/exchange/betting/json-rpc/v1";

async function callBettingApi<T>(session: BetfairSession, method: string, params: Record<string, unknown>): Promise<T> {
  const r = await fetch(BETTING_JSONRPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Application": session.appKey,
      "X-Authentication": session.sessionToken
    },
    body: JSON.stringify([{ jsonrpc: "2.0", method: "SportsAPING/v1.0/" + method, params, id: 1 }])
  });
  if (!r.ok) throw new Error("Betfair API " + method + " " + r.status);
  const data = await r.json();
  const entry = Array.isArray(data) ? data[0] : data;
  if (entry.error) throw new Error("Betfair API " + method + ": " + JSON.stringify(entry.error));
  return entry.result as T;
}

export interface BetfairRunnerCatalog {
  selectionId: number;
  runnerName: string;
  handicap: number;
}

export interface BetfairMarketCatalogue {
  marketId: string;
  marketName: string;
  totalMatched?: number;
  runners?: BetfairRunnerCatalog[];
}

// Encontra mercados (ex. "Match Odds" de um jogo) por texto livre + filtro de evento/competição —
// necessário para obter marketId/selectionId antes de listMarketBook ou placeOrders.
export async function listMarketCatalogue(session: BetfairSession, filter: Record<string, unknown>, maxResults = 20): Promise<BetfairMarketCatalogue[]> {
  return callBettingApi<BetfairMarketCatalogue[]>(session, "listMarketCatalogue", {
    filter,
    marketProjection: ["RUNNER_DESCRIPTION", "EVENT"],
    maxResults
  });
}

export interface BetfairPriceSize { price: number; size: number; }
export interface BetfairRunnerBook {
  selectionId: number;
  status: string;
  lastPriceTraded?: number;
  ex?: { availableToBack?: BetfairPriceSize[]; availableToLay?: BetfairPriceSize[] };
}
export interface BetfairMarketBook {
  marketId: string;
  status: string;
  runners: BetfairRunnerBook[];
}

// Odds ao vivo (back/lay) de um mercado já identificado via listMarketCatalogue.
export async function listMarketBook(session: BetfairSession, marketIds: string[]): Promise<BetfairMarketBook[]> {
  return callBettingApi<BetfairMarketBook[]>(session, "listMarketBook", {
    marketIds,
    priceProjection: { priceData: ["EX_BEST_OFFERS"] }
  });
}

export type BetfairSide = "BACK" | "LAY";

export interface BetfairPlaceInstruction {
  selectionId: number;
  side: BetfairSide;
  handicap?: number;
  limitOrder: { size: number; price: number; persistenceType: "LAPSE" | "PERSIST" | "MARKET_ON_CLOSE" };
}

export interface BetfairPlaceOrdersResult {
  status: string;   // "SUCCESS" | "FAILURE" | ...
  marketId: string;
  instructionReports: Array<{ status: string; betId?: string; averagePriceMatched?: number; sizeMatched?: number }>;
}

// Coloca uma ou mais ordens (apostas) num mercado real — dinheiro real da conta Betfair ligada.
// NUNCA invocar isto a partir de código correndo no browser do utilizador final; isto existe só
// como referência de forma/params para uma futura rota de backend.
export async function placeOrders(session: BetfairSession, marketId: string, instructions: BetfairPlaceInstruction[]): Promise<BetfairPlaceOrdersResult> {
  return callBettingApi<BetfairPlaceOrdersResult>(session, "placeOrders", { marketId, instructions });
}

export async function cancelOrders(session: BetfairSession, marketId: string, betIds?: string[]): Promise<unknown> {
  return callBettingApi(session, "cancelOrders", betIds ? { marketId, instructions: betIds.map(id => ({ betId: id })) } : { marketId });
}

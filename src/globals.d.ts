// ===== Globais carregados via <script> no index.html (CDN), fora do grafo de módulos npm =====
// Ficam tipados de forma solta (any) de propósito: são bibliotecas externas que este projeto
// não instala como dependência — ver os comentários junto de cada <script> em index.html.

/** Chart.js — usado só em src/main.ts (gráfico de evolução da banca). */
declare const Chart: any;

interface CoworkBridge {
  askClaude?(prompt: string, context: string[]): Promise<string | { text?: string }>;
  /** ESPECULATIVO: sem confirmação de que esta função existe com esta assinatura fora do contexto
   * de artifact publicado no Claude — ver src/api.ts:syncBetsToExternalSheet, que testa a presença
   * desta função antes de a chamar e nunca bloqueia nada se ela não existir ou falhar. */
  callMcpTool?(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

interface Window {
  cowork?: CoworkBridge;
}

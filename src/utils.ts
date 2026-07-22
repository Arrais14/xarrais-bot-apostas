// ===== Utilitários de formatação partilhados (sem dependências de outros módulos) =====
// Usados pela camada de apresentação (main.ts) e por texto gerado noutros módulos
// (api.ts para a nota de análise de fallback).

/** Chave de agrupamento por dia LOCAL (não UTC) — de propósito: o utilizador navega e vê
 * as horas dos jogos em hora local, incluindo jogos às 00:30Z que caem no dia seguinte
 * em horário de Portugal. */
export function ymd(d: Date): string {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

export function fmtDate(d: Date): string {
  return d.toLocaleDateString("pt-PT", { weekday: "short", day: "numeric", month: "short" });
}

export function fmt2(x: number | null | undefined): string {
  return x == null ? "—" : x.toFixed(2);
}

export function pct(x: number | null | undefined): string {
  return x == null ? "—" : (100 * x).toFixed(1) + "%";
}

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" } as Record<string, string>)[c]);
}

export function formHtml(f: string | null | undefined): string {
  if (!f) return "";
  return '<span class="form">' + f.split("").map(c => c === "W" ? "<b>V</b>" : c === "L" ? "<i>D</i>" : "E").join("") + "</span>";
}

/** Conversão numérica defensiva — equivalente ao parseFloat(...) usado por todo o lado no
 * original, mas type-safe para campos que podem chegar como number ou string (ex. import/CSV). */
export function num(v: number | string | null | undefined): number {
  if (v == null) return NaN;
  return typeof v === "number" ? v : parseFloat(v);
}

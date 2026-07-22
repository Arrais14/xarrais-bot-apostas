import type { PreloadedData } from "./types";

// ===== DADOS (atualizados automaticamente pela tarefa diária do Claude) =====
export const PRELOADED: PreloadedData = {
  fetchedAt: "2026-07-20T17:05:00Z",
  note: "Época europeia parada (o Mundial terminou a 19/07). Ligas ativas: Brasileirão e Liga MX. As ligas europeias regressam em agosto e serão incluídas automaticamente.",
  games: [
    {id:"401841148", lg:"Brasileirão", d:"2026-07-21T22:30Z", v:"Arena MRV, Belo Horizonte",
     h:{n:"Atlético-MG", f:"WWLWW", r:"7-3-8", s:"Victor Hugo (3 golos)"},
     a:{n:"Bahia", f:"WWLDL", r:"8-5-5", s:"Luciano Juba (7 golos)"},
     o:{h:2.10, d:3.30, a:3.45, oh:2.05, oa:3.50, l:2.5, ov:1.87, un:1.83, sh:"-0,5 @ 2.00", sa:"+0,5 @ 1.69"}},
    {id:"401877036", lg:"Liga MX", d:"2026-07-22T01:00Z", v:"Estadio Banorte, Cidade do México",
     h:{n:"Cruz Azul", f:"WWDWD", r:"1-0-0", s:"Ángel Márquez (2 golos)"},
     a:{n:"Puebla", f:"WLLLL", r:"1-0-0", s:"Ignacio Maestro Puch (1 golo)"},
     o:{h:1.30, d:5.25, a:8.50, oh:1.30, oa:8.00, l:2.5, ov:1.61, un:2.20, sh:"-1,5 @ 1.83", sa:"+1,5 @ 1.80"}},
    {id:"401877035", lg:"Liga MX", d:"2026-07-22T03:05Z", v:"Estadio Nemesio Díez Riega, Toluca",
     h:{n:"Toluca", f:"WWLWL", r:"1-0-0", s:"Jesús Gallardo (1 golo)"},
     a:{n:"Pumas UNAM", f:"LLDWL", r:"0-0-1", s:null},
     o:{h:1.57, d:4.20, a:5.00, oh:1.57, oa:5.25, l:2.5, ov:1.59, un:2.20, sh:"-0,5 @ 1.53", sa:"+0,5 @ 2.30"}},
    {id:"cfc-pal", lg:"Brasileirão", d:"2026-07-22T22:30Z", v:"Couto Pereira, Curitiba",
     h:{n:"Coritiba", f:"LWWLD", r:"7-5-6", s:"Breno (8 golos)"},
     a:{n:"Palmeiras", f:"WWWLD", r:"12-5-1", s:"José Manuel López (6 golos)"},
     o:{h:3.55, d:3.15, a:2.05, oh:3.85, oa:1.95, l:2.5, ov:2.15, un:1.61, sh:"+0,5 @ 1.65", sa:"-0,5 @ 2.00"}},
    {id:"cha-fla", lg:"Brasileirão", d:"2026-07-23T00:30Z", v:"Arena Condá, Chapecó",
     h:{n:"Chapecoense", f:"LLLWD", r:"1-6-10", s:"Walter Clar (3 golos)"},
     a:{n:"Flamengo", f:"WWLWD", r:"10-4-3", s:"Pedro (10 golos)"},
     o:{h:6.00, d:4.10, a:1.48, oh:6.50, oa:1.44, l:2.5, ov:1.80, un:1.87, sh:"+1,5 @ 1.49", sa:"-1,5 @ 2.30"}},
    {id:"int-cru", lg:"Brasileirão", d:"2026-07-23T00:30Z", v:"Estádio Beira-Rio, Porto Alegre",
     h:{n:"Internacional", f:"LLWWD", r:"5-6-7", s:"Johan Carbonero (4 golos)"},
     a:{n:"Cruzeiro", f:"DWWDD", r:"6-6-6", s:"Christian (5 golos)"},
     o:{h:2.15, d:3.20, a:3.25, oh:2.15, oa:3.40, l:2.5, ov:1.95, un:1.71, sh:"-0,5 @ 2.05", sa:"+0,5 @ 1.61"}},
    {id:"sao-cap", lg:"Brasileirão", d:"2026-07-23T00:30Z", v:"Est. Cicero de Souza Marques, Bragança Paulista",
     h:{n:"São Paulo", f:"LWDDL", r:"7-4-7", s:"Jonathan Calleri (6 golos)"},
     a:{n:"Athletico-PR", f:"WWDWL", r:"9-3-6", s:"Kevin Viveros (11 golos)"},
     o:{h:2.00, d:3.15, a:3.90, oh:1.91, oa:4.20, l:2.5, ov:2.10, un:1.63, sh:"-0,5 @ 1.91", sa:"+0,5 @ 1.74"}},
    {id:"401879458", lg:"Brasileirão", d:"2026-07-23T22:30Z", v:"Estádio Nilton Santos, Rio de Janeiro",
     h:{n:"Botafogo", f:"LWDWW", r:"6-4-7", s:"Arthur Cabral (7 golos)"},
     a:{n:"Vitória", f:"WWLWW", r:"6-4-7", s:"Renê (5 golos)"},
     o:null},
    {id:"401841151", lg:"Brasileirão", d:"2026-07-23T22:30Z", v:"Neo Química Arena, São Paulo",
     h:{n:"Corinthians", f:"WLWDL", r:"6-6-6", s:"André (3 golos)"},
     a:{n:"Remo", f:"WLWWD", r:"4-6-8", s:null},
     o:{h:1.51, d:3.95, a:6.00, oh:1.53, oa:5.75, l:2.5, ov:1.91, un:1.74, sh:"-0,5 @ 1.48", sa:"+0,5 @ 2.35"}}
  ]
};
// ===== FIM DOS DADOS =====

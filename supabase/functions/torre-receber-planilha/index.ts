// =============================================================================
// EDGE FUNCTION: torre-receber-planilha
// AJBorges Transporte & Logística
//
// Recebe a cópia das abas da planilha "TORRE DE CONTROLE SHOPEE", enviada
// pelo Apps Script da conta TI (supabase/apps-script/torre-sincronizar.gs),
// e grava pela RPC torre.aplicar_planilha (schema torre, só service_role).
//
// Entrada: POST { abas: [ { aba, cabecalho, extras, linhas: [ { linha, celulas } ] } ] }
//
// Configuração: Verify JWT DESLIGADO.
// Autorização: header x-torre-secret, comparado ao secret TORRE_SYNC_SECRET
// (próprio da Torre; não usa o CRON_SECRET do site).
// Corpo: no máximo 5 MB.
//
// Logs: somente contagens e códigos de erro (nunca nome, telefone ou placa).
// =============================================================================

function lerChave(
  legado: string,
  novo: string,
): string | undefined {
  const antiga = Deno.env.get(legado);

  if (antiga) return antiga;

  const json = Deno.env.get(novo);

  if (json) {
    try {
      const mapa = JSON.parse(json) as Record<string, string>;
      return mapa.default ?? Object.values(mapa)[0];
    } catch {
      // Configuração inválida: tratada pelo handler.
    }
  }

  return undefined;
}

function resp(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// Resume os dois valores em SHA-256 e compara todos os bytes.
async function segredoConfere(
  recebido: string,
  esperado: string,
): Promise<boolean> {
  const resumo = async (texto: string) =>
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(texto),
      ),
    );

  const [a, b] = await Promise.all([
    resumo(recebido),
    resumo(esperado),
  ]);

  let diferenca = 0;

  for (let i = 0; i < a.length; i++) {
    diferenca |= a[i] ^ b[i];
  }

  return diferenca === 0;
}

const LIMITE_CORPO = 5 * 1024 * 1024;
const MAX_ABAS = 20;
const MAX_LINHAS = 3000;
const MAX_COLUNAS = 80;

// Lê o corpo parando no limite (não confia só no Content-Length).
async function lerCorpo(
  req: Request,
  limite: number,
): Promise<string | null> {
  const declarado = Number(req.headers.get("content-length") ?? "0");

  if (declarado > limite) return null;
  if (!req.body) return "";

  const leitor = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await leitor.read();

    if (done) break;

    total += value.length;

    if (total > limite) {
      await leitor.cancel();
      return null;
    }

    partes.push(value);
  }

  const tudo = new Uint8Array(total);
  let pos = 0;

  for (const parte of partes) {
    tudo.set(parte, pos);
    pos += parte.length;
  }

  return new TextDecoder().decode(tudo);
}

type Linha = { linha: number; celulas: unknown[] };
type Aba = {
  aba: string;
  cabecalho: unknown;
  extras: unknown;
  linhas: Linha[];
};

// Confere o formato e remonta só com os campos esperados.
// A RPC valida de novo (limites, abas permitidas, trava de 50%).
function validar(corpo: unknown): Aba[] | string {
  const abas = (corpo as { abas?: unknown } | null)?.abas;

  if (!Array.isArray(abas)) return "abas ausente";
  if (abas.length === 0) return "nenhuma aba";
  if (abas.length > MAX_ABAS) return "abas demais";

  const saida: Aba[] = [];

  for (const a of abas as Record<string, unknown>[]) {
    if (!a || typeof a.aba !== "string" || !a.aba) {
      return "aba sem nome";
    }

    if (!Array.isArray(a.linhas)) return "linhas ausente";
    if (a.linhas.length > MAX_LINHAS) return "linhas demais";

    const linhas: Linha[] = [];

    for (const l of a.linhas as Record<string, unknown>[]) {
      if (
        !l ||
        !Number.isInteger(l.linha) ||
        (l.linha as number) < 1 ||
        !Array.isArray(l.celulas)
      ) {
        return "linha fora do formato";
      }

      if (l.celulas.length > MAX_COLUNAS) return "colunas demais";

      linhas.push({
        linha: l.linha as number,
        celulas: l.celulas,
      });
    }

    saida.push({
      aba: a.aba,
      cabecalho: a.cabecalho ?? [],
      extras: a.extras ?? {},
      linhas,
    });
  }

  return saida;
}

// ---------- Handler ----------

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return resp(405, {
      erro: "Método não permitido.",
    });
  }

  const segredo = Deno.env.get("TORRE_SYNC_SECRET") ?? "";
  const recebido = req.headers.get("x-torre-secret") ?? "";

  if (!segredo) {
    console.error("torre-receber-planilha: TORRE_SYNC_SECRET ausente");
  }

  if (
    !segredo ||
    !recebido ||
    !(await segredoConfere(recebido, segredo))
  ) {
    return resp(401, {
      erro: "Não autorizado.",
    });
  }

  const texto = await lerCorpo(req, LIMITE_CORPO);

  if (texto === null) {
    console.error("torre-receber-planilha: corpo acima de 5 MB");

    return resp(413, {
      erro: "Corpo acima de 5 MB.",
    });
  }

  let corpo: unknown;

  try {
    corpo = JSON.parse(texto);
  } catch {
    return resp(400, {
      erro: "JSON inválido.",
    });
  }

  const abas = validar(corpo);

  if (typeof abas === "string") {
    console.error(`torre-receber-planilha: recusado (${abas})`);

    return resp(400, {
      erro: `Formato inválido: ${abas}.`,
    });
  }

  const totalLinhas = abas.reduce((n, a) => n + a.linhas.length, 0);

  try {
    const url = Deno.env.get("SUPABASE_URL");

    const serviceKey = lerChave(
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_SECRET_KEYS",
    );

    if (!url || !serviceKey) {
      console.error("torre-receber-planilha: variáveis ausentes");

      return resp(503, {
        erro: "Serviço temporariamente indisponível.",
      });
    }

    const r = await fetch(`${url}/rest/v1/rpc/aplicar_planilha`, {
      method: "POST",
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "Content-Profile": "torre",
        "Accept-Profile": "torre",
      },
      body: JSON.stringify({ p_payload: { abas } }),
    });

    const resultado = await r.json().catch(() => null) as {
      ok?: boolean;
      recusado?: boolean;
      abas?: number;
      linhas?: number;
      bloqueadas?: string[];
      erro?: string | null;
      code?: string;
    } | null;

    if (!r.ok || !resultado) {
      console.error(
        `torre-receber-planilha: falha na RPC: http=${r.status}` +
          ` code=${resultado?.code ?? "?"}`,
      );

      return resp(503, {
        erro: "Serviço temporariamente indisponível.",
      });
    }

    console.log(
      `torre-receber-planilha: recebidas=${abas.length}` +
        ` linhas=${totalLinhas}` +
        ` aplicadas=${resultado.abas ?? 0}` +
        ` gravadas=${resultado.linhas ?? 0}` +
        ` bloqueadas=${resultado.bloqueadas?.length ?? 0}` +
        ` recusado=${resultado.recusado === true}`,
    );

    // A mensagem da RPC só tem nome de aba, contagens e limites.
    return resp(resultado.recusado ? 422 : 200, {
      ok: resultado.ok === true,
      abas: resultado.abas ?? 0,
      linhas: resultado.linhas ?? 0,
      bloqueadas: resultado.bloqueadas ?? [],
      erro: resultado.erro ?? null,
    });
  } catch (erro) {
    console.error(
      "torre-receber-planilha: erro interno:",
      String((erro as { name?: string } | null)?.name ?? "erro"),
    );

    return resp(503, {
      erro: "Serviço temporariamente indisponível.",
    });
  }
});

// "Sugestões de tratativa" da edge function torre-passagem-turno (T03), carregada no Node com Deno/env
// falsos, o Gemini SIMULADO e o PostgREST simulado indo para um PGlite com T01 + T02 + T03 (as RPCs rodam
// como authenticated com o JWT do usuário, então quem decide é a RLS).
// Confere: com pendência resolvida parecida, a função manda as resoluções (R1...) e o esquema com
// sugestoes_tratativa; sugestão com referência válida vira a seção "SUGESTÕES DE TRATATIVA" dizendo de
// qual passagem veio; referência inventada (R9) ou sem referência = descartada; nada parecido = não manda
// nada e a seção não aparece (mesmo se a IA devolver sugestão); pendência aberta não é referência; placa
// que só está na resolução não derruba a resposta; CPF da resolução sai antes da IA; busca fora = gera sem
// sugestão; motorista não chega na busca; logs sem texto.
// Uso: node testes/torre/t_torre_sugestoes_funcao.js
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..', '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); if (!cond) falhas++; };

const TOKENS = {
  'tok-admin': { sub: '00000000-0000-0000-0000-0000000000c3', role: 'authenticated', email: 'admin@teste.local', app_metadata: { role: 'admin' } },
  'tok-motorista': { sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated', app_metadata: { role: 'motorista' } }
};

(async () => {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated; create role anon; create role service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
  `);
  await db.exec(ateCommit(ler('supabase/sql/torre/T01_copia_planilha.sql')));
  for (const arq of ['T02_passagem_turno.sql', 'T03_pendencias.sql']) {
    const sql = ateCommit(ler(`supabase/sql/torre/${arq}`));
    await db.exec(sql.slice(sql.indexOf('\nbegin;\n')));
  }
  // Histórico: T2 de 02/11 resolveu "canhotos do CD Cajamar" (com placa e CPF na resolução); "Ligar..." continua aberta
  await db.exec(`begin;
    select set_config('request.jwt.claims', '${JSON.stringify(TOKENS['tok-admin'])}', true);
    set local role authenticated;
    select torre.publicar_passagem('T1', '2026-11-02', 'x', null,
      E'PENDÊNCIAS PARA O PRÓXIMO TURNO\\n- Canhotos do CD Cajamar não chegaram\\n- Ligar para a transportadora Rápido Sul', '[]');
    select torre.publicar_passagem('T2', '2026-11-02', 'x', null, E'AVISOS\\n- ok',
      (select jsonb_agg(jsonb_build_object('id', id, 'status', case when texto like 'Canhotos%' then 'resolvida' else 'continua' end,
        'resolucao', case when texto like 'Canhotos%' then 'Pedi ao CD Cajamar o reenvio por e-mail; a carreta XYZ9A87 trouxe os originais (motorista cpf 123.456.789-09).'
                          else 'Ninguém atendeu.' end))
         from torre.passagem_pendencias where status = 'aberta'));
    commit;`);
  const passagemT2 = (await db.query(`select id::text from torre.passagens_turno where turno = 'T2'`)).rows[0].id;

  const ctx = { gemini: [], buscas: [], logs: [], respostaIa: null, buscaStatus: 200, env: {
    SUPABASE_URL: 'https://teste.invalid', SUPABASE_ANON_KEY: 'chave-publica-teste', GEMINI_API_KEY: 'chave-gemini-de-teste' } };
  globalThis.Deno = { env: { get: (k) => ctx.env[k] }, serve: (fn) => { ctx.handler = fn; } };
  const rpc = async (nome, opcoes, sql, params) => {
    const h = opcoes.headers;
    if (h['Content-Profile'] !== 'torre' || h['Accept-Profile'] !== 'torre' || h.apikey !== 'chave-publica-teste') return new Response('{"code":"PGRST106"}', { status: 406 });
    const claims = TOKENS[String(h.Authorization).replace('Bearer ', '')];
    if (!claims) return new Response('{"code":"PGRST301"}', { status: 401 });
    await db.exec(`begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true); set local role authenticated;`);
    try {
      const r = (await db.query(sql, params)).rows;
      await db.exec('commit');
      return new Response(JSON.stringify(nome === 'registrar' ? r[0].r : r), { status: 200 });
    } catch (e) {
      await db.exec('rollback');
      return new Response(JSON.stringify({ code: e.code, message: e.message }), { status: e.code === 'PT429' ? 429 : e.code === '42501' ? 403 : 400 });
    }
  };
  globalThis.fetch = async (url, opcoes) => {
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      ctx.gemini.push(JSON.parse(opcoes.body));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ctx.respostaIa) }] } }] }), { status: 200 });
    }
    if (url === 'https://teste.invalid/rest/v1/rpc/registrar_chamada_ia') {
      return rpc('registrar', opcoes, 'select torre.registrar_chamada_ia($1) r', [JSON.parse(opcoes.body).p_tamanho]);
    }
    if (url === 'https://teste.invalid/rest/v1/rpc/buscar_resolucoes_parecidas') {
      const corpo = JSON.parse(opcoes.body);
      ctx.buscas.push(corpo);
      if (ctx.buscaStatus !== 200) return new Response('{}', { status: ctx.buscaStatus });
      return rpc('buscar', opcoes, 'select id::text, texto, resolucao, passagem_id::text, turno, data::text, comuns from torre.buscar_resolucoes_parecidas($1, $2)', [corpo.p_texto, corpo.p_limite]);
    }
    return new Response('{}', { status: 404 });
  };
  for (const tipo of ['log', 'error', 'warn']) {
    const orig = console[tipo];
    console[tipo] = (...a) => { const s = a.join(' '); if (s.startsWith('torre-passagem-turno')) ctx.logs.push(s); else orig(...a); };
  }
  await import(pathToFileURL(path.join(RAIZ, 'supabase/functions/torre-passagem-turno/index.ts')).href);
  const gerar = async (texto, token = 'tok-admin') => {
    const r = await ctx.handler(new Request('https://f.invalid/', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ turno: 'T3', texto }) }));
    return { status: r.status, corpo: await r.json() };
  };
  const BASE = { urgente: [], em_andamento: [], pendencias_proximo_turno: ['Cobrar os canhotos do CD Cajamar.'], avisos: [] };

  // 1. Parecido: manda R1 (só a resolvida), esquema com sugestões; sugestão válida vira a seção com a passagem
  ctx.respostaIa = { ...BASE, sugestoes_tratativa: [
    { texto: 'Pedir ao CD Cajamar o reenvio por e-mail; a carreta XYZ9A87 trouxe os originais.', referencia: 'R1' },
    { texto: 'Acionar o jurídico.', referencia: 'R9' },
    { texto: 'Sem referência.', referencia: '' }] };
  let r = await gerar('Os canhotos do CD Cajamar ainda não chegaram, cobrar de novo.');
  const pedido = ctx.gemini[0];
  const msg = pedido.contents[0].parts[0].text;
  ok(r.status === 200, 'gerou com sugestões', r.status);
  ok(/R1\. Pendência: Canhotos do CD Cajamar não chegaram/.test(msg) && /Como foi resolvido: Pedi ao CD Cajamar o reenvio/.test(msg) && !/R2\./.test(msg),
    'mandou só a resolução parecida (R1), não a pendência que continua', msg.split('\n').filter(l => /^R\d|Como foi/.test(l.trim())).join(' / '));
  ok(!/123\.456\.789-09/.test(msg) && /\[CPF removido\]/.test(msg), 'CPF da resolução sai antes da IA');
  ok(!!pedido.generationConfig.responseSchema.properties.sugestoes_tratativa && /Sugestões de tratativa/.test(pedido.systemInstruction.parts[0].text),
    'esquema e instrução pedem sugestoes_tratativa');
  const dataBr = '02/11/2026';
  ok(r.corpo.texto_ia.endsWith(`SUGESTÕES DE TRATATIVA\n- Pedir ao CD Cajamar o reenvio por e-mail; a carreta XYZ9A87 trouxe os originais. (como resolvido na passagem do T2 de ${dataBr})`),
    'seção "SUGESTÕES DE TRATATIVA" no fim, dizendo de qual passagem veio', r.corpo.texto_ia.split('\n\n').pop());
  ok(r.corpo.sugestoes.length === 1 && r.corpo.sugestoes[0].passagem.id === passagemT2 && r.corpo.sugestoes[0].passagem.turno === 'T2',
    'R9 e sem referência descartadas; a resposta traz a passagem de origem', r.corpo.sugestoes);
  ok(!/Acionar o jurídico|Sem referência/.test(r.corpo.texto_ia), 'nada inventado entra no texto');
  ok(/PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Cobrar os canhotos do CD Cajamar\./.test(r.corpo.texto_ia), 'as 4 seções continuam iguais');

  // 2. Nada parecido: não manda resoluções nem pede sugestões; a seção não aparece mesmo se a IA devolver
  ctx.gemini.length = 0;
  ctx.respostaIa = { ...BASE, pendencias_proximo_turno: ['Trocar o pneu da carreta.'], sugestoes_tratativa: [{ texto: 'Inventada.', referencia: 'R1' }] };
  r = await gerar('Pneu furado na serra, socorro a caminho.');
  const p2 = ctx.gemini[0];
  ok(r.status === 200 && !/Resoluções anteriores/.test(p2.contents[0].parts[0].text) && !p2.generationConfig.responseSchema.properties.sugestoes_tratativa
    && !/Sugestões de tratativa/.test(p2.systemInstruction.parts[0].text), 'sem nada parecido: não manda resoluções nem pede sugestões');
  ok(!/SUGESTÕES DE TRATATIVA/.test(r.corpo.texto_ia) && r.corpo.sugestoes.length === 0, 'sem nada parecido: a seção não aparece', r.corpo.texto_ia.split('\n\n').length + ' seções');

  // 3. Busca fora do ar: gera sem sugestão
  ctx.buscaStatus = 500;
  ctx.respostaIa = { ...BASE, sugestoes_tratativa: [{ texto: 'x', referencia: 'R1' }] };
  r = await gerar('Os canhotos do CD Cajamar ainda não chegaram.');
  ok(r.status === 200 && !/SUGESTÕES/.test(r.corpo.texto_ia), 'busca fora: passagem gerada, sem sugestões', r.status);
  ctx.buscaStatus = 200;

  // 4. Motorista: barrado antes da busca e da IA
  const buscasAntes = ctx.buscas.length;
  const iaAntes = ctx.gemini.length;
  r = await gerar('Os canhotos do CD Cajamar.', 'tok-motorista');
  ok(r.status === 403 && ctx.buscas.length === buscasAntes && ctx.gemini.length === iaAntes, 'motorista: 403 sem buscar e sem chamar a IA', r.status);

  // 5. Unidade: sugestoesValidas / montarTexto
  const mod = await import(pathToFileURL(path.join(RAIZ, 'supabase/functions/torre-passagem-turno/index.ts')).href);
  const refs = [{ id: 'a', texto: 't', resolucao: 'r', passagem_id: 'p1', turno: 'T1', data: '2026-11-01' }];
  ok(mod.montarTexto(BASE).split('\n\n').length === 4, 'montarTexto sem referências: 4 seções (como antes)');
  ok(mod.sugestoesValidas({ sugestoes_tratativa: [{ texto: 'a', referencia: 'r1' }, { texto: 'a', referencia: 'R1' }, { texto: 5, referencia: 'R1' }] }, refs).length === 1,
    'sugestões repetidas ou sem texto são descartadas');

  const logs = ctx.logs.join(' | ');
  ok(!/Cajamar|canhotos|XYZ9A87|123\.456|Pneu/.test(logs), 'logs sem texto, placa ou CPF', logs.slice(0, 220));
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

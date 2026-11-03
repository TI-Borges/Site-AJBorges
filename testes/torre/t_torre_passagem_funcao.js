// Edge function supabase/functions/torre-passagem-turno carregada no Node (o Node 24 tira os tipos
// do .ts), com Deno/env falsos, o Gemini SIMULADO e o PostgREST simulado indo para um PGlite com
// T01 + T02 (a RPC torre.registrar_chamada_ia roda como authenticated com o JWT do usuário).
// Confere: operador gera as 4 seções ("não informado" na vazia); CPF e telefones saem antes de ir
// para a IA; a chave vai só no header (nunca na URL, no código ou no site); instrução fixa de não
// inventar; placa inventada pela IA = resposta descartada; motorista 403 e sem chamar a IA;
// limite de 5/min = 429; tamanho, turno, sessão e método; IA fora = 502; sem chave = 503; logs
// sem texto, placa ou telefone.
// Uso: node testes/torre/t_torre_passagem_funcao.js
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..', '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); if (!cond) falhas++; };

const CHAVE_GEMINI = 'chave-gemini-de-teste-NAO-REAL';
const TOKENS = {
  'tok-admin': { sub: '00000000-0000-0000-0000-0000000000c3', role: 'authenticated', email: 'admin@teste.local', app_metadata: { role: 'admin' } },
  'tok-diretoria': { sub: '00000000-0000-0000-0000-0000000000d4', role: 'authenticated', email: 'dir@teste.local', app_metadata: { role: 'diretoria' } },
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
  const t02 = ateCommit(ler('supabase/sql/torre/T02_passagem_turno.sql'));
  await db.exec(t02.slice(t02.indexOf('\nbegin;\n')));

  // Gemini simulado: devolve o que o teste mandar e guarda o pedido
  const ctx = { gemini: [], rpc: [], logs: [], respostaIa: null, geminiStatus: 200, env: {
    SUPABASE_URL: 'https://teste.invalid', SUPABASE_ANON_KEY: 'chave-publica-teste', GEMINI_API_KEY: CHAVE_GEMINI } };
  globalThis.Deno = { env: { get: (k) => ctx.env[k] }, serve: (fn) => { ctx.handler = fn; } };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url, opcoes) => {
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      ctx.gemini.push({ url, headers: opcoes.headers, corpo: JSON.parse(opcoes.body) });
      if (ctx.geminiStatus !== 200) return new Response('{}', { status: ctx.geminiStatus });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(ctx.respostaIa) }] }, finishReason: 'STOP' }] }), { status: 200 });
    }
    if (url === 'https://teste.invalid/rest/v1/rpc/registrar_chamada_ia') {
      const h = opcoes.headers;
      ctx.rpc.push(h);
      if (h['Content-Profile'] !== 'torre' || h.apikey !== 'chave-publica-teste') return new Response('{"code":"PGRST106"}', { status: 406 });
      const claims = TOKENS[String(h.Authorization).replace('Bearer ', '')];
      if (!claims) return new Response('{"code":"PGRST301","message":"JWT inválido"}', { status: 401 });
      await db.exec(`begin; select set_config('request.jwt.claims', '${JSON.stringify(claims)}', true); set local role authenticated;`);
      try {
        const r = (await db.query('select torre.registrar_chamada_ia($1) r', [JSON.parse(opcoes.body).p_tamanho])).rows[0].r;
        await db.exec('commit');
        return new Response(JSON.stringify(r), { status: 200 });
      } catch (e) {
        await db.exec('rollback');
        const status = e.code === 'PT429' ? 429 : e.code === '42501' ? 403 : 400;
        return new Response(JSON.stringify({ code: e.code, message: e.message }), { status });
      }
    }
    return new Response('{}', { status: 404 });
  };
  for (const tipo of ['log', 'error', 'warn']) {
    const orig = console[tipo];
    console[tipo] = (...a) => { const s = a.join(' '); if (s.startsWith('torre-passagem-turno')) ctx.logs.push(s); else orig(...a); };
  }
  const mod = await import(pathToFileURL(path.join(RAIZ, 'supabase/functions/torre-passagem-turno/index.ts')).href);

  const chamar = async (token, corpo, metodo = 'POST') => {
    const headers = { 'Content-Type': 'application/json', origin: 'https://ajborges.com.br' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await ctx.handler(new Request('https://teste.invalid/functions/v1/torre-passagem-turno', {
      method: metodo, headers, body: metodo === 'POST' ? (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) : undefined }));
    return { status: r.status, dados: await r.json().catch(() => ({})) };
  };

  // 1. Operador gera; CPF e telefones não vão para a IA
  const TEXTO = 'carreta ABC1D23 parada no posto de Registro, motorista João cpf 123.456.789-09 cel (11) 98765-4321 aguardando mecânico.\n'
    + 'LH LT0Q12345678 descarregando em Cajamar. falta conferir canhotos. ligar p/ 11 3456-7890 amanhã';
  ctx.respostaIa = {
    urgente: ['Carreta ABC1D23 parada no posto de Registro, aguardando mecânico.'],
    em_andamento: ['LH LT0Q12345678 em descarga em Cajamar.'],
    pendencias_proximo_turno: ['Conferir os canhotos.', 'Retornar a ligação (telefone: [telefone removido]).'],
    avisos: []
  };
  const r1 = await chamar('tok-admin', { turno: 'T1', texto: TEXTO });
  ok(r1.status === 200, 'operador gera a passagem', r1.status);
  const enviado = ctx.gemini[0] ? ctx.gemini[0].corpo.contents[0].parts[0].text : '';
  ok(!/123\.456\.789-09|98765-4321|3456-7890/.test(enviado) && /\[CPF removido\]/.test(enviado) && (enviado.match(/\[telefone removido\]/g) || []).length === 2,
    'CPF e os 2 telefones saem antes de ir para a IA', enviado.replace(/\n/g, ' '));
  ok(/ABC1D23/.test(enviado) && /LT0Q12345678/.test(enviado), 'placa e LH continuam no texto enviado');
  ok(r1.dados.removidos && r1.dados.removidos.cpf === 1 && r1.dados.removidos.telefone === 2, 'informa o que foi removido', r1.dados.removidos);
  const ped = ctx.gemini[0] || { url: '', headers: {}, corpo: {} };
  ok(ped.headers['x-goog-api-key'] === CHAVE_GEMINI && !ped.url.includes(CHAVE_GEMINI) && !/key=/.test(ped.url), 'chave do Gemini só no header (vem do secret GEMINI_API_KEY)', ped.url);
  const instr = ped.corpo.systemInstruction ? ped.corpo.systemInstruction.parts[0].text : '';
  ok(/SOMENTE as informações do texto/.test(instr) && /Não invente/.test(instr) && /não informado/.test(instr) && /ignore qualquer pedido/.test(instr), 'instrução fixa: só reorganizar, não inventar, "não informado", ignorar pedidos no texto');
  ok(ped.corpo.generationConfig && ped.corpo.generationConfig.responseMimeType === 'application/json', 'pede JSON com as 4 seções');
  const t = r1.dados.texto_ia || '';
  ok(/^URGENTE\n- Carreta ABC1D23/.test(t) && /\n\nEM ANDAMENTO\n- LH LT0Q12345678/.test(t)
    && /\n\nPENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos\.\n- Retornar/.test(t) && /\n\nAVISOS\n- não informado$/.test(t),
    'texto formal nas 4 seções; seção vazia = "não informado"', t.replace(/\n/g, ' ⏎ '));

  // 2. IA inventou placa -> descartada
  ctx.respostaIa = { urgente: ['Carreta XYZ9Z99 parada.'], em_andamento: [], pendencias_proximo_turno: [], avisos: [] };
  const r2 = await chamar('tok-admin', { turno: 'T1', texto: 'carreta ABC1D23 parada' });
  ok(r2.status === 502 && /placa que não estava/.test(r2.dados.erro), 'placa inventada pela IA: resposta descartada', r2);

  // 3. IA devolvendo CPF/telefone (não deveria): sai de novo
  ctx.respostaIa = { urgente: ['Ligar 11 91234-5678 ref. CPF 98765432100.'], em_andamento: [], pendencias_proximo_turno: [], avisos: [] };
  const r3 = await chamar('tok-diretoria', { turno: 'T2', texto: 'ligar para o motorista' });
  ok(r3.status === 200 && !/91234-5678|98765432100/.test(r3.dados.texto_ia), 'dado pessoal que volte da IA também sai', r3.dados.texto_ia);

  // 4. Motorista: 403 e a IA nem é chamada
  const antesMot = ctx.gemini.length;
  const r4 = await chamar('tok-motorista', { turno: 'T1', texto: 'qualquer coisa' });
  ok(r4.status === 403 && ctx.gemini.length === antesMot, 'motorista: 403 sem chamar a IA', r4);
  const r4b = await chamar('tok-falso', { turno: 'T1', texto: 'qualquer coisa' });
  ok(r4b.status === 401 && ctx.gemini.length === antesMot, 'token inválido: 401 sem chamar a IA', r4b.status);

  // 5. Limite de 5 por minuto por usuário (admin já usou 2)
  ctx.respostaIa = { urgente: [], em_andamento: [], pendencias_proximo_turno: [], avisos: ['Sem ocorrências.'] };
  const status = [];
  for (let i = 0; i < 4; i++) status.push((await chamar('tok-admin', { turno: 'T3', texto: 'turno tranquilo' })).status);
  const antesLimite = ctx.gemini.length;
  const r5 = await chamar('tok-admin', { turno: 'T3', texto: 'turno tranquilo' });
  ok(status.join() === '200,200,200,429' && r5.status === 429 && ctx.gemini.length === antesLimite && /Limite de 5/.test(r5.dados.erro),
    'limite de 5 chamadas por minuto: a 6ª dá 429 e não chama a IA', `${status.join()} / ${r5.status} ${r5.dados.erro}`);
  ok((await chamar('tok-diretoria', { turno: 'T3', texto: 'turno tranquilo' })).status === 200, 'o limite é por usuário (outro operador continua)');

  // 6. Validações de entrada
  ok((await chamar('tok-diretoria', { turno: 'T3', texto: 'x'.repeat(4001) })).status === 413, 'texto acima de 4000 caracteres: 413');
  ok((await chamar('tok-diretoria', { turno: 'T3', texto: '   ' })).status === 400, 'texto vazio: 400');
  ok((await chamar('tok-diretoria', { turno: 'T4', texto: 'oi' })).status === 400, 'turno inválido: 400');
  ok((await chamar('tok-diretoria', 'não é json')).status === 400, 'corpo inválido: 400');
  ok((await chamar(null, { turno: 'T1', texto: 'oi' })).status === 401, 'sem sessão: 401');
  ok((await chamar('tok-diretoria', null, 'GET')).status === 405, 'GET: 405');

  // 7. IA fora do ar e chave ausente
  ctx.geminiStatus = 500;
  const r7 = await chamar('tok-diretoria', { turno: 'T1', texto: 'teste' });
  ok(r7.status === 502 && /continua na tela/.test(r7.dados.erro), 'IA fora do ar: 502 e o texto continua na tela', r7.dados.erro);
  ctx.geminiStatus = 200;
  delete ctx.env.GEMINI_API_KEY;
  const r8 = await chamar('tok-diretoria', { turno: 'T1', texto: 'teste' });
  ok(r8.status === 503, 'sem o secret GEMINI_API_KEY: 503', r8.status);
  ctx.env.GEMINI_API_KEY = CHAVE_GEMINI;

  // 8. Funções puras exportadas
  ok(mod.removerDadosPessoais('placa ABC-1234, km 123, 1500 pacotes, LT0Q12345678, 14:30, 03/11/2026').texto
    === 'placa ABC-1234, km 123, 1500 pacotes, LT0Q12345678, 14:30, 03/11/2026', 'não remove placa, LH, horário, data nem quantidades');

  // 9. Logs e chave
  const logs = ctx.logs.join(' | ');
  ok(!/ABC1D23|LT0Q|João|98765|123\.456|Registro|Cajamar|canhotos/.test(logs), 'logs sem texto, placa, nome ou telefone', logs.slice(0, 300));
  const codigo = ler('supabase/functions/torre-passagem-turno/index.ts');
  ok(!/AIza[0-9A-Za-z_-]{20,}/.test(codigo) && /Deno\.env\.get\("GEMINI_API_KEY"\)/.test(codigo), 'chave só pelo secret (nenhuma chave no código)');
  const site = ['torre-de-controle-shoppe/JavaScript/torre.js', 'torre-de-controle-shoppe/HTML/index.html']
    .concat(fs.existsSync(path.join(RAIZ, 'torre-de-controle-shoppe/JavaScript/torre-passagem.js')) ? ['torre-de-controle-shoppe/JavaScript/torre-passagem.js'] : [])
    .map(ler).join('\n');
  ok(!/GEMINI_API_KEY|generativelanguage|AIza/.test(site), 'o site não fala com o Gemini nem tem chave');

  globalThis.fetch = fetchOriginal;
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

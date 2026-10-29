// Apoio dos testes da Torre: PGlite com o T01 instalado (papéis e is_admin() simulados como no
// Supabase) e a edge function torre-receber-planilha carregada no Node (o Node 24 tira os tipos do .ts),
// com o fetch dela indo para o PGlite como service_role, do jeito que o PostgREST faria.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..', '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');

async function bancoComTorre() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated;
    create role anon;
    create role service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
  `);
  const sql = ler('supabase/sql/torre/T01_copia_planilha.sql');
  await db.exec(sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length));
  return db;
}

// PostgREST simulado: só a rota da RPC, como service_role, exigindo os cabeçalhos do schema torre
function postgrestFalso(db, registro) {
  return async (url, opcoes) => {
    registro.push({ url, headers: opcoes.headers, tamanho: opcoes.body.length });
    if (registro.falharHttp) return new Response(JSON.stringify({ code: 'PGRST000', message: 'x' }), { status: 500 });
    const h = opcoes.headers;
    if (url !== 'https://teste.invalid/rest/v1/rpc/aplicar_planilha' || h['Content-Profile'] !== 'torre' || h['Accept-Profile'] !== 'torre'
        || h.apikey !== 'chave-service-teste' || h.Authorization !== 'Bearer chave-service-teste') {
      return new Response(JSON.stringify({ code: 'PGRST106', message: 'rota/cabeçalhos errados' }), { status: 406 });
    }
    const { p_payload } = JSON.parse(opcoes.body);
    await db.exec('begin; set local role service_role;');
    try {
      const r = (await db.query('select torre.aplicar_planilha($1) r', [p_payload])).rows[0].r;
      await db.exec('commit');
      return new Response(JSON.stringify(r), { status: 200 });
    } catch (e) {
      await db.exec('rollback');
      return new Response(JSON.stringify({ code: e.code, message: e.message }), { status: 400 });
    }
  };
}

// Carrega a edge function com Deno/env/fetch falsos; devolve o handler e o que ela pediu de env e logou
async function carregarFuncao(db) {
  const env = { SUPABASE_URL: 'https://teste.invalid', SUPABASE_SERVICE_ROLE_KEY: 'chave-service-teste',
    TORRE_SYNC_SECRET: 'segredo-da-torre-teste', CRON_SECRET: 'segredo-do-cron-do-site' };
  const ctx = { envLidas: [], logs: [], chamadas: [], handler: null, env };
  globalThis.Deno = {
    env: { get: (k) => { ctx.envLidas.push(k); return env[k]; } },
    serve: (fn) => { ctx.handler = fn; }
  };
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = postgrestFalso(db, ctx.chamadas);
  ctx.restaurarFetch = () => { globalThis.fetch = fetchOriginal; };
  for (const tipo of ['log', 'error', 'warn']) {
    const orig = console[tipo];
    console[tipo] = (...a) => { const s = a.join(' '); if (s.startsWith('torre-receber-planilha')) ctx.logs.push(s); else orig(...a); };
  }
  await import(pathToFileURL(path.join(RAIZ, 'supabase/functions/torre-receber-planilha/index.ts')).href);
  return ctx;
}

module.exports = { RAIZ, ler, bancoComTorre, carregarFuncao };

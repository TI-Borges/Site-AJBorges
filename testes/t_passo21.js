// Roda supabase/sql/passo21_avisos_locais.sql num Postgres em WASM (PGlite) por cima do passo 16, com
// auth.uid(), auth.jwt() e is_admin() simulados como no Supabase (is_admin lê auth.jwt() -> 'app_metadata'
// ->> 'role') e dois avisos que já existiam antes do passo 21. Roda o passo 21 duas vezes (tem que poder
// ser reexecutado), as conferências 5.x bloco a bloco, a RPC como a página chama (anon e gestão) e
// depois o passo 21b (apaga a RPC antiga; a nova continua).
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const ler = (arq) => fs.readFileSync(path.join(RAIZ, 'supabase/sql', arq), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);

(async () => {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated;
    create role anon;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on all functions in schema auth to anon, authenticated;
    create table public.perfis (id uuid primary key, nome text, role text);
    insert into public.perfis values ('11111111-1111-1111-1111-111111111111', 'Motorista Teste', 'motorista'),
                                     ('22222222-2222-2222-2222-222222222222', 'Gestão Teste', 'admin');
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    create table public.fichas_viagem (id text primary key, data_envio timestamptz);
    create table public.cadastros_agregados (id uuid primary key, criado_em timestamptz default now());
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);

  const r = {};
  const p16 = ler('passo16_avisos_notificacoes.sql');
  await db.exec(ateCommit(p16));
  // Avisos que já existiam (um ativo e um cancelado)
  await db.exec(`
    insert into public.avisos_atualizacao (inicio, fim, descricao) values (now() + interval '2 hours', now() + interval '4 hours', 'Antigo ativo');
    insert into public.avisos_atualizacao (inicio, fim, descricao, cancelado) values (now() + interval '2 hours', now() + interval '4 hours', 'Antigo cancelado', true);
  `);

  const p21 = ler('passo21_avisos_locais.sql');
  await db.exec(ateCommit(p21));
  await db.exec(ateCommit(p21));
  r.reexecutou = 'ok (2x)';
  r.antigosComOs4 = (await db.query(`select descricao, array_to_string(locais, ',') locais from public.avisos_atualizacao order by id`)).rows.map(x => `${x.descricao}: ${x.locais}`);
  r.outrasFuncoes = (await db.query(`select p.proname || '(' || pg_get_function_arguments(p.oid) || ')' f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`)).rows.map(x => x.f);
  r.policiesIguaisAoPasso16 = (await db.query(`select string_agg(policyname || ':' || cmd, ', ' order by policyname) p from pg_policies where tablename = 'avisos_atualizacao'`)).rows[0].p;

  const blocos = p21.slice(ateCommit(p21).length).split(/^(?=-- 5\.\d+ )/m).filter(b => /^-- 5\.\d+ /.test(b));
  r.conferencias = {};
  for (const b of blocos) {
    const titulo = b.split('\n')[0].replace(/^-- /, '').slice(0, 90);
    try {
      await db.exec(b);
      r.conferencias[titulo] = '(sem erro e sem RESULTADO)';
    } catch (e) {
      r.conferencias[titulo] = e.message;
      await db.exec('rollback').catch(() => {});
    }
  }
  r.nadaFicouGravado = (await db.query(`select count(*)::int n from public.avisos_atualizacao where descricao like 'Teste P21%'`)).rows[0].n === 0;

  // Como a página (anon, PostgREST) e o dashboard (gestão) chamam a RPC
  await db.exec(`insert into public.avisos_atualizacao (inicio, fim, descricao, locais) values
    (now() + interval '1 hour', now() + interval '3 hours', 'Só frota', array['frota']),
    (now() + interval '1 hour', now() + interval '3 hours', 'Só cadastro', array['cadastro']),
    (now() + interval '1 hour', now() + interval '3 hours', 'Frota e ficha', array['frota', 'ficha'])`);
  const como = async (papel, claims, q) => {
    try {
      await db.exec(`begin; select set_config('request.jwt.claims', '${claims}', true); set local role ${papel};`);
      return (await db.query(q)).rows.map(x => Object.values(x).join(' ')).join(' / ') || '(nada)';
    } catch (e) { return 'ERRO: ' + e.message; } finally { await db.exec('rollback'); }
  };
  const GESTAO = JSON.stringify({ sub: '22222222-2222-2222-2222-222222222222', role: 'authenticated', app_metadata: { role: 'admin' } });
  const MOTORISTA = JSON.stringify({ sub: '11111111-1111-1111-1111-111111111111', role: 'authenticated' });
  r.rpc = {};
  for (const local of ['frota', 'cadastro', 'ficha', 'site', 'blog']) {
    const q = `select descricao from public.avisos_atualizacao_ativos('${local}')`;
    r.rpc[local] = { visitante: await como('anon', '', q), motorista: await como('authenticated', MOTORISTA, q), gestao: await como('authenticated', GESTAO, q) };
  }
  r.rpc.nulo = await como('authenticated', GESTAO, `select descricao from public.avisos_atualizacao_ativos(null)`);
  r.rpc.colunas = (await db.query(`select pg_get_function_result('public.avisos_atualizacao_ativos(text)'::regprocedure) c`)).rows[0].c;
  r.rpc.locaisNaResposta = await como('anon', '', `select descricao, array_to_string(locais, ',') from public.avisos_atualizacao_ativos('ficha')`);
  r.rpc.antigaVisitante = await como('anon', '', `select descricao from public.avisos_atualizacao_ativos()`);
  r.gestaoLeLocaisNaTabela = await como('authenticated', GESTAO, `select descricao, array_to_string(locais, ',') from public.avisos_atualizacao where descricao = 'Só frota'`);
  r.gestaoGravaLocais = await como('authenticated', GESTAO, `insert into public.avisos_atualizacao (inicio, fim, descricao, locais) values (now() + interval '1 hour', now() + interval '2 hours', 'x', array['site']) returning array_to_string(locais, ',')`);
  r.motoristaGrava = await como('authenticated', MOTORISTA, `insert into public.avisos_atualizacao (inicio, fim, descricao, locais) values (now() + interval '1 hour', now() + interval '2 hours', 'x', array['site']) returning id`);
  r.anonLeTabela = await como('anon', '', `select locais from public.avisos_atualizacao`);
  r.gestaoAlteraLocais = await como('authenticated', GESTAO, `update public.avisos_atualizacao set locais = array['site'] where descricao = 'Só frota' returning id`);

  // Passo 21b: apaga a RPC antiga (duas vezes), a nova continua
  const p21b = ler('passo21b_apagar_rpc_antiga.sql');
  await db.exec(ateCommit(p21b));
  await db.exec(ateCommit(p21b));
  r.passo21b = {};
  for (const b of p21b.slice(ateCommit(p21b).length).split(/^(?=-- \d\. )/m).filter(b => /^-- \d\. /.test(b))) {
    try { await db.exec(b); r.passo21b[b.split('\n')[0]] = '(sem RESULTADO)'; } catch (e) { r.passo21b[b.split('\n')[0]] = e.message; }
  }
  r.passo21b.antiga = await como('anon', '', `select descricao from public.avisos_atualizacao_ativos()`);
  r.passo21b.nova = await como('anon', '', `select descricao from public.avisos_atualizacao_ativos('ficha')`);
  console.log(JSON.stringify(r, null, 2));
})().catch(e => { console.error(e); process.exit(1); });

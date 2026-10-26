// Roda supabase/sql/passo16_avisos_notificacoes.sql num Postgres em WASM (PGlite), com auth.uid() e
// is_admin() simulados (perfil com role admin/diretoria) e as permissões padrão do Supabase para tabela
// nova; roda duas vezes (tem que poder ser reexecutado) e depois as conferências 5.x, bloco a bloco.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/passo16_avisos_notificacoes.sql'), 'utf8');
const ateCommit = sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);

(async () => {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create role authenticated;
    create role anon;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on all functions in schema auth to anon, authenticated;
    create table public.perfis (id uuid primary key, nome text, role text);
    insert into public.perfis values ('11111111-1111-1111-1111-111111111111', 'Motorista Teste', 'motorista'),
                                     ('22222222-2222-2222-2222-222222222222', 'Gestão Teste', 'admin');
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select exists (select 1 from public.perfis where id = auth.uid() and role in ('admin', 'diretoria')) $$;
    -- Tabelas que já existem no Supabase (só as colunas usadas aqui); fichas sem índice em data_envio,
    -- cadastros já com um índice em criado_em (não pode criar outro)
    create table public.fichas_viagem (id text primary key, motorista text, status text, data_envio timestamptz, motorista_id uuid);
    create table public.cadastros_agregados (id uuid primary key, nome text, criado_em timestamptz default now());
    create index cadastros_ja_tinha on public.cadastros_agregados (criado_em);
    insert into public.fichas_viagem values ('AJB-1', 'A', 'pendente', now(), '11111111-1111-1111-1111-111111111111'),
                                            ('AJB-2', 'B', 'aprovado', now(), '11111111-1111-1111-1111-111111111111');
    insert into public.cadastros_agregados (id, nome) values ('33333333-3333-3333-3333-333333333333', 'C');
    -- RLS de hoje (simulada): gestão lê tudo
    alter table public.fichas_viagem enable row level security;
    alter table public.cadastros_agregados enable row level security;
    create policy gestao_le_fichas on public.fichas_viagem for select to authenticated using (public.is_admin());
    create policy gestao_le_cadastros on public.cadastros_agregados for select to authenticated using (public.is_admin());
    grant select on public.fichas_viagem, public.cadastros_agregados to authenticated;
    -- Supabase: tabela nova no public vem com tudo para anon e authenticated
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);

  const r = {};
  await db.exec(ateCommit);
  await db.exec(ateCommit);
  r.reexecutou = 'ok (2x)';
  r.indices = (await db.query(`select tablename, indexname from pg_indexes where tablename in ('fichas_viagem', 'cadastros_agregados') and indexname <> 'fichas_viagem_pkey' and indexname <> 'cadastros_agregados_pkey' order by 1, 2`)).rows.map(x => `${x.tablename}: ${x.indexname}`);

  const resto = sql.slice(ateCommit.length);
  const blocos = resto.split(/^(?=-- 5\.\d+ )/m).filter(b => /^-- 5\.\d+ /.test(b));
  r.conferencias = {};
  for (const b of blocos) {
    const titulo = b.split('\n')[0].replace(/^-- /, '');
    try {
      await db.exec(b);
      r.conferencias[titulo] = '(sem erro e sem RESULTADO)';
    } catch (e) {
      r.conferencias[titulo] = e.message;
      await db.exec('rollback').catch(() => {});
    }
  }

  // Como a página e o dashboard leem (PostgREST = select com as colunas pedidas)
  const comoAnon = async (q) => {
    try {
      await db.exec('begin; set local role anon;');
      const res = await db.query(q);
      return res.rows;
    } catch (e) { return 'ERRO: ' + e.message; } finally { await db.exec('rollback'); }
  };
  await db.exec(`insert into public.avisos_atualizacao (inicio, fim, descricao) values (now() + interval '1 hour', now() + interval '3 hours', 'Aviso de teste')`);
  r.anonPelaRpc = await comoAnon(`select id, descricao from public.avisos_atualizacao_ativos()`);
  r.anonSelectTudo = await comoAnon(`select * from public.avisos_atualizacao`);
  r.anonInsere = await comoAnon(`insert into public.avisos_atualizacao (inicio, fim, descricao) values (now() + interval '1 hour', now() + interval '2 hours', 'x')`);
  console.log(JSON.stringify(r, null, 2));
})().catch(e => { console.error(e); process.exit(1); });

// Roda supabase/sql/referencia_fichas_atual.sql + passo9 + passo11..15 + passo17 num Postgres em WASM (PGlite),
// com auth.uid(), auth.jwt() e is_admin() simulados como no Supabase (is_admin lê auth.jwt() -> 'app_metadata' ->> 'role'),
// reservar_numero_ficha() e storage.objects simulados e as policies que já existem em fichas_viagem
// (fichas_admin_all, fichas_motorista_select e uma de insert do envio de hoje). O passo 17 roda duas vezes
// (tem que poder ser reexecutado) e depois as conferências 6.x, bloco a bloco, como no SQL Editor.
// CENARIO=update_aberto simula uma policy de update antiga que deixasse o motorista alterar qualquer ficha dele:
// o trigger tem que bloquear a ficha enviada do mesmo jeito.
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const ler = (a) => fs.readFileSync(path.join(RAIZ, a), 'utf8');
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
const A = '11111111-1111-1111-1111-111111111111';
const B = '33333333-3333-3333-3333-333333333333';

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
    create role service_role;
    create table auth.users (id uuid primary key, email text, encrypted_password text, last_sign_in_at timestamptz, created_at timestamptz default now());
    create table auth.sessions (id uuid primary key, user_id uuid);
    create table public.perfis (id uuid primary key, nome text, cpf text, role text, status text, email text, telefone text, senha_alterada_em timestamptz);
    insert into public.perfis values ('${A}', 'Motorista A', '12345678900', 'motorista', 'aprovado', 'a@x', '1', null),
                                     ('${B}', 'Motorista B', '98765432100', 'motorista', 'aprovado', 'b@x', '2', null),
                                     ('22222222-2222-2222-2222-222222222222', 'Gestão', null, 'admin', 'aprovado', 'g@x', '3', null);
    insert into auth.users (id, email) values ('${A}', 'a@x'), ('${B}', 'b@x');
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
    create table public.fichas_viagem (
      id text not null primary key, motorista text not null, motorista_cpf text, placas text,
      destino_inicial text, destino_final text, frete_origem text, status text, origem_envio text, aprovado_por text,
      data_envio timestamptz, aprovado_em timestamptz, iniciada_em timestamptz,
      data_saida date, data_chegada date,
      km_saida numeric, km_chegada numeric, km_total numeric, retorno_1 numeric, retorno_2 numeric, retorno_3 numeric,
      total_frete numeric, vr_comissao numeric, valor_adiantamento numeric default 0, recibo_tm_1 numeric, saldo_comissao numeric, total_despesas numeric,
      media_km_l numeric,
      abastecimentos jsonb, comprovantes jsonb, despesas_extras jsonb, dados_completos jsonb, motorista_id uuid
    );
    -- Número da ficha (simulado): sequência + função que o envio de hoje chama pela RPC
    create sequence public.fichas_numero_seq;
    create function public.reservar_numero_ficha() returns text language sql security definer set search_path to '' as $$
      select 'AJB-2026-' || lpad(nextval('public.fichas_numero_seq')::text, 3, '0') $$;
    -- Storage simulado (só a tabela e a RLS ligada, como no Supabase)
    create schema storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    create policy gestao_tudo_storage on storage.objects for all to authenticated using (public.is_admin()) with check (public.is_admin());
    grant usage on schema public, auth, storage to authenticated, anon;
    grant all on all tables in schema public, storage to authenticated;
    grant all on all sequences in schema public to authenticated;
    grant execute on all functions in schema auth to anon, authenticated;
  `);
  await db.exec('set check_function_bodies = off;' + ler('supabase/sql/referencia_fichas_atual.sql') + ';set check_function_bodies = on;');
  await db.exec(`create trigger proteger_colunas_admin_fichas before insert or update on public.fichas_viagem
                 for each row execute function public.proteger_colunas_admin_fichas();`);
  await db.exec(ler('supabase/sql/passo9_frota.sql'));
  await db.exec(`update public.perfis set vinculo = 'frota'`);
  await db.exec(ler('supabase/sql/passo11_ficha_motorista.sql'));
  for (const p of ['passo12_placa_motorista', 'passo13_comissao_motorista', 'passo13b_adiantamento', 'passo14_datas_motorista', 'passo15_viana_destino']) {
    await db.exec(ateCommit(ler(`supabase/sql/${p}.sql`)));
  }
  // RLS de hoje (simulada)
  await db.exec(`
    alter table public.fichas_viagem enable row level security;
    create policy fichas_admin_all on public.fichas_viagem for all to authenticated using (public.is_admin()) with check (public.is_admin());
    create policy fichas_motorista_select on public.fichas_viagem for select to authenticated using (motorista_id = auth.uid());
    create policy fichas_motorista_insert on public.fichas_viagem for insert to authenticated with check (motorista_id = auth.uid() and status = 'pendente');
  `);
  if (process.env.CENARIO === 'update_aberto') {
    await db.exec(`create policy fichas_motorista_update_antiga on public.fichas_viagem for update to authenticated using (motorista_id = auth.uid()) with check (motorista_id = auth.uid());`);
  }

  const r = { cenario: process.env.CENARIO || 'padrao' };
  const sql = ler('supabase/sql/passo17_viagem_em_andamento.sql');
  // Item 0 (consultas de antes) + begin..commit, duas vezes
  await db.exec(ateCommit(sql));
  await db.exec(ateCommit(sql));
  r.reexecutou = 'ok (2x)';

  const resto = sql.slice(ateCommit(sql).length);
  const blocos = resto.split(/^(?=-- 6\.\d+ )/m).filter(b => /^-- 6\.\d+ /.test(b));
  const seqLer = async () => JSON.stringify((await db.query('select last_value, is_called from public.fichas_numero_seq')).rows[0]);
  const seqAntesConferencias = await seqLer();
  r.conferencias = {};
  for (const b of blocos) {
    const titulo = b.split('\n')[0].replace(/^-- /, '').replace(/ \(esperado:.*$/, '');
    try {
      await db.exec(b);
      r.conferencias[titulo] = '(sem erro e sem RESULTADO)';
    } catch (e) {
      r.conferencias[titulo] = e.message;
      await db.exec('rollback').catch(() => {});
    }
  }
  r.conferenciasNaoGastamNumero = (await seqLer()) === seqAntesConferencias;
  r.numeroDeVerdadeVoltou = (await db.query("select public.reservar_numero_ficha() n")).rows[0].n;
  r.esperado = Object.fromEntries(blocos.map(b => {
    const l = b.split('\n')[0];
    return [l.replace(/^-- /, '').replace(/ \(esperado:.*$/, ''), (l.match(/\(esperado: (.*)\)$/) || [])[1] || ''];
  }));

  // Como a página chama pelo PostgREST (insert/update com select), passo a passo
  const como = async (uid, q, params = [], admin = false) => {
    await db.exec(`begin; select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, role: 'authenticated', ...(admin ? { app_metadata: { role: 'admin' } } : {}) })}', true); set local role authenticated;`);
    try { const res = await db.query(q, params); await db.exec('commit'); return res.rows; }
    catch (e) { await db.exec('rollback'); return 'ERRO: ' + e.message; }
  };
  const seqAntes = (await db.query(`select last_value, is_called from public.fichas_numero_seq`)).rows[0];
  const ins = await como(A, `insert into public.fichas_viagem (id, motorista, status, data_saida, dados_completos) values ('RASC-x', 'A', 'rascunho', '2026-10-01', $1) returning id, status, data_envio, atualizado_em`, [{ kmSaida: '100000', dataSaida: '01/10/2026' }]);
  const idRasc = Array.isArray(ins) ? ins[0].id : null;
  r.fluxoPagina = { criaRascunho: Array.isArray(ins) ? `${ins[0].id.slice(0, 5)}… ${ins[0].status}` : ins };
  r.fluxoPagina.segundoRascunhoMesmoMotorista = await como(A, `insert into public.fichas_viagem (id, motorista, status, dados_completos) values ('RASC-y', 'A', 'rascunho', '{}')`);
  r.fluxoPagina.bLeRascunhoDeA = await como(B, `select id from public.fichas_viagem where id = $1`, [idRasc]);
  r.fluxoPagina.bAtualizaRascunhoDeA = await como(B, `update public.fichas_viagem set dados_completos = '{}' where id = $1 returning id`, [idRasc]);
  r.fluxoPagina.aEsvaziaRascunho = await como(A, `update public.fichas_viagem set placas = null, data_saida = null, abastecimentos = '[]', comprovantes = '[]', despesas_extras = '[]', dados_completos = '{}' where id = $1 and status = 'rascunho' returning id, status, km_saida, data_saida, placas`, [idRasc]);
  r.fluxoPagina.numeroNaoGastoNoRascunho = JSON.stringify((await db.query(`select last_value, is_called from public.fichas_numero_seq`)).rows[0]) === JSON.stringify(seqAntes);
  r.fluxoPagina.gestaoVeRascunho = await como('22222222-2222-2222-2222-222222222222', `select left(id, 5) id, status, atualizado_em is not null tem_atualizado from public.fichas_viagem where status = 'rascunho'`, [], true);
  r.fluxoPagina.envia = await como(A, `update public.fichas_viagem set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05', dados_completos = $2 where id = $1 and status = 'rascunho' returning id, status, dados_completos->>'id' dc_id`, [idRasc, { kmSaida: '100000', kmEntrada: '101500' }]);
  r.fluxoPagina.envioDiretoPendente = await como(A, `insert into public.fichas_viagem (id, motorista, status, placas, data_saida, data_chegada, dados_completos) values ('AJB-2026-900', 'A', 'pendente', 'ABC1D23', '2026-10-01', '2026-10-05', $1) returning id, status`, [{ kmSaida: '1', kmEntrada: '2' }]);
  r.fluxoPagina.motoristaAprova = await como(A, `update public.fichas_viagem set status = 'aprovado' where id = 'AJB-2026-900' returning id`);
  r.fluxoPagina.gestaoEditaPendente = await como('22222222-2222-2222-2222-222222222222', `update public.fichas_viagem set km_total = 9 where id = 'AJB-2026-900' returning id, km_total`, [], true);

  console.log(JSON.stringify(r, null, 2));
})().catch(e => { console.error(e); process.exit(1); });

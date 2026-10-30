// Roda supabase/sql/referencia_fichas_atual.sql + passo9 + passo11..15 + passo17 + passo19 (até o commit) + passo22 num
// Postgres em WASM (PGlite), com a mesma simulação do t_passo19 (auth.uid(), auth.jwt(), is_admin() pelo app_metadata,
// RLS de fichas_viagem e auditoria). O passo 22 roda duas vezes (tem que poder ser reexecutado) e depois as
// conferências, bloco a bloco, como no SQL Editor; cada RESULTADO é comparado com o "esperado" do título.
// Antes do passo 22 mostra o corte de hoje (8 fretes / 10 abastecimentos).
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
  // Auditoria de hoje (simulada como a do banco): trg_auditar_fichas AFTER INSERT OR DELETE OR UPDATE,
  // gravar_auditoria_fichas() plpgsql, security definer, search_path 'public', grava to_jsonb(old) e to_jsonb(new)
  await db.exec(`
    create table public.auditoria_fichas (id bigserial primary key, operacao text, ficha_id text, usuario uuid,
      dados_antigos jsonb, dados_novos jsonb, criado_em timestamptz default now());
    create function public.gravar_auditoria_fichas() returns trigger language plpgsql security definer set search_path to 'public' as $$
    begin
      insert into public.auditoria_fichas (operacao, ficha_id, usuario, dados_antigos, dados_novos)
      values (tg_op, coalesce(new.id, old.id), auth.uid(),
              case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
              case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
      return coalesce(new, old);
    end;
    $$;
    create trigger trg_auditar_fichas after insert or delete or update on public.fichas_viagem
      for each row execute function public.gravar_auditoria_fichas();
  `);

  const r = {};
  await db.exec(ateCommit(ler('supabase/sql/passo17_viagem_em_andamento.sql')));
  await db.exec(ateCommit(ler('supabase/sql/passo19_frete_sem_valor.sql')));
  const sql = ler('supabase/sql/passo22_fretes_postos.sql');
  const contar = async () => (await db.query(`select
      jsonb_array_length(public._limpar_fretes((select jsonb_agg('{"cliente":"shopee","valor":"1,00"}'::jsonb) from generate_series(1, 20)), null, 'carreta', null, null)) fretes_20,
      jsonb_array_length(public._limpar_abastecimentos((select jsonb_agg('{"posto":"P"}'::jsonb) from generate_series(1, 20)))) abast_20`)).rows[0];
  r.cortes = { antesDoPasso22: await contar() };
  await db.exec(ateCommit(sql));
  r.cortes.depois = await contar();
  await db.exec(ateCommit(sql));
  r.reexecutou = 'ok (2x)';

  const resto = sql.slice(ateCommit(sql).length);
  const blocos = resto.split(/^(?=-- \d+\.\d+ )/m).filter(b => /^-- \d+\.\d+ /.test(b));
  const seqLer = async () => JSON.stringify((await db.query('select last_value, is_called from public.fichas_numero_seq')).rows[0]);
  const seqAntes = await seqLer();
  const normalizar = (t) => t.replace(/^RESULTADO \(nada foi salvo\): /, '').replace(/^RESULTADO \(só leitura\): /, '');
  r.conferencias = {};
  r.batem = {};
  for (const b of blocos) {
    const l = b.split('\n')[0];
    const titulo = l.replace(/^-- /, '').replace(/ \(esperado:.*$/, '');
    const esperado = (l.match(/\(esperado: (.*)\)$/) || [])[1] || '';
    let obtido;
    try { await db.exec(b); obtido = '(sem erro e sem RESULTADO)'; }
    catch (e) { obtido = e.message; await db.exec('rollback').catch(() => {}); }
    r.conferencias[titulo] = obtido;
    r.batem[titulo] = normalizar(obtido) === esperado ? 'ok' : 'DIFERENTE, esperado: ' + esperado;
  }
  r.conferenciasNaoGastamNumero = (await seqLer()) === seqAntes;
  r.fichasQueSobraram = Number((await db.query('select count(*) n from public.fichas_viagem')).rows[0].n);
  console.log(JSON.stringify(r, null, 2));
})().catch(e => { console.error(e); process.exit(1); });

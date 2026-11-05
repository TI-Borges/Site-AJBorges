// supabase/sql/passo24_media_combustivel.sql num Postgres em WASM (PGlite), com a mesma simulação do t_passo23
// (referencia + passo9, 11..15, 17, 19, 22 e 23; auth.uid(), auth.jwt(), is_admin() pelo app_metadata, RLS de
// fichas_viagem e auditoria) e fichas INVENTADAS já gravadas (antigas, sem Momento). Roda como no SQL Editor:
// item 0, principal (duas vezes), conferências 7.1 a 7.5 (cada RESULTADO comparado com o "esperado" do título;
// N e M = os números do item 0) e 7.6, que tem que dar igual ao item 0. Confere também que o arquivo não
// tem update/delete/truncate fora das conferências e que a trava recusa uma função que não seja a do passo 22.
// Uso: node testes/t_passo24.js
// Uso: node testes/t_passo23.js
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

  await db.exec(ateCommit(ler('supabase/sql/passo17_viagem_em_andamento.sql')));
  await db.exec(ateCommit(ler('supabase/sql/passo19_frete_sem_valor.sql')));
  await db.exec(ateCommit(ler('supabase/sql/passo22_fretes_postos.sql')));
  await db.exec(ateCommit(ler('supabase/sql/passo23_adiantamentos.sql')));

  // Fichas "reais" já gravadas (antigas, sem Momento), como estão hoje: uma pela gestão e um rascunho do motorista B
  await db.exec(`
    select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","app_metadata":{"role":"admin"}}', false);
    insert into public.fichas_viagem (id, motorista, status, placas, abastecimentos, dados_completos)
    values ('AJB-2026-001', 'Motorista A', 'aprovado', 'ABC1D23',
            '[{"posto":"Posto A","valor":"1.000,00","litros":"200","combustivel":"diesel_s10"}]', '{"kmSaida":"1000","kmEntrada":"1600"}');
    select set_config('request.jwt.claims', '{"sub":"${B}","role":"authenticated"}', false);
    set role authenticated;
    insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
    values ('x', 'teste', 'rascunho', '[{"posto":"Posto B","litros":"50","combustivel":"diesel_s10"}]', '{}');
    reset role;
    select set_config('request.jwt.claims', '', false);
  `);

  const sql = ler('supabase/sql/passo24_media_combustivel.sql');
  const r = { erros: [] };
  const codigo = sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
  const principal = sql.slice(sql.indexOf('\nbegin;\n') + 1, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);
  const principalSemComentarios = principal.replace(/--.*$/gm, '');
  r.semApagarNemAlterarDados = !/\b(truncate|delete|update|insert|drop|alter|grant|revoke)\b/i.test(principalSemComentarios.replace(/'(?:[^']|'')*'/g, "''"));
  r.semDeleteTruncateNoArquivo = !/\b(truncate|delete)\b/i.test(codigo);
  r.conferenciasTerminamEmRollback = sql.split(/^-- 7\.[2-5] /m).slice(1).every((b) => /\nrollback;\s*(\n|$)/.test(b));

  const item0 = sql.slice(sql.indexOf('select (select md5('), sql.indexOf('\nbegin;\n'));
  const fotoFichas = async () => JSON.stringify((await db.query('select * from public.fichas_viagem order by id')).rows);
  const fotoAud = async () => JSON.stringify((await db.query('select * from public.auditoria_fichas order by id')).rows);
  const fichasAntes = await fotoFichas();
  const audAntes = await fotoAud();
  const antes = (await db.query(item0)).rows[0];
  r.item0 = antes;

  // A trava: com uma função que não é a do passo 22, o principal para e nada muda
  await db.exec(`begin; create or replace function public._limpar_abastecimentos(p jsonb) returns jsonb language sql immutable set search_path to '' as $$ select '[]'::jsonb $$;`);
  try { await db.exec('savepoint s;' + principal.replace(/^begin;\n/, '').replace(/\ncommit;\n$/, '\n')); r.trava = 'NÃO PAROU'; }
  catch (e) { r.trava = /^PARADO/.test(e.message) ? 'parou' : e.message; }
  await db.exec('rollback');

  await db.exec(principal);
  await db.exec(principal);
  r.principalReexecutavel = true;
  r.fichasIguaisDepoisDoPrincipal = (await fotoFichas()) === fichasAntes;

  const pares = (texto) => Object.fromEntries(texto.split(' | ').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const conferencias = sql.split(/^(?=-- 7\.\d )/m).filter((b) => /^-- 7\.\d /.test(b));
  r.conferencias = {};
  for (const bloco of conferencias) {
    const titulo = bloco.split('\n')[0].replace(/^-- /, '');
    const chave = titulo.slice(0, 3);
    const esperado = (titulo.match(/\(esperado: (.*)\)\s*$/) || [])[1];
    try {
      const res = await db.exec(bloco);
      const rows = res[res.length - 1].rows;
      r.conferencias[chave] = rows;
      if (chave === '7.6') r.item76IgualAoItem0 = JSON.stringify(rows[0]) === JSON.stringify(antes);
      else r.erros.push(`${chave}: não deu RESULTADO`);
    } catch (e) {
      await db.exec('rollback').catch(() => {});
      await db.exec('reset role').catch(() => {});
      const msg = e.message;
      r.conferencias[chave] = msg;
      if (!/^RESULTADO/.test(msg)) { r.erros.push(`${chave}: ${msg}`); continue; }
      const obtido = pares(msg.replace(/^RESULTADO( \([^)]*\))?: /, ''));
      for (const [k, v] of Object.entries(pares(esperado))) {
        const alvo = v === 'N' ? String(antes.fichas) : v === 'M' ? String(antes.auditoria) : v;
        if (obtido[k] !== alvo) r.erros.push(`${chave} ${k}: ${obtido[k]} (esperado ${alvo})`);
      }
    }
  }
  r.fichasIguaisNoFim = (await fotoFichas()) === fichasAntes;
  r.auditoriaIgualNoFim = (await fotoAud()) === audAntes;
  r.numeroNaoGasto = (await db.query('select last_value from public.fichas_numero_seq')).rows[0].last_value;

  console.log(JSON.stringify(r, null, 2));
  const ok = !r.erros.length && r.semApagarNemAlterarDados && r.semDeleteTruncateNoArquivo && r.conferenciasTerminamEmRollback &&
    r.trava === 'parou' && r.fichasIguaisDepoisDoPrincipal && r.item76IgualAoItem0 && r.fichasIguaisNoFim && r.auditoriaIgualNoFim;
  console.log(ok ? 'OK' : 'FALHOU');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

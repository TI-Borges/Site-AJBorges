-- =============================================================================
-- PASSO 16 - Aviso de atualização do site + base das notificações dos dashboards
-- AJBorges Transporte & Logística
--
--   1. Tabela public.avisos_atualizacao: a gestão agenda "o site vai ficar em
--      atualização de tal hora a tal hora" e a faixa aparece na ficha do
--      motorista, no login e nas páginas públicas.
--   2. Permissões e RLS da tabela:
--        - ler: qualquer um (anon e authenticated) só vê avisos não cancelados
--          que ainda não terminaram (fim > now()). O site lê pela RPC do item 3,
--          que devolve só id, inicio, fim e descricao (criado_por não sai);
--        - a gestão (public.is_admin(), a mesma das outras regras) cria e
--          cancela; para cancelar, o Postgres exige que ela enxergue a linha
--          depois de cancelada, por isso a gestão lê todas as linhas;
--        - apagar: ninguém (cancelar = cancelado = true).
--   3. RPC public.avisos_atualizacao_ativos(): os avisos ativos, para a faixa
--      das páginas e para a lista dos dashboards.
--   4. Notificações dos dashboards (sem tabela nova e sem Realtime): índice na
--      data de criação de fichas_viagem (data_envio) e de cadastros_agregados
--      (criado_em), criado só se ainda não houver um índice nessa coluna.
--
-- Não muda: fichas_viagem, cadastros_agregados (só o índice), trigger
-- proteger_colunas_admin_fichas, is_admin(), login e edge functions.
--
-- Rodar no SQL Editor do Supabase até o "commit;". Tudo roda numa transação
-- (begin ... commit): se algo falhar, nada é alterado. Pode ser reexecutado.
-- As conferências ficam depois do commit: rode cada uma separadamente.
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. Tabela public.avisos_atualizacao
--    cancelado é not null para o filtro "não cancelado" nunca dar null.
-- -----------------------------------------------------------------------------
create table if not exists public.avisos_atualizacao (
  id          bigint generated always as identity primary key,
  inicio      timestamptz not null,
  fim         timestamptz not null,
  descricao   text not null,
  criado_por  uuid default auth.uid(),
  criado_em   timestamptz default now(),
  cancelado   boolean not null default false,
  constraint avisos_atualizacao_fim_depois_do_inicio check (fim > inicio),
  constraint avisos_atualizacao_descricao_tamanho check (char_length(descricao) between 1 and 500)
);

-- A faixa procura "não cancelado e fim > agora"
create index if not exists avisos_atualizacao_fim_idx
  on public.avisos_atualizacao (fim) where not cancelado;


-- -----------------------------------------------------------------------------
-- 2a. Permissões por coluna
--     O Supabase dá tudo para anon/authenticated em tabela nova: tira e devolve
--     só o necessário. anon: nada na tabela (lê pela RPC). authenticated:
--     ler id, inicio, fim, descricao (criado_por, criado_em e cancelado não
--     saem pela API); criar com inicio, fim, descricao (criado_por = auth.uid(),
--     criado_em = now() e cancelado = false vêm do default); alterar só
--     cancelado. Apagar: nenhum grant.
-- -----------------------------------------------------------------------------
revoke all on public.avisos_atualizacao from anon, authenticated;
grant select (id, inicio, fim, descricao) on public.avisos_atualizacao to authenticated;
grant insert (inicio, fim, descricao) on public.avisos_atualizacao to authenticated;
grant update (cancelado) on public.avisos_atualizacao to authenticated;


-- -----------------------------------------------------------------------------
-- 2b. RLS
--     Quem não é da gestão só enxerga os avisos ativos. A gestão enxerga todos
--     (sem isso o Postgres recusa o cancelamento: a linha cancelada sairia da
--     vista dela). Criar e cancelar: só a gestão. Sem policy de delete =
--     ninguém apaga.
-- -----------------------------------------------------------------------------
alter table public.avisos_atualizacao enable row level security;

drop policy if exists avisos_atualizacao_ler_ativos on public.avisos_atualizacao;
create policy avisos_atualizacao_ler_ativos on public.avisos_atualizacao
  for select to anon, authenticated
  using (not cancelado and fim > now());

drop policy if exists avisos_atualizacao_gestao_le_todos on public.avisos_atualizacao;
create policy avisos_atualizacao_gestao_le_todos on public.avisos_atualizacao
  for select to authenticated
  using (coalesce(public.is_admin(), false));

drop policy if exists avisos_atualizacao_gestao_cria on public.avisos_atualizacao;
create policy avisos_atualizacao_gestao_cria on public.avisos_atualizacao
  for insert to authenticated
  with check (coalesce(public.is_admin(), false));

drop policy if exists avisos_atualizacao_gestao_cancela on public.avisos_atualizacao;
create policy avisos_atualizacao_gestao_cancela on public.avisos_atualizacao
  for update to authenticated
  using (coalesce(public.is_admin(), false))
  with check (coalesce(public.is_admin(), false));


-- -----------------------------------------------------------------------------
-- 3. RPC avisos_atualizacao_ativos()
--    Avisos não cancelados com fim > now(), do mais próximo para o mais longe,
--    só com id, inicio, fim e descricao. Security definer com search_path
--    vazio (como as RPCs do passo 10); pode ser chamada sem login.
-- -----------------------------------------------------------------------------
create or replace function public.avisos_atualizacao_ativos()
returns table (id bigint, inicio timestamptz, fim timestamptz, descricao text)
language sql
stable
security definer
set search_path to ''
as $$
  select a.id, a.inicio, a.fim, a.descricao
    from public.avisos_atualizacao a
   where not a.cancelado
     and a.fim > now()
   order by a.inicio, a.id;
$$;

revoke all on function public.avisos_atualizacao_ativos() from public;
grant execute on function public.avisos_atualizacao_ativos() to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4. Índices das notificações
--    Os dashboards contam "o que chegou depois da última vez que vi" pela data
--    de criação: fichas_viagem.data_envio (gravada pelo trigger no INSERT do
--    motorista) e cadastros_agregados.criado_em. Cria o índice só quando
--    nenhum índice da tabela começa por essa coluna.
-- -----------------------------------------------------------------------------
do $$
declare
  v_alvo record;
begin
  for v_alvo in
    select * from (values ('fichas_viagem', 'data_envio', 'fichas_viagem_data_envio_idx'),
                          ('cadastros_agregados', 'criado_em', 'cadastros_agregados_criado_em_idx')) t(tabela, coluna, nome)
  loop
    if not exists (
      select 1
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = format('public.%I', v_alvo.tabela)::regclass
         and a.attname = v_alvo.coluna
    ) then
      execute format('create index %I on public.%I (%I desc)', v_alvo.nome, v_alvo.tabela, v_alvo.coluna);
    end if;
  end loop;
end $$;


commit;


-- =============================================================================
-- 5. Conferência (depois do commit; rode cada bloco separadamente)
--    Os testes que gravam rodam como o primeiro perfil com role = 'admin' ou
--    'motorista' e desfazem tudo no final (rollback). O is_admin() lê o papel
--    de auth.jwt() -> 'app_metadata' ->> 'role': nas claims da gestão vai
--    app_metadata.role = 'admin'.
-- =============================================================================

-- 5.1 Tabela, permissões, policies e RPC (esperado: rls=t | anon_na_tabela=(nada) | ler=id,inicio,fim,descricao | criar=descricao,fim,inicio | alterar=cancelado | apagar=(nenhum) | policies=avisos_atualizacao_gestao_cancela:UPDATE, avisos_atualizacao_gestao_cria:INSERT, avisos_atualizacao_gestao_le_todos:SELECT, avisos_atualizacao_ler_ativos:SELECT | rpc_anon=t | rpc_authenticated=t)
do $$
begin
  raise exception 'RESULTADO: rls=% | anon_na_tabela=% | ler=% | criar=% | alterar=% | apagar=% | policies=% | rpc_anon=% | rpc_authenticated=%',
    (select relrowsecurity from pg_class where oid = 'public.avisos_atualizacao'::regclass),
    coalesce((select string_agg(distinct privilege_type, ',') from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee = 'anon'), '(nada)'),
    (select string_agg(column_name, ',' order by ordinal_position) from information_schema.column_privileges p
       join information_schema.columns c using (table_schema, table_name, column_name)
      where p.table_schema = 'public' and p.table_name = 'avisos_atualizacao' and p.grantee = 'authenticated' and p.privilege_type = 'SELECT'),
    (select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee = 'authenticated' and privilege_type = 'INSERT'),
    (select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
    coalesce((select string_agg(grantee, ',') from information_schema.table_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee in ('anon', 'authenticated') and privilege_type = 'DELETE'), '(nenhum)'),
    (select string_agg(policyname || ':' || cmd, ', ' order by policyname) from pg_policies
      where schemaname = 'public' and tablename = 'avisos_atualizacao'),
    has_function_privilege('anon', 'public.avisos_atualizacao_ativos()', 'execute'),
    has_function_privilege('authenticated', 'public.avisos_atualizacao_ativos()', 'execute');
end $$;

-- 5.2 Visitante sem login (anon): 1 aviso futuro, 1 cancelado e 1 que já terminou (esperado: rpc_ve=1 | descricao=Teste P16 futuro | tabela_direto=bloqueado)
begin;
insert into public.avisos_atualizacao (inicio, fim, descricao) values
  (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P16 futuro');
insert into public.avisos_atualizacao (inicio, fim, descricao, cancelado) values
  (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P16 cancelado', true);
insert into public.avisos_atualizacao (inicio, fim, descricao) values
  (now() - interval '3 hours', now() - interval '1 hour', 'Teste P16 terminado');
set local role anon;
do $$
declare v_bloqueado text := 'LIBERADO';
begin
  begin
    perform criado_por from public.avisos_atualizacao;
  exception when insufficient_privilege then v_bloqueado := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): rpc_ve=% | descricao=% | tabela_direto=%',
    (select count(*) from public.avisos_atualizacao_ativos() where descricao like 'Teste P16%'),
    (select string_agg(descricao, ', ') from public.avisos_atualizacao_ativos() where descricao like 'Teste P16%'),
    v_bloqueado;
end $$;
rollback;

-- 5.3 Motorista tenta criar um aviso (esperado: erro "new row violates row-level security policy"; se aparecer RESULTADO, a regra falhou)
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' limit 1), true);
set local role authenticated;
do $$
begin
  insert into public.avisos_atualizacao (inicio, fim, descricao)
  values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P16 motorista');
  raise exception 'RESULTADO (nada foi salvo): o motorista CONSEGUIU criar o aviso';
end $$;
rollback;

-- 5.4 Gestão cria, cancela e tenta apagar (esperado: criado_por_e_o_admin=t | linhas_canceladas=1 | cancelado=t | apagar=bloqueado | outro_usuario_ve=0)
--     O is_admin() lê o papel do JWT (app_metadata.role), por isso ele vai nas claims.
--     O 1º bloco grava como a gestão e guarda os resultados (set_config, só nesta transação);
--     depois do reset role, o 2º bloco lê como o usuário do SQL Editor as colunas que a API não mostra.
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' limit 1), true);
set local role authenticated;
do $$
declare
  v_id bigint;
  v_cancelou bigint;
  v_apagar text := 'LIBERADO';
begin
  insert into public.avisos_atualizacao (inicio, fim, descricao)
  values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P16 gestão')
  returning id into v_id;
  update public.avisos_atualizacao set cancelado = true where id = v_id;
  get diagnostics v_cancelou = row_count;
  begin
    delete from public.avisos_atualizacao where id = v_id;
  exception when insufficient_privilege then v_apagar := 'bloqueado';
  end;
  perform set_config('p16.id', v_id::text, true);
  perform set_config('p16.cancelou', v_cancelou::text, true);
  perform set_config('p16.apagar', v_apagar, true);
end $$;
reset role;
do $$
declare
  v_id bigint := current_setting('p16.id')::bigint;
begin
  raise exception 'RESULTADO (nada foi salvo): criado_por_e_o_admin=% | linhas_canceladas=% | cancelado=% | apagar=% | outro_usuario_ve=%',
    (select criado_por = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid from public.avisos_atualizacao where id = v_id),
    current_setting('p16.cancelou'),
    (select cancelado from public.avisos_atualizacao where id = v_id),
    current_setting('p16.apagar'),
    (select count(*) from public.avisos_atualizacao where id = v_id and not cancelado and fim > now());
end $$;
rollback;

-- 5.5 Fim antes do início e descrição vazia (esperado: erro "avisos_atualizacao_fim_depois_do_inicio"; troque as datas para ver o de descrição)
begin;
insert into public.avisos_atualizacao (inicio, fim, descricao)
values (now() + interval '2 hours', now() + interval '1 hour', 'Teste P16 datas');
rollback;

-- 5.6 Índices das notificações (esperado: fichas_viagem=<um índice com data_envio> | cadastros_agregados=<um índice com criado_em>)
do $$
begin
  raise exception 'RESULTADO: fichas_viagem=% | cadastros_agregados=%',
    (select string_agg(indexname || ' (' || indexdef || ')', '; ') from pg_indexes
      where schemaname = 'public' and tablename = 'fichas_viagem' and indexdef like '%(data_envio%'),
    (select string_agg(indexname || ' (' || indexdef || ')', '; ') from pg_indexes
      where schemaname = 'public' and tablename = 'cadastros_agregados' and indexdef like '%(criado_em%');
end $$;

-- 5.7 A gestão consegue contar fichas e cadastros pela RLS de hoje (esperado: fichas=<total> | cadastros=<total>, os mesmos números do dashboard; 0 com tabela cheia = a RLS não deixa)
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' limit 1), true);
set local role authenticated;
do $$
begin
  raise exception 'RESULTADO (só leitura): fichas=% | cadastros=% | policies de leitura: fichas_viagem=% | cadastros_agregados=%',
    (select count(*) from public.fichas_viagem),
    (select count(*) from public.cadastros_agregados),
    (select string_agg(policyname, ', ') from pg_policies where schemaname = 'public' and tablename = 'fichas_viagem' and cmd in ('SELECT', 'ALL')),
    (select string_agg(policyname, ', ') from pg_policies where schemaname = 'public' and tablename = 'cadastros_agregados' and cmd in ('SELECT', 'ALL'));
end $$;
rollback;

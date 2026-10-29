-- =============================================================================
-- PASSO 21 - Onde cada aviso de atualização aparece
-- AJBorges Transporte & Logística
--
--   1. Coluna public.avisos_atualizacao.locais (text[]): onde o aviso aparece.
--        frota    = Dashboard - Portal da Frota (dashboard-admin e escolhaDashboard)
--        cadastro = Dashboard - Cadastro do Motorista
--        ficha    = Relatório de Viagem (ficha do motorista e login)
--        site     = páginas do site (index, Agregue-se, Nossos Fretes, Sobre Nós, Contato)
--      Padrão: os 4. Os avisos que já existem ficam com os 4. Só aceita esses
--      valores e pelo menos 1.
--   2. Permissões: a gestão (authenticated) passa a ler e a gravar locais.
--      As outras permissões e as policies do passo 16 não mudam.
--   3. RPC nova public.avisos_atualizacao_ativos(p_local text): os avisos
--      ativos daquele local, com id, inicio, fim, descricao e locais.
--      Aviso de dashboard (frota, cadastro) é interno: só sai para a gestão
--      (is_admin()). Local inválido = lista vazia.
--   4. RPC antiga public.avisos_atualizacao_ativos() (sem parâmetro): continua
--      existindo porque o site no ar usa ela até o push; passa a devolver só
--      os avisos da ficha ou do site. É apagada no passo21b, depois do push.
--
-- Não muda: as outras tabelas e funções, is_admin(), login e edge functions.
--
-- Ordem do deploy: rodar este passo 21 -> push do site -> rodar o passo 21b.
--
-- Rodar no SQL Editor do Supabase até o "commit;". Tudo roda numa transação
-- (begin ... commit): se algo falhar, nada é alterado. Pode ser reexecutado.
-- As conferências ficam depois do commit: rode cada uma separadamente.
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. Coluna locais
--    O add column com default preenche os avisos que já existem com os 4.
-- -----------------------------------------------------------------------------
alter table public.avisos_atualizacao
  add column if not exists locais text[] not null
  default array['frota', 'cadastro', 'ficha', 'site']::text[];

-- Só os 4 valores (um null dentro da lista também é recusado)
alter table public.avisos_atualizacao drop constraint if exists avisos_atualizacao_locais_validos;
alter table public.avisos_atualizacao add constraint avisos_atualizacao_locais_validos
  check (locais <@ array['frota', 'cadastro', 'ficha', 'site']::text[]);

-- Pelo menos 1
alter table public.avisos_atualizacao drop constraint if exists avisos_atualizacao_locais_pelo_menos_um;
alter table public.avisos_atualizacao add constraint avisos_atualizacao_locais_pelo_menos_um
  check (cardinality(locais) >= 1);


-- -----------------------------------------------------------------------------
-- 2. Permissões da coluna nova (só authenticated; a RLS do passo 16 continua:
--    só a gestão cria e quem não é da gestão só enxerga avisos ativos)
-- -----------------------------------------------------------------------------
grant select (locais) on public.avisos_atualizacao to authenticated;
grant insert (locais) on public.avisos_atualizacao to authenticated;


-- -----------------------------------------------------------------------------
-- 3. RPC nova avisos_atualizacao_ativos(p_local)
--    Avisos não cancelados com fim > now() que contêm p_local, do mais próximo
--    para o mais longe. ficha e site: qualquer um. frota e cadastro: só a
--    gestão. Outro valor (ou null): nada. Security definer com search_path
--    vazio, como a do passo 16.
-- -----------------------------------------------------------------------------
create or replace function public.avisos_atualizacao_ativos(p_local text)
returns table (id bigint, inicio timestamptz, fim timestamptz, descricao text, locais text[])
language sql
stable
security definer
set search_path to ''
as $$
  select a.id, a.inicio, a.fim, a.descricao, a.locais
    from public.avisos_atualizacao a
   where not a.cancelado
     and a.fim > now()
     and p_local = any (a.locais)
     and (p_local in ('ficha', 'site')
          or (p_local in ('frota', 'cadastro') and coalesce(public.is_admin(), false)))
   order by a.inicio, a.id;
$$;

revoke all on function public.avisos_atualizacao_ativos(text) from public;
grant execute on function public.avisos_atualizacao_ativos(text) to anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4. RPC antiga avisos_atualizacao_ativos() (sem parâmetro)
--    Mesmas colunas de antes; agora só os avisos da ficha ou do site (aviso
--    só de dashboard não aparece mais na faixa do site no ar). Permissões
--    ficam como estão (o create or replace não mexe nelas).
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
     and a.locais && array['ficha', 'site']::text[]
   order by a.inicio, a.id;
$$;


commit;


-- =============================================================================
-- 5. Conferência (depois do commit; rode cada bloco separadamente)
--    Os testes que gravam desfazem tudo no final (rollback). O usuário de cada
--    teste (o primeiro perfil com role = 'motorista' ou 'admin') é escolhido
--    antes do set role. O is_admin() lê auth.jwt() -> 'app_metadata' ->> 'role':
--    nas claims da gestão vai app_metadata.role = 'admin'.
-- =============================================================================

-- 5.1 Coluna, regras, permissões e RPCs (esperado: coluna=text[] not null default ARRAY['frota'::text, 'cadastro'::text, 'ficha'::text, 'site'::text] | regras=avisos_atualizacao_locais_pelo_menos_um, avisos_atualizacao_locais_validos | ler=id,inicio,fim,descricao,locais | criar=descricao,fim,inicio,locais | alterar=cancelado | anon_na_tabela=(nada) | rpc_nova_anon=t | rpc_nova_authenticated=t | rpc_antiga_anon=t | rpc_antiga_authenticated=t)
do $$
begin
  raise exception 'RESULTADO: coluna=% | regras=% | ler=% | criar=% | alterar=% | anon_na_tabela=% | rpc_nova_anon=% | rpc_nova_authenticated=% | rpc_antiga_anon=% | rpc_antiga_authenticated=%',
    (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
            || ' default ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '(nenhum)')
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.avisos_atualizacao'::regclass and a.attname = 'locais'),
    (select string_agg(conname, ', ' order by conname) from pg_constraint
      where conrelid = 'public.avisos_atualizacao'::regclass and conname like 'avisos_atualizacao_locais%'),
    (select string_agg(column_name, ',' order by ordinal_position) from information_schema.column_privileges p
       join information_schema.columns c using (table_schema, table_name, column_name)
      where p.table_schema = 'public' and p.table_name = 'avisos_atualizacao' and p.grantee = 'authenticated' and p.privilege_type = 'SELECT'),
    (select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee = 'authenticated' and privilege_type = 'INSERT'),
    (select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
    coalesce((select string_agg(distinct privilege_type, ',') from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'avisos_atualizacao' and grantee = 'anon'), '(nada)'),
    has_function_privilege('anon', 'public.avisos_atualizacao_ativos(text)', 'execute'),
    has_function_privilege('authenticated', 'public.avisos_atualizacao_ativos(text)', 'execute'),
    has_function_privilege('anon', 'public.avisos_atualizacao_ativos()', 'execute'),
    has_function_privilege('authenticated', 'public.avisos_atualizacao_ativos()', 'execute');
end $$;

-- 5.2 Os avisos que já existiam ficaram com os 4 locais (esperado: avisos=<total> | com_os_4=<o mesmo total> | sem_os_4=0). Rode logo depois do passo 21, antes de criar aviso novo pelo dashboard.
do $$
begin
  raise exception 'RESULTADO (só leitura): avisos=% | com_os_4=% | sem_os_4=%',
    (select count(*) from public.avisos_atualizacao),
    (select count(*) from public.avisos_atualizacao where locais @> array['frota', 'cadastro', 'ficha', 'site']::text[] and cardinality(locais) = 4),
    (select count(*) from public.avisos_atualizacao where not (locais @> array['frota', 'cadastro', 'ficha', 'site']::text[] and cardinality(locais) = 4));
end $$;

-- 5.3 Quem vê o quê, em cada local (esperado:
--     visitante: frota=(nada) cadastro=(nada) ficha=ficha+todos site=site+todos invalido=(nada) | antiga=ficha+site+todos
--     motorista: frota=(nada) cadastro=(nada) ficha=ficha+todos site=site+todos invalido=(nada) | antiga=ficha+site+todos
--     gestao:    frota=dashboard+todos cadastro=dashboard+todos ficha=ficha+todos site=site+todos invalido=(nada) | antiga=ficha+site+todos)
--     "dashboard" só aparece para a gestão; "site" nunca aparece na ficha; a RPC antiga continua respondendo.
begin;
insert into public.avisos_atualizacao (inicio, fim, descricao, locais) values
  (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 dashboard', array['frota', 'cadastro']),
  (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 site', array['site']),
  (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 ficha', array['ficha']),
  (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 todos', array['frota', 'cadastro', 'ficha', 'site']);
-- Visitante (sem login)
set local role anon;
do $$
begin
  perform set_config('p21.visitante', (
    select string_agg(l || '=' || coalesce((select string_agg(replace(r.descricao, 'Teste P21 ', ''), '+' order by r.descricao)
                                              from public.avisos_atualizacao_ativos(l) r where r.descricao like 'Teste P21 %'), '(nada)'), ' ' order by n)
      from unnest(array['frota', 'cadastro', 'ficha', 'site', 'invalido']) with ordinality u(l, n))
    || ' | antiga=' || coalesce((select string_agg(replace(r.descricao, 'Teste P21 ', ''), '+' order by r.descricao)
                                   from public.avisos_atualizacao_ativos() r where r.descricao like 'Teste P21 %'), '(nada)'), true);
end $$;
reset role;
-- Motorista (escolhido antes do set role)
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' limit 1), true);
set local role authenticated;
do $$
begin
  perform set_config('p21.motorista', (
    select string_agg(l || '=' || coalesce((select string_agg(replace(r.descricao, 'Teste P21 ', ''), '+' order by r.descricao)
                                              from public.avisos_atualizacao_ativos(l) r where r.descricao like 'Teste P21 %'), '(nada)'), ' ' order by n)
      from unnest(array['frota', 'cadastro', 'ficha', 'site', 'invalido']) with ordinality u(l, n))
    || ' | antiga=' || coalesce((select string_agg(replace(r.descricao, 'Teste P21 ', ''), '+' order by r.descricao)
                                   from public.avisos_atualizacao_ativos() r where r.descricao like 'Teste P21 %'), '(nada)'), true);
end $$;
reset role;
-- Gestão (escolhida antes do set role; o papel vai em app_metadata)
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' limit 1), true);
set local role authenticated;
do $$
begin
  perform set_config('p21.gestao', (
    select string_agg(l || '=' || coalesce((select string_agg(replace(r.descricao, 'Teste P21 ', ''), '+' order by r.descricao)
                                              from public.avisos_atualizacao_ativos(l) r where r.descricao like 'Teste P21 %'), '(nada)'), ' ' order by n)
      from unnest(array['frota', 'cadastro', 'ficha', 'site', 'invalido']) with ordinality u(l, n))
    || ' | antiga=' || coalesce((select string_agg(replace(r.descricao, 'Teste P21 ', ''), '+' order by r.descricao)
                                   from public.avisos_atualizacao_ativos() r where r.descricao like 'Teste P21 %'), '(nada)'), true);
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): visitante: % || motorista: % || gestao: %',
    current_setting('p21.visitante'), current_setting('p21.motorista'), current_setting('p21.gestao');
end $$;
rollback;

-- 5.4 O banco recusa locais vazio, com valor inválido ou com null (esperado: vazio=recusado (avisos_atualizacao_locais_pelo_menos_um) | invalido=recusado (avisos_atualizacao_locais_validos) | com_null=recusado (avisos_atualizacao_locais_validos) | null=recusado (not null) | sem_informar=frota,cadastro,ficha,site)
begin;
do $$
declare
  v_vazio text := 'ACEITO';
  v_invalido text := 'ACEITO';
  v_com_null text := 'ACEITO';
  v_null text := 'ACEITO';
  v_sem_informar text;
  v_restricao text;
begin
  begin
    insert into public.avisos_atualizacao (inicio, fim, descricao, locais)
    values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 vazio', array[]::text[]);
  exception when check_violation then
    get stacked diagnostics v_restricao = constraint_name;
    v_vazio := 'recusado (' || v_restricao || ')';
  end;
  begin
    insert into public.avisos_atualizacao (inicio, fim, descricao, locais)
    values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 inválido', array['site', 'blog']);
  exception when check_violation then
    get stacked diagnostics v_restricao = constraint_name;
    v_invalido := 'recusado (' || v_restricao || ')';
  end;
  begin
    insert into public.avisos_atualizacao (inicio, fim, descricao, locais)
    values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 com null', array['site', null]);
  exception when check_violation then
    get stacked diagnostics v_restricao = constraint_name;
    v_com_null := 'recusado (' || v_restricao || ')';
  end;
  begin
    insert into public.avisos_atualizacao (inicio, fim, descricao, locais)
    values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 null', null);
  exception when not_null_violation then
    v_null := 'recusado (not null)';
  end;
  insert into public.avisos_atualizacao (inicio, fim, descricao)
  values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 sem informar')
  returning array_to_string(locais, ',') into v_sem_informar;
  raise exception 'RESULTADO (nada foi salvo): vazio=% | invalido=% | com_null=% | null=% | sem_informar=%',
    v_vazio, v_invalido, v_com_null, v_null, v_sem_informar;
end $$;
rollback;

-- 5.5 A gestão cria pela API um aviso só do site e o motorista tenta criar um (esperado: gestao_criou=site | aparece_no_site=1 | aparece_na_ficha=0 | motorista=bloqueado)
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' limit 1), true);
set local role authenticated;
do $$
declare
  v_locais text;
begin
  insert into public.avisos_atualizacao (inicio, fim, descricao, locais)
  values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 gestão só site', array['site'])
  returning array_to_string(locais, ',') into v_locais;
  perform set_config('p21.gestao_criou', v_locais, true);
end $$;
reset role;
set local role anon;
do $$
begin
  perform set_config('p21.no_site', (select count(*) from public.avisos_atualizacao_ativos('site') where descricao = 'Teste P21 gestão só site')::text, true);
  perform set_config('p21.na_ficha', (select count(*) from public.avisos_atualizacao_ativos('ficha') where descricao = 'Teste P21 gestão só site')::text, true);
end $$;
reset role;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' limit 1), true);
set local role authenticated;
do $$
declare
  v_motorista text := 'CONSEGUIU CRIAR';
begin
  begin
    insert into public.avisos_atualizacao (inicio, fim, descricao, locais)
    values (now() + interval '1 day', now() + interval '1 day 2 hours', 'Teste P21 motorista', array['site']);
  exception when insufficient_privilege then v_motorista := 'bloqueado';
  end;
  perform set_config('p21.motorista_cria', v_motorista, true);
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): gestao_criou=% | aparece_no_site=% | aparece_na_ficha=% | motorista=%',
    current_setting('p21.gestao_criou'), current_setting('p21.no_site'), current_setting('p21.na_ficha'), current_setting('p21.motorista_cria');
end $$;
rollback;

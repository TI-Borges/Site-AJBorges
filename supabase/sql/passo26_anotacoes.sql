-- =============================================================================
-- PASSO 26 - Anotações da gestão em cada cadastro (Dashboard do Cadastro)
--            RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- Decisão da gestão: a marcação Apto / Inapto (passo 25b) não será usada; no
-- lugar dela, um campo livre de ANOTAÇÕES em cada cadastro. Este passo NÃO
-- depende do 25b (roda com ou sem ele) e não mexe nas colunas, na função nem no
-- trigger do 25b, se existirem. Só acrescenta:
--   1. Colunas novas em public.cadastros_agregados, todas nulas:
--        anotacoes    texto livre, até 2000 letras (check)
--        anotado_por  e-mail de quem escreveu por último (vem do servidor)
--        anotado_em   quando (vem do servidor)
--      Os cadastros que já existem ficam com as 3 colunas nulas: add column sem
--      default não reescreve nenhuma linha e nenhum outro campo muda.
--   2. Trigger trg_cadastro_anotacao (BEFORE INSERT OR UPDATE) com a função
--      public.cadastro_anotacao_guarda(): cadastro novo nasce sem anotação (a
--      ficha e a edge function não conseguem escrever); mudar qualquer uma das 3
--      colunas exige public.is_admin() (admin e diretoria), por qualquer caminho;
--      o texto é aparado (vazio vira null) e quem/quando são sempre os do servidor.
--      Mudanças em outras colunas (status, dados, documentos...) seguem como hoje.
--   3. RPC public.anotar_cadastro(p_id, p_texto): só is_admin(); grava só a
--      anotação. execute só para authenticated.
--   Nenhum update, delete ou truncate de dados neste arquivo (fora as
--   conferências, que terminam em rollback). Nenhum drop. Nenhuma policy nova:
--   quem lê os cadastros continua sendo quem já lia (a gestão, pela RLS de hoje).
--
-- Como rodar (SQL Editor do Supabase), ANTES de publicar o site:
--   a) rode o item 0 sozinho e anote o resultado;
--   b) rode do "begin;" até o "commit;" (se algo falhar, nada é alterado; pode ser
--      reexecutado);
--   c) rode cada conferência do item 7 separadamente (tudo é desfeito com
--      rollback; o resultado aparece como erro "RESULTADO ...");
--   d) o 7.6 repete o item 0: tem que dar igual (rode num horário calmo);
--   e) o item 9 (só leitura) mostra quantos cadastros já têm avaliação Apto /
--      Inapto ou motivo preenchidos (0 se o 25b nunca foi rodado).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. ANTES (só leitura): retrato do public, cadastros (sem as colunas novas) e arquivos
--    (anote; o 7.6 repete e tem que dar igual. O retrato deixa de fora só as 3
--     colunas, as 2 funções e o trigger que este passo cria)
-- -----------------------------------------------------------------------------
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
             and not (c.relname = 'cadastros_agregados' and a.attname in ('anotacoes', 'anotado_por', 'anotado_em'))
          union all
          select 'con ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
            from pg_constraint k join pg_class c on c.oid = k.conrelid
           where c.relnamespace = 'public'::regnamespace and k.conname <> 'cadastros_agregados_anotacoes'
          union all
          select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
                 || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('anotar_cadastro', 'cadastro_anotacao_guarda')
          union all
          select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname = 'public'
          union all
          select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> 'trg_cadastro_anotacao'
          union all
          select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
        ) s) as retrato_public,
       (select count(*) from public.cadastros_agregados) as cadastros,
       (select md5(coalesce(string_agg((to_jsonb(c) - array['anotacoes', 'anotado_por', 'anotado_em'])::text, E'\n' order by c.id), ''))
          from public.cadastros_agregados c) as md5_cadastros_sem_colunas_novas,
       (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro') as arquivos,
       (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
          from storage.objects o where o.bucket_id = 'documentos-cadastro') as md5_arquivos;


begin;


-- -----------------------------------------------------------------------------
-- 1. Colunas (as linhas que já existem ficam nulas = sem anotação)
-- -----------------------------------------------------------------------------
alter table public.cadastros_agregados add column if not exists anotacoes text;
alter table public.cadastros_agregados add column if not exists anotado_por text;
alter table public.cadastros_agregados add column if not exists anotado_em timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cadastros_agregados'::regclass and conname = 'cadastros_agregados_anotacoes') then
    alter table public.cadastros_agregados add constraint cadastros_agregados_anotacoes
      check (anotacoes is null or char_length(anotacoes) <= 2000);
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 2. Guarda das 3 colunas (vale para a RPC e para qualquer update direto)
-- -----------------------------------------------------------------------------
create or replace function public.cadastro_anotacao_guarda()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Cadastro novo (ficha / edge function) nasce sem anotação
  if tg_op = 'INSERT' then
    new.anotacoes := null;
    new.anotado_por := null;
    new.anotado_em := null;
    return new;
  end if;

  if new.anotacoes is not distinct from old.anotacoes
     and new.anotado_por is not distinct from old.anotado_por
     and new.anotado_em is not distinct from old.anotado_em then
    return new;
  end if;

  if not coalesce(public.is_admin(), false) then
    raise exception 'Acesso negado: só a gestão escreve anotações.' using errcode = 'insufficient_privilege';
  end if;

  new.anotacoes := nullif(btrim(coalesce(new.anotacoes, ''), E' \t\r\n'), '');
  -- Quem e quando: sempre do servidor
  new.anotado_por := coalesce(nullif(auth.jwt() ->> 'email', ''), 'admin');
  new.anotado_em := now();
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.cadastros_agregados'::regclass and tgname = 'trg_cadastro_anotacao') then
    create trigger trg_cadastro_anotacao
      before insert or update on public.cadastros_agregados
      for each row execute function public.cadastro_anotacao_guarda();
  end if;
end $$;


-- -----------------------------------------------------------------------------
-- 3. RPC anotar_cadastro: só admin/diretoria; grava só a anotação
--    p_texto: aparado; vazio (ou só espaços) apaga a anotação
-- -----------------------------------------------------------------------------
create or replace function public.anotar_cadastro(
  p_id uuid,
  p_texto text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_texto text := nullif(btrim(coalesce(p_texto, ''), E' \t\r\n'), '');
  v_linha jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'Acesso negado.' using errcode = 'insufficient_privilege';
  end if;

  if char_length(coalesce(v_texto, '')) > 2000 then
    raise exception 'A anotação tem no máximo 2000 letras.' using errcode = 'check_violation';
  end if;

  update public.cadastros_agregados
     set anotacoes = v_texto
   where id = p_id
  returning jsonb_build_object('id', id, 'anotacoes', anotacoes, 'anotado_por', anotado_por, 'anotado_em', anotado_em)
    into v_linha;

  if v_linha is null then
    raise exception 'Cadastro não encontrado.';
  end if;

  return v_linha;
end;
$$;


-- -----------------------------------------------------------------------------
-- 4. Permissões: só authenticated chama a RPC (e ela confere is_admin());
--    a função do trigger ninguém chama direto
-- -----------------------------------------------------------------------------
revoke all on function public.anotar_cadastro(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.anotar_cadastro(uuid, text) to authenticated;
revoke all on function public.cadastro_anotacao_guarda() from public, anon, authenticated, service_role;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
--    As anotações são feitas em cadastros de TESTE criados dentro da transação
--    (CPF 999.999.999-8x, que a ficha não aceita); nenhum cadastro de verdade é tocado.
-- =============================================================================

-- 7.1 Estrutura e permissões (esperado: colunas=anotacoes:text anotado_em:timestamp with time zone anotado_por:text | check=CHECK (((anotacoes IS NULL) OR (char_length(anotacoes) <= 2000))) | trigger=ligado | quando=before insert update | rpc=authenticated:t anon:f definer:t config=search_path="" | guarda=anon:f authenticated:f | cadastros_com_anotacao=0 | policies_novas=0)
do $$
begin
  raise exception 'RESULTADO (só leitura): colunas=% | check=% | trigger=% | quando=% | rpc=authenticated:% anon:% definer:% config=% | guarda=anon:% authenticated:% | cadastros_com_anotacao=% | policies_novas=%',
    (select string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ' ' order by a.attname)
       from pg_attribute a
      where a.attrelid = 'public.cadastros_agregados'::regclass and not a.attisdropped
        and a.attname in ('anotacoes', 'anotado_por', 'anotado_em')),
    (select pg_get_constraintdef(k.oid) from pg_constraint k
      where k.conrelid = 'public.cadastros_agregados'::regclass and k.conname = 'cadastros_agregados_anotacoes'),
    (select case when t.tgenabled = 'O' then 'ligado' else 'DESLIGADO' end from pg_trigger t
      where t.tgrelid = 'public.cadastros_agregados'::regclass and t.tgname = 'trg_cadastro_anotacao'),
    -- tgtype: 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE
    (select case when t.tgtype & 2 = 2 then 'before' else 'after' end
            || case when t.tgtype & 4 = 4 then ' insert' else '' end
            || case when t.tgtype & 8 = 8 then ' delete' else '' end
            || case when t.tgtype & 16 = 16 then ' update' else '' end
       from pg_trigger t
      where t.tgrelid = 'public.cadastros_agregados'::regclass and t.tgname = 'trg_cadastro_anotacao'),
    left(has_function_privilege('authenticated', 'public.anotar_cadastro(uuid, text)', 'execute')::text, 1),
    left(has_function_privilege('anon', 'public.anotar_cadastro(uuid, text)', 'execute')::text, 1),
    (select left(p.prosecdef::text, 1) from pg_proc p where p.oid = 'public.anotar_cadastro(uuid, text)'::regprocedure),
    (select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.anotar_cadastro(uuid, text)'::regprocedure),
    left(has_function_privilege('anon', 'public.cadastro_anotacao_guarda()', 'execute')::text, 1),
    left(has_function_privilege('authenticated', 'public.cadastro_anotacao_guarda()', 'execute')::text, 1),
    (select count(*) from public.cadastros_agregados
      where anotacoes is not null or anotado_por is not null or anotado_em is not null),
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'cadastros_agregados'
        and (coalesce(qual, '') || coalesce(with_check, '')) ~* 'anota');
end $$;

-- 7.2 Admin anota, reescreve e apaga (esperado: numeros_de_teste_livres=t | anotou=Ligar na segunda. / Pediu prazo. | quebra_de_linha_preservada=t | quem=admin@teste.local | quando_do_servidor=t | reescreveu=Reescrita | com_2000=aceito | com_2001=recusado | html_guardado_como_texto=<img src=x onerror=alert(1)> | apagou=(nula) | quem_apagou=admin@teste.local | quem_forjado_vira_o_do_servidor=admin@teste.local | insert_com_anotacao=ignorada)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
values (null, 'pf', 'pendente', 'Fulano de Teste P26', '99999999981', null, '11900000000', true, '{"cpf": "99999999981"}');
select set_config('p26.livre',
         (select case when count(*) = 1 then 't' else 'f' end from public.cadastros_agregados where regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = '99999999981'), true);
select set_config('p26.id', (select id::text from public.cadastros_agregados where cpf = '99999999981' and nome = 'Fulano de Teste P26'), true);
set local role authenticated;
do $$
declare
  v_id    uuid := current_setting('p26.id')::uuid;
  v_1     jsonb;
  v_2     jsonb;
  v_2000  text := 'RECUSADO';
  v_2001  text := 'ACEITO';
  v_html  jsonb;
  v_apaga jsonb;
begin
  v_1 := public.anotar_cadastro(v_id, E'  Ligar na segunda.\nPediu prazo.  ');
  v_2 := public.anotar_cadastro(v_id, 'Reescrita');
  begin perform public.anotar_cadastro(v_id, repeat('x', 2000)); v_2000 := 'aceito';
  exception when check_violation then v_2000 := 'recusado'; end;
  begin perform public.anotar_cadastro(v_id, repeat('x', 2001));
  exception when check_violation then v_2001 := 'recusado'; end;
  v_html := public.anotar_cadastro(v_id, '<img src=x onerror=alert(1)>');
  v_apaga := public.anotar_cadastro(v_id, E'   \n  ');
  perform set_config('p26.res', format('anotou=%s | quebra_de_linha_preservada=%s | quem=%s | quando_do_servidor=%s | reescreveu=%s | com_2000=%s | com_2001=%s | html_guardado_como_texto=%s | apagou=%s | quem_apagou=%s',
    replace(v_1 ->> 'anotacoes', E'\n', ' / '),
    left(((v_1 ->> 'anotacoes') = E'Ligar na segunda.\nPediu prazo.')::text, 1),
    v_1 ->> 'anotado_por',
    case when (v_1 ->> 'anotado_em')::timestamptz = now() then 't' else 'f' end,
    v_2 ->> 'anotacoes', v_2000, v_2001, v_html ->> 'anotacoes',
    coalesce(v_apaga ->> 'anotacoes', '(nula)'), v_apaga ->> 'anotado_por'), true);
end $$;
reset role;
do $$
declare
  v_id   uuid := current_setting('p26.id')::uuid;
  v_novo uuid;
begin
  -- Update direto tentando escrever outro nome e outra data: o servidor troca pelos dele
  update public.cadastros_agregados
     set anotacoes = 'direto', anotado_por = 'outra pessoa', anotado_em = '2000-01-01'
   where id = v_id;
  -- Cadastro novo chegando já com anotação (como se a ficha mandasse): nasce sem anotação
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados,
                                          anotacoes, anotado_por, anotado_em)
  values (null, 'pf', 'pendente', 'Ciclano de Teste P26', '99999999982', null, '11900000000', true, '{}',
          'forjada', 'ficha', now())
  returning id into v_novo;
  raise exception 'RESULTADO (nada foi salvo): numeros_de_teste_livres=% | % | quem_forjado_vira_o_do_servidor=% | insert_com_anotacao=%',
    current_setting('p26.livre'), current_setting('p26.res'),
    (select anotado_por || case when anotado_em = now() then '' else ' (DATA FORJADA)' end from public.cadastros_agregados where id = v_id),
    (select case when anotacoes is null and anotado_por is null and anotado_em is null
                 then 'ignorada' else 'GRAVADA' end from public.cadastros_agregados where id = v_novo);
end $$;
rollback;

-- 7.3 Motorista, anon e sem login não anotam (esperado: motorista_rpc=bloqueado | motorista_update_direto=bloqueado | anon_rpc=bloqueado | anon_update_direto=bloqueado | sem_login_update_direto=bloqueado | motorista_ve_cadastros=0 | continua_sem_anotacao=t)
begin;
insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
values (null, 'pf', 'pendente', 'Fulano de Teste P26', '99999999981', null, '11900000000', true, '{}');
select set_config('p26.id', (select id::text from public.cadastros_agregados where cpf = '99999999981'), true);
select set_config('request.jwt.claims',
         '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
-- update direto com o JWT do motorista (como se ele tivesse um caminho até a tabela)
do $$
declare
  v_dir text := 'LIBERADO';
begin
  begin
    update public.cadastros_agregados set anotacoes = 'motorista' where id = current_setting('p26.id')::uuid;
  exception when insufficient_privilege then v_dir := 'bloqueado'; end;
  perform set_config('p26.dir', v_dir, true);
end $$;
set local role authenticated;
do $$
declare
  v_rpc text := 'LIBERADO';
begin
  begin perform public.anotar_cadastro(current_setting('p26.id')::uuid, 'motorista');
  exception when insufficient_privilege then v_rpc := 'bloqueado'; end;
  perform set_config('p26.rpc', v_rpc, true);
  perform set_config('p26.ve', (select count(*)::text from public.cadastros_agregados), true);
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
declare
  v_rpc    text := 'LIBERADO';
  v_dir    text := 'LIBERADO';
  v_linhas bigint;
begin
  begin perform public.anotar_cadastro(current_setting('p26.id')::uuid, 'anon');
  exception when insufficient_privilege then v_rpc := 'bloqueado'; end;
  begin
    update public.cadastros_agregados set anotacoes = 'anon' where id = current_setting('p26.id')::uuid;
    get diagnostics v_linhas = row_count;
    if v_linhas = 0 then v_dir := 'bloqueado'; end if;
  exception when insufficient_privilege then v_dir := 'bloqueado'; end;
  perform set_config('p26.anon', v_rpc, true);
  perform set_config('p26.anon_dir', v_dir, true);
end $$;
reset role;
-- update direto sem login nenhum (service_role da edge function, SQL Editor): também não anota
select set_config('request.jwt.claims', '', true);
do $$
declare
  v_dir text := 'LIBERADO';
begin
  begin
    update public.cadastros_agregados set anotacoes = 'sem login' where id = current_setting('p26.id')::uuid;
  exception when insufficient_privilege then v_dir := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): motorista_rpc=% | motorista_update_direto=% | anon_rpc=% | anon_update_direto=% | sem_login_update_direto=% | motorista_ve_cadastros=% | continua_sem_anotacao=%',
    current_setting('p26.rpc'), current_setting('p26.dir'), current_setting('p26.anon'), current_setting('p26.anon_dir'), v_dir,
    current_setting('p26.ve'),
    (select left((anotacoes is null and anotado_por is null)::text, 1) from public.cadastros_agregados where id = current_setting('p26.id')::uuid);
end $$;
rollback;

-- 7.4 Anotar não muda status, documentos, avaliação nem a trava por CPF (esperado: status_igual=t | documentos_iguais=t | avaliacao_igual=t | resto_da_linha_igual=t | ativo_anotado_continua_travando=recusado | anotar_recusado_nao_trava=aceito)
--     A avaliação (passo 25b, se existir) é lida pelo to_jsonb: sem as colunas do 25b, os dois lados são nulos.
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados, documentos)
values (null, 'pf', 'pendente', 'Fulano de Teste P26', '99999999981', null, '11900000000', true, '{"x": 1}',
        '[{"campo": "cnh", "path": "terceiros/teste-p26/cnh_1_a.pdf"}]'),
       (null, 'pf', 'recusado', 'Ciclano de Teste P26', '99999999982', null, '11900000000', true, '{}', '[]');
do $$
declare
  v_a      uuid := (select id from public.cadastros_agregados where cpf = '99999999981');
  v_b      uuid := (select id from public.cadastros_agregados where cpf = '99999999982');
  v_antes  jsonb;
  v_trava  text := 'ACEITO';
  v_livre  text := 'RECUSADO';
begin
  select to_jsonb(c) into v_antes from public.cadastros_agregados c where c.id = v_a;

  perform public.anotar_cadastro(v_a, 'Teste da conferência 7.4');
  perform public.anotar_cadastro(v_b, 'Teste da conferência 7.4');

  -- A trava continua: o cadastro ativo anotado ainda ocupa o CPF
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P26', '999.999.999-81', null, '11900000000', true, '{}');
  exception when unique_violation then v_trava := 'recusado'; end;
  -- Anotar um recusado não o torna ativo: o CPF dele continua livre
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Ciclano de Teste P26', '99999999982', null, '11900000000', true, '{}');
  v_livre := 'aceito';

  raise exception 'RESULTADO (nada foi salvo): status_igual=% | documentos_iguais=% | avaliacao_igual=% | resto_da_linha_igual=% | ativo_anotado_continua_travando=% | anotar_recusado_nao_trava=%',
    (select left((to_jsonb(c) -> 'status' = v_antes -> 'status')::text, 1) from public.cadastros_agregados c where c.id = v_a),
    (select left((to_jsonb(c) -> 'documentos' = v_antes -> 'documentos')::text, 1) from public.cadastros_agregados c where c.id = v_a),
    (select left(((to_jsonb(c) -> 'avaliacao') is not distinct from (v_antes -> 'avaliacao')
              and (to_jsonb(c) -> 'avaliacao_motivo') is not distinct from (v_antes -> 'avaliacao_motivo')
              and (to_jsonb(c) -> 'avaliado_por') is not distinct from (v_antes -> 'avaliado_por'))::text, 1)
       from public.cadastros_agregados c where c.id = v_a),
    (select left(((to_jsonb(c) - array['anotacoes', 'anotado_por', 'anotado_em']) = (v_antes - array['anotacoes', 'anotado_por', 'anotado_em']))::text, 1)
       from public.cadastros_agregados c where c.id = v_a),
    v_trava, v_livre;
end $$;
rollback;

-- 7.5 Os existentes não mudam e nenhum arquivo é criado ou apagado (esperado: cadastros_antes=N | cadastros_depois=N | existentes_iguais_sem_colunas_novas=t | existentes_sem_anotacao=t | arquivos_antes=M | arquivos_depois=M | arquivos_iguais=t)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
do $$
declare
  v_cad_antes bigint;
  v_cad_md5   text;
  v_arq_antes bigint;
  v_arq_md5   text;
  v_id        uuid;
begin
  select count(*), md5(coalesce(string_agg((to_jsonb(c) - array['anotacoes', 'anotado_por', 'anotado_em'])::text, E'\n' order by c.id), ''))
    into v_cad_antes, v_cad_md5
    from public.cadastros_agregados c;
  select count(*), md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), '')) into v_arq_antes, v_arq_md5
    from storage.objects o where o.bucket_id = 'documentos-cadastro';

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Fulano de Teste P26', '99999999981', null, '11900000000', true, '{}')
  returning id into v_id;
  perform public.anotar_cadastro(v_id, 'Teste da conferência 7.5');
  perform public.anotar_cadastro(v_id, '');

  raise exception 'RESULTADO (nada foi salvo): cadastros_antes=% | cadastros_depois=% | existentes_iguais_sem_colunas_novas=% | existentes_sem_anotacao=% | arquivos_antes=% | arquivos_depois=% | arquivos_iguais=%',
    v_cad_antes,
    (select count(*) from public.cadastros_agregados where id <> v_id),
    left(((select md5(coalesce(string_agg((to_jsonb(c) - array['anotacoes', 'anotado_por', 'anotado_em'])::text, E'\n' order by c.id), ''))
       from public.cadastros_agregados c where c.id <> v_id) = v_cad_md5)::text, 1),
    (select left(coalesce(bool_and(anotacoes is null and anotado_por is null and anotado_em is null), true)::text, 1)
       from public.cadastros_agregados where id <> v_id),
    v_arq_antes,
    (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro'),
    left(((select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
       from storage.objects o where o.bucket_id = 'documentos-cadastro') = v_arq_md5)::text, 1);
end $$;
rollback;

-- 7.6 DEPOIS (só leitura): o mesmo do item 0 (esperado: retrato_public, cadastros, md5_cadastros_sem_colunas_novas, arquivos e md5_arquivos iguais ao item 0)
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
             and not (c.relname = 'cadastros_agregados' and a.attname in ('anotacoes', 'anotado_por', 'anotado_em'))
          union all
          select 'con ' || c.relname || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
            from pg_constraint k join pg_class c on c.oid = k.conrelid
           where c.relnamespace = 'public'::regnamespace and k.conname <> 'cadastros_agregados_anotacoes'
          union all
          select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
                 || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('anotar_cadastro', 'cadastro_anotacao_guarda')
          union all
          select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname = 'public'
          union all
          select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> 'trg_cadastro_anotacao'
          union all
          select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
        ) s) as retrato_public,
       (select count(*) from public.cadastros_agregados) as cadastros,
       (select md5(coalesce(string_agg((to_jsonb(c) - array['anotacoes', 'anotado_por', 'anotado_em'])::text, E'\n' order by c.id), ''))
          from public.cadastros_agregados c) as md5_cadastros_sem_colunas_novas,
       (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro') as arquivos,
       (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
          from storage.objects o where o.bucket_id = 'documentos-cadastro') as md5_arquivos;


-- =============================================================================
-- 9. Só leitura: quantos cadastros já têm a avaliação Apto / Inapto (passo 25b) preenchida
--    Funciona com ou sem as colunas do 25b (lê pelo to_jsonb; sem elas, tudo dá 0).
--    colunas_do_25b: 2 = o 25b foi rodado; 0 = nunca foi.
-- =============================================================================
select (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'cadastros_agregados'
           and column_name in ('avaliacao', 'avaliacao_motivo')) as colunas_do_25b,
       count(*) as cadastros,
       count(*) filter (where nullif(btrim(to_jsonb(c) ->> 'avaliacao'), '') is not null) as com_avaliacao,
       count(*) filter (where nullif(btrim(to_jsonb(c) ->> 'avaliacao_motivo'), '') is not null) as com_motivo,
       count(*) filter (where nullif(btrim(to_jsonb(c) ->> 'avaliacao'), '') is not null
                           or nullif(btrim(to_jsonb(c) ->> 'avaliacao_motivo'), '') is not null) as com_avaliacao_ou_motivo
  from public.cadastros_agregados c;

-- =============================================================================
-- TORRE T02 - Passagem de turno com IA                RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- Rode DEPOIS do T01 (usa o schema torre e a função torre.eh_operador()).
--
-- O operador escolhe o turno, escreve do jeito dele, a edge function
-- torre-passagem-turno reorganiza o texto com o Gemini, ele revisa, edita e
-- publica. O próximo turno vê a última passagem e o histórico.
--
--   1. torre.turnos: T1, T2 e T3 com os horários EM BRANCO (ninguém inventou
--      horário; o operador preenche na tela). Operador lê e edita os horários.
--   2. torre.passagens_turno: turno, data, texto_original, texto_ia,
--      texto_final; autor, autor_email e criado_em vêm do servidor (o que o
--      navegador mandar é ignorado). Publicada não muda: sem update, sem
--      delete e sem truncate (barrados por trigger, vale até para o dono).
--   3. torre.ia_chamadas + RPC torre.registrar_chamada_ia(p_tamanho): a edge
--      function chama ANTES de mandar o texto ao Gemini, com o JWT do
--      operador. Confere torre.eh_operador() e o limite de chamadas
--      (5 por minuto por usuário e 30 por minuto no total); passou do limite
--      = erro PT429 (o PostgREST devolve HTTP 429). Ninguém lê nem grava
--      essa tabela pela API.
--   4. RLS: tudo só para torre.eh_operador() (admin e diretoria, como no
--      T01). anon e motorista: nada. Nenhuma policy de delete.
--
-- Não cria nem altera nada fora do schema torre. Só CHAMA torre.eh_operador()
-- (que chama public.is_admin()) e auth.uid()/auth.jwt().
--
-- Como rodar (SQL Editor do Supabase):
--   a) rode o item 0 sozinho e anote o retrato do public;
--   b) rode do "begin;" até o "commit;" (se algo falhar, nada é alterado;
--      pode ser reexecutado);
--   c) rode cada conferência do item 7 separadamente (tudo é desfeito com
--      rollback; o resultado aparece como erro "RESULTADO ...");
--   d) o 7.7 repete o retrato do public: tem que dar igual ao item 0.
-- Obs.: depois deste arquivo a conferência 8.1 do T01 muda (tabelas novas,
-- policies de insert/update e grants de escrita nas tabelas do T02).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Retrato do public (rode ANTES e anote; a conferência 7.7 repete e tem que dar igual)
-- -----------------------------------------------------------------------------
select md5(string_agg(x, E'\n' order by x)) as retrato_public, count(*) as itens
from (
  select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
    from pg_class c where c.relnamespace = 'public'::regnamespace
  union all
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
  union all
  select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
         || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
  union all
  select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
  union all
  select 'def ' || d.defaclnamespace::text || ' ' || d.defaclobjtype::text || ' ' || d.defaclacl::text
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname in ('torre', 'rh'))
) s;


begin;


-- -----------------------------------------------------------------------------
-- 1. Turnos (horários em branco até o operador preencher)
-- -----------------------------------------------------------------------------
create table if not exists torre.turnos (
  turno          text primary key check (turno in ('T1', 'T2', 'T3')),
  inicio         time,
  fim            time,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);

insert into torre.turnos (turno) values ('T1'), ('T2'), ('T3')
on conflict (turno) do nothing;


-- -----------------------------------------------------------------------------
-- 2. Passagens de turno (publicada não muda)
-- -----------------------------------------------------------------------------
create table if not exists torre.passagens_turno (
  id              uuid primary key default gen_random_uuid(),
  turno           text not null check (turno in ('T1', 'T2', 'T3')),
  data            date not null default current_date,
  texto_original  text not null check (length(btrim(texto_original)) between 1 and 4000),
  texto_ia        text check (texto_ia is null or length(texto_ia) <= 8000),
  texto_final     text not null check (length(btrim(texto_final)) between 1 and 8000),
  autor           uuid not null,
  autor_email     text,
  criado_em       timestamptz not null default now()
);
create index if not exists passagens_turno_recentes on torre.passagens_turno (criado_em desc);
create index if not exists passagens_turno_filtro on torre.passagens_turno (data, turno);


-- -----------------------------------------------------------------------------
-- 3. Chamadas à IA (só para o limite por minuto; ninguém lê pela API)
-- -----------------------------------------------------------------------------
create table if not exists torre.ia_chamadas (
  id        bigint generated always as identity primary key,
  usuario   uuid not null,
  criado_em timestamptz not null default now(),
  tamanho   int not null check (tamanho between 0 and 100000)
);
create index if not exists ia_chamadas_recentes on torre.ia_chamadas (criado_em desc, usuario);


-- -----------------------------------------------------------------------------
-- 4. Funções e triggers
-- -----------------------------------------------------------------------------

-- Passagem: autor, e-mail e hora sempre do servidor
create or replace function torre.passagem_servidor()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.autor := auth.uid();
  new.autor_email := nullif((select auth.jwt()) ->> 'email', '');
  new.criado_em := now();
  if new.autor is null then
    raise exception 'torre.passagens_turno: precisa de usuário autenticado' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Horário do turno: quem e quando alterou, do servidor; o código do turno não muda
create or replace function torre.turno_servidor()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.turno := old.turno;
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;

-- Publicada não muda e nada é apagado (vale até para o dono das tabelas)
create or replace function torre.bloquear_passagem()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'torre.%: % não é permitido (passagem publicada não muda nem é apagada)',
    tg_table_name, lower(tg_op) using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists torre_10_servidor on torre.passagens_turno;
create trigger torre_10_servidor before insert on torre.passagens_turno
  for each row execute function torre.passagem_servidor();
drop trigger if exists torre_00_sem_update on torre.passagens_turno;
create trigger torre_00_sem_update before update on torre.passagens_turno
  for each row execute function torre.bloquear_passagem();
drop trigger if exists torre_00_sem_delete on torre.passagens_turno;
create trigger torre_00_sem_delete before delete on torre.passagens_turno
  for each row execute function torre.bloquear_passagem();
drop trigger if exists torre_00_sem_truncate on torre.passagens_turno;
create trigger torre_00_sem_truncate before truncate on torre.passagens_turno
  for each statement execute function torre.bloquear_passagem();

drop trigger if exists torre_10_servidor on torre.turnos;
create trigger torre_10_servidor before update on torre.turnos
  for each row execute function torre.turno_servidor();
drop trigger if exists torre_00_sem_delete on torre.turnos;
create trigger torre_00_sem_delete before delete on torre.turnos
  for each row execute function torre.bloquear_passagem();
drop trigger if exists torre_00_sem_truncate on torre.turnos;
create trigger torre_00_sem_truncate before truncate on torre.turnos
  for each statement execute function torre.bloquear_passagem();

-- Limite de chamadas à IA (a edge function chama com o JWT do operador)
create or replace function torre.registrar_chamada_ia(p_tamanho int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_usuario uuid := auth.uid();
  v_do_usuario int;
  v_total int;
begin
  if not torre.eh_operador() or v_usuario is null then
    raise exception 'torre.registrar_chamada_ia: só operador da Torre' using errcode = 'insufficient_privilege';
  end if;
  if p_tamanho is null or p_tamanho < 1 or p_tamanho > 4000 then
    raise exception 'torre.registrar_chamada_ia: texto vazio ou maior que 4000 caracteres' using errcode = 'check_violation';
  end if;

  -- Uma chamada de cada vez por usuário (evita passar do limite com cliques ao mesmo tempo)
  perform pg_advisory_xact_lock(hashtext('torre.ia_chamadas'));
  select count(*) filter (where c.usuario = v_usuario), count(*)
    into v_do_usuario, v_total
    from torre.ia_chamadas c
   where c.criado_em > now() - interval '1 minute';
  if v_do_usuario >= 5 then
    raise exception 'Limite de 5 passagens geradas por minuto. Espere um pouco e tente de novo.' using errcode = 'PT429';
  end if;
  if v_total >= 30 then
    raise exception 'Muitas passagens sendo geradas agora. Espere um minuto e tente de novo.' using errcode = 'PT429';
  end if;

  insert into torre.ia_chamadas (usuario, tamanho) values (v_usuario, p_tamanho);
  return jsonb_build_object('ok', true, 'restantes_no_minuto', 4 - v_do_usuario);
end $$;


-- -----------------------------------------------------------------------------
-- 5. RLS e policies (só operador; nenhuma de delete; ia_chamadas sem nenhuma)
-- -----------------------------------------------------------------------------
alter table torre.turnos          enable row level security;
alter table torre.passagens_turno enable row level security;
alter table torre.ia_chamadas     enable row level security;

drop policy if exists torre_operador_le on torre.turnos;
create policy torre_operador_le on torre.turnos for select to authenticated using (torre.eh_operador());
drop policy if exists torre_operador_altera on torre.turnos;
create policy torre_operador_altera on torre.turnos for update to authenticated
  using (torre.eh_operador()) with check (torre.eh_operador());

drop policy if exists torre_operador_le on torre.passagens_turno;
create policy torre_operador_le on torre.passagens_turno for select to authenticated using (torre.eh_operador());
drop policy if exists torre_operador_publica on torre.passagens_turno;
create policy torre_operador_publica on torre.passagens_turno for insert to authenticated
  with check (torre.eh_operador());


-- -----------------------------------------------------------------------------
-- 6. Permissões (anon, public e service_role: nada; delete nunca)
-- -----------------------------------------------------------------------------
revoke all on torre.turnos, torre.passagens_turno, torre.ia_chamadas
  from public, anon, authenticated, service_role;
revoke all on sequence torre.ia_chamadas_id_seq from public, anon, authenticated, service_role;
grant select on torre.turnos to authenticated;
grant update (inicio, fim) on torre.turnos to authenticated;
grant select, insert on torre.passagens_turno to authenticated;

revoke all on function torre.passagem_servidor(), torre.turno_servidor(), torre.bloquear_passagem(),
                       torre.registrar_chamada_ia(int)
  from public, anon, authenticated, service_role;
grant execute on function torre.registrar_chamada_ia(int) to authenticated;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
-- =============================================================================

-- 7.1 Estrutura e permissões (esperado: tabelas_rls=ia_chamadas:true, passagens_turno:true, turnos:true | policies=passagens_turno:INSERT,SELECT turnos:SELECT,UPDATE | policies_delete=0 | passagens=INSERT,SELECT | turnos=SELECT | turnos_colunas_update=fim,inicio | ia_chamadas=nada | anon_privilegios=0 | service_role_privilegios=0 | delete_ou_truncate=0 | rpc=definer:true search_path="" authenticated:true anon:false service_role:false | gatilhos_para_alguem=0 | bloqueios_ligados=5 | turnos_sem_horario=T1,T2,T3)
do $$
begin
  raise exception 'RESULTADO: tabelas_rls=% | policies=% | policies_delete=% | passagens=% | turnos=% | turnos_colunas_update=% | ia_chamadas=% | anon_privilegios=% | service_role_privilegios=% | delete_ou_truncate=% | rpc=definer:% % authenticated:% anon:% service_role:% | gatilhos_para_alguem=% | bloqueios_ligados=% | turnos_sem_horario=%',
    (select string_agg(c.relname || ':' || c.relrowsecurity, ', ' order by c.relname)
       from pg_class c where c.relnamespace = 'torre'::regnamespace and c.relkind = 'r'
        and c.relname in ('turnos', 'passagens_turno', 'ia_chamadas')),
    (select string_agg(tablename || ':' || cmds, ' ' order by tablename)
       from (select tablename, string_agg(cmd, ',' order by cmd) as cmds from pg_policies
              where schemaname = 'torre' and tablename in ('turnos', 'passagens_turno', 'ia_chamadas')
              group by tablename) p),
    (select count(*) from pg_policies where schemaname = 'torre' and cmd in ('DELETE', 'ALL')),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'torre.passagens_turno'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'torre.turnos'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
      where a.attrelid = 'torre.turnos'::regclass and a.attnum > 0
        and has_column_privilege('authenticated', 'torre.turnos', a.attname, 'update')),
    (select coalesce(string_agg(a.privilege_type, ','), 'nada') from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'torre.ia_chamadas'::regclass and a.grantee <> c.relowner),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.grantee = 'anon'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.oid in ('torre.turnos'::regclass, 'torre.passagens_turno'::regclass, 'torre.ia_chamadas'::regclass)
        and a.grantee = 'service_role'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner),
    (select p.prosecdef::text from pg_proc p where p.oid = 'torre.registrar_chamada_ia(int)'::regprocedure),
    (select coalesce(array_to_string(p.proconfig, ','), 'SEM search_path') from pg_proc p where p.oid = 'torre.registrar_chamada_ia(int)'::regprocedure),
    has_function_privilege('authenticated', 'torre.registrar_chamada_ia(int)', 'execute')::text,
    has_function_privilege('anon', 'torre.registrar_chamada_ia(int)', 'execute')::text,
    has_function_privilege('service_role', 'torre.registrar_chamada_ia(int)', 'execute')::text,
    (select count(*) from pg_proc p
      where p.oid in ('torre.passagem_servidor()'::regprocedure, 'torre.turno_servidor()'::regprocedure, 'torre.bloquear_passagem()'::regprocedure)
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
    (select count(*) from pg_trigger t
      where t.tgrelid in ('torre.passagens_turno'::regclass, 'torre.turnos'::regclass) and t.tgenabled = 'O'
        and t.tgname in ('torre_00_sem_update', 'torre_00_sem_delete', 'torre_00_sem_truncate')),
    (select string_agg(turno, ',' order by turno) from torre.turnos where inicio is null and fim is null);
end $$;

-- 7.2 Anon não lê nem grava (esperado: passagens=bloqueado | turnos=bloqueado | publicar=bloqueado | rpc=bloqueado)
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
declare
  v_le text := 'LIBERADO';
  v_turnos text := 'LIBERADO';
  v_grava text := 'LIBERADO';
  v_rpc text := 'LIBERADO';
begin
  begin perform count(*) from torre.passagens_turno; exception when insufficient_privilege then v_le := 'bloqueado'; end;
  begin perform count(*) from torre.turnos; exception when insufficient_privilege then v_turnos := 'bloqueado'; end;
  begin
    insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T1', 'x', 'x');
  exception when insufficient_privilege then v_grava := 'bloqueado';
  end;
  begin perform torre.registrar_chamada_ia(10); exception when insufficient_privilege then v_rpc := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): passagens=% | turnos=% | publicar=% | rpc=%', v_le, v_turnos, v_grava, v_rpc;
end $$;
reset role;
rollback;

-- 7.3 Motorista logado não lê nem grava (esperado: passagens_vistas=0 | turnos_vistos=0 | publicar=bloqueado | alterar_horario=0 linhas | rpc=bloqueado | eh_operador=f)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T1', 'texto de teste 7.3', 'passagem de teste 7.3');
select set_config('request.jwt.claims',
         '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
set local role authenticated;
do $$
declare
  v_n bigint;
  v_grava text := 'LIBERADO';
  v_rpc text := 'LIBERADO';
  v_horario text;
begin
  begin
    insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T1', 'x', 'x');
  exception when insufficient_privilege then v_grava := 'bloqueado';
  end;
  update torre.turnos set inicio = '06:00' where turno = 'T1';
  get diagnostics v_n = row_count;
  v_horario := v_n || ' linhas';
  begin perform torre.registrar_chamada_ia(10); exception when insufficient_privilege then v_rpc := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): passagens_vistas=% | turnos_vistos=% | publicar=% | alterar_horario=% | rpc=% | eh_operador=%',
    (select count(*) from torre.passagens_turno), (select count(*) from torre.turnos),
    v_grava, v_horario, v_rpc, torre.eh_operador();
end $$;
reset role;
rollback;

-- 7.4 Operador publica e lê; autor e hora do servidor; edita só o horário (esperado: publicou=ok | autor_servidor=t | email_servidor=t | hora_servidor=t | leu=1 | diretoria_le=1 | diretoria_publica=ok | horario=T1 06:00-14:00 por admin | trocar_codigo_turno=bloqueado | turno_invalido=recusado)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
do $$
declare
  v_id uuid;
  v_invalido text := 'ACEITO';
  v_codigo text := 'TROCOU';
begin
  insert into torre.passagens_turno (turno, data, texto_original, texto_ia, texto_final, autor, autor_email, criado_em)
  values ('T2', current_date, 'carreta abc1d23 parada', 'URGENTE\n- Carreta ABC1D23 parada', 'URGENTE\n- Carreta ABC1D23 parada.',
          '99999999-9999-9999-9999-999999999999', 'falso@x', '2000-01-01')
  returning id into v_id;
  update torre.turnos set inicio = '06:00', fim = '14:00' where turno = 'T1';
  begin
    update torre.turnos set turno = 'T9' where turno = 'T2';
  exception when insufficient_privilege then v_codigo := 'bloqueado';
  end;
  begin
    insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T4', 'x', 'x');
  exception when check_violation then v_invalido := 'recusado';
  end;
  perform set_config('t02.id', v_id::text, true);
  perform set_config('t02.parcial', format('publicou=ok | autor_servidor=%s | email_servidor=%s | hora_servidor=%s | leu=%s',
    (select autor = '00000000-0000-0000-0000-0000000000c3' from torre.passagens_turno where id = v_id),
    (select autor_email = 'admin@teste.local' from torre.passagens_turno where id = v_id),
    (select criado_em = now() from torre.passagens_turno where id = v_id),
    (select count(*) from torre.passagens_turno where id = v_id)), true);
  perform set_config('t02.horario', (select format('T1 %s-%s por %s', to_char(inicio, 'HH24:MI'), to_char(fim, 'HH24:MI'),
      case when atualizado_por = '00000000-0000-0000-0000-0000000000c3' then 'admin' else 'OUTRO' end) from torre.turnos where turno = 'T1')
    || ' | trocar_codigo_turno=' || v_codigo
    || ' | turno_invalido=' || v_invalido, true);
end $$;
reset role;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated","email":"diretoria@teste.local","app_metadata":{"role":"diretoria"}}', true);
set local role authenticated;
do $$
declare
  v_publica text := 'ok';
begin
  begin
    insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T3', 'texto da diretoria', 'passagem da diretoria');
  exception when insufficient_privilege then v_publica := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): % | diretoria_le=% | diretoria_publica=% | horario=%',
    current_setting('t02.parcial'),
    (select count(*) from torre.passagens_turno where id = current_setting('t02.id')::uuid),
    v_publica, current_setting('t02.horario');
end $$;
reset role;
rollback;

-- 7.5 Ninguém apaga nem altera passagem publicada (esperado: operador=alterar:bloqueado apagar:bloqueado | dono=alterar:bloqueado apagar:bloqueado truncate:bloqueado | turnos=apagar:bloqueado | passagem_intacta=t)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
do $$
declare
  v_id uuid;
begin
  insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T1', 'original 7.5', 'final 7.5') returning id into v_id;
  perform set_config('t02.id', v_id::text, true);
end $$;
set local role authenticated;
do $$
declare
  v_id uuid := current_setting('t02.id')::uuid;
  v_alt text := 'LIBERADO';
  v_del text := 'LIBERADO';
  v_tdel text := 'LIBERADO';
begin
  begin update torre.passagens_turno set texto_final = 'mudei' where id = v_id; exception when insufficient_privilege then v_alt := 'bloqueado'; end;
  begin delete from torre.passagens_turno where id = v_id; exception when insufficient_privilege then v_del := 'bloqueado'; end;
  begin delete from torre.turnos where turno = 'T1'; exception when insufficient_privilege then v_tdel := 'bloqueado'; end;
  perform set_config('t02.operador', format('operador=alterar:%s apagar:%s', v_alt, v_del), true);
  perform set_config('t02.turnos', format('turnos=apagar:%s', v_tdel), true);
end $$;
reset role;
do $$
declare
  v_id uuid := current_setting('t02.id')::uuid;
  v_alt text := 'LIBERADO';
  v_del text := 'LIBERADO';
  v_trunc text := 'LIBERADO';
begin
  begin update torre.passagens_turno set texto_final = 'mudei' where id = v_id; exception when insufficient_privilege then v_alt := 'bloqueado'; end;
  begin delete from torre.passagens_turno where id = v_id; exception when insufficient_privilege then v_del := 'bloqueado'; end;
  begin truncate torre.passagens_turno; exception when insufficient_privilege then v_trunc := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): % | dono=alterar:% apagar:% truncate:% | % | passagem_intacta=%',
    current_setting('t02.operador'), v_alt, v_del, v_trunc, current_setting('t02.turnos'),
    (select texto_final = 'final 7.5' and texto_original = 'original 7.5' from torre.passagens_turno where id = v_id);
end $$;
rollback;

-- 7.6 Limite de chamadas à IA (esperado: operador=5 liberadas, 6a:PT429 | outro_operador=liberada | texto_grande=recusado | motorista=bloqueado | ninguem_le_ia_chamadas=bloqueado)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
set local role authenticated;
do $$
declare
  v_ok int := 0;
  v_sexta text := 'LIBERADA';
  v_grande text := 'ACEITO';
  v_le text := 'LIBERADO';
begin
  for i in 1..5 loop
    perform torre.registrar_chamada_ia(100);
    v_ok := v_ok + 1;
  end loop;
  begin
    perform torre.registrar_chamada_ia(100);
  exception when sqlstate 'PT429' then v_sexta := 'PT429';
  end;
  begin
    perform torre.registrar_chamada_ia(4001);
  exception when check_violation then v_grande := 'recusado';
  end;
  begin perform count(*) from torre.ia_chamadas; exception when insufficient_privilege then v_le := 'bloqueado'; end;
  perform set_config('t02.r', format('operador=%s liberadas, 6a:%s | texto_grande=%s | ninguem_le_ia_chamadas=%s', v_ok, v_sexta, v_grande, v_le), true);
end $$;
reset role;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated","email":"diretoria@teste.local","app_metadata":{"role":"diretoria"}}', true);
set local role authenticated;
do $$
declare
  v_outro text := 'liberada';
begin
  begin perform torre.registrar_chamada_ia(100); exception when sqlstate 'PT429' then v_outro := 'PT429'; end;
  perform set_config('t02.outro', v_outro, true);
end $$;
reset role;
select set_config('request.jwt.claims',
         '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
set local role authenticated;
do $$
declare
  v_mot text := 'LIBERADO';
  v_r text[] := string_to_array(current_setting('t02.r'), ' | ');
begin
  begin perform torre.registrar_chamada_ia(100); exception when insufficient_privilege then v_mot := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): % | outro_operador=% | % | motorista=% | %',
    v_r[1], current_setting('t02.outro'), v_r[2], v_mot, v_r[3];
end $$;
reset role;
rollback;

-- 7.7 Nada mudou no public (esperado: o mesmo retrato_public e itens do item 0)
select md5(string_agg(x, E'\n' order by x)) as retrato_public, count(*) as itens
from (
  select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
    from pg_class c where c.relnamespace = 'public'::regnamespace
  union all
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
  union all
  select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
         || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
  union all
  select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
  union all
  select 'def ' || d.defaclnamespace::text || ' ' || d.defaclobjtype::text || ' ' || d.defaclacl::text
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname in ('torre', 'rh'))
) s;

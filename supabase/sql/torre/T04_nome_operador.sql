-- =============================================================================
-- TORRE T04 - Nome do operador na passagem de turno     RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- Rode DEPOIS do T03 (usa torre.passagens_turno, torre.passagem_pendencias e
-- torre.publicar_passagem).
--
-- Todos os operadores usam o mesmo login, então autor/autor_email não dizem
-- quem escreveu. A tela pede "Seu nome" e o banco guarda junto:
--
--   1. torre.passagens_turno.operador_nome: quem publicou a passagem;
--      torre.passagem_pendencias.resolvido_nome: quem fechou a pendência
--      (o mesmo "Seu nome" de quem publica a passagem que fecha).
--      text, btrim, 2 a 80 letras. Passagens e pendências antigas ficam com
--      o nome vazio (a tela mostra "não informado"): nenhum update nelas.
--   2. Trigger novo em torre.passagens_turno (torre_15_operador_nome): publicar
--      sem nome, ou com menos de 2 letras, é recusado. Vale para a RPC e para
--      a página antiga (que grava direto com insert).
--   3. torre.publicar_passagem ganha p_operador_nome (obrigatório) e grava os
--      dois nomes. A versão antiga (6 parâmetros) é apagada: a página antiga
--      que chamar a RPC sem nome também é recusada.
--   4. torre.pendencia_fechar (do T03) grava resolvido_nome com o nome que a
--      publicar_passagem deixou na transação ('torre.operador_nome', local);
--      sem esse nome, fechar é recusado. torre.pendencia_nova zera o campo.
--   5. torre.buscar_pendencias devolve também criado_nome (o nome de quem
--      publicou a passagem em que a pendência nasceu).
--   Autor, e-mail e hora continuam vindo do servidor como hoje. Nenhum grant
--   novo de update ou delete; passagem publicada e pendência fechada
--   continuam sem mudar. O nome não vai para a IA (a edge function
--   torre-passagem-turno não muda).
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
--   d) o 7.6 repete o retrato do public: tem que dar igual ao item 0.
-- Depois: publicar o site (a tela passa a mandar o nome). Entre rodar este
-- arquivo e publicar o site, a tela antiga não consegue publicar (sem nome).
-- Obs.: depois deste arquivo as conferências 7.x do T02 e do T03 que publicam
-- não rodam mais como estão (publicar agora exige o nome), e a 8.1 do T01
-- muda de novo (coluna, função e trigger novos).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Retrato do public (rode ANTES e anote; a conferência 7.6 repete e tem que dar igual)
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
-- 1. Colunas (as linhas antigas ficam com null = "não informado")
-- -----------------------------------------------------------------------------
alter table torre.passagens_turno add column if not exists operador_nome text;
alter table torre.passagens_turno drop constraint if exists passagens_turno_operador_nome;
alter table torre.passagens_turno add constraint passagens_turno_operador_nome
  check (operador_nome is null or length(btrim(operador_nome)) between 2 and 80);

alter table torre.passagem_pendencias add column if not exists resolvido_nome text;
alter table torre.passagem_pendencias drop constraint if exists passagem_pendencias_resolvido_nome;
alter table torre.passagem_pendencias add constraint passagem_pendencias_resolvido_nome
  check (resolvido_nome is null or (status <> 'aberta' and length(btrim(resolvido_nome)) between 2 and 80));


-- -----------------------------------------------------------------------------
-- 2. Funções e triggers
-- -----------------------------------------------------------------------------

-- Passagem nova: "Seu nome" obrigatório (vale para a RPC e para quem grava direto)
create or replace function torre.passagem_operador_nome()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.operador_nome := btrim(new.operador_nome);
  if new.operador_nome is null or length(new.operador_nome) not between 2 and 80 then
    raise exception 'Preencha "Seu nome" (2 a 80 letras) antes de publicar a passagem.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists torre_15_operador_nome on torre.passagens_turno;
create trigger torre_15_operador_nome before insert on torre.passagens_turno
  for each row execute function torre.passagem_operador_nome();

-- Nova pendência: aberta, turno/data da passagem, autor e hora do servidor (igual ao T03 + resolvido_nome vazio)
create or replace function torre.pendencia_nova()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_turno text;
  v_data  date;
begin
  select p.turno, p.data into v_turno, v_data from torre.passagens_turno p where p.id = new.passagem_id;
  if v_turno is null then
    raise exception 'torre.passagem_pendencias: passagem não encontrada' using errcode = 'foreign_key_violation';
  end if;
  new.turno := v_turno;
  new.data := v_data;
  new.texto := btrim(new.texto);
  new.status := 'aberta';
  new.resolucao := null;
  new.resolvido_por := null;
  new.resolvido_email := null;
  new.resolvido_nome := null;
  new.resolvido_em := null;
  new.fechada_na_passagem := null;
  new.criado_por := auth.uid();
  new.criado_em := now();
  if new.criado_por is null then
    raise exception 'torre.passagem_pendencias: precisa de usuário autenticado' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Fechar: igual ao T03 + resolvido_nome = o "Seu nome" de quem publica a passagem que fecha
-- (a torre.publicar_passagem deixa em 'torre.operador_nome', só nesta transação)
create or replace function torre.pendencia_fechar()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'aberta' then
    raise exception 'torre.passagem_pendencias: pendência já fechada não muda' using errcode = 'insufficient_privilege';
  end if;
  if new.status not in ('resolvida', 'continua') then
    raise exception 'Feche a pendência como "Resolvida" ou "Continua".' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(new.resolucao, ''))) = 0 then
    raise exception 'Preencha "Como foi resolvido" em cada pendência herdada.' using errcode = 'check_violation';
  end if;
  if new.fechada_na_passagem is null then
    raise exception 'torre.passagem_pendencias: a pendência é fechada junto com a publicação da passagem' using errcode = 'check_violation';
  end if;
  new.resolvido_nome := btrim(coalesce(current_setting('torre.operador_nome', true), ''));
  if length(new.resolvido_nome) not between 2 and 80 then
    raise exception 'Preencha "Seu nome" (2 a 80 letras) para fechar as pendências herdadas.' using errcode = 'check_violation';
  end if;
  new.id := old.id;
  new.passagem_id := old.passagem_id;
  new.turno := old.turno;
  new.data := old.data;
  new.texto := old.texto;
  new.origem_id := old.origem_id;
  new.criado_por := old.criado_por;
  new.criado_em := old.criado_em;
  new.ordem := old.ordem;
  new.resolucao := btrim(new.resolucao);
  new.resolvido_por := auth.uid();
  new.resolvido_email := nullif((select auth.jwt()) ->> 'email', '');
  new.resolvido_em := now();
  if new.resolvido_por is null then
    raise exception 'torre.passagem_pendencias: precisa de usuário autenticado' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Publica a passagem e fecha as herdadas numa transação só (igual ao T03 + p_operador_nome).
-- p_fechamentos: [{ "id": "<pendência aberta>", "status": "resolvida" | "continua", "resolucao": "..." }]
drop function if exists torre.publicar_passagem(text, date, text, text, text, jsonb);
create or replace function torre.publicar_passagem(p_turno text, p_data date, p_texto_original text,
                                                   p_texto_ia text, p_texto_final text, p_fechamentos jsonb,
                                                   p_operador_nome text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_id        uuid := gen_random_uuid();
  v_nome      text := btrim(p_operador_nome);
  v_f         jsonb;
  v_status    text;
  v_res       text;
  v_fechadas  int := 0;
  v_continuam int := 0;
  v_novas     int := 0;
  r           record;
begin
  if not torre.eh_operador() then
    raise exception 'torre.publicar_passagem: só operador da Torre' using errcode = 'insufficient_privilege';
  end if;
  if v_nome is null or length(v_nome) not between 2 and 80 then
    raise exception 'Preencha "Seu nome" (2 a 80 letras) antes de publicar a passagem.' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_fechamentos, '[]'::jsonb)) <> 'array' then
    raise exception 'torre.publicar_passagem: fechamentos inválidos' using errcode = 'check_violation';
  end if;
  -- Uma publicação de cada vez (duas abas publicando juntas não fecham a mesma pendência)
  perform pg_advisory_xact_lock(hashtext('torre.publicar_passagem'));
  -- quem fecha as herdadas (torre.pendencia_fechar lê daqui)
  perform set_config('torre.operador_nome', v_nome, true);

  for r in select p.id, p.texto from torre.passagem_pendencias p where p.status = 'aberta' order by p.ordem loop
    select f into v_f from jsonb_array_elements(coalesce(p_fechamentos, '[]'::jsonb)) f
     where f ->> 'id' = r.id::text limit 1;
    if v_f is null then
      raise exception 'Feche cada pendência herdada antes de publicar (falta: %).', left(r.texto, 80)
        using errcode = 'check_violation';
    end if;
    v_status := v_f ->> 'status';
    v_res := btrim(coalesce(v_f ->> 'resolucao', ''));
    if v_status is null or v_status not in ('resolvida', 'continua') then
      raise exception 'Escolha "Resolvida" ou "Continua" em cada pendência herdada.' using errcode = 'check_violation';
    end if;
    if v_res = '' then
      raise exception 'Preencha "Como foi resolvido" em cada pendência herdada.' using errcode = 'check_violation';
    end if;
    update torre.passagem_pendencias set status = v_status, resolucao = v_res, fechada_na_passagem = v_id
     where id = r.id;
    v_fechadas := v_fechadas + 1;
  end loop;
  perform set_config('torre.operador_nome', '', true);

  insert into torre.passagens_turno (id, turno, data, texto_original, texto_ia, texto_final, operador_nome)
  values (v_id, p_turno, p_data, p_texto_original, p_texto_ia, p_texto_final, v_nome);

  -- "Continua": passa para esta passagem (e daí para o próximo turno)
  insert into torre.passagem_pendencias (passagem_id, texto, origem_id)
  select v_id, p.texto, p.id from torre.passagem_pendencias p
   where p.fechada_na_passagem = v_id and p.status = 'continua' order by p.ordem;
  get diagnostics v_continuam = row_count;

  -- Itens do texto (o que já continua com o mesmo texto não é repetido)
  insert into torre.passagem_pendencias (passagem_id, texto)
  select v_id, i.item from (select item, ordinality from torre.itens_pendencias(p_texto_final) with ordinality as t(item, ordinality)) i
   where not exists (select 1 from torre.passagem_pendencias c
                      where c.passagem_id = v_id and lower(btrim(c.texto)) = lower(btrim(i.item)))
   order by i.ordinality;
  get diagnostics v_novas = row_count;

  return jsonb_build_object('id', v_id, 'fechadas', v_fechadas, 'continuam', v_continuam, 'novas', v_novas);
end $$;

-- Histórico de pendências: igual ao T03 + criado_nome (quem publicou a passagem da pendência);
-- resolvido_nome já vem na linha
create or replace function torre.buscar_pendencias(p_texto text, p_turno text, p_data date, p_status text)
returns setof jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(p) || jsonb_build_object(
           'criado_nome', c.operador_nome,
           'origem_turno', o.turno, 'origem_data', o.data,
           'fechada_turno', f.turno, 'fechada_data', f.data)
    from torre.passagem_pendencias p
    left join torre.passagens_turno c on c.id = p.passagem_id
    left join torre.passagens_turno f on f.id = p.fechada_na_passagem
    left join torre.passagem_pendencias po on po.id = p.origem_id
    left join torre.passagens_turno o on o.id = po.passagem_id
   where (coalesce(btrim(p_texto), '') = ''
          or p.texto ilike '%' || replace(replace(replace(btrim(p_texto), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          or p.resolucao ilike '%' || replace(replace(replace(btrim(p_texto), '\', '\\'), '%', '\%'), '_', '\_') || '%')
     and (coalesce(p_turno, '') = '' or p.turno = p_turno)
     and (p_data is null or p.data = p_data)
     and (coalesce(p_status, '') = '' or p.status = p_status)
   order by p.ordem desc
   limit 200;
$$;


-- -----------------------------------------------------------------------------
-- 3. Permissões (nada novo de update/delete; anon, public e service_role: nada)
-- -----------------------------------------------------------------------------
-- operador_nome entra pelo grant de insert da tabela (T02); resolvido_nome só pelo trigger
revoke all on function torre.passagem_operador_nome(), torre.pendencia_nova(), torre.pendencia_fechar(),
                       torre.publicar_passagem(text, date, text, text, text, jsonb, text),
                       torre.buscar_pendencias(text, text, date, text)
  from public, anon, authenticated, service_role;
grant execute on function torre.publicar_passagem(text, date, text, text, text, jsonb, text),
                          torre.buscar_pendencias(text, text, date, text)
  to authenticated;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
--    Se já houver pendência aberta de verdade no banco, elas são fechadas só
--    dentro da transação (desfeito no rollback) para poder publicar.
-- =============================================================================

-- 7.1 Estrutura e permissões (esperado: colunas=passagem_pendencias.resolvido_nome:text passagens_turno.operador_nome:text | gatilho_nome=ligado | publicar_6_parametros=apagada | publicar=authenticated:t anon:f service_role:f definer:f config=search_path="" | colunas_update_pendencias=fechada_na_passagem,resolucao,status | update_passagens=nenhum | delete_ou_truncate=0 | gatilhos_para_alguem=0 | policies_delete=0)
do $$
begin
  raise exception 'RESULTADO: colunas=% | gatilho_nome=% | publicar_6_parametros=% | publicar=authenticated:% anon:% service_role:% definer:% config=% | colunas_update_pendencias=% | update_passagens=% | delete_ou_truncate=% | gatilhos_para_alguem=% | policies_delete=%',
    (select string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod), ' ' order by c.relname)
       from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'torre'::regnamespace and a.attname in ('operador_nome', 'resolvido_nome') and not a.attisdropped),
    (select case when t.tgenabled = 'O' then 'ligado' else 'DESLIGADO' end from pg_trigger t
      where t.tgrelid = 'torre.passagens_turno'::regclass and t.tgname = 'torre_15_operador_nome'),
    (select case when count(*) = 0 then 'apagada' else 'AINDA EXISTE' end from pg_proc p
      where p.pronamespace = 'torre'::regnamespace and p.proname = 'publicar_passagem' and p.pronargs = 6),
    has_function_privilege('authenticated', 'torre.publicar_passagem(text, date, text, text, text, jsonb, text)', 'execute'),
    has_function_privilege('anon', 'torre.publicar_passagem(text, date, text, text, text, jsonb, text)', 'execute'),
    has_function_privilege('service_role', 'torre.publicar_passagem(text, date, text, text, text, jsonb, text)', 'execute'),
    (select p.prosecdef from pg_proc p where p.oid = 'torre.publicar_passagem(text, date, text, text, text, jsonb, text)'::regprocedure),
    (select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'torre.publicar_passagem(text, date, text, text, text, jsonb, text)'::regprocedure),
    (select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
      where a.attrelid = 'torre.passagem_pendencias'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('authenticated', 'torre.passagem_pendencias', a.attname, 'update')),
    (select coalesce(string_agg(a.attname, ','), 'nenhum') from pg_attribute a
      where a.attrelid = 'torre.passagens_turno'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('authenticated', 'torre.passagens_turno', a.attname, 'update')),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner),
    (select count(*) from pg_proc p
      where p.oid in ('torre.passagem_operador_nome()'::regprocedure, 'torre.pendencia_nova()'::regprocedure,
                      'torre.pendencia_fechar()'::regprocedure)
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
    (select count(*) from pg_policies where schemaname = 'torre' and cmd in ('DELETE', 'ALL'));
end $$;

-- 7.2 Publica com nome; o nome fica na passagem e na pendência fechada (esperado: publicou=t | nome_passagem=Maria Souza | nome_de_quem_fechou=João da Silva | continua_nome=João da Silva | nova_aberta_sem_nome=t | email_e_autor_do_servidor=t | historico=criou:Maria Souza resolveu:João da Silva)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
select set_config('torre.operador_nome', 'Conferência 7.2', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.2',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
select set_config('torre.operador_nome', '', true);
set local role authenticated;
do $$
declare
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_l uuid;
begin
  v_a := (torre.publicar_passagem('T1', current_date, 'turno 1', null,
           E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos do CD Cajamar\n- Ligar para a transportadora às 08:00', '[]',
           '  Maria Souza  ') ->> 'id')::uuid;
  select id into v_c from torre.passagem_pendencias where passagem_id = v_a and texto like 'Conferir%';
  select id into v_l from torre.passagem_pendencias where passagem_id = v_a and texto like 'Ligar%';
  v_b := (torre.publicar_passagem('T2', current_date, 'turno 2', null, E'AVISOS\n- ok',
           jsonb_build_array(jsonb_build_object('id', v_c, 'status', 'resolvida', 'resolucao', 'Canhotos conferidos.'),
                             jsonb_build_object('id', v_l, 'status', 'continua', 'resolucao', 'Ninguém atendeu.')),
           'João da Silva') ->> 'id')::uuid;
  raise exception 'RESULTADO (nada foi salvo): publicou=% | nome_passagem=% | nome_de_quem_fechou=% | continua_nome=% | nova_aberta_sem_nome=% | email_e_autor_do_servidor=% | historico=%',
    (v_a is not null and v_b is not null),
    (select operador_nome from torre.passagens_turno where id = v_a),
    (select resolvido_nome from torre.passagem_pendencias where id = v_c and fechada_na_passagem = v_b),
    (select resolvido_nome from torre.passagem_pendencias where id = v_l and status = 'continua'),
    (select bool_and(resolvido_nome is null and status = 'aberta') from torre.passagem_pendencias where passagem_id = v_b),
    (select bool_and(p.autor = '00000000-0000-0000-0000-0000000000c3' and p.autor_email = 'admin@teste.local')
       and (select resolvido_email = 'admin@teste.local' and resolvido_por = '00000000-0000-0000-0000-0000000000c3'
              from torre.passagem_pendencias where id = v_c)
       from torre.passagens_turno p where p.id in (v_a, v_b)),
    (select 'criou:' || (j ->> 'criado_nome') || ' resolveu:' || (j ->> 'resolvido_nome')
       from torre.buscar_pendencias('canhotos do CD Cajamar', null, null, 'resolvida') j where (j ->> 'id')::uuid = v_c);
end $$;
reset role;
rollback;

-- 7.3 Recusa sem nome, inclusive pela página antiga (esperado: sem_nome=recusado | vazio=recusado | so_espacos=recusado | uma_letra=recusado | 81_letras=recusado | pagina_antiga_insert_direto=recusado | pagina_antiga_rpc_sem_nome=recusado | fechar_sem_nome=recusado | duas_letras=aceito | oitenta_letras=aceito | passagens_novas=2)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
select set_config('torre.operador_nome', 'Conferência 7.3', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.3',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
select set_config('torre.operador_nome', '', true);
select set_config('t04.antes', (select count(*)::text from torre.passagens_turno), true);
set local role authenticated;
do $$
declare
  v_sem    text := 'ACEITO';
  v_vazio  text := 'ACEITO';
  v_esp    text := 'ACEITO';
  v_uma    text := 'ACEITO';
  v_longo  text := 'ACEITO';
  v_direto text := 'ACEITO';
  v_rpc6   text := 'ACEITO';
  v_fechar text := 'ACEITO';
  v_duas   text := 'recusado';
  v_oitenta text := 'recusado';
  v_a      uuid;
  v_p      uuid;
begin
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, E'AVISOS\n- ok', '[]', null);
  exception when check_violation then v_sem := 'recusado'; end;
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, E'AVISOS\n- ok', '[]', '');
  exception when check_violation then v_vazio := 'recusado'; end;
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, E'AVISOS\n- ok', '[]', '    ');
  exception when check_violation then v_esp := 'recusado'; end;
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, E'AVISOS\n- ok', '[]', ' A ');
  exception when check_violation then v_uma := 'recusado'; end;
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, E'AVISOS\n- ok', '[]', repeat('a', 81));
  exception when check_violation then v_longo := 'recusado'; end;
  -- página antiga: grava direto na tabela, sem nome
  begin insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T1', 'página antiga', 'página antiga');
  exception when check_violation then v_direto := 'recusado'; end;
  -- página antiga: chama a RPC com os 6 parâmetros do T03 (sem nome)
  begin execute 'select torre.publicar_passagem($1, $2, $3, $4, $5, $6)' using 'T1', current_date, 'x', null::text, 'x', '[]'::jsonb;
  exception when undefined_function then v_rpc6 := 'recusado'; end;
  -- fechar pendência sem o nome de quem fecha (direto, fora da RPC)
  v_a := (torre.publicar_passagem('T1', current_date, 'x', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Item da 7.3', '[]', 'Ze') ->> 'id')::uuid;
  v_duas := 'aceito';
  select id into v_p from torre.passagem_pendencias where passagem_id = v_a;
  begin update torre.passagem_pendencias set status = 'resolvida', resolucao = 'x', fechada_na_passagem = v_a where id = v_p;
  exception when check_violation then v_fechar := 'recusado'; end;
  perform torre.publicar_passagem('T2', current_date, 'x', null, E'AVISOS\n- ok',
    jsonb_build_array(jsonb_build_object('id', v_p, 'status', 'resolvida', 'resolucao', 'ok')), repeat('b', 80));
  v_oitenta := 'aceito';
  raise exception 'RESULTADO (nada foi salvo): sem_nome=% | vazio=% | so_espacos=% | uma_letra=% | 81_letras=% | pagina_antiga_insert_direto=% | pagina_antiga_rpc_sem_nome=% | fechar_sem_nome=% | duas_letras=% | oitenta_letras=% | passagens_novas=%',
    v_sem, v_vazio, v_esp, v_uma, v_longo, v_direto, v_rpc6, v_fechar, v_duas, v_oitenta,
    (select count(*) from torre.passagens_turno) - current_setting('t04.antes')::int;
end $$;
reset role;
rollback;

-- 7.4 Passagem publicada e pendência fechada continuam sem mudar (esperado: operador=mudar_nome:bloqueado apagar:bloqueado mudar_nome_resolvido:bloqueado | dono=mudar_nome:bloqueado mudar_nome_resolvido:bloqueado | intactas=t)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
select set_config('torre.operador_nome', 'Conferência 7.4', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.4',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
select set_config('torre.operador_nome', '', true);
set local role authenticated;
do $$
declare
  v_a      uuid;
  v_p      uuid;
  v_mudar  text := 'LIBERADO';
  v_apagar text := 'LIBERADO';
  v_res    text := 'LIBERADO';
begin
  v_a := (torre.publicar_passagem('T1', current_date, 'x', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Item da 7.4', '[]', 'Maria Souza') ->> 'id')::uuid;
  select id into v_p from torre.passagem_pendencias where passagem_id = v_a;
  perform torre.publicar_passagem('T2', current_date, 'x', null, E'AVISOS\n- ok',
    jsonb_build_array(jsonb_build_object('id', v_p, 'status', 'resolvida', 'resolucao', 'ok')), 'João da Silva');
  begin update torre.passagens_turno set operador_nome = 'Outro' where id = v_a; exception when insufficient_privilege then v_mudar := 'bloqueado'; end;
  begin delete from torre.passagens_turno where id = v_a; exception when insufficient_privilege then v_apagar := 'bloqueado'; end;
  begin update torre.passagem_pendencias set resolvido_nome = 'Outro' where id = v_p; exception when insufficient_privilege then v_res := 'bloqueado'; end;
  perform set_config('t04.a', v_a::text, true);
  perform set_config('t04.p', v_p::text, true);
  perform set_config('t04.operador', format('operador=mudar_nome:%s apagar:%s mudar_nome_resolvido:%s', v_mudar, v_apagar, v_res), true);
end $$;
reset role;
do $$
declare
  v_a     uuid := current_setting('t04.a')::uuid;
  v_p     uuid := current_setting('t04.p')::uuid;
  v_mudar text := 'LIBERADO';
  v_res   text := 'LIBERADO';
begin
  begin update torre.passagens_turno set operador_nome = 'Dono mudou' where id = v_a; exception when insufficient_privilege then v_mudar := 'bloqueado'; end;
  perform set_config('torre.operador_nome', 'Dono mudou', true);
  begin update torre.passagem_pendencias set resolvido_nome = 'Dono mudou' where id = v_p; exception when insufficient_privilege then v_res := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): % | dono=mudar_nome:% mudar_nome_resolvido:% | intactas=%',
    current_setting('t04.operador'), v_mudar, v_res,
    (select operador_nome = 'Maria Souza' from torre.passagens_turno where id = v_a)
      and (select resolvido_nome = 'João da Silva' and status = 'resolvida' from torre.passagem_pendencias where id = v_p);
end $$;
rollback;

-- 7.5 Anon e motorista não leem nem publicam (esperado: anon=publicar:bloqueado ler:bloqueado | motorista=publicar:bloqueado passagens_vistas:0 pendencias_vistas:0 historico:0)
begin;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
declare
  v_pub text := 'LIBERADO';
  v_le  text := 'LIBERADO';
begin
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, 'x', '[]', 'Anônimo'); exception when insufficient_privilege then v_pub := 'bloqueado'; end;
  begin perform count(*) from torre.passagens_turno; exception when insufficient_privilege then v_le := 'bloqueado'; end;
  perform set_config('t04.anon', format('anon=publicar:%s ler:%s', v_pub, v_le), true);
end $$;
reset role;
select set_config('request.jwt.claims',
         '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
set local role authenticated;
do $$
declare
  v_pub text := 'LIBERADO';
begin
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, 'x', '[]', 'Motorista'); exception when insufficient_privilege then v_pub := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): % | motorista=publicar:% passagens_vistas:% pendencias_vistas:% historico:%',
    current_setting('t04.anon'), v_pub, (select count(*) from torre.passagens_turno), (select count(*) from torre.passagem_pendencias),
    (select count(*) from torre.buscar_pendencias(null, null, null, null));
end $$;
reset role;
rollback;

-- 7.6 Nada mudou no public (esperado: o mesmo retrato_public e itens do item 0)
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

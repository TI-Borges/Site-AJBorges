-- =============================================================================
-- PASSO 25 - Cadastro único por CPF do motorista e CNPJ (PJ)     RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- Regra: o CPF do motorista só pode ter UM cadastro ativo, em qualquer tipo
-- (PF ou PJ: um PF bloqueia um PJ com o mesmo CPF de motorista, e vice-versa);
-- e, na PJ, o CNPJ também só pode ter UM cadastro PJ ativo. Ativo = qualquer
-- situação que não seja 'recusado'. Depois que a gestão recusa o anterior, pode
-- enviar de novo.
--
-- Onde ficam os números (gravados pela edge function solicitar-cadastro):
--   CPF do motorista: coluna cpf (só números, PF e PJ);
--   CNPJ: dados ->> 'cnpj' (só na PJ, como foi digitado, com máscara).
-- A comparação usa só os dígitos (sem pontos, barra e traço).
--
--   1. Função public.cadastro_agregado_unico() + trigger trg_cadastro_agregado_unico,
--      BEFORE INSERT: recusa o cadastro NOVO quando já existe outro ativo com o
--      mesmo CPF (qualquer tipo) ou, na PJ, o mesmo CNPJ. Erro 23505
--      (unique_violation) com a mensagem 'cadastro_duplicado: ... CPF' ou '... CNPJ',
--      que a edge function troca pela mensagem da ficha. Um lock por documento
--      (pg_advisory_xact_lock, sempre CPF antes de CNPJ) impede que dois envios ao
--      mesmo tempo passem juntos.
--   2. Só INSERT: nenhum update, delete ou índice único. Os cadastros que já
--      existem, inclusive os duplicados de hoje, ficam exatamente como estão (o
--      Dashboard do Cadastro mostra o selo "CPF repetido" / "CNPJ repetido" para a
--      gestão recusar os extras manualmente).
--
-- Como rodar (SQL Editor do Supabase):
--   a) rode o item 0 sozinho e anote o resultado (retrato do public, contagem de
--      cadastros e de arquivos);
--   b) itens 0.1 e 0.2: só leitura (gatilhos que já existem e contagem de repetidos);
--   c) rode do "begin;" até o "commit;" (se algo falhar, nada é alterado; pode ser
--      reexecutado);
--   d) rode cada conferência do item 7 separadamente (tudo é desfeito com
--      rollback; o resultado aparece como erro "RESULTADO ...");
--   e) o 7.6 repete o item 0: tem que dar igual. (Se alguém enviar uma ficha ou a
--      gestão mexer num cadastro entre o 0 e o 7.6, cadastros/md5 mudam por isso:
--      rode num horário calmo.)
-- Depois: republicar a edge function solicitar-cadastro e publicar o site.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. ANTES (só leitura): retrato do public, cadastros e arquivos do bucket
--    (anote; o 7.6 repete e tem que dar igual. O retrato deixa de fora só a
--     função e o trigger que este passo cria)
-- -----------------------------------------------------------------------------
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          union all
          select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
                 || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'cadastro_agregado_unico'
          union all
          select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname = 'public'
          union all
          select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> 'trg_cadastro_agregado_unico'
          union all
          select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
        ) s) as retrato_public,
       (select count(*) from public.cadastros_agregados) as cadastros,
       (select md5(coalesce(string_agg(c::text, E'\n' order by c.id), '')) from public.cadastros_agregados c) as md5_cadastros,
       (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro') as arquivos,
       (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
          from storage.objects o where o.bucket_id = 'documentos-cadastro') as md5_arquivos;


-- -----------------------------------------------------------------------------
-- 0.1 Só leitura: gatilhos que já existem em cadastros_agregados
--     (as conferências do item 7 gravam cadastros de teste e desfazem; se aparecer
--      algum gatilho que chame net.http_post / supabase_functions.http_request
--      (webhook), me mande o resultado antes de rodar o item 7)
-- -----------------------------------------------------------------------------
select tgname as gatilho, pg_get_triggerdef(oid) as definicao
  from pg_trigger
 where tgrelid = 'public.cadastros_agregados'::regclass and not tgisinternal
 order by tgname;


-- -----------------------------------------------------------------------------
-- 0.2 Só leitura: CPFs/CNPJs repetidos hoje, por situação (sem nomes nem números)
--     CPF = CPF do motorista em qualquer tipo (PF e PJ); CNPJ = só entre PJ.
--     (uma PJ conta nas duas listas)
--     cadastros = quantos cadastros estão num grupo repetido;
--     documentos = quantos CPFs/CNPJs diferentes estão repetidos.
--     "ativos" conta só os grupos com 2 ou mais cadastros não recusados (os que o
--     dashboard marca); "contando recusados" conta qualquer repetição.
-- -----------------------------------------------------------------------------
with base as (
  select 'CPF' as documento,
         coalesce(status, '(sem situação)') as situacao,
         coalesce(status, '') <> 'recusado' as ativo,
         regexp_replace(coalesce(cpf, ''), '\D', '', 'g') as chave
    from public.cadastros_agregados
  union all
  select 'CNPJ',
         coalesce(status, '(sem situação)'),
         coalesce(status, '') <> 'recusado',
         regexp_replace(coalesce(dados ->> 'cnpj', ''), '\D', '', 'g')
    from public.cadastros_agregados
   where tipo = 'pj'
),
rep_ativos as (
  select documento, chave from base where ativo and chave <> '' group by 1, 2 having count(*) > 1
),
rep_todos as (
  select documento, chave from base where chave <> '' group by 1, 2 having count(*) > 1
)
select 'ativos' as grupo, b.documento, b.situacao, count(*) as cadastros, count(distinct b.chave) as documentos
  from base b join rep_ativos r using (documento, chave)
 where b.ativo
 group by 1, 2, 3
union all
select 'contando recusados', b.documento, b.situacao, count(*), count(distinct b.chave)
  from base b join rep_todos r using (documento, chave)
 group by 1, 2, 3
union all
select 'sem número', documento, situacao, count(*), 0
  from base where chave = ''
 group by 1, 2, 3
 order by 1, 2, 3;


begin;


-- -----------------------------------------------------------------------------
-- 1. Função do trigger: recusa um cadastro NOVO quando já existe outro ativo
--    com o mesmo CPF de motorista (PF ou PJ) ou, na PJ, o mesmo CNPJ,
--    comparando só os dígitos
-- -----------------------------------------------------------------------------
create or replace function public.cadastro_agregado_unico()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cpf  text;
  v_cnpj text;
begin
  -- Cadastro já gravado como recusado não ocupa a vaga
  if coalesce(new.status, '') = 'recusado' then
    return new;
  end if;

  v_cpf := regexp_replace(coalesce(new.cpf, ''), '\D', '', 'g');
  v_cnpj := case when new.tipo = 'pj' then regexp_replace(coalesce(new.dados ->> 'cnpj', ''), '\D', '', 'g') else '' end;

  -- Dois envios do mesmo documento ao mesmo tempo: o segundo espera o primeiro terminar
  -- (sempre CPF antes de CNPJ, para dois envios nunca ficarem esperando um pelo outro)
  if v_cpf <> '' then
    perform pg_advisory_xact_lock(hashtextextended('cadastro_unico:cpf:' || v_cpf, 0));
  end if;
  if v_cnpj <> '' then
    perform pg_advisory_xact_lock(hashtextextended('cadastro_unico:cnpj:' || v_cnpj, 0));
  end if;

  -- Não diz qual cadastro nem a situação dele: a edge function devolve a mensagem da ficha
  if v_cpf <> '' and exists (
    select 1
      from public.cadastros_agregados c
     where c.id is distinct from new.id
       and coalesce(c.status, '') <> 'recusado'
       and regexp_replace(coalesce(c.cpf, ''), '\D', '', 'g') = v_cpf
  ) then
    raise exception 'cadastro_duplicado: já existe um cadastro ativo com este CPF'
      using errcode = 'unique_violation';
  end if;

  if v_cnpj <> '' and exists (
    select 1
      from public.cadastros_agregados c
     where c.id is distinct from new.id
       and coalesce(c.status, '') <> 'recusado'
       and c.tipo = 'pj'
       and regexp_replace(coalesce(c.dados ->> 'cnpj', ''), '\D', '', 'g') = v_cnpj
  ) then
    raise exception 'cadastro_duplicado: já existe um cadastro ativo com este CNPJ'
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. Trigger só no INSERT: os cadastros que já existem não são tocados
-- -----------------------------------------------------------------------------
drop trigger if exists trg_cadastro_agregado_unico on public.cadastros_agregados;
create trigger trg_cadastro_agregado_unico
  before insert on public.cadastros_agregados
  for each row execute function public.cadastro_agregado_unico();


-- -----------------------------------------------------------------------------
-- 3. Permissões: ninguém chama a função direto (só o trigger)
-- -----------------------------------------------------------------------------
revoke all on function public.cadastro_agregado_unico() from public, anon, authenticated, service_role;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
--    Os cadastros de teste usam números que a ficha não aceita (999.999.999-99 e
--    99.999.999/9999-99), então não batem com nenhum cadastro de verdade.
-- =============================================================================

-- 7.1 Estrutura e permissões (esperado: trigger=ligado | quando=before insert | definer=t | config=search_path="" | executar=anon:f authenticated:f | indices_unicos_novos=0 | apaga_ou_altera=0)
do $$
begin
  raise exception 'RESULTADO: trigger=% | quando=% | definer=% | config=% | executar=anon:% authenticated:% | indices_unicos_novos=% | apaga_ou_altera=%',
    (select case when t.tgenabled = 'O' then 'ligado' else 'DESLIGADO' end from pg_trigger t
      where t.tgrelid = 'public.cadastros_agregados'::regclass and t.tgname = 'trg_cadastro_agregado_unico'),
    -- tgtype: 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE
    (select case when t.tgtype & 2 = 2 then 'before' else 'after' end
            || case when t.tgtype & 4 = 4 then ' insert' else '' end
            || case when t.tgtype & 8 = 8 then ' delete' else '' end
            || case when t.tgtype & 16 = 16 then ' update' else '' end
            || case when t.tgtype & 32 = 32 then ' truncate' else '' end
       from pg_trigger t
      where t.tgrelid = 'public.cadastros_agregados'::regclass and t.tgname = 'trg_cadastro_agregado_unico'),
    (select p.prosecdef from pg_proc p where p.oid = 'public.cadastro_agregado_unico()'::regprocedure),
    (select array_to_string(p.proconfig, ',') from pg_proc p where p.oid = 'public.cadastro_agregado_unico()'::regprocedure),
    has_function_privilege('anon', 'public.cadastro_agregado_unico()', 'execute'),
    has_function_privilege('authenticated', 'public.cadastro_agregado_unico()', 'execute'),
    (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
      where i.indrelid = 'public.cadastros_agregados'::regclass and i.indisunique and not i.indisprimary
        and pg_get_indexdef(i.indexrelid) ~* '(cpf|cnpj)'),
    (select count(*) from pg_proc p
      where p.oid = 'public.cadastro_agregado_unico()'::regprocedure
        and p.prosrc ~* '\m(update|delete|truncate)\M');
end $$;

-- 7.2 CPF (esperado: cpf_de_teste_livre=t | primeiro=aceito | segundo_igual=recusado | segundo_com_pontos=recusado | mensagem=cadastro_duplicado: já existe um cadastro ativo com este CPF | mensagem_sem_dados=t | depois_de_recusar=aceito | de_novo_com_o_novo_ativo=recusado | gravado_como_recusado=aceito)
begin;
do $$
declare
  v_livre   boolean;
  v_a       uuid;
  v_primeiro text := 'RECUSADO';
  v_igual   text := 'ACEITO';
  v_pontos  text := 'ACEITO';
  v_depois  text := 'RECUSADO';
  v_denovo  text := 'ACEITO';
  v_recus   text := 'RECUSADO';
  v_msg     text;
begin
  select not exists (select 1 from public.cadastros_agregados
                      where regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = '99999999999') into v_livre;

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Fulano de Teste P25', '99999999999', null, '11900000000', true,
          '{"motorista-nome": "Fulano", "motorista-sobrenome": "de Teste P25", "cpf": "99999999999"}')
  returning id into v_a;
  v_primeiro := 'aceito';

  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P25 (2)', '99999999999', null, '11900000000', true, '{}');
  exception when unique_violation then
    v_igual := 'recusado';
    get stacked diagnostics v_msg = message_text;
  end;

  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P25 (3)', '999.999.999-99', null, '11900000000', true, '{}');
  exception when unique_violation then v_pontos := 'recusado';
  end;

  -- A gestão recusa o primeiro: a pessoa pode enviar de novo (e o novo passa a ocupar a vaga)
  update public.cadastros_agregados set status = 'recusado' where id = v_a;
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Fulano de Teste P25 (4)', '999.999.999-99', null, '11900000000', true, '{}');
  v_depois := 'aceito';

  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'analise', 'Fulano de Teste P25 (5)', '99999999999', null, '11900000000', true, '{}');
  exception when unique_violation then v_denovo := 'recusado';
  end;

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'recusado', 'Fulano de Teste P25 (6)', '99999999999', null, '11900000000', true, '{}');
  v_recus := 'aceito';

  raise exception 'RESULTADO (nada foi salvo): cpf_de_teste_livre=% | primeiro=% | segundo_igual=% | segundo_com_pontos=% | mensagem=% | mensagem_sem_dados=% | depois_de_recusar=% | de_novo_com_o_novo_ativo=% | gravado_como_recusado=%',
    v_livre, v_primeiro, v_igual, v_pontos, v_msg,
    (v_msg !~ '9{3}' and v_msg !~* '(fulano|teste|pendente|analise|aprovado)'),
    v_depois, v_denovo, v_recus;
end $$;
rollback;

-- 7.3 CNPJ e CPF do motorista em qualquer tipo (esperado: numeros_de_teste_livres=t | primeiro_pj=aceito | mesmo_cnpj_sem_pontos=recusado | mesmo_cnpj_com_pontos=recusado | mensagem_cnpj=cadastro_duplicado: já existe um cadastro ativo com este CNPJ | outro_cnpj_mesmo_motorista=recusado | mensagem_cpf=cadastro_duplicado: já existe um cadastro ativo com este CPF | pf_com_cpf_do_motorista_da_pj=recusado | pj_com_cpf_de_um_pf=recusado | pj_novo_cpf_e_cnpj_novos=aceito | depois_de_recusar=aceito)
begin;
do $$
declare
  v_livre    boolean;
  v_a        uuid;
  v_primeiro text := 'RECUSADO';
  v_sem      text := 'ACEITO';
  v_com      text := 'ACEITO';
  v_outro    text := 'ACEITO';
  v_pf       text := 'ACEITO';
  v_pjdopf   text := 'ACEITO';
  v_novo     text := 'RECUSADO';
  v_depois   text := 'RECUSADO';
  v_msg_cnpj text;
  v_msg_cpf  text;
begin
  select not exists (select 1 from public.cadastros_agregados
                      where regexp_replace(coalesce(dados ->> 'cnpj', ''), '\D', '', 'g') in ('99999999999999', '99999999999998', '99999999999997')
                         or regexp_replace(coalesce(cpf, ''), '\D', '', 'g') in ('99999999999', '99999999998', '99999999997', '99999999996', '99999999995'))
    into v_livre;

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pj', 'pendente', 'Fulano de Teste P25', '99999999999', null, '11900000000', true,
          '{"nome-empresa": "Empresa de Teste P25", "cnpj": "99.999.999/9999-99"}')
  returning id into v_a;
  v_primeiro := 'aceito';

  -- Mesmo CNPJ com outro motorista
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pj', 'pendente', 'Ciclano de Teste P25', '99999999998', null, '11900000000', true,
            '{"cnpj": "99999999999999"}');
  exception when unique_violation then
    v_sem := 'recusado';
    get stacked diagnostics v_msg_cnpj = message_text;
  end;

  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pj', 'aprovado', 'Ciclano de Teste P25', '99999999997', null, '11900000000', true,
            '{"cnpj": " 99 999 999 / 9999 - 99 "}');
  exception when unique_violation then v_com := 'recusado';
  end;

  -- Outra empresa com o mesmo motorista: o CPF do motorista já está num cadastro ativo
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pj', 'pendente', 'Fulano de Teste P25', '999.999.999-99', null, '11900000000', true,
            '{"cnpj": "99.999.999/9999-98"}');
  exception when unique_violation then
    v_outro := 'recusado';
    get stacked diagnostics v_msg_cpf = message_text;
  end;

  -- O motorista da PJ tentando um cadastro PF
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P25', '99999999999', null, '11900000000', true, '{}');
  exception when unique_violation then v_pf := 'recusado';
  end;

  -- Um PF ativo bloqueia um PJ com o mesmo CPF de motorista
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Beltrano de Teste P25', '99999999996', null, '11900000000', true, '{}');
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pj', 'pendente', 'Beltrano de Teste P25', '999.999.999-96', null, '11900000000', true,
            '{"cnpj": "99.999.999/9999-97"}');
  exception when unique_violation then v_pjdopf := 'recusado';
  end;

  -- CPF e CNPJ novos passam
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pj', 'pendente', 'Sicrano de Teste P25', '99999999995', null, '11900000000', true,
          '{"cnpj": "99.999.999/9999-98"}');
  v_novo := 'aceito';

  -- A gestão recusa a primeira PJ: o mesmo motorista e o mesmo CNPJ podem enviar de novo
  update public.cadastros_agregados set status = 'recusado' where id = v_a;
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pj', 'pendente', 'Fulano de Teste P25', '99999999999', null, '11900000000', true,
          '{"cnpj": "99999999999999"}');
  v_depois := 'aceito';

  raise exception 'RESULTADO (nada foi salvo): numeros_de_teste_livres=% | primeiro_pj=% | mesmo_cnpj_sem_pontos=% | mesmo_cnpj_com_pontos=% | mensagem_cnpj=% | outro_cnpj_mesmo_motorista=% | mensagem_cpf=% | pf_com_cpf_do_motorista_da_pj=% | pj_com_cpf_de_um_pf=% | pj_novo_cpf_e_cnpj_novos=% | depois_de_recusar=%',
    v_livre, v_primeiro, v_sem, v_com, v_msg_cnpj, v_outro, v_msg_cpf, v_pf, v_pjdopf, v_novo, v_depois;
end $$;
rollback;

-- 7.4 Os existentes não mudam e nenhum arquivo é criado ou apagado (esperado: cadastros_antes=N | cadastros_depois=N | existentes_iguais=t | arquivos_antes=M | arquivos_depois=M | arquivos_iguais=t | testes_gravados_na_transacao=2)
begin;
do $$
declare
  v_cad_antes  bigint;
  v_cad_md5    text;
  v_arq_antes  bigint;
  v_arq_md5    text;
  v_ids        uuid[] := '{}';
  v_id         uuid;
begin
  select count(*), md5(coalesce(string_agg(c::text, E'\n' order by c.id), '')) into v_cad_antes, v_cad_md5
    from public.cadastros_agregados c;
  select count(*), md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), '')) into v_arq_antes, v_arq_md5
    from storage.objects o where o.bucket_id = 'documentos-cadastro';

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Fulano de Teste P25', '99999999999', null, '11900000000', true, '{}')
  returning id into v_id;
  v_ids := v_ids || v_id;
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pf', 'pendente', 'Fulano de Teste P25', '999.999.999-99', null, '11900000000', true, '{}');
  exception when unique_violation then null;
  end;
  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pj', 'pendente', 'Ciclano de Teste P25', '99999999998', null, '11900000000', true, '{"cnpj": "99.999.999/9999-99"}')
  returning id into v_id;
  v_ids := v_ids || v_id;
  begin
    insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
    values (null, 'pj', 'pendente', 'Sicrano de Teste P25', '99999999997', null, '11900000000', true, '{"cnpj": "99999999999999"}');
  exception when unique_violation then null;
  end;

  raise exception 'RESULTADO (nada foi salvo): cadastros_antes=% | cadastros_depois=% | existentes_iguais=% | arquivos_antes=% | arquivos_depois=% | arquivos_iguais=% | testes_gravados_na_transacao=%',
    v_cad_antes,
    (select count(*) from public.cadastros_agregados where id <> all (v_ids)),
    (select md5(coalesce(string_agg(c::text, E'\n' order by c.id), '')) from public.cadastros_agregados c where c.id <> all (v_ids)) = v_cad_md5,
    v_arq_antes,
    (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro'),
    (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
       from storage.objects o where o.bucket_id = 'documentos-cadastro') = v_arq_md5,
    (select count(*) from public.cadastros_agregados where id = any (v_ids));
end $$;
rollback;

-- 7.5 Duplicados que já existem continuam lá, sem mudança (só leitura; esperado: os mesmos números do item 0.2, grupo "ativos")
with base as (
  select 'CPF' as documento, coalesce(status, '(sem situação)') as situacao,
         regexp_replace(coalesce(cpf, ''), '\D', '', 'g') as chave
    from public.cadastros_agregados
   where coalesce(status, '') <> 'recusado'
  union all
  select 'CNPJ', coalesce(status, '(sem situação)'),
         regexp_replace(coalesce(dados ->> 'cnpj', ''), '\D', '', 'g')
    from public.cadastros_agregados
   where tipo = 'pj' and coalesce(status, '') <> 'recusado'
),
rep as (
  select documento, chave from base where chave <> '' group by 1, 2 having count(*) > 1
)
select 'ativos' as grupo, b.documento, b.situacao, count(*) as cadastros, count(distinct b.chave) as documentos
  from base b join rep r using (documento, chave)
 group by 1, 2, 3
 order by 1, 2, 3;

-- 7.6 DEPOIS (só leitura): o mesmo do item 0 (esperado: retrato_public, cadastros, md5_cadastros, arquivos e md5_arquivos iguais ao item 0)
select (select md5(string_agg(x, E'\n' order by x)) from (
          select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
            from pg_class c where c.relnamespace = 'public'::regnamespace
          union all
          select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
            from pg_attribute a join pg_class c on c.oid = a.attrelid
           where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          union all
          select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '') || ' '
                 || p.prosecdef || ' ' || coalesce(array_to_string(p.proconfig, ','), '')
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'cadastro_agregado_unico'
          union all
          select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
                 || coalesce(qual, '') || ' ' || coalesce(with_check, '')
            from pg_policies where schemaname = 'public'
          union all
          select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
            from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgname <> 'trg_cadastro_agregado_unico'
          union all
          select 'nsp ' || coalesce(n.nspacl::text, '') from pg_namespace n where n.nspname = 'public'
        ) s) as retrato_public,
       (select count(*) from public.cadastros_agregados) as cadastros,
       (select md5(coalesce(string_agg(c::text, E'\n' order by c.id), '')) from public.cadastros_agregados c) as md5_cadastros,
       (select count(*) from storage.objects o where o.bucket_id = 'documentos-cadastro') as arquivos,
       (select md5(coalesce(string_agg(o.id::text || ' ' || o.name, E'\n' order by o.name), ''))
          from storage.objects o where o.bucket_id = 'documentos-cadastro') as md5_arquivos;

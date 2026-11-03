-- =============================================================================
-- R04 - Limpeza dos colaboradores de teste (UMA vez, antes do uso real)
--                                                       RASCUNHO - AINDA NÃO RODADO
--
-- Rode DEPOIS do R01, R01b e R03.
--
-- Apaga de verdade (delete físico) os colaboradores cujos nomes estão na lista
-- do topo e tudo que é deles: processos, etapas, observações, anexos, exames,
-- férias, contratos PJ e as linhas da auditoria desses registros. Nada mais.
--
-- Nomes: comparados sem diferença de maiúsculas/minúsculas e de espaços
-- sobrando ("  fulano  DE tal" = "Fulano de Tal"). Nome da lista que não
-- achar ninguém = erro, nada é apagado (confira a grafia).
--
-- Arquivos do bucket rh-anexos (pastas <processo_id>/...): o SQL NÃO apaga.
-- O Supabase barra delete direto em storage.objects, e mesmo que deixasse,
-- sumiria só o registro: o arquivo continuaria guardado no Storage. Por isso a
-- PRÉVIA lista as pastas, você apaga essas pastas no painel (Storage >
-- rh-anexos) e o modo 'apagar' se recusa a rodar enquanto sobrar arquivo delas.
--
-- Como rodar (o arquivo INTEIRO de uma vez, no SQL Editor):
--   1. Preencha a lista de nomes (abaixo, único lugar) e deixe modo 'previa'.
--      Rode. Sai um erro "PRÉVIA (nada foi apagado): ..." com quem foi achado,
--      quanto vai sair de cada tabela, as pastas do bucket e o retrato do que
--      tem que ficar igual. Nada fica salvo (o apagar é ensaiado e desfeito).
--   2. Apague no painel as pastas listadas em "pastas_no_bucket".
--   3. Troque o modo para 'apagar' e rode de novo. Tudo numa transação: trava
--      as tabelas do rh, desliga o rh_00_sem_delete só nas 9 tabelas que
--      perdem linhas, apaga, religa e confere. Se qualquer conferência falhar,
--      dá erro e nada é apagado. Se der certo, faz commit e mostra a
--      conferência depois (uma linha, coluna "conferencia" = OK).
--   O rh_00_sem_truncate não é desligado (o script não usa truncate), mas a
--   conferência confere os dois.
--
-- Rodar de novo depois de apagado dá erro "nome sem nenhum colaborador" (os
-- nomes não existem mais) e não apaga nada.
--
-- As tabelas temporárias r04_* (pg_temp) são da sessão: somem quando a
-- conexão fecha e não entram em nenhum retrato.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- PREENCHA AQUI: nomes dos colaboradores de teste (um por linha) e o modo
-- -----------------------------------------------------------------------------
drop view if exists pg_temp.r04_ligados, pg_temp.r04_retrato;
drop table if exists pg_temp.r04_nomes, pg_temp.r04_alvos, pg_temp.r04_antes;
create temp table r04_nomes (
  nome  text not null,
  chave text generated always as (lower(regexp_replace(btrim(nome), '\s+', ' ', 'g'))) stored
);

insert into r04_nomes (nome) values
  ('COLOQUE AQUI O NOME 1'),
  ('COLOQUE AQUI O NOME 2');

-- 'previa' = mostra o que vai apagar e desfaz tudo; 'apagar' = apaga de verdade
select set_config('r04.modo', 'previa', true);


-- -----------------------------------------------------------------------------
-- 1. Trava as tabelas do rh (ninguém grava até o fim; leitura continua)
-- -----------------------------------------------------------------------------
lock table rh.colaboradores, rh.modelos, rh.modelo_etapas, rh.processos, rh.etapas, rh.observacoes,
           rh.anexos, rh.contratos_pj, rh.exames, rh.ferias, rh.auditoria in exclusive mode;


-- -----------------------------------------------------------------------------
-- 2. Quem sai: colaboradores com esses nomes e tudo que é deles
-- -----------------------------------------------------------------------------
create temp table r04_alvos (tabela text not null, id uuid not null, primary key (tabela, id));

insert into r04_alvos
select 'colaboradores', c.id from rh.colaboradores c
 where lower(regexp_replace(btrim(c.nome), '\s+', ' ', 'g')) in (select n.chave from r04_nomes n);
insert into r04_alvos
select 'processos', p.id from rh.processos p
 where p.colaborador_id in (select id from r04_alvos where tabela = 'colaboradores');
insert into r04_alvos
select 'etapas', e.id from rh.etapas e
 where e.processo_id in (select id from r04_alvos where tabela = 'processos');
insert into r04_alvos
select 'observacoes', o.id from rh.observacoes o
 where o.etapa_id in (select id from r04_alvos where tabela = 'etapas');
insert into r04_alvos
select 'anexos', a.id from rh.anexos a
 where a.etapa_id in (select id from r04_alvos where tabela = 'etapas');
insert into r04_alvos
select 'exames', x.id from rh.exames x
 where x.colaborador_id in (select id from r04_alvos where tabela = 'colaboradores');
insert into r04_alvos
select 'ferias', f.id from rh.ferias f
 where f.colaborador_id in (select id from r04_alvos where tabela = 'colaboradores');
insert into r04_alvos
select 'contratos_pj', c.id from rh.contratos_pj c
 where c.colaborador_id in (select id from r04_alvos where tabela = 'colaboradores');


-- -----------------------------------------------------------------------------
-- 3. O que existe hoje ligado a esses nomes (antes = o que vai sair; depois = 0)
-- -----------------------------------------------------------------------------
create temp view r04_ligados as
select 1 as ordem, 'colaboradores' as tabela, count(*) as n from rh.colaboradores t
 where t.id in (select id from r04_alvos where tabela = 'colaboradores')
    or lower(regexp_replace(btrim(t.nome), '\s+', ' ', 'g')) in (select chave from r04_nomes)
union all
select 2, 'processos', count(*) from rh.processos t
 where t.id in (select id from r04_alvos where tabela = 'processos')
union all
select 3, 'etapas', count(*) from rh.etapas t
 where t.id in (select id from r04_alvos where tabela = 'etapas')
union all
select 4, 'observacoes', count(*) from rh.observacoes t
 where t.id in (select id from r04_alvos where tabela = 'observacoes')
union all
select 5, 'anexos', count(*) from rh.anexos t
 where t.id in (select id from r04_alvos where tabela = 'anexos')
union all
select 6, 'exames', count(*) from rh.exames t
 where t.id in (select id from r04_alvos where tabela = 'exames')
union all
select 7, 'ferias', count(*) from rh.ferias t
 where t.id in (select id from r04_alvos where tabela = 'ferias')
union all
select 8, 'contratos_pj', count(*) from rh.contratos_pj t
 where t.id in (select id from r04_alvos where tabela = 'contratos_pj')
union all
select 9, 'auditoria', count(*) from rh.auditoria t
  join r04_alvos a on a.tabela = t.tabela and a.id = t.registro_id
union all
select 10, 'arquivos_no_bucket', count(*) from storage.objects o
 where o.bucket_id = 'rh-anexos'
   and split_part(o.name, '/', 1) in (select id::text from r04_alvos where tabela = 'processos');


-- -----------------------------------------------------------------------------
-- 4. Retrato do que tem que ficar igual
--    retrato_public: mesmo cálculo do R01/R01b/R03; retrato_rh: estrutura do
--    schema rh (tabelas, colunas, funções, policies, triggers com tgenabled);
--    outros_rh: contagem e md5 das linhas do rh que NÃO são desses nomes, e
--    dos outros arquivos do rh-anexos.
-- -----------------------------------------------------------------------------
create temp view r04_retrato as
with publico as (
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
), estrutura_rh as (
  select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '') || ' ' || c.relrowsecurity as x
    from pg_class c where c.relnamespace = 'rh'::regnamespace
  union all
  select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || coalesce(a.attacl::text, '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
   where c.relnamespace = 'rh'::regnamespace and a.attnum > 0 and not a.attisdropped
  union all
  select 'fn ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '')
    from pg_proc p where p.pronamespace = 'rh'::regnamespace
  union all
  select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' '
         || coalesce(qual, '') || ' ' || coalesce(with_check, '')
    from pg_policies where schemaname = 'rh'
  union all
  select 'trg ' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'rh'::regnamespace and not t.tgisinternal
), outros as (
  select 1 as ordem, 'colaboradores' as tabela, count(*) as n, md5(coalesce(string_agg(t::text, ',' order by t.id), '')) as h
    from rh.colaboradores t where t.id not in (select id from r04_alvos where tabela = 'colaboradores')
  union all
  select 2, 'processos', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.processos t where t.id not in (select id from r04_alvos where tabela = 'processos')
  union all
  select 3, 'etapas', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.etapas t where t.id not in (select id from r04_alvos where tabela = 'etapas')
  union all
  select 4, 'observacoes', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.observacoes t where t.id not in (select id from r04_alvos where tabela = 'observacoes')
  union all
  select 5, 'anexos', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.anexos t where t.id not in (select id from r04_alvos where tabela = 'anexos')
  union all
  select 6, 'exames', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.exames t where t.id not in (select id from r04_alvos where tabela = 'exames')
  union all
  select 7, 'ferias', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.ferias t where t.id not in (select id from r04_alvos where tabela = 'ferias')
  union all
  select 8, 'contratos_pj', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.contratos_pj t where t.id not in (select id from r04_alvos where tabela = 'contratos_pj')
  union all
  select 9, 'auditoria', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), ''))
    from rh.auditoria t
   where not exists (select 1 from r04_alvos a where a.tabela = t.tabela and a.id = t.registro_id)
  union all
  select 10, 'modelos', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from rh.modelos t
  union all
  select 11, 'modelo_etapas', count(*), md5(coalesce(string_agg(t::text, ',' order by t.id), '')) from rh.modelo_etapas t
  union all
  select 12, 'arquivos_no_bucket', count(*),
         md5(coalesce(string_agg(o.name || ' ' || coalesce(o.metadata::text, ''), ',' order by o.name), ''))
    from storage.objects o
   where o.bucket_id = 'rh-anexos'
     and split_part(o.name, '/', 1) not in (select id::text from r04_alvos where tabela = 'processos')
)
select (select md5(string_agg(x, E'\n' order by x)) || ' (' || count(*) || ' itens)' from publico) as retrato_public,
       (select md5(string_agg(x, E'\n' order by x)) || ' (' || count(*) || ' itens)' from estrutura_rh) as retrato_rh,
       (select string_agg(tabela || '=' || n, ' ' order by ordem) || ' (md5 '
               || md5(string_agg(tabela || ':' || n || ':' || h, ',' order by ordem)) || ')' from outros) as outros_rh;

create temp table r04_antes as
select r.*, (select string_agg(tabela || '=' || n, ' ' order by ordem) from r04_ligados) as vai_sair
  from r04_retrato r;


-- -----------------------------------------------------------------------------
-- 5. Apaga (com o rh_00_sem_delete desligado só aqui) e confere antes do commit
-- -----------------------------------------------------------------------------
do $$
declare
  v_modo text := current_setting('r04.modo', true);
  v_tabelas text[] := array['auditoria', 'observacoes', 'anexos', 'etapas', 'processos',
                            'exames', 'ferias', 'contratos_pj', 'colaboradores'];
  v_t text;
  v_achados text;
  v_sem_ninguem text;
  v_vai_sair text;
  v_pastas text;
  v_arquivos bigint;
  v_sobrou text;
  v_trg_ligados bigint;
  v_trg_desligados text;
  v_antes record;
  v_depois record;
begin
  if v_modo is null or v_modo not in ('previa', 'apagar') then
    raise exception 'R04 (nada foi apagado): o modo tem que ser ''previa'' ou ''apagar'' (está %)', coalesce(v_modo, 'vazio');
  end if;
  if not exists (select 1 from r04_nomes where chave <> '') then
    raise exception 'R04 (nada foi apagado): a lista de nomes está vazia';
  end if;

  -- Quem foi achado (por nome da lista) e nome que não achou ninguém
  select string_agg(format('%s: %s', n.nome,
           coalesce((select string_agg(format('%s (%s, cadastrado em %s)', c.nome, c.vinculo, to_char(c.criado_em, 'DD/MM/YYYY')),
                                       '; ' order by c.criado_em)
                       from rh.colaboradores c
                      where lower(regexp_replace(btrim(c.nome), '\s+', ' ', 'g')) = n.chave), 'NINGUÉM')), ' | ' order by n.nome)
    into v_achados
    from (select distinct on (chave) nome, chave from r04_nomes where chave <> '' order by chave, nome) n;

  select string_agg(distinct n.nome, ', ') into v_sem_ninguem
    from r04_nomes n
   where n.chave <> ''
     and not exists (select 1 from rh.colaboradores c
                      where lower(regexp_replace(btrim(c.nome), '\s+', ' ', 'g')) = n.chave);
  if v_sem_ninguem is not null then
    raise exception 'R04 (nada foi apagado): nome(s) da lista sem nenhum colaborador: %. Confira a grafia. Achados: %',
      v_sem_ninguem, v_achados;
  end if;

  select vai_sair into v_vai_sair from r04_antes;
  select count(*), coalesce(string_agg(distinct split_part(o.name, '/', 1), ', '), 'nenhuma')
    into v_arquivos, v_pastas
    from storage.objects o
   where o.bucket_id = 'rh-anexos'
     and split_part(o.name, '/', 1) in (select id::text from r04_alvos where tabela = 'processos');

  if v_modo = 'apagar' and v_arquivos > 0 then
    raise exception 'R04 (nada foi apagado): ainda há % arquivo(s) dessas pessoas no bucket rh-anexos. Apague no painel (Storage > rh-anexos) as pastas: %',
      v_arquivos, v_pastas;
  end if;

  -- Apaga: filhos antes dos pais; o rh_00_sem_delete fica desligado só entre o disable e o enable
  foreach v_t in array v_tabelas loop
    execute format('alter table rh.%I disable trigger rh_00_sem_delete', v_t);
  end loop;

  delete from rh.auditoria t using r04_alvos a where a.tabela = t.tabela and a.id = t.registro_id;
  delete from rh.observacoes  where id in (select id from r04_alvos where tabela = 'observacoes');
  delete from rh.anexos       where id in (select id from r04_alvos where tabela = 'anexos');
  delete from rh.etapas       where id in (select id from r04_alvos where tabela = 'etapas');
  delete from rh.processos    where id in (select id from r04_alvos where tabela = 'processos');
  delete from rh.exames       where id in (select id from r04_alvos where tabela = 'exames');
  delete from rh.ferias       where id in (select id from r04_alvos where tabela = 'ferias');
  delete from rh.contratos_pj where id in (select id from r04_alvos where tabela = 'contratos_pj');
  delete from rh.colaboradores where id in (select id from r04_alvos where tabela = 'colaboradores');

  foreach v_t in array v_tabelas loop
    execute format('alter table rh.%I enable trigger rh_00_sem_delete', v_t);
  end loop;

  -- Conferências antes do commit (qualquer diferença = erro = nada apagado)
  select string_agg(tabela || '=' || n, ' ' order by ordem) into v_sobrou
    from r04_ligados where n > 0 and (tabela <> 'arquivos_no_bucket' or v_modo = 'apagar');
  if v_sobrou is not null then
    raise exception 'R04 (nada foi apagado): sobrou registro desses nomes: %', v_sobrou;
  end if;

  select count(*) filter (where t.tgenabled = 'O'),
         string_agg(c.relname || '.' || t.tgname || ':' || t.tgenabled::text, ', ') filter (where t.tgenabled <> 'O')
    into v_trg_ligados, v_trg_desligados
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'rh'::regnamespace and t.tgname in ('rh_00_sem_delete', 'rh_00_sem_truncate');
  if v_trg_desligados is not null or v_trg_ligados <> 22 then
    raise exception 'R04 (nada foi apagado): triggers de bloqueio fora do esperado (ligados=%, esperado 22; desligados: %)',
      v_trg_ligados, coalesce(v_trg_desligados, 'nenhum');
  end if;

  select * into v_antes from r04_antes;
  select * into v_depois from r04_retrato;
  if (v_antes.retrato_public, v_antes.retrato_rh, v_antes.outros_rh)
     is distinct from (v_depois.retrato_public, v_depois.retrato_rh, v_depois.outros_rh) then
    raise exception 'R04 (nada foi apagado): mudou algo além desses nomes. antes: public=% rh=% outros=% | depois: public=% rh=% outros=%',
      v_antes.retrato_public, v_antes.retrato_rh, v_antes.outros_rh,
      v_depois.retrato_public, v_depois.retrato_rh, v_depois.outros_rh;
  end if;

  if v_modo = 'previa' then
    raise exception 'PRÉVIA (nada foi apagado): achados=% || vai_sair: % || pastas_no_bucket (apague no painel antes do modo apagar): % || tem_que_ficar_igual: retrato_public=% | retrato_rh=% | outros_rh=%',
      v_achados, v_vai_sair, v_pastas, v_antes.retrato_public, v_antes.retrato_rh, v_antes.outros_rh;
  end if;
end $$;

commit;


-- -----------------------------------------------------------------------------
-- 6. Conferência depois do commit (lê o que ficou gravado)
--    restam_desses_nomes: tudo 0; triggers: 22 ligados (tgenabled 'O');
--    retrato_* e outros_rh: iguais aos da PRÉVIA.
-- -----------------------------------------------------------------------------
select case when (select sum(n) from r04_ligados) = 0
             and (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
                   where c.relnamespace = 'rh'::regnamespace and t.tgenabled = 'O'
                     and t.tgname in ('rh_00_sem_delete', 'rh_00_sem_truncate')) = 22
             and not exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                              where c.relnamespace = 'rh'::regnamespace and t.tgenabled <> 'O'
                                and t.tgname in ('rh_00_sem_delete', 'rh_00_sem_truncate'))
             and (a.retrato_public, a.retrato_rh, a.outros_rh) = (d.retrato_public, d.retrato_rh, d.outros_rh)
            then 'OK' else 'DIFERENTE' end as conferencia,
       a.vai_sair as apagados,
       (select string_agg(tabela || '=' || n, ' ' order by ordem) from r04_ligados) as restam_desses_nomes,
       (select string_agg(t.tgenabled::text || '=' || n, ' ' order by t.tgenabled)
          from (select t.tgenabled, count(*) as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
                 where c.relnamespace = 'rh'::regnamespace and t.tgname in ('rh_00_sem_delete', 'rh_00_sem_truncate')
                 group by t.tgenabled) t) as triggers_bloqueio,
       a.retrato_public as retrato_public_antes, d.retrato_public as retrato_public_depois,
       a.retrato_rh as retrato_rh_antes, d.retrato_rh as retrato_rh_depois,
       a.outros_rh as outros_rh_antes, d.outros_rh as outros_rh_depois
  from r04_antes a, r04_retrato d;

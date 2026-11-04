-- =============================================================================
-- TORRE T03 - Pendências da passagem de turno          RASCUNHO - AINDA NÃO RODADO
-- AJBorges Transporte & Logística
--
-- Rode DEPOIS do T02 (usa torre.passagens_turno, torre.eh_operador() e o
-- mesmo padrão de carimbos do servidor).
--
-- Cada item de "PENDÊNCIAS PARA O PRÓXIMO TURNO" da passagem publicada vira
-- uma pendência rastreável, ligada à passagem e ao turno. O turno seguinte só
-- publica a sua passagem depois de fechar cada pendência herdada como
-- "Resolvida" ou "Continua", sempre com "Como foi resolvido". "Continua"
-- fecha a herdada e cria uma cópia ligada à passagem nova (origem_id aponta
-- para a anterior), então ela passa para o turno seguinte.
--
--   1. torre.passagem_pendencias: passagem_id, turno e data (da passagem,
--      copiados pelo servidor), texto, status (aberta | resolvida | continua),
--      resolucao, resolvido_por, resolvido_email, resolvido_em,
--      fechada_na_passagem (a passagem que a fechou), origem_id, criado_por,
--      criado_em e ordem (número crescente do servidor: a ordem em que os
--      itens foram escritos; duas linhas podem ter o mesmo criado_em).
--      Carimbos sempre do servidor (o que o navegador mandar é ignorado).
--      Pendência fechada não muda; ninguém apaga (nem o dono).
--   2. Trigger em torre.passagens_turno: com pendência aberta, publicar é
--      recusado (vale também para a página antiga, que grava direto).
--   3. RPCs (security invoker: a RLS de quem chama vale):
--      - torre.publicar_passagem(...): numa transação só, fecha as herdadas,
--        publica a passagem e cria as pendências dela (e as que continuam);
--      - torre.buscar_pendencias(texto, turno, data, status): tela
--        "Histórico de pendências";
--      - torre.buscar_resolucoes_parecidas(texto, limite): a edge function
--        torre-passagem-turno usa para as "Sugestões de tratativa" (só
--        pendências resolvidas com palavras em comum; nada parecido = vazio).
--   4. RLS: tudo só para torre.eh_operador(). Nenhuma policy de delete.
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
-- Depois: republicar a edge function torre-passagem-turno (sugestões de
-- tratativa) e publicar o site (a tela passa a publicar pela RPC).
-- Obs.: depois deste arquivo a conferência 8.1 do T01 muda de novo (tabela,
-- policies e grants novos).
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
-- 1. Pendências
-- -----------------------------------------------------------------------------
create table if not exists torre.passagem_pendencias (
  id                  uuid primary key default gen_random_uuid(),
  passagem_id         uuid not null references torre.passagens_turno (id),
  turno               text not null check (turno in ('T1', 'T2', 'T3')),
  data                date not null,
  texto               text not null check (length(btrim(texto)) between 1 and 600),
  status              text not null default 'aberta' check (status in ('aberta', 'resolvida', 'continua')),
  resolucao           text check (resolucao is null or length(btrim(resolucao)) between 1 and 1000),
  resolvido_por       uuid,
  resolvido_email     text,
  resolvido_em        timestamptz,
  -- a passagem que fechou (o FK só é conferido no commit: a RPC fecha antes de publicar)
  fechada_na_passagem uuid references torre.passagens_turno (id) deferrable initially deferred,
  -- "Continua": a pendência da passagem anterior que esta continua
  origem_id           uuid references torre.passagem_pendencias (id),
  criado_por          uuid,
  criado_em           timestamptz not null default now(),
  -- ordem em que foram criadas (os itens de uma passagem saem na ordem do texto)
  ordem               bigint generated always as identity,
  constraint passagem_pendencias_fechada check (
    (status = 'aberta' and resolucao is null and resolvido_em is null and fechada_na_passagem is null)
    or (status <> 'aberta' and resolucao is not null and resolvido_em is not null and fechada_na_passagem is not null))
);
create index if not exists passagem_pendencias_abertas on torre.passagem_pendencias (ordem) where status = 'aberta';
create index if not exists passagem_pendencias_filtro on torre.passagem_pendencias (data, turno, status);
create index if not exists passagem_pendencias_passagem on torre.passagem_pendencias (passagem_id);


-- -----------------------------------------------------------------------------
-- 2. Funções e triggers
-- -----------------------------------------------------------------------------

-- Nova pendência: aberta, turno/data da passagem, autor e hora do servidor
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
  new.resolvido_em := null;
  new.fechada_na_passagem := null;
  new.criado_por := auth.uid();
  new.criado_em := now();
  if new.criado_por is null then
    raise exception 'torre.passagem_pendencias: precisa de usuário autenticado' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

-- Fechar: só aberta -> resolvida/continua, com "Como foi resolvido"; o resto não muda;
-- quem e quando, do servidor
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

create or replace function torre.bloquear_pendencia()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'torre.%: % não é permitido (pendência não é apagada)',
    tg_table_name, lower(tg_op) using errcode = 'insufficient_privilege';
end $$;

-- Publicar com pendência herdada aberta = recusado (vale também para quem grava direto)
create or replace function torre.passagem_exige_pendencias_fechadas()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from torre.passagem_pendencias where status = 'aberta') then
    raise exception 'Há pendências herdadas abertas: feche cada uma (Resolvida ou Continua, com "Como foi resolvido") antes de publicar.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists torre_10_servidor on torre.passagem_pendencias;
create trigger torre_10_servidor before insert on torre.passagem_pendencias
  for each row execute function torre.pendencia_nova();
drop trigger if exists torre_10_fechar on torre.passagem_pendencias;
create trigger torre_10_fechar before update on torre.passagem_pendencias
  for each row execute function torre.pendencia_fechar();
drop trigger if exists torre_00_sem_delete on torre.passagem_pendencias;
create trigger torre_00_sem_delete before delete on torre.passagem_pendencias
  for each row execute function torre.bloquear_pendencia();
drop trigger if exists torre_00_sem_truncate on torre.passagem_pendencias;
create trigger torre_00_sem_truncate before truncate on torre.passagem_pendencias
  for each statement execute function torre.bloquear_pendencia();

drop trigger if exists torre_20_pendencias_fechadas on torre.passagens_turno;
create trigger torre_20_pendencias_fechadas before insert on torre.passagens_turno
  for each row execute function torre.passagem_exige_pendencias_fechadas();

-- Itens da seção "PENDÊNCIAS PARA O PRÓXIMO TURNO" do texto da passagem
-- (até o próximo título; "não informado" e linhas vazias não contam; até 30 itens de 600 letras)
create or replace function torre.itens_pendencias(p_texto text)
returns setof text language plpgsql immutable set search_path = '' as $$
declare
  v_linha  text;
  v_titulo text;
  v_item   text;
  v_dentro boolean := false;
  v_n      int := 0;
begin
  foreach v_linha in array string_to_array(replace(coalesce(p_texto, ''), E'\r', ''), E'\n') loop
    v_titulo := upper(translate(btrim(regexp_replace(v_linha, '[:[:space:]]+$', '')),
                                'ÊÉÓÕÃÇÁêéóõãçá', 'EEOOACAeeooaca'));
    if v_titulo in ('URGENTE', 'EM ANDAMENTO', 'AVISOS', 'SUGESTOES DE TRATATIVA') then
      v_dentro := false;
      continue;
    end if;
    if v_titulo in ('PENDENCIAS PARA O PROXIMO TURNO', 'PENDENCIAS') then
      v_dentro := true;
      continue;
    end if;
    if v_dentro and v_n < 30 then
      v_item := btrim(regexp_replace(v_linha, '^[[:space:]]*[-•*][[:space:]]*', ''));
      if v_item <> '' and lower(translate(v_item, 'ãÃ.', 'aa')) not in ('nao informado', 'nao informada') then
        v_n := v_n + 1;
        return next left(v_item, 600);
      end if;
    end if;
  end loop;
end $$;

-- Publica a passagem e fecha as herdadas numa transação só.
-- p_fechamentos: [{ "id": "<pendência aberta>", "status": "resolvida" | "continua", "resolucao": "..." }]
create or replace function torre.publicar_passagem(p_turno text, p_data date, p_texto_original text,
                                                   p_texto_ia text, p_texto_final text, p_fechamentos jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_id        uuid := gen_random_uuid();
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
  if jsonb_typeof(coalesce(p_fechamentos, '[]'::jsonb)) <> 'array' then
    raise exception 'torre.publicar_passagem: fechamentos inválidos' using errcode = 'check_violation';
  end if;
  -- Uma publicação de cada vez (duas abas publicando juntas não fecham a mesma pendência)
  perform pg_advisory_xact_lock(hashtext('torre.publicar_passagem'));

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

  insert into torre.passagens_turno (id, turno, data, texto_original, texto_ia, texto_final)
  values (v_id, p_turno, p_data, p_texto_original, p_texto_ia, p_texto_final);

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

-- Histórico de pendências (texto em texto ou "como foi resolvido"; turno; data da passagem; status)
create or replace function torre.buscar_pendencias(p_texto text, p_turno text, p_data date, p_status text)
returns setof jsonb language sql stable security invoker set search_path = '' as $$
  select to_jsonb(p) || jsonb_build_object(
           'origem_turno', o.turno, 'origem_data', o.data,
           'fechada_turno', f.turno, 'fechada_data', f.data)
    from torre.passagem_pendencias p
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

-- Palavras de um texto para comparar (sem acento, minúsculas, 4+ letras, sem palavras comuns)
create or replace function torre.palavras(p_texto text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct w order by w), '{}'::text[])
    from regexp_split_to_table(lower(translate(coalesce(p_texto, ''),
           'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç',
           'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc')), '[^a-z0-9]+') w
   where length(w) >= 4
     and w not in ('para', 'pela', 'pelo', 'pelas', 'pelos', 'como', 'mais', 'esta', 'este', 'isso', 'essa', 'esse',
                   'turno', 'proximo', 'sobre', 'depois', 'antes', 'ainda', 'foram', 'sera', 'quando', 'onde',
                   'qual', 'quais', 'tambem', 'muito', 'pode', 'deve', 'fazer', 'feito', 'estao', 'nosso',
                   'pendencia', 'pendencias', 'informado', 'verificar', 'conferir', 'precisa');
$$;

-- Pendências RESOLVIDAS parecidas com o texto (2+ palavras em comum e 30%+ das palavras dela),
-- com a passagem que resolveu; nada parecido = nenhuma linha
create or replace function torre.buscar_resolucoes_parecidas(p_texto text, p_limite int)
returns table (id uuid, texto text, resolucao text, passagem_id uuid, turno text, data date, comuns int)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.texto, p.resolucao, f.id, f.turno, f.data, c.n
    from torre.passagem_pendencias p
    join torre.passagens_turno f on f.id = p.fechada_na_passagem
    cross join lateral (select torre.palavras(p.texto) as w) pw
    cross join lateral (select count(*)::int as n from unnest(pw.w) x where x = any (torre.palavras(p_texto))) c
   where p.status = 'resolvida'
     and c.n >= 2
     and c.n::numeric / greatest(cardinality(pw.w), 1) >= 0.3
   order by c.n desc, p.resolvido_em desc
   limit least(greatest(coalesce(p_limite, 5), 1), 10);
$$;


-- -----------------------------------------------------------------------------
-- 3. RLS e policies (só operador; nenhuma de delete)
-- -----------------------------------------------------------------------------
alter table torre.passagem_pendencias enable row level security;

drop policy if exists torre_operador_le on torre.passagem_pendencias;
create policy torre_operador_le on torre.passagem_pendencias for select to authenticated using (torre.eh_operador());
drop policy if exists torre_operador_cria on torre.passagem_pendencias;
create policy torre_operador_cria on torre.passagem_pendencias for insert to authenticated
  with check (torre.eh_operador());
drop policy if exists torre_operador_fecha on torre.passagem_pendencias;
create policy torre_operador_fecha on torre.passagem_pendencias for update to authenticated
  using (torre.eh_operador()) with check (torre.eh_operador());


-- -----------------------------------------------------------------------------
-- 4. Permissões (anon, public e service_role: nada; delete nunca)
-- -----------------------------------------------------------------------------
revoke all on torre.passagem_pendencias from public, anon, authenticated, service_role;
revoke all on sequence torre.passagem_pendencias_ordem_seq from public, anon, authenticated, service_role;
grant select on torre.passagem_pendencias to authenticated;
grant insert (passagem_id, texto, origem_id) on torre.passagem_pendencias to authenticated;
grant update (status, resolucao, fechada_na_passagem) on torre.passagem_pendencias to authenticated;

revoke all on function torre.pendencia_nova(), torre.pendencia_fechar(), torre.bloquear_pendencia(),
                       torre.passagem_exige_pendencias_fechadas(), torre.itens_pendencias(text),
                       torre.publicar_passagem(text, date, text, text, text, jsonb),
                       torre.buscar_pendencias(text, text, date, text), torre.palavras(text),
                       torre.buscar_resolucoes_parecidas(text, int)
  from public, anon, authenticated, service_role;
-- (as RPCs são security invoker: itens_pendencias e palavras rodam como quem chamou)
grant execute on function torre.publicar_passagem(text, date, text, text, text, jsonb),
                          torre.buscar_pendencias(text, text, date, text),
                          torre.buscar_resolucoes_parecidas(text, int),
                          torre.itens_pendencias(text), torre.palavras(text)
  to authenticated;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
--    Se já houver pendência aberta de verdade no banco, a 7.3 a 7.6 a fecham só
--    dentro da transação (desfeito no rollback) para poderem publicar.
-- =============================================================================

-- 7.1 Estrutura e permissões (esperado: rls=true | policies=INSERT,SELECT,UPDATE | policies_delete=0 | tabela=SELECT | colunas_insert=origem_id,passagem_id,texto | colunas_update=fechada_na_passagem,resolucao,status | anon_privilegios=0 | service_role_privilegios=0 | delete_ou_truncate=0 | rpcs=authenticated:4 anon:0 service_role:0 definer:0 sem_search_path:0 | gatilhos_para_alguem=0 | bloqueios_ligados=3 | itens=Conferir os canhotos; Ligar para o CD às 08:00)
--     "tabela" é o grant da tabela inteira (só leitura); criar e fechar são grants por coluna (colunas_insert/colunas_update).
do $$
begin
  raise exception 'RESULTADO: rls=% | policies=% | policies_delete=% | tabela=% | colunas_insert=% | colunas_update=% | anon_privilegios=% | service_role_privilegios=% | delete_ou_truncate=% | rpcs=authenticated:% anon:% service_role:% definer:% sem_search_path:% | gatilhos_para_alguem=% | bloqueios_ligados=% | itens=%',
    (select c.relrowsecurity::text from pg_class c where c.oid = 'torre.passagem_pendencias'::regclass),
    (select string_agg(cmd, ',' order by cmd) from pg_policies where schemaname = 'torre' and tablename = 'passagem_pendencias'),
    (select count(*) from pg_policies where schemaname = 'torre' and cmd in ('DELETE', 'ALL')),
    (select string_agg(a.privilege_type, ',' order by a.privilege_type) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'torre.passagem_pendencias'::regclass and a.grantee = 'authenticated'::regrole::oid),
    (select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
      where a.attrelid = 'torre.passagem_pendencias'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('authenticated', 'torre.passagem_pendencias', a.attname, 'insert')),
    (select string_agg(a.attname, ',' order by a.attname) from pg_attribute a
      where a.attrelid = 'torre.passagem_pendencias'::regclass and a.attnum > 0 and not a.attisdropped
        and has_column_privilege('authenticated', 'torre.passagem_pendencias', a.attname, 'update')),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'torre.passagem_pendencias'::regclass and a.grantee = 'anon'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.oid = 'torre.passagem_pendencias'::regclass and a.grantee = 'service_role'::regrole::oid),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.privilege_type in ('DELETE', 'TRUNCATE')
        and a.grantee <> c.relowner),
    (select count(*) from pg_proc p where p.oid in ('torre.publicar_passagem(text, date, text, text, text, jsonb)'::regprocedure,
        'torre.buscar_pendencias(text, text, date, text)'::regprocedure, 'torre.buscar_resolucoes_parecidas(text, int)'::regprocedure,
        'torre.itens_pendencias(text)'::regprocedure) and has_function_privilege('authenticated', p.oid, 'execute')),
    (select count(*) from pg_proc p where p.pronamespace = 'torre'::regnamespace
        and p.proname in ('publicar_passagem', 'buscar_pendencias', 'buscar_resolucoes_parecidas', 'itens_pendencias', 'palavras')
        and has_function_privilege('anon', p.oid, 'execute')),
    (select count(*) from pg_proc p where p.pronamespace = 'torre'::regnamespace
        and p.proname in ('publicar_passagem', 'buscar_pendencias', 'buscar_resolucoes_parecidas', 'itens_pendencias', 'palavras')
        and has_function_privilege('service_role', p.oid, 'execute')),
    (select count(*) from pg_proc p where p.pronamespace = 'torre'::regnamespace
        and p.proname in ('publicar_passagem', 'buscar_pendencias', 'buscar_resolucoes_parecidas', 'itens_pendencias', 'palavras',
                          'pendencia_nova', 'pendencia_fechar', 'bloquear_pendencia', 'passagem_exige_pendencias_fechadas')
        and p.prosecdef),
    (select count(*) from pg_proc p where p.pronamespace = 'torre'::regnamespace
        and p.proname in ('publicar_passagem', 'buscar_pendencias', 'buscar_resolucoes_parecidas', 'itens_pendencias', 'palavras',
                          'pendencia_nova', 'pendencia_fechar', 'bloquear_pendencia', 'passagem_exige_pendencias_fechadas')
        and coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=""'),
    (select count(*) from pg_proc p
      where p.oid in ('torre.pendencia_nova()'::regprocedure, 'torre.pendencia_fechar()'::regprocedure,
                      'torre.bloquear_pendencia()'::regprocedure, 'torre.passagem_exige_pendencias_fechadas()'::regprocedure)
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
    (select count(*) from pg_trigger t
      where t.tgenabled = 'O' and ((t.tgrelid = 'torre.passagem_pendencias'::regclass and t.tgname in ('torre_00_sem_delete', 'torre_00_sem_truncate'))
         or (t.tgrelid = 'torre.passagens_turno'::regclass and t.tgname = 'torre_20_pendencias_fechadas'))),
    (select string_agg(i, '; ') from torre.itens_pendencias(E'URGENTE\n- Carreta parada\n\nPENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos\n- não informado\nLigar para o CD às 08:00\n\nAVISOS\n- Chuva') i);
end $$;

-- 7.2 Anon e motorista não leem nem gravam (esperado: anon=ler:bloqueado publicar:bloqueado historico:bloqueado | motorista=pendencias_vistas:0 publicar:bloqueado fechar:0 linhas historico:0 parecidas:0)
begin;
-- uma passagem com pendência, feita pela gestão (para o motorista tentar ver e fechar)
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.2',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
select torre.publicar_passagem('T1', current_date, 'texto 7.2', null,
         E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir canhotos do CD Cajamar', '[]');
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
declare
  v_le   text := 'LIBERADO';
  v_pub  text := 'LIBERADO';
  v_hist text := 'LIBERADO';
begin
  begin perform count(*) from torre.passagem_pendencias; exception when insufficient_privilege then v_le := 'bloqueado'; end;
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, 'x', '[]'); exception when insufficient_privilege then v_pub := 'bloqueado'; end;
  begin perform count(*) from torre.buscar_pendencias(null, null, null, null); exception when insufficient_privilege then v_hist := 'bloqueado'; end;
  perform set_config('t03.anon', format('anon=ler:%s publicar:%s historico:%s', v_le, v_pub, v_hist), true);
end $$;
reset role;
select set_config('request.jwt.claims',
         '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"role":"motorista"}}', true);
set local role authenticated;
do $$
declare
  v_pub text := 'LIBERADO';
  v_n   bigint;
begin
  begin perform torre.publicar_passagem('T1', current_date, 'x', null, 'x', '[]'); exception when insufficient_privilege then v_pub := 'bloqueado'; end;
  update torre.passagem_pendencias set status = 'resolvida', resolucao = 'x';
  get diagnostics v_n = row_count;
  raise exception 'RESULTADO (nada foi salvo): % | motorista=pendencias_vistas:% publicar:% fechar:% linhas historico:% parecidas:%',
    current_setting('t03.anon'), (select count(*) from torre.passagem_pendencias), v_pub, v_n,
    (select count(*) from torre.buscar_pendencias(null, null, null, null)),
    (select count(*) from torre.buscar_resolucoes_parecidas('canhotos do CD Cajamar', 5));
end $$;
reset role;
rollback;

-- 7.3 Operador publica e cada item vira pendência; carimbos do servidor (esperado: publicou=novas:3 fechadas:0 continuam:0 | pendencias=Conferir os canhotos do CD Cajamar; Ligar para a transportadora às 08:00; Cobrar o CTe da LH 123 | status=aberta,aberta,aberta | turno_data_da_passagem=t | criado_por_servidor=t | hora_servidor=t | resolvido_vazio=t | criar_ja_resolvida=vira aberta)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.3',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
set local role authenticated;
do $$
declare
  v_r   jsonb;
  v_id  uuid;
  v_pid uuid;
begin
  v_r := torre.publicar_passagem('T2', current_date - 1, 'texto 7.3', 'texto da ia 7.3',
           E'URGENTE\n- Carreta ABC1D23 parada\n\nPENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos do CD Cajamar\n- Ligar para a transportadora às 08:00\n- Cobrar o CTe da LH 123\n\nAVISOS\n- não informado', '[]');
  v_id := (v_r ->> 'id')::uuid;
  -- tentar criar uma pendência já resolvida, com carimbos falsos
  insert into torre.passagem_pendencias (passagem_id, texto)
  values (v_id, 'pendência criada à mão') returning id into v_pid;
  raise exception 'RESULTADO (nada foi salvo): publicou=novas:% fechadas:% continuam:% | pendencias=% | status=% | turno_data_da_passagem=% | criado_por_servidor=% | hora_servidor=% | resolvido_vazio=% | criar_ja_resolvida=%',
    v_r ->> 'novas', v_r ->> 'fechadas', v_r ->> 'continuam',
    (select string_agg(texto, '; ' order by ordem) from torre.passagem_pendencias where passagem_id = v_id and id <> v_pid
        and texto <> 'pendência criada à mão'),
    (select string_agg(status, ',') from torre.passagem_pendencias where passagem_id = v_id and id <> v_pid),
    (select bool_and(turno = 'T2' and data = current_date - 1) from torre.passagem_pendencias where passagem_id = v_id),
    (select bool_and(criado_por = '00000000-0000-0000-0000-0000000000c3') from torre.passagem_pendencias where passagem_id = v_id),
    (select bool_and(criado_em = now()) from torre.passagem_pendencias where passagem_id = v_id),
    (select bool_and(resolucao is null and resolvido_por is null and resolvido_em is null) from torre.passagem_pendencias where passagem_id = v_id),
    (select case when status = 'aberta' then 'vira aberta' else status end from torre.passagem_pendencias where id = v_pid);
end $$;
reset role;
rollback;

-- 7.4 O turno seguinte é obrigado a fechar cada herdada (esperado: sem_fechar=recusado | sem_como_foi_resolvido=recusado | status_invalido=recusado | gravar_direto=recusado | publicou=fechadas:2 continuam:1 novas:1 | resolvida=resolvida por admin@teste.local | continua=continua | passou_para_o_proximo=Ligar para a transportadora às 08:00 (aberta, origem ok) | passagens=2)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.4',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
select set_config('t03.antes', (select count(*)::text from torre.passagens_turno), true);
set local role authenticated;
do $$
declare
  v_r       jsonb;
  v_a       uuid;
  v_b       uuid;
  v_sem     text := 'ACEITO';
  v_semres  text := 'ACEITO';
  v_inval   text := 'ACEITO';
  v_direto  text := 'ACEITO';
  v_canhoto uuid;
  v_ligar   uuid;
  v_texto   text := E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos do CD Cajamar\n- Ligar para a transportadora às 08:00';
begin
  v_a := (torre.publicar_passagem('T1', current_date, 'turno 1', null, v_texto, '[]') ->> 'id')::uuid;
  select id into v_canhoto from torre.passagem_pendencias where passagem_id = v_a and texto like 'Conferir%';
  select id into v_ligar from torre.passagem_pendencias where passagem_id = v_a and texto like 'Ligar%';
  begin
    perform torre.publicar_passagem('T2', current_date, 'turno 2', null, 'AVISOS\n- nada', '[]');
  exception when check_violation then v_sem := 'recusado';
  end;
  begin
    perform torre.publicar_passagem('T2', current_date, 'turno 2', null, 'AVISOS\n- nada',
      jsonb_build_array(jsonb_build_object('id', v_canhoto, 'status', 'resolvida', 'resolucao', '   '),
                        jsonb_build_object('id', v_ligar, 'status', 'continua', 'resolucao', 'ninguém atendeu')));
  exception when check_violation then v_semres := 'recusado';
  end;
  begin
    perform torre.publicar_passagem('T2', current_date, 'turno 2', null, 'AVISOS\n- nada',
      jsonb_build_array(jsonb_build_object('id', v_canhoto, 'status', 'aberta', 'resolucao', 'x'),
                        jsonb_build_object('id', v_ligar, 'status', 'continua', 'resolucao', 'ninguém atendeu')));
  exception when check_violation then v_inval := 'recusado';
  end;
  begin
    insert into torre.passagens_turno (turno, texto_original, texto_final) values ('T2', 'página antiga', 'página antiga');
  exception when check_violation then v_direto := 'recusado';
  end;
  v_r := torre.publicar_passagem('T2', current_date, 'turno 2', null,
           E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Ligar para a transportadora às 08:00\n- Pedir a foto do lacre da LH 456',
           jsonb_build_array(jsonb_build_object('id', v_canhoto, 'status', 'resolvida', 'resolucao', 'Canhotos conferidos com o CD por e-mail.'),
                             jsonb_build_object('id', v_ligar, 'status', 'continua', 'resolucao', 'Liguei 2x e ninguém atendeu.')));
  v_b := (v_r ->> 'id')::uuid;
  raise exception 'RESULTADO (nada foi salvo): sem_fechar=% | sem_como_foi_resolvido=% | status_invalido=% | gravar_direto=% | publicou=fechadas:% continuam:% novas:% | resolvida=% | continua=% | passou_para_o_proximo=% | passagens=%',
    v_sem, v_semres, v_inval, v_direto, v_r ->> 'fechadas', v_r ->> 'continuam', v_r ->> 'novas',
    (select status || ' por ' || resolvido_email from torre.passagem_pendencias
      where id = v_canhoto and fechada_na_passagem = v_b and resolvido_por = '00000000-0000-0000-0000-0000000000c3' and resolvido_em = now()),
    (select status from torre.passagem_pendencias where id = v_ligar and fechada_na_passagem = v_b),
    (select string_agg(texto || ' (' || status || case when origem_id = v_ligar then ', origem ok' else '' end || ')', '; ')
       from torre.passagem_pendencias where passagem_id = v_b and texto like 'Ligar%'),
    (select count(*) from torre.passagens_turno) - current_setting('t03.antes')::int;
end $$;
reset role;
rollback;

-- 7.5 Pendência fechada não muda e ninguém apaga (esperado: operador=reabrir:bloqueado mudar_resolucao:bloqueado apagar:bloqueado mudar_texto_aberta:ignorado | dono=apagar:bloqueado truncate:bloqueado mudar:bloqueado | fechar_sem_publicar=recusado | intacta=t)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.5',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
set local role authenticated;
do $$
declare
  v_a       uuid;
  v_b       uuid;
  v_p       uuid;
  v_q       uuid;
  v_reabrir text := 'LIBERADO';
  v_mudar   text := 'LIBERADO';
  v_apagar  text := 'LIBERADO';
  v_fechar  text := 'ACEITO';
begin
  v_a := (torre.publicar_passagem('T1', current_date, 'x', null, E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Item A\n- Item B', '[]') ->> 'id')::uuid;
  select id into v_p from torre.passagem_pendencias where passagem_id = v_a and texto = 'Item A';
  select id into v_q from torre.passagem_pendencias where passagem_id = v_a and texto = 'Item B';
  -- texto de pendência aberta não muda (só status/resolução têm grant; o trigger devolve o texto)
  begin
    update torre.passagem_pendencias set texto = 'mudei' where id = v_q;
  exception when insufficient_privilege then null;
  end;
  -- fechar sem publicar a passagem: recusado
  begin
    update torre.passagem_pendencias set status = 'resolvida', resolucao = 'x' where id = v_q;
  exception when check_violation then v_fechar := 'recusado';
  end;
  v_b := (torre.publicar_passagem('T2', current_date, 'x', null, 'AVISOS\n- ok',
           jsonb_build_array(jsonb_build_object('id', v_p, 'status', 'resolvida', 'resolucao', 'Resolvido A'),
                             jsonb_build_object('id', v_q, 'status', 'resolvida', 'resolucao', 'Resolvido B'))) ->> 'id')::uuid;
  begin update torre.passagem_pendencias set status = 'aberta' where id = v_p; exception when insufficient_privilege then v_reabrir := 'bloqueado'; end;
  begin update torre.passagem_pendencias set resolucao = 'outra' where id = v_p; exception when insufficient_privilege then v_mudar := 'bloqueado'; end;
  begin delete from torre.passagem_pendencias where id = v_p; exception when insufficient_privilege then v_apagar := 'bloqueado'; end;
  perform set_config('t03.p', v_p::text, true);
  perform set_config('t03.q', v_q::text, true);
  perform set_config('t03.operador', format('operador=reabrir:%s mudar_resolucao:%s apagar:%s mudar_texto_aberta:%s', v_reabrir, v_mudar, v_apagar,
    (select case when texto = 'Item B' then 'ignorado' else 'MUDOU' end from torre.passagem_pendencias where id = v_q)), true);
  perform set_config('t03.fechar', v_fechar, true);
end $$;
reset role;
-- (confere agora os FKs adiados da publicação; senão o truncate para em "pending trigger events")
set constraints all immediate;
do $$
declare
  v_p      uuid := current_setting('t03.p')::uuid;
  v_apagar text := 'LIBERADO';
  v_trunc  text := 'LIBERADO';
  v_mudar  text := 'LIBERADO';
begin
  begin delete from torre.passagem_pendencias where id = v_p; exception when insufficient_privilege then v_apagar := 'bloqueado'; end;
  begin truncate torre.passagem_pendencias; exception when insufficient_privilege then v_trunc := 'bloqueado'; end;
  begin update torre.passagem_pendencias set resolucao = 'dono mudou' where id = v_p; exception when insufficient_privilege then v_mudar := 'bloqueado'; end;
  raise exception 'RESULTADO (nada foi salvo): % | dono=apagar:% truncate:% mudar:% | fechar_sem_publicar=% | intacta=%',
    current_setting('t03.operador'), v_apagar, v_trunc, v_mudar, current_setting('t03.fechar'),
    (select status = 'resolvida' and resolucao = 'Resolvido A' and texto = 'Item A' from torre.passagem_pendencias where id = v_p);
end $$;
rollback;

-- 7.6 Histórico e resoluções parecidas (esperado: todas=3 | texto=1 | texto_na_resolucao=1 | turno_t1=2 | status_resolvida=1 | data_ontem=0 | curinga_por_cento=0 | parecidas=Canhotos conferidos com o CD por e-mail. (T2) | nada_parecido=0 | aberta_nao_conta=0)
begin;
select set_config('request.jwt.claims',
         '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
update torre.passagem_pendencias set status = 'resolvida', resolucao = 'fechada pela conferência 7.6',
       fechada_na_passagem = (select id from torre.passagens_turno order by criado_em desc limit 1) where status = 'aberta';
set local role authenticated;
do $$
declare
  v_a uuid;
  v_c uuid;
  v_l uuid;
begin
  -- só as pendências criadas aqui contam (o banco real pode ter outras)
  perform set_config('t03.desde', now()::text, true);
  v_a := (torre.publicar_passagem('T1', current_date, 'x', null,
           E'PENDÊNCIAS PARA O PRÓXIMO TURNO\n- Conferir os canhotos do CD Cajamar\n- Ligar para a transportadora às 08:00', '[]') ->> 'id')::uuid;
  select id into v_c from torre.passagem_pendencias where passagem_id = v_a and texto like 'Conferir%';
  select id into v_l from torre.passagem_pendencias where passagem_id = v_a and texto like 'Ligar%';
  perform torre.publicar_passagem('T2', current_date, 'x', null, 'AVISOS\n- ok',
    jsonb_build_array(jsonb_build_object('id', v_c, 'status', 'resolvida', 'resolucao', 'Canhotos conferidos com o CD por e-mail.'),
                      jsonb_build_object('id', v_l, 'status', 'continua', 'resolucao', 'Ninguém atendeu.')));
  raise exception 'RESULTADO (nada foi salvo): todas=% | texto=% | texto_na_resolucao=% | turno_t1=% | status_resolvida=% | data_ontem=% | curinga_por_cento=% | parecidas=% | nada_parecido=% | aberta_nao_conta=%',
    (select count(*) from torre.buscar_pendencias(null, null, null, null) j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select count(*) from torre.buscar_pendencias('cajamar', null, null, null) j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select count(*) from torre.buscar_pendencias('por e-mail', null, null, null) j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select count(*) from torre.buscar_pendencias('', 'T1', null, null) j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select count(*) from torre.buscar_pendencias(null, null, null, 'resolvida') j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select count(*) from torre.buscar_pendencias(null, null, current_date - 1, null) j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select count(*) from torre.buscar_pendencias('%', null, null, null) j where (j ->> 'criado_em')::timestamptz >= current_setting('t03.desde')::timestamptz),
    (select string_agg(resolucao || ' (' || turno || ')', '; ') from torre.buscar_resolucoes_parecidas('O CD Cajamar ainda não mandou os canhotos', 5)
      where id = v_c),
    (select count(*) from torre.buscar_resolucoes_parecidas('Pneu furado na serra, socorro a caminho', 5)),
    (select count(*) from torre.buscar_resolucoes_parecidas('Ligar para a transportadora às 08:00', 5) where id = v_l);
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

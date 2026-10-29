-- =============================================================================
-- TORRE T01 - Cópia da planilha "TORRE DE CONTROLE SHOPEE" para o Supabase do site
-- AJBorges Transporte & Logística
--
-- Fase 1: um Apps Script da conta TI lê as abas da planilha a cada 5 min e
-- envia para a edge function torre-receber-planilha, que chama
-- torre.aplicar_planilha() (só service_role). O site lê SÓ as views torre.v_*
-- (o "contrato", em torre-de-controle-shoppe/CONTRATO_DADOS.md). Na fase 2
-- (dados direto do Atlas/Shopee) as mesmas views passam a ler as tabelas
-- definitivas, com os mesmos nomes de coluna, e o site não muda.
--
--   1. Schema torre (usage só para authenticated e service_role; anon não).
--   2. Tabelas: planilha_abas, planilha_linhas, sincronizacao e colunas
--      (colunas = de qual título da planilha sai cada coluna das views; ajustar
--      um título é um UPDATE nela, sem mexer nas views nem no site).
--   3. Funções de apoio das views (título normalizado, cor -> situação etc.).
--   4. RPC torre.aplicar_planilha(p_payload jsonb): substitui as abas
--      recebidas numa transação só, com trava de 50% e limites.
--   5. Mapa título -> coluna (torre.colunas).
--   6. Views do contrato (security_invoker = true).
--   7. Acesso: RLS em tudo, leitura só para torre.eh_operador()
--      (= public.is_admin(): admin e diretoria pelo app_metadata do JWT),
--      nenhuma escrita pela API, funções fechadas para public/anon.
--
-- Abas que PODEM zerar de verdade (a trava de 50% não vale para elas):
--   - CARREGAMENTOS: só tem linha enquanto há caminhão carregando; de
--     madrugada ou no domingo pode não haver nenhum.
--   - DESCARGAS: o mesmo, só enquanto há descarga em andamento.
--   - FATURAMENTO: lista o que falta faturar; depois do fechamento fica vazia.
-- As outras (MATRIZ, VALIDAÇÕES, ORIGEM, TRÂNSITO, LINKS, ENDEREÇOS) sempre
-- têm linhas com a operação rodando: chegar vazia ou com menos da metade é
-- quase sempre erro (filtro ligado, aba renomeada, leitura errada). Nesse caso
-- a aba anterior fica, e o erro vai para torre.sincronizacao.
--
-- Não cria nem altera nada fora do schema torre. Só CHAMA public.is_admin().
--
-- Como rodar (SQL Editor do Supabase):
--   a) rode o item 0 sozinho e anote o retrato do public;
--   b) rode do "begin;" até o "commit;" (se algo falhar, nada é alterado;
--      pode ser reexecutado);
--   c) rode cada conferência do item 8 separadamente (tudo é desfeito com
--      rollback; o resultado aparece como erro "RESULTADO ...").
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Retrato do public (rode ANTES e anote; a conferência 8.8 repete e tem que dar igual)
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
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname = 'torre')
) s;


begin;


-- -----------------------------------------------------------------------------
-- 1. Schema
-- -----------------------------------------------------------------------------
create schema if not exists torre;
revoke all on schema torre from public;
grant usage on schema torre to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 2. Tabelas
--    planilha_linhas.celulas = lista na ordem das colunas:
--      [{"c": "LH", "v": "LT0Q…", "bg": "#f4cccc", "fg": "#ff0000", "url": null}, …]
--      c = título da coluna; v = texto como aparece na tela; bg/fg = cores
--      (o script omite bg branco, fg preto e url vazia); g = bloco (só na
--      MATRIZ: ORIGEM, CARREGAMENTO, TRÂNSITO, DESCARGAS); cb = true quando o
--      fundo é a cor do bloco/cabeçalho (sem significado).
-- -----------------------------------------------------------------------------
create table if not exists torre.planilha_abas (
  aba        text primary key,
  cabecalho  jsonb not null default '[]'::jsonb,
  extras     jsonb not null default '{}'::jsonb,
  copiado_em timestamptz not null default now(),
  linhas     int not null default 0
);

create table if not exists torre.planilha_linhas (
  aba     text not null,
  linha   int not null,
  celulas jsonb not null,
  primary key (aba, linha)
);

create table if not exists torre.sincronizacao (
  id           bigint generated always as identity primary key,
  iniciado_em  timestamptz not null default now(),
  terminado_em timestamptz,
  abas         int,
  linhas       int,
  erro         text
);
create index if not exists sincronizacao_iniciado_em on torre.sincronizacao (iniciado_em desc);

-- De qual título da planilha sai cada coluna das views. titulos = alternativas
-- em ordem de preferência (vale o primeiro que existir na aba); grupos = bloco
-- da MATRIZ (vazio = coluna fora dos blocos). A comparação ignora maiúsculas,
-- acentos, espaços e pontuação ("CIOT / VPO" = "ciot/vpo").
create table if not exists torre.colunas (
  aba      text not null,
  coluna   text not null,
  ordem    int not null,
  titulos  text[] not null,
  grupos   text[] not null default '{}',
  situacao boolean not null default true,
  com_url  boolean not null default false,
  primary key (aba, coluna)
);


-- -----------------------------------------------------------------------------
-- 3. Funções de apoio (usadas pelas views; executáveis só por authenticated)
-- -----------------------------------------------------------------------------

-- Título normalizado: sem acento, maiúsculo, só letras e números
create or replace function torre.chave(p_texto text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(upper(translate(coalesce(p_texto, ''),
           'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
           'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')), '[^A-Z0-9]', '', 'g')
$$;

-- Família de uma cor (#rrggbb ou #rgb): vermelho, laranja, amarelo, verde,
-- azul, preto ou neutro (branco, cinza, roxo). Por faixa de matiz, não pelo hex.
create or replace function torre.familia_cor(p_cor text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  v  text := lower(btrim(coalesce(p_cor, '')));
  r  numeric; g numeric; b numeric;
  mx numeric; mn numeric; d numeric; l numeric; s numeric; h numeric;
begin
  if v ~ '^#[0-9a-f]{3}$' then
    v := '#' || repeat(substr(v, 2, 1), 2) || repeat(substr(v, 3, 1), 2) || repeat(substr(v, 4, 1), 2);
  end if;
  if v !~ '^#[0-9a-f]{6}$' then
    return null;
  end if;
  r := ('x' || substr(v, 2, 2))::bit(8)::int / 255.0;
  g := ('x' || substr(v, 4, 2))::bit(8)::int / 255.0;
  b := ('x' || substr(v, 6, 2))::bit(8)::int / 255.0;
  mx := greatest(r, g, b);
  mn := least(r, g, b);
  d := mx - mn;
  l := (mx + mn) / 2;
  if l <= 0.15 then
    return 'preto';
  end if;
  s := case when d = 0 then 0 else d / (1 - abs(2 * l - 1)) end;
  if l >= 0.97 or s < 0.2 then
    return 'neutro';
  end if;
  if mx = r then
    h := 60 * ((g - b) / d);
  elsif mx = g then
    h := 60 * ((b - r) / d + 2);
  else
    h := 60 * ((r - g) / d + 4);
  end if;
  if h < 0 then
    h := h + 360;
  end if;
  return case
    when h < 15 or h >= 330 then 'vermelho'
    when h < 42  then 'laranja'
    when h < 70  then 'amarelo'
    when h < 165 then 'verde'
    when h < 260 then 'azul'
    else 'neutro'
  end;
end $$;

-- Situação de uma célula (torre-de-controle-shoppe/CORES.md): pela cor de
-- fundo; se o fundo não diz nada, pela cor do texto (texto azul não conta: é
-- a cor padrão de link). Fundo marcado como cor do bloco (cb) não conta.
create or replace function torre.situacao(p_celula jsonb)
returns text language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_celula) is distinct from 'object' then null else
    coalesce(
      case when coalesce(p_celula ->> 'cb', '') <> 'true' then
        case torre.familia_cor(p_celula ->> 'bg')
          when 'vermelho' then 'critico' when 'verde' then 'ok' when 'amarelo' then 'atencao'
          when 'laranja' then 'andamento' when 'azul' then 'info' when 'preto' then 'destaque'
        end
      end,
      case torre.familia_cor(p_celula ->> 'fg')
        when 'vermelho' then 'critico' when 'verde' then 'ok' when 'amarelo' then 'atencao'
        when 'laranja' then 'andamento'
      end)
  end
$$;

-- Células de uma linha indexadas por "BLOCO|TITULO" normalizados (título
-- repetido na mesma aba e bloco: vale o primeiro, da esquerda)
create or replace function torre.mapa(p_celulas jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(d.k, d.e), '{}'::jsonb)
  from (select distinct on (s.k) s.k, s.e
          from (select torre.chave(a.e ->> 'g') || '|' || torre.chave(a.e ->> 'c') as k, a.e, a.i
                  from jsonb_array_elements(case when jsonb_typeof(p_celulas) = 'array' then p_celulas else '[]'::jsonb end)
                       with ordinality as a(e, i)
                 where jsonb_typeof(a.e) = 'object') s
         order by s.k, s.i) d
$$;

-- Chaves aceitas por coluna de uma aba: {"lh": ["|LH", "|LT"], …}
create or replace function torre.titulos(p_aba text)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(c.coluna, (
           select coalesce(jsonb_agg(torre.chave(g.g) || '|' || torre.chave(t.t) order by g.i, t.i), '[]'::jsonb)
             from unnest(case when cardinality(c.grupos) > 0 then c.grupos else array[''] end) with ordinality as g(g, i)
             cross join unnest(c.titulos) with ordinality as t(t, i))), '{}'::jsonb)
    from torre.colunas c
   where c.aba = p_aba
$$;

-- Primeira célula que existir entre as chaves aceitas
create or replace function torre.celula(p_mapa jsonb, p_chaves jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select p_mapa -> a.k
    from jsonb_array_elements_text(case when jsonb_typeof(p_chaves) = 'array' then p_chaves else '[]'::jsonb end)
         with ordinality as a(k, i)
   where p_mapa ? a.k
   order by a.i
   limit 1
$$;

create or replace function torre.valor(p_celula jsonb)
returns text language sql immutable set search_path = '' as $$
  select nullif(btrim(p_celula ->> 'v'), '')
$$;

-- Link da célula (ou o próprio texto, se for um endereço). Só http/https.
create or replace function torre.url(p_celula jsonb)
returns text language sql immutable set search_path = '' as $$
  select u from (select coalesce(nullif(btrim(p_celula ->> 'url'), ''), btrim(p_celula ->> 'v')) as u) s
   where u ~* '^https?://[^[:space:]]+$'
$$;

-- Primeiro número inteiro do texto ("1.234" = 1234)
create or replace function torre.numero(p_texto text)
returns int language sql immutable set search_path = '' as $$
  select nullif(substring(replace(coalesce(p_texto, ''), '.', '') from '[0-9]{1,9}'), '')::int
$$;

-- Contador do topo da MATRIZ: acha o rótulo (linhas 1-2) e pega o número da
-- própria célula ("ROTAS ATIVAS: 12"), da de baixo ou da da direita
create or replace function torre.contador(p_topo jsonb, p_rotulos text[])
returns int language plpgsql immutable set search_path = '' as $$
declare
  v_alvos text[];
  r int;
  c int;
  v_txt text;
begin
  if jsonb_typeof(p_topo) is distinct from 'array' then
    return null;
  end if;
  select array_agg(torre.chave(x)) into v_alvos from unnest(p_rotulos) x;
  for r in 0 .. jsonb_array_length(p_topo) - 1 loop
    continue when jsonb_typeof(p_topo -> r) is distinct from 'array';
    for c in 0 .. jsonb_array_length(p_topo -> r) - 1 loop
      v_txt := p_topo -> r ->> c;
      if torre.chave(regexp_replace(coalesce(v_txt, ''), '[0-9]', '', 'g')) = any(v_alvos) then
        return coalesce(torre.numero(v_txt), torre.numero(p_topo -> (r + 1) ->> c), torre.numero(p_topo -> r ->> (c + 1)));
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- "29/10/2026 10:35:00", "29/10 10:35" ou "29/10/26" -> horário de Brasília
create or replace function torre.texto_para_data(p_texto text)
returns timestamptz language plpgsql stable set search_path = '' as $$
declare
  m text[] := regexp_match(coalesce(p_texto, ''),
                '([0-9]{1,2})/([0-9]{1,2})(?:/([0-9]{2,4}))?(?:[^0-9]+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?');
  v_ano int;
begin
  if m is null then
    return null;
  end if;
  v_ano := coalesce(m[3]::int, extract(year from now() at time zone 'America/Sao_Paulo')::int);
  if v_ano < 100 then
    v_ano := v_ano + 2000;
  end if;
  return make_timestamptz(v_ano, m[2]::int, m[1]::int, coalesce(m[4]::int, 0), coalesce(m[5]::int, 0),
                          coalesce(m[6]::int, 0), 'America/Sao_Paulo');
exception when others then
  return null;
end $$;

-- Quem vê a Torre: o mesmo is_admin() do site (admin e diretoria)
create or replace function torre.eh_operador()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.is_admin(), false)
$$;


-- -----------------------------------------------------------------------------
-- 4. RPC torre.aplicar_planilha(p_payload jsonb) - só service_role (edge function)
--    { "abas": [ { "aba", "cabecalho", "extras", "linhas": [ { "linha", "celulas" } ] } ] }
--    - valida tudo antes de gravar; fora do formato ou dos limites (20 abas,
--      3.000 linhas por aba, 80 colunas, 1 MB por célula) ou aba fora da lista:
--      recusa tudo e registra o motivo em torre.sincronizacao;
--    - substitui cada aba recebida inteira (apaga e insere), numa transação só;
--    - trava: aba com linhas hoje que chega vazia ou com menos de 50% delas não
--      é substituída (fica a anterior; o erro é registrado), menos as que podem
--      zerar (CARREGAMENTOS, DESCARGAS, FATURAMENTO) e as que só têm dados de
--      exemplo (T01_dados_exemplo.sql);
--    - abas que não vieram ficam como estão.
-- -----------------------------------------------------------------------------
create or replace function torre.aplicar_planilha(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_abas_permitidas constant text[] := array['MATRIZ', 'VALIDAÇÕES PRÉ CARREGAMENTO', 'ORIGEM', 'CARREGAMENTOS',
    'TRÂNSITO', 'DESCARGAS', 'FATURAMENTO', 'LINKS / TREINAMENTOS', 'ENDEREÇOS'];
  c_podem_zerar constant text[] := array['CARREGAMENTOS', 'DESCARGAS', 'FATURAMENTO'];
  c_max_abas    constant int := 20;
  c_max_linhas  constant int := 3000;
  c_max_colunas constant int := 80;
  c_max_bytes   constant int := 1048576;
  v_sync       bigint;
  v_motivo     text;
  v_aba        jsonb;
  v_nome       text;
  v_nomes      text[] := '{}';
  v_n          int;
  v_novas      int;
  v_atuais     int;
  v_exemplo    boolean;
  v_avisos     text[] := '{}';
  v_bloqueadas text[] := '{}';
  v_aplicadas  int := 0;
  v_total      int := 0;
begin
  -- uma cópia por vez
  perform pg_advisory_xact_lock(hashtext('torre.aplicar_planilha'));
  insert into torre.sincronizacao (iniciado_em) values (clock_timestamp()) returning id into v_sync;

  -- Validação (nada é gravado se algo estiver errado)
  if jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload -> 'abas') is distinct from 'array' then
    v_motivo := 'formato inválido (esperado {"abas": [...]})';
  elsif jsonb_array_length(p_payload -> 'abas') = 0 then
    v_motivo := 'nenhuma aba recebida';
  elsif jsonb_array_length(p_payload -> 'abas') > c_max_abas then
    v_motivo := format('%s abas (máximo %s)', jsonb_array_length(p_payload -> 'abas'), c_max_abas);
  else
    for v_aba in select e from jsonb_array_elements(p_payload -> 'abas') e loop
      v_nome := case when jsonb_typeof(v_aba) = 'object' and jsonb_typeof(v_aba -> 'aba') = 'string' then v_aba ->> 'aba' end;
      if v_nome is null then
        v_motivo := 'aba sem nome'; exit;
      elsif not (v_nome = any(c_abas_permitidas)) then
        v_motivo := format('aba não permitida: %s', left(v_nome, 60)); exit;
      elsif v_nome = any(v_nomes) then
        v_motivo := format('%s: aba repetida', v_nome); exit;
      elsif jsonb_typeof(v_aba -> 'linhas') is distinct from 'array' then
        v_motivo := format('%s: "linhas" não é uma lista', v_nome); exit;
      elsif coalesce(jsonb_typeof(v_aba -> 'cabecalho'), 'null') not in ('array', 'object', 'null')
         or coalesce(jsonb_typeof(v_aba -> 'extras'), 'null') not in ('object', 'null') then
        v_motivo := format('%s: cabecalho/extras em formato inválido', v_nome); exit;
      elsif octet_length(coalesce(v_aba -> 'cabecalho', 'null'::jsonb)::text) > c_max_bytes
         or octet_length(coalesce(v_aba -> 'extras', 'null'::jsonb)::text) > c_max_bytes then
        v_motivo := format('%s: cabecalho/extras acima de 1 MB', v_nome); exit;
      elsif jsonb_array_length(v_aba -> 'linhas') > c_max_linhas then
        v_motivo := format('%s: %s linhas (máximo %s)', v_nome, jsonb_array_length(v_aba -> 'linhas'), c_max_linhas); exit;
      end if;
      v_nomes := v_nomes || v_nome;

      select count(*) into v_n
        from jsonb_array_elements(v_aba -> 'linhas') l
       where not (jsonb_typeof(l) = 'object'
                  and jsonb_typeof(l -> 'linha') = 'number' and (l ->> 'linha') ~ '^[1-9][0-9]{0,6}$'
                  and jsonb_typeof(l -> 'celulas') = 'array');
      if v_n > 0 then
        v_motivo := format('%s: %s linha(s) fora do formato {"linha": n, "celulas": [...]}', v_nome, v_n); exit;
      end if;
      select count(*) - count(distinct l ->> 'linha') into v_n from jsonb_array_elements(v_aba -> 'linhas') l;
      if v_n > 0 then
        v_motivo := format('%s: número de linha repetido', v_nome); exit;
      end if;
      select coalesce(max(jsonb_array_length(l -> 'celulas')), 0) into v_n from jsonb_array_elements(v_aba -> 'linhas') l;
      if v_n > c_max_colunas then
        v_motivo := format('%s: %s colunas (máximo %s)', v_nome, v_n, c_max_colunas); exit;
      end if;
      select count(*) filter (where jsonb_typeof(c) <> 'object'),
             count(*) filter (where octet_length(c::text) > c_max_bytes)
        into v_n, v_novas
        from jsonb_array_elements(v_aba -> 'linhas') l, jsonb_array_elements(l -> 'celulas') c;
      if v_n > 0 then
        v_motivo := format('%s: célula fora do formato', v_nome); exit;
      elsif v_novas > 0 then
        v_motivo := format('%s: célula acima de 1 MB', v_nome); exit;
      end if;
    end loop;
  end if;

  if v_motivo is not null then
    update torre.sincronizacao
       set terminado_em = clock_timestamp(), abas = 0, linhas = 0, erro = 'recusado: ' || v_motivo
     where id = v_sync;
    return jsonb_build_object('ok', false, 'recusado', true, 'abas', 0, 'linhas', 0, 'erro', v_motivo);
  end if;

  -- Aplicação
  for v_aba in select e from jsonb_array_elements(p_payload -> 'abas') e loop
    v_nome := v_aba ->> 'aba';
    v_novas := jsonb_array_length(v_aba -> 'linhas');
    select count(*) into v_atuais from torre.planilha_linhas where aba = v_nome;
    select coalesce(a.extras ->> 'exemplo', '') = 'true' into v_exemplo from torre.planilha_abas a where a.aba = v_nome;

    if v_atuais > 0 and v_novas < v_atuais * 0.5
       and not (v_nome = any(c_podem_zerar)) and not coalesce(v_exemplo, false) then
      v_bloqueadas := v_bloqueadas || v_nome;
      v_avisos := v_avisos || format('%s: chegou com %s linha(s) e tem %s hoje (trava de 50%%); mantida a anterior',
                                     v_nome, v_novas, v_atuais);
      continue;
    end if;

    delete from torre.planilha_linhas where aba = v_nome;
    insert into torre.planilha_linhas (aba, linha, celulas)
    select v_nome, (l ->> 'linha')::int, l -> 'celulas'
      from jsonb_array_elements(v_aba -> 'linhas') l;
    insert into torre.planilha_abas (aba, cabecalho, extras, copiado_em, linhas)
    values (v_nome,
            coalesce(nullif(v_aba -> 'cabecalho', 'null'::jsonb), '[]'::jsonb),
            coalesce(nullif(v_aba -> 'extras', 'null'::jsonb), '{}'::jsonb) - 'exemplo',
            now(), v_novas)
    on conflict (aba) do update
      set cabecalho = excluded.cabecalho, extras = excluded.extras,
          copiado_em = excluded.copiado_em, linhas = excluded.linhas;
    v_aplicadas := v_aplicadas + 1;
    v_total := v_total + v_novas;
  end loop;

  update torre.sincronizacao
     set terminado_em = clock_timestamp(), abas = v_aplicadas, linhas = v_total,
         erro = nullif(array_to_string(v_avisos, '; '), '')
   where id = v_sync;
  delete from torre.sincronizacao where iniciado_em < now() - interval '30 days';

  return jsonb_build_object('ok', cardinality(v_bloqueadas) = 0, 'abas', v_aplicadas, 'linhas', v_total,
                            'bloqueadas', to_jsonb(v_bloqueadas),
                            'erro', nullif(array_to_string(v_avisos, '; '), ''));
end $$;


-- -----------------------------------------------------------------------------
-- 5. Mapa título da planilha -> coluna das views
--    Os títulos da TRÂNSITO são os da planilha. Os das outras abas são os
--    prováveis: confira depois da 1ª cópia (consulta no fim do CONTRATO_DADOS.md)
--    e, se algum não bater, ajuste aqui E no banco:
--      update torre.colunas set titulos = array['TÍTULO NOVO'] where aba = '…' and coluna = '…';
--    Rodar este arquivo de novo regrava o mapa com o que está aqui.
-- -----------------------------------------------------------------------------
insert into torre.colunas (aba, coluna, ordem, titulos, grupos, situacao, com_url)
select m.aba, m.coluna, row_number() over ()::int, m.titulos, m.grupos, m.situacao, m.com_url
from (values
  -- MATRIZ (linha 6 = títulos, linha 5 = blocos)
  ('MATRIZ', 'lh',                         array['LH', 'LT'],                                       '{}'::text[],                        true,  false),
  ('MATRIZ', 'motorista',                  array['MOTORISTA'],                                      '{}',                                true,  false),
  ('MATRIZ', 'cavalo',                     array['CAVALO', 'PLACA', 'PLACA CAVALO'],                '{}',                                true,  false),
  ('MATRIZ', 'carreta',                    array['CARRETA', 'PLACA CARRETA'],                       '{}',                                true,  false),
  ('MATRIZ', 'origem_eta',                 array['ETA', 'ETA ORIGEM'],                              array['ORIGEM'],                     true,  false),
  ('MATRIZ', 'origem_localizacao',         array['LOCALIZAÇÃO', 'POSIÇÃO ATUAL', 'POSIÇÃO'],        array['ORIGEM'],                     true,  true),
  ('MATRIZ', 'origem_km',                  array['KM', 'KM RESTANTE', 'DISTÂNCIA'],                 array['ORIGEM'],                     true,  false),
  ('MATRIZ', 'origem_timer',               array['TIMER'],                                          array['ORIGEM'],                     true,  false),
  ('MATRIZ', 'carregamento_cpt',           array['CPT'],                                            array['CARREGAMENTO', 'CARREGAMENTOS'], true, false),
  ('MATRIZ', 'carregamento_timer',         array['TIMER'],                                          array['CARREGAMENTO', 'CARREGAMENTOS'], true, false),
  ('MATRIZ', 'carregamento_status',        array['STATUS'],                                         array['CARREGAMENTO', 'CARREGAMENTOS'], true, false),
  ('MATRIZ', 'transito_previsao_chegada',  array['PREVISÃO DE CHEGADA', 'PREVISÃO CHEGADA', 'PREVISÃO'], array['TRÂNSITO'],             true,  false),
  ('MATRIZ', 'transito_cpt',               array['CPT'],                                            array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_eta_destino',       array['ETA DESTINO', 'ETA'],                             array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_status',            array['STATUS'],                                         array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_parada',            array['PARADA', 'T PARADA', 'TEMPO PARADO'],             array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_kh',                array['KM/H', 'K/H', 'KH'],                              array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'transito_tt_restante',       array['TT RESTANTE', 'TEMPO RESTANTE', 'TT'],            array['TRÂNSITO'],                   true,  false),
  ('MATRIZ', 'descarga_chegada',           array['CHEGADA'],                                        array['DESCARGAS', 'DESCARGA'],      true,  false),
  ('MATRIZ', 'descarga_timer',             array['TIMER'],                                          array['DESCARGAS', 'DESCARGA'],      true,  false),
  ('MATRIZ', 'descarga_status',            array['STATUS'],                                         array['DESCARGAS', 'DESCARGA'],      true,  false),
  -- VALIDAÇÕES PRÉ CARREGAMENTO (títulos na linha 3)
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'lh',          array['LH', 'LT'],                                 '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'motorista',   array['MOTORISTA'],                                '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'contato',     array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'], '{}',                             true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'cavalo',      array['CAVALO', 'PLACA', 'PLACA CAVALO'],          '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'carreta',     array['CARRETA', 'PLACA CARRETA'],                 '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'vinculo',     array['VÍNCULO'],                                  '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'origem',      array['ORIGEM'],                                   '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'destino',     array['DESTINO'],                                  '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'cpt',         array['CPT', 'CPT ORIGEM'],                        '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'checklist',   array['CHECKLIST', 'CHECK LIST'],                  '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'gr',          array['GR', 'GERENCIAMENTO DE RISCO'],             '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'rastreador',  array['RASTREADOR', 'ISCA'],                       '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'ciot_vpo',    array['CIOT / VPO', 'CIOT', 'VPO'],                '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'sm',          array['SM'],                                       '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'status',      array['STATUS'],                                   '{}',                                true,  false),
  ('VALIDAÇÕES PRÉ CARREGAMENTO', 'observacao',  array['OBSERVAÇÃO', 'OBSERVAÇÕES', 'OBS'],         '{}',                                true,  false),
  -- ORIGEM
  ('ORIGEM', 'lh',             array['LH', 'LT'],                                 '{}', true, false),
  ('ORIGEM', 'motorista',      array['MOTORISTA'],                                '{}', true, false),
  ('ORIGEM', 'contato',        array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'], '{}', true, false),
  ('ORIGEM', 'cavalo',         array['CAVALO', 'PLACA', 'PLACA CAVALO'],          '{}', true, false),
  ('ORIGEM', 'carreta',        array['CARRETA', 'PLACA CARRETA'],                 '{}', true, false),
  ('ORIGEM', 'vinculo',        array['VÍNCULO'],                                  '{}', true, false),
  ('ORIGEM', 'origem',         array['ORIGEM'],                                   '{}', true, false),
  ('ORIGEM', 'destino',        array['DESTINO'],                                  '{}', true, false),
  ('ORIGEM', 'posicao_atual',  array['POSIÇÃO ATUAL', 'LOCALIZAÇÃO', 'POSIÇÃO'],  '{}', true, true),
  ('ORIGEM', 'km',             array['KM', 'KM RESTANTE', 'DISTÂNCIA'],           '{}', true, false),
  ('ORIGEM', 'eta',            array['ETA', 'ETA ORIGEM', 'PREVISÃO DE CHEGADA'], '{}', true, false),
  ('ORIGEM', 'cpt',            array['CPT', 'CPT ORIGEM'],                        '{}', true, false),
  ('ORIGEM', 'timer',          array['TIMER'],                                    '{}', true, false),
  ('ORIGEM', 'status',         array['STATUS'],                                   '{}', true, false),
  -- CARREGAMENTOS
  ('CARREGAMENTOS', 'lh',                   array['LH', 'LT'],                                 '{}', true, false),
  ('CARREGAMENTOS', 'motorista',            array['MOTORISTA'],                                '{}', true, false),
  ('CARREGAMENTOS', 'contato',              array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'], '{}', true, false),
  ('CARREGAMENTOS', 'cavalo',               array['CAVALO', 'PLACA', 'PLACA CAVALO'],          '{}', true, false),
  ('CARREGAMENTOS', 'carreta',              array['CARRETA', 'PLACA CARRETA'],                 '{}', true, false),
  ('CARREGAMENTOS', 'vinculo',              array['VÍNCULO'],                                  '{}', true, false),
  ('CARREGAMENTOS', 'origem',               array['ORIGEM'],                                   '{}', true, false),
  ('CARREGAMENTOS', 'destino',              array['DESTINO'],                                  '{}', true, false),
  ('CARREGAMENTOS', 'chegada',              array['CHEGADA', 'CHEGADA ORIGEM'],                '{}', true, false),
  ('CARREGAMENTOS', 'cpt',                  array['CPT', 'CPT ORIGEM'],                        '{}', true, false),
  ('CARREGAMENTOS', 'inicio_carregamento',  array['INÍCIO CARREGAMENTO', 'INÍCIO'],            '{}', true, false),
  ('CARREGAMENTOS', 'timer',                array['TIMER'],                                    '{}', true, false),
  ('CARREGAMENTOS', 'status',               array['STATUS'],                                   '{}', true, false),
  -- TRÂNSITO (colunas A-Z da planilha)
  ('TRÂNSITO', 'lh',                 array['LH'],                                       '{}', true, false),
  ('TRÂNSITO', 'motorista',          array['MOTORISTA'],                                '{}', true, false),
  ('TRÂNSITO', 'carga',              array['CARGA'],                                    '{}', true, false),
  ('TRÂNSITO', 'contato',            array['CONTATO DO MOTORISTA', 'CONTATO'],          '{}', true, false),
  ('TRÂNSITO', 'cavalo',             array['CAVALO'],                                   '{}', true, false),
  ('TRÂNSITO', 'carreta',            array['CARRETA'],                                  '{}', true, false),
  ('TRÂNSITO', 'vinculo',            array['VÍNCULO'],                                  '{}', true, false),
  ('TRÂNSITO', 'origem',             array['ORIGEM'],                                   '{}', true, false),
  ('TRÂNSITO', 'destino',            array['DESTINO'],                                  '{}', true, false),
  ('TRÂNSITO', 'posicao_atual',      array['POSIÇÃO ATUAL'],                            '{}', true, true),
  ('TRÂNSITO', 'cpt_origem',         array['CPT ORIGEM'],                               '{}', true, false),
  ('TRÂNSITO', 'cpt_realizado',      array['CPT REALIZADO'],                            '{}', true, false),
  ('TRÂNSITO', 'pct',                array['PCT'],                                      '{}', true, false),
  ('TRÂNSITO', 'km_h',               array['KM/H'],                                     '{}', true, false),
  ('TRÂNSITO', 't_parada',           array['T PARADA'],                                 '{}', true, false),
  ('TRÂNSITO', 'total_parada',       array['TOTAL PARADA'],                             '{}', true, false),
  ('TRÂNSITO', 'macro',              array['MACRO'],                                    '{}', true, false),
  ('TRÂNSITO', 'atualizacao',        array['ATUALIZAÇÃO'],                              '{}', true, false),
  ('TRÂNSITO', 'previsao_chegada',   array['PREVISÃO DE CHEGADA'],                      '{}', true, false),
  ('TRÂNSITO', 'eta_destino',        array['ETA DESTINO'],                              '{}', true, false),
  ('TRÂNSITO', 't_chegada',          array['T CHEGADA'],                                '{}', true, false),
  ('TRÂNSITO', 'status',             array['STATUS'],                                   '{}', true, false),
  ('TRÂNSITO', 'progressao_viagem',  array['PROGRESSÃO VIAGEM', 'PROGRESSÃO DA VIAGEM'], '{}', true, false),
  ('TRÂNSITO', 'faturamento',        array['FATURAMENTO'],                              '{}', true, false),
  ('TRÂNSITO', 'ciot_vpo',           array['CIOT / VPO'],                               '{}', true, false),
  ('TRÂNSITO', 'sm',                 array['SM'],                                       '{}', true, false),
  -- DESCARGAS
  ('DESCARGAS', 'lh',               array['LH', 'LT'],                                 '{}', true, false),
  ('DESCARGAS', 'motorista',        array['MOTORISTA'],                                '{}', true, false),
  ('DESCARGAS', 'contato',          array['CONTATO DO MOTORISTA', 'CONTATO', 'TELEFONE'], '{}', true, false),
  ('DESCARGAS', 'cavalo',           array['CAVALO', 'PLACA', 'PLACA CAVALO'],          '{}', true, false),
  ('DESCARGAS', 'carreta',          array['CARRETA', 'PLACA CARRETA'],                 '{}', true, false),
  ('DESCARGAS', 'vinculo',          array['VÍNCULO'],                                  '{}', true, false),
  ('DESCARGAS', 'origem',           array['ORIGEM'],                                   '{}', true, false),
  ('DESCARGAS', 'destino',          array['DESTINO'],                                  '{}', true, false),
  ('DESCARGAS', 'chegada',          array['CHEGADA', 'CHEGADA DESTINO'],               '{}', true, false),
  ('DESCARGAS', 'inicio_descarga',  array['INÍCIO DESCARGA', 'INÍCIO'],                '{}', true, false),
  ('DESCARGAS', 'fim_descarga',     array['FIM DESCARGA', 'FIM', 'TÉRMINO'],           '{}', true, false),
  ('DESCARGAS', 'timer',            array['TIMER'],                                    '{}', true, false),
  ('DESCARGAS', 'status',           array['STATUS'],                                   '{}', true, false),
  -- FATURAMENTO
  ('FATURAMENTO', 'lh',          array['LH', 'LT'],                         '{}', true, false),
  ('FATURAMENTO', 'motorista',   array['MOTORISTA'],                        '{}', true, false),
  ('FATURAMENTO', 'cavalo',      array['CAVALO', 'PLACA', 'PLACA CAVALO'],  '{}', true, false),
  ('FATURAMENTO', 'carreta',     array['CARRETA', 'PLACA CARRETA'],         '{}', true, false),
  ('FATURAMENTO', 'vinculo',     array['VÍNCULO'],                          '{}', true, false),
  ('FATURAMENTO', 'origem',      array['ORIGEM'],                           '{}', true, false),
  ('FATURAMENTO', 'destino',     array['DESTINO'],                          '{}', true, false),
  ('FATURAMENTO', 'data',        array['DATA', 'DATA VIAGEM'],              '{}', true, false),
  ('FATURAMENTO', 'valor',       array['VALOR', 'VALOR FRETE', 'FRETE'],    '{}', true, false),
  ('FATURAMENTO', 'cte',         array['CTE', 'CT-E'],                      '{}', true, false),
  ('FATURAMENTO', 'ciot_vpo',    array['CIOT / VPO', 'CIOT', 'VPO'],        '{}', true, false),
  ('FATURAMENTO', 'status',      array['STATUS', 'FATURAMENTO'],            '{}', true, false),
  ('FATURAMENTO', 'observacao',  array['OBSERVAÇÃO', 'OBSERVAÇÕES', 'OBS'], '{}', true, false),
  -- LINKS / TREINAMENTOS (sem cabeçalho: o script usa a letra da coluna)
  ('LINKS / TREINAMENTOS', 'titulo',  array['B'], '{}', false, false),
  ('LINKS / TREINAMENTOS', 'link',    array['C'], '{}', false, true),
  ('LINKS / TREINAMENTOS', 'link_2',  array['D'], '{}', false, true),
  -- ENDEREÇOS
  ('ENDEREÇOS', 'nome',        array['NOME', 'LOCAL', 'UNIDADE', 'CD', 'HUB'],          '{}', false, false),
  ('ENDEREÇOS', 'endereco',    array['ENDEREÇO', 'ENDEREÇO COMPLETO'],                  '{}', false, false),
  ('ENDEREÇOS', 'cidade',      array['CIDADE', 'MUNICÍPIO'],                            '{}', false, false),
  ('ENDEREÇOS', 'uf',          array['UF', 'ESTADO'],                                   '{}', false, false),
  ('ENDEREÇOS', 'cep',         array['CEP'],                                            '{}', false, false),
  ('ENDEREÇOS', 'contato',     array['CONTATO', 'TELEFONE'],                            '{}', false, false),
  ('ENDEREÇOS', 'horario',     array['HORÁRIO', 'HORÁRIO DE FUNCIONAMENTO'],            '{}', false, false),
  ('ENDEREÇOS', 'mapa',        array['MAPA', 'LINK', 'LOCALIZAÇÃO', 'GOOGLE MAPS'],     '{}', false, true),
  ('ENDEREÇOS', 'observacao',  array['OBSERVAÇÃO', 'OBSERVAÇÕES', 'OBS'],               '{}', false, false)
) as m(aba, coluna, titulos, grupos, situacao, com_url)
on conflict (aba, coluna) do update
  set ordem = excluded.ordem, titulos = excluded.titulos, grupos = excluded.grupos,
      situacao = excluded.situacao, com_url = excluded.com_url;


-- -----------------------------------------------------------------------------
-- 6. Views do contrato (o site só lê estas). security_invoker = true: quem
--    consulta passa pela RLS das tabelas (só torre.eh_operador() vê).
--    Cada view: ordem (na fase 1, a linha da planilha) + as colunas de
--    torre.colunas, na ordem; para cada coluna com situacao = true, também
--    <coluna>_situacao; com com_url = true, também <coluna>_url.
--    v_matriz tem ainda etapa (origem / carregamento / transito / descarga).
--    create or replace view não deixa tirar nem renomear coluna: o contrato
--    só cresce (coluna nova entra no fim).
-- -----------------------------------------------------------------------------
do $$
declare
  v       record;
  v_cels  text;
  v_cols  text;
  v_etapa text;
begin
  for v in select * from (values
      ('v_matriz', 'MATRIZ'), ('v_validacoes', 'VALIDAÇÕES PRÉ CARREGAMENTO'), ('v_origem', 'ORIGEM'),
      ('v_carregamentos', 'CARREGAMENTOS'), ('v_transito', 'TRÂNSITO'), ('v_descargas', 'DESCARGAS'),
      ('v_faturamento', 'FATURAMENTO'), ('v_links', 'LINKS / TREINAMENTOS'), ('v_enderecos', 'ENDEREÇOS')) x(visao, aba)
  loop
    select string_agg(format('torre.celula(x.m, t.t -> %L) as %I', c.coluna, c.coluna), E',\n         ' order by c.ordem),
           string_agg(format('torre.valor(k.%I) as %I', c.coluna, c.coluna)
                      || case when c.com_url then format(E',\n       torre.url(k.%I) as %I', c.coluna, c.coluna || '_url') else '' end
                      || case when c.situacao then format(E',\n       torre.situacao(k.%I) as %I', c.coluna, c.coluna || '_situacao') else '' end,
                      E',\n       ' order by c.ordem)
      into v_cels, v_cols
      from torre.colunas c
     where c.aba = v.aba;
    if v_cels is null then
      raise exception 'torre.colunas não tem colunas para a aba %', v.aba;
    end if;

    v_etapa := '';
    if v.aba = 'MATRIZ' then
      -- o bloco mais adiantado que tiver alguma coluna preenchida
      select E'\n       case ' || string_agg(format('when coalesce(%s) is not null then %L', e.cols, e.etapa), ' ' order by e.prio)
             || E' end as etapa,'
        into v_etapa
        from (select p.prio, p.etapa,
                     string_agg(format('torre.valor(k.%I)', c.coluna), ', ' order by c.ordem) as cols
                from (values (1, 'descarga_', 'descarga'), (2, 'transito_', 'transito'),
                             (3, 'carregamento_', 'carregamento'), (4, 'origem_', 'origem')) p(prio, prefixo, etapa)
                join torre.colunas c on c.aba = 'MATRIZ' and c.coluna like p.prefixo || '%' and cardinality(c.grupos) > 0
               group by p.prio, p.etapa) e;
    end if;

    execute format($v$
create or replace view torre.%I with (security_invoker = true) as
select l.linha as ordem,%s
       %s
from torre.planilha_linhas l
cross join (select torre.titulos(%L) as t offset 0) t
cross join lateral (select torre.mapa(l.celulas) as m offset 0) x
cross join lateral (select %s offset 0) k
where l.aba = %L$v$, v.visao, v_etapa, v_cols, v.aba, v_cels, v.aba);
  end loop;
end $$;

-- Contadores do topo da MATRIZ (linhas 1-2) e "Última atualização" (linha 5)
create or replace view torre.v_matriz_contadores with (security_invoker = true) as
select torre.contador(a.extras -> 'topo', array['ROTAS ATIVAS'])                                         as rotas_ativas,
       torre.contador(a.extras -> 'topo', array['PENDENTES CHEGADA', 'PENDENTES DE CHEGADA', 'PENDENTE CHEGADA']) as pendentes_chegada,
       torre.contador(a.extras -> 'topo', array['CARREGAMENTOS', 'CARREGAMENTO'])                         as carregamentos,
       torre.contador(a.extras -> 'topo', array['TRÂNSITO', 'EM TRÂNSITO'])                               as transito,
       torre.contador(a.extras -> 'topo', array['ATRASOS', 'ATRASADOS', 'ATRASO'])                        as atrasos,
       torre.contador(a.extras -> 'topo', array['DESCARGA', 'DESCARGAS'])                                 as descarga,
       torre.texto_para_data(a.extras ->> 'ultima_atualizacao')                                         as atualizado_em,
       a.copiado_em
  from torre.planilha_abas a
 where a.aba = 'MATRIZ';

-- Última sincronização boa (que aplicou pelo menos uma aba) e a última tentativa
create or replace view torre.v_status with (security_invoker = true) as
select b.terminado_em                                                  as ultima_sincronizacao,
       floor(extract(epoch from (now() - b.terminado_em)) / 60)::int  as minutos_desde,
       b.abas,
       b.linhas,
       u.iniciado_em                                                   as ultima_tentativa,
       u.erro                                                          as ultimo_erro
  from (select s.iniciado_em, s.erro from torre.sincronizacao s order by s.iniciado_em desc, s.id desc limit 1) u
  left join lateral (select s.terminado_em, s.abas, s.linhas from torre.sincronizacao s
                      where s.terminado_em is not null and s.abas > 0
                      order by s.terminado_em desc, s.id desc limit 1) b on true;


-- -----------------------------------------------------------------------------
-- 7. Acesso
--    - RLS em todas as tabelas; select só para torre.eh_operador();
--    - nenhuma policy nem grant de insert/update/delete: ninguém grava pela
--      API (a cópia entra só pela RPC, que é security definer);
--    - funções fechadas para public/anon; authenticated executa só as de
--      apoio das views; aplicar_planilha só service_role;
--    - default privileges: o que for criado depois no schema torre já nasce fechado.
-- -----------------------------------------------------------------------------
alter table torre.planilha_abas   enable row level security;
alter table torre.planilha_linhas enable row level security;
alter table torre.sincronizacao   enable row level security;
alter table torre.colunas         enable row level security;

drop policy if exists torre_operador_le on torre.planilha_abas;
drop policy if exists torre_operador_le on torre.planilha_linhas;
drop policy if exists torre_operador_le on torre.sincronizacao;
drop policy if exists torre_operador_le on torre.colunas;
create policy torre_operador_le on torre.planilha_abas   for select to authenticated using (torre.eh_operador());
create policy torre_operador_le on torre.planilha_linhas for select to authenticated using (torre.eh_operador());
create policy torre_operador_le on torre.sincronizacao   for select to authenticated using (torre.eh_operador());
create policy torre_operador_le on torre.colunas         for select to authenticated using (torre.eh_operador());

revoke all on all tables in schema torre from public, anon, authenticated, service_role;
revoke all on all sequences in schema torre from public, anon, authenticated, service_role;
grant select on all tables in schema torre to authenticated;

revoke all on all functions in schema torre from public, anon, authenticated, service_role;
grant execute on function
  torre.chave(text), torre.familia_cor(text), torre.situacao(jsonb), torre.mapa(jsonb), torre.titulos(text),
  torre.celula(jsonb, jsonb), torre.valor(jsonb), torre.url(jsonb), torre.numero(text),
  torre.contador(jsonb, text[]), torre.texto_para_data(text), torre.eh_operador()
  to authenticated;
grant execute on function torre.aplicar_planilha(jsonb) to service_role;

alter default privileges in schema torre revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema torre revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema torre revoke execute on functions from public, anon, authenticated, service_role;


commit;


-- =============================================================================
-- 8. Conferências (depois do commit; rode cada bloco separadamente)
--    O resultado aparece como erro "RESULTADO ..." e tudo é desfeito (rollback).
--    Motorista = primeiro perfil com role = 'motorista' (escolhido ANTES do
--    set role; sem nenhum, um id qualquer). Admin = claims com
--    app_metadata.role = 'admin' (é o que o public.is_admin() lê).
--    Onde é preciso ler como o usuário do SQL Editor depois de testar como
--    outro papel, o reset role fica fora do bloco do $$.
--    A linha de teste usa o número de linha 999999 (não existe na planilha).
-- =============================================================================

-- 8.1 Estrutura e permissões (esperado: tabelas_rls=colunas:true, planilha_abas:true, planilha_linhas:true, sincronizacao:true | views_invoker=11 de 11 | policies=4 (só select) | anon_usa_schema=f | anon_privilegios=0 | authenticated_escrita=0 | funcoes_para_anon=0 | rpc_authenticated=f | rpc_service_role=t | service_role_tabelas=0)
do $$
begin
  raise exception 'RESULTADO: tabelas_rls=% | views_invoker=% de % | policies=% | anon_usa_schema=% | anon_privilegios=% | authenticated_escrita=% | funcoes_para_anon=% | rpc_authenticated=% | rpc_service_role=% | service_role_tabelas=%',
    (select string_agg(c.relname || ':' || c.relrowsecurity, ', ' order by c.relname)
       from pg_class c where c.relnamespace = 'torre'::regnamespace and c.relkind = 'r'),
    (select count(*) from pg_class c where c.relnamespace = 'torre'::regnamespace and c.relkind = 'v'
        and 'security_invoker=true' = any(c.reloptions)),
    (select count(*) from pg_class c where c.relnamespace = 'torre'::regnamespace and c.relkind = 'v'),
    (select count(*) || case when bool_and(cmd = 'SELECT') then ' (só select)' else ' (TEM ESCRITA)' end
       from pg_policies where schemaname = 'torre'),
    has_schema_privilege('anon', 'torre', 'usage'),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.grantee in (0::oid, 'anon'::regrole::oid)),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.grantee = 'authenticated'::regrole::oid and a.privilege_type <> 'SELECT'),
    (select count(*) from pg_proc p where p.pronamespace = 'torre'::regnamespace and has_function_privilege('anon', p.oid, 'execute')),
    has_function_privilege('authenticated', 'torre.aplicar_planilha(jsonb)', 'execute'),
    has_function_privilege('service_role', 'torre.aplicar_planilha(jsonb)', 'execute'),
    (select count(*) from pg_class c, aclexplode(c.relacl) a
      where c.relnamespace = 'torre'::regnamespace and a.grantee = 'service_role'::regrole::oid);
end $$;

-- 8.2 Anon não vê nada (esperado: leu=nada | bloqueados=13 de 13 | rpc=bloqueada)
begin;
insert into torre.planilha_linhas (aba, linha, celulas)
values ('TRÂNSITO', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "STATUS", "v": "ATRASADO", "bg": "#f4cccc"}]');
set local role anon;
do $$
declare
  o text;
  v_n bigint;
  v_leu text := '';
  v_bloq int := 0;
  v_rpc text := 'LIBERADA';
begin
  foreach o in array array['v_matriz', 'v_validacoes', 'v_origem', 'v_carregamentos', 'v_transito', 'v_descargas',
                           'v_faturamento', 'v_links', 'v_enderecos', 'v_matriz_contadores', 'v_status',
                           'planilha_linhas', 'planilha_abas'] loop
    begin
      execute format('select count(*) from torre.%I', o) into v_n;
      v_leu := v_leu || o || '=' || v_n || ' ';
    exception when insufficient_privilege then
      v_bloq := v_bloq + 1;
    end;
  end loop;
  begin
    perform torre.aplicar_planilha('{"abas": []}'::jsonb);
  exception when insufficient_privilege then
    v_rpc := 'bloqueada';
  end;
  raise exception 'RESULTADO (nada foi salvo): leu=% | bloqueados=% de 13 | rpc=%', coalesce(nullif(btrim(v_leu), ''), 'nada'), v_bloq, v_rpc;
end $$;
rollback;

-- 8.3 Motorista logado (sem papel admin) não vê nada (esperado: linhas_vistas=0 | rpc=bloqueada | eh_operador=f)
begin;
insert into torre.planilha_linhas (aba, linha, celulas)
values ('TRÂNSITO', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"c": "STATUS", "v": "ATRASADO", "bg": "#f4cccc"}]');
select set_config('request.jwt.claims',
         json_build_object('sub', coalesce((select id from public.perfis where role = 'motorista' order by id limit 1), gen_random_uuid()),
                           'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare
  o text;
  v_n bigint;
  v_total bigint := 0;
  v_rpc text := 'LIBERADA';
begin
  foreach o in array array['v_matriz', 'v_validacoes', 'v_origem', 'v_carregamentos', 'v_transito', 'v_descargas',
                           'v_faturamento', 'v_links', 'v_enderecos', 'v_matriz_contadores', 'v_status',
                           'planilha_linhas', 'planilha_abas', 'sincronizacao', 'colunas'] loop
    execute format('select count(*) from torre.%I', o) into v_n;
    v_total := v_total + v_n;
  end loop;
  begin
    perform torre.aplicar_planilha('{"abas": []}'::jsonb);
  exception when insufficient_privilege then
    v_rpc := 'bloqueada';
  end;
  raise exception 'RESULTADO (nada foi salvo): linhas_vistas=% | rpc=% | eh_operador=%', v_total, v_rpc, torre.eh_operador();
end $$;
rollback;

-- 8.4 Admin vê, com as colunas do contrato e a situação pela cor (esperado: lh=LT0TESTE | status=ATRASADO | status_situacao=critico | posicao_atual_url=https://exemplo.invalid/mapa | cpt_origem_situacao=ok | sem_cor=(null) | matriz_etapa=transito | matriz_transito_status_situacao=andamento | matriz_descarga_status=(null))
begin;
insert into torre.planilha_linhas (aba, linha, celulas) values
  ('TRÂNSITO', 999999, '[{"c": "STATUS", "v": "ATRASADO", "bg": "#f4cccc"}, {"c": "LH", "v": "LT0TESTE"},
                         {"c": "Posição Atual", "v": "Ver no mapa", "url": "https://exemplo.invalid/mapa"},
                         {"c": "CPT ORIGEM", "v": "29/10 10:00", "bg": "#b6d7a8"}, {"c": "MOTORISTA", "v": "Teste", "bg": "#ffffff"}]'),
  ('MATRIZ', 999999, '[{"c": "LH", "v": "LT0TESTE"}, {"g": "TRÂNSITO", "c": "STATUS", "v": "Em trânsito", "bg": "#ff9900"},
                       {"g": "DESCARGAS", "c": "STATUS", "v": ""}]');
select set_config('request.jwt.claims',
         json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
                           'app_metadata', json_build_object('role', 'admin'))::text, true);
set local role authenticated;
do $$
declare
  t record;
  m record;
begin
  select * into t from torre.v_transito where ordem = 999999;
  select * into m from torre.v_matriz where ordem = 999999;
  raise exception 'RESULTADO (nada foi salvo): lh=% | status=% | status_situacao=% | posicao_atual_url=% | cpt_origem_situacao=% | sem_cor=% | matriz_etapa=% | matriz_transito_status_situacao=% | matriz_descarga_status=%',
    t.lh, t.status, t.status_situacao, t.posicao_atual_url, t.cpt_origem_situacao, coalesce(t.motorista_situacao, '(null)'),
    m.etapa, m.transito_status_situacao, coalesce(m.descarga_status, '(null)');
end $$;
rollback;

-- 8.5 Ninguém grava pela API: admin e service_role tentam gravar direto (esperado: admin=insert:bloqueado update:bloqueado delete:bloqueado colunas:bloqueado rpc:bloqueado | service_role=insert:bloqueado update:bloqueado delete:bloqueado | linhas_iguais=t)
begin;
select set_config('t01.antes', (select count(*)::text from torre.planilha_linhas), true);
select set_config('request.jwt.claims',
         json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
                           'app_metadata', json_build_object('role', 'admin'))::text, true);
set local role authenticated;
do $$
declare
  v_res text := '';
  v_cmd text;
  v_n bigint;
begin
  foreach v_cmd in array array[
    'insert:insert into torre.planilha_linhas (aba, linha, celulas) values (''TRÂNSITO'', 999998, ''[]'')',
    'update:update torre.planilha_abas set linhas = 0',
    'delete:delete from torre.planilha_linhas',
    'colunas:update torre.colunas set titulos = array[''X'']',
    'rpc:select torre.aplicar_planilha(''{"abas": []}''::jsonb)'] loop
    begin
      execute substr(v_cmd, position(':' in v_cmd) + 1);
      get diagnostics v_n = row_count;
      v_res := v_res || split_part(v_cmd, ':', 1) || ':LIBERADO(' || v_n || ') ';
    exception when insufficient_privilege then
      v_res := v_res || split_part(v_cmd, ':', 1) || ':bloqueado ';
    end;
  end loop;
  perform set_config('t01.admin', btrim(v_res), true);
end $$;
reset role;
set local role service_role;
do $$
declare
  v_res text := '';
  v_cmd text;
begin
  foreach v_cmd in array array[
    'insert:insert into torre.planilha_linhas (aba, linha, celulas) values (''TRÂNSITO'', 999998, ''[]'')',
    'update:update torre.planilha_abas set linhas = 0',
    'delete:delete from torre.planilha_linhas'] loop
    begin
      execute substr(v_cmd, position(':' in v_cmd) + 1);
      v_res := v_res || split_part(v_cmd, ':', 1) || ':LIBERADO ';
    exception when insufficient_privilege then
      v_res := v_res || split_part(v_cmd, ':', 1) || ':bloqueado ';
    end;
  end loop;
  perform set_config('t01.service', btrim(v_res), true);
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): admin=% | service_role=% | linhas_iguais=%',
    current_setting('t01.admin'), current_setting('t01.service'),
    (select count(*)::text from torre.planilha_linhas) = current_setting('t01.antes');
end $$;
rollback;

-- 8.6 Trava dos 50% (esperado: origem_10=aplicada, 10 linhas | origem_4=bloqueada, ficou 10 | origem_vazia=bloqueada, ficou 10 | origem_5=aplicada, 5 linhas | descargas_zerou=aplicada, 0 linhas | exemplo_substituido=aplicada, 1 linha | erros_registrados=2)
begin;
delete from torre.planilha_linhas where aba in ('ORIGEM', 'DESCARGAS');
delete from torre.planilha_abas where aba in ('ORIGEM', 'DESCARGAS');
create function pg_temp.carga(p_aba text, p_n int) returns jsonb language sql as $f$
  select jsonb_build_object('abas', jsonb_build_array(jsonb_build_object('aba', p_aba, 'cabecalho', '[]'::jsonb, 'extras', '{}'::jsonb,
           'linhas', coalesce((select jsonb_agg(jsonb_build_object('linha', i + 1, 'celulas',
                                 jsonb_build_array(jsonb_build_object('c', 'LH', 'v', 'LT0TESTE' || i))))
                                 from generate_series(1, p_n) i), '[]'::jsonb))))
$f$;
do $$
declare
  v_ini timestamptz := clock_timestamp();
  r jsonb;
  v_res text[] := '{}';
  v_n int;
  v_erros int;
begin
  foreach v_n in array array[10, 4, 0, 5] loop
    r := torre.aplicar_planilha(pg_temp.carga('ORIGEM', v_n));
    v_res := v_res || format('origem_%s=%s, %s', case when v_n = 0 then 'vazia' else v_n::text end,
      case when (r -> 'bloqueadas') ? 'ORIGEM' then 'bloqueada' else 'aplicada' end,
      case when (r -> 'bloqueadas') ? 'ORIGEM' then 'ficou ' || (select count(*) from torre.planilha_linhas where aba = 'ORIGEM')
           else (select count(*) from torre.planilha_linhas where aba = 'ORIGEM') || ' linhas' end);
  end loop;
  perform torre.aplicar_planilha(pg_temp.carga('DESCARGAS', 10));
  r := torre.aplicar_planilha(pg_temp.carga('DESCARGAS', 0));
  v_res := v_res || format('descargas_zerou=%s, %s linhas',
    case when (r -> 'bloqueadas') ? 'DESCARGAS' then 'bloqueada' else 'aplicada' end,
    (select count(*) from torre.planilha_linhas where aba = 'DESCARGAS'));
  update torre.planilha_abas set extras = '{"exemplo": true}' where aba = 'ORIGEM';
  r := torre.aplicar_planilha(pg_temp.carga('ORIGEM', 1));
  v_res := v_res || format('exemplo_substituido=%s, %s linha',
    case when (r -> 'bloqueadas') ? 'ORIGEM' then 'bloqueada' else 'aplicada' end,
    (select count(*) from torre.planilha_linhas where aba = 'ORIGEM'));
  select count(*) into v_erros from torre.sincronizacao where iniciado_em >= v_ini and erro like 'ORIGEM:%trava de 50%';
  raise exception 'RESULTADO (nada foi salvo): % | erros_registrados=%', array_to_string(v_res, ' | '), v_erros;
end $$;
rollback;

-- 8.7 Limites e abas proibidas recusam tudo (esperado: 21_abas=recusado | 3001_linhas=recusado | 81_colunas=recusado | celula_1mb=recusado | configuracoes=recusado | base_atlas=recusado | linha_repetida=recusado | formato=recusado | nada_mudou=t | recusas_registradas=8)
begin;
do $$
declare
  v_ini timestamptz := clock_timestamp();
  v_antes text := (select count(*) || '/' || coalesce(max(copiado_em)::text, '') from torre.planilha_linhas l
                     left join torre.planilha_abas a using (aba));
  v_casos text[][] := array[
    ['21_abas', (select jsonb_build_object('abas', jsonb_agg(jsonb_build_object('aba', 'ORIGEM', 'linhas', '[]'::jsonb))) from generate_series(1, 21))::text],
    ['3001_linhas', jsonb_build_object('abas', jsonb_build_array(jsonb_build_object('aba', 'ORIGEM', 'linhas',
        (select jsonb_agg(jsonb_build_object('linha', i, 'celulas', '[]'::jsonb)) from generate_series(1, 3001) i))))::text],
    ['81_colunas', jsonb_build_object('abas', jsonb_build_array(jsonb_build_object('aba', 'ORIGEM', 'linhas',
        jsonb_build_array(jsonb_build_object('linha', 2, 'celulas',
          (select jsonb_agg(jsonb_build_object('c', 'C' || i, 'v', 'x')) from generate_series(1, 81) i))))))::text],
    ['celula_1mb', jsonb_build_object('abas', jsonb_build_array(jsonb_build_object('aba', 'ORIGEM', 'linhas',
        jsonb_build_array(jsonb_build_object('linha', 2, 'celulas',
          jsonb_build_array(jsonb_build_object('c', 'LH', 'v', repeat('x', 1048577))))))))::text],
    ['configuracoes', '{"abas": [{"aba": "CONFIGURAÇÕES", "linhas": []}]}'],
    ['base_atlas', '{"abas": [{"aba": "BASE ATLAS", "linhas": []}]}'],
    ['linha_repetida', '{"abas": [{"aba": "ORIGEM", "linhas": [{"linha": 2, "celulas": []}, {"linha": 2, "celulas": []}]}]}'],
    ['formato', '{"abas": "ORIGEM"}']];
  v_res text[] := '{}';
  r jsonb;
  i int;
begin
  for i in 1 .. array_length(v_casos, 1) loop
    r := torre.aplicar_planilha(v_casos[i][2]::jsonb);
    v_res := v_res || (v_casos[i][1] || '=' || case when (r ->> 'recusado')::boolean then 'recusado' else 'ACEITO' end);
  end loop;
  raise exception 'RESULTADO (nada foi salvo): % | nada_mudou=% | recusas_registradas=%', array_to_string(v_res, ' | '),
    (select count(*) || '/' || coalesce(max(copiado_em)::text, '') from torre.planilha_linhas l left join torre.planilha_abas a using (aba)) = v_antes,
    (select count(*) from torre.sincronizacao where iniciado_em >= v_ini and erro like 'recusado:%');
end $$;
rollback;

-- 8.8 Nada mudou no public (esperado: o mesmo retrato_public e itens do item 0)
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
    from pg_default_acl d where d.defaclnamespace not in (select oid from pg_namespace where nspname = 'torre')
) s;

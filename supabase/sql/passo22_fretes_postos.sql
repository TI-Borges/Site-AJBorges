-- =============================================================================
-- PASSO 22 - Fretes e abastecimentos sem limite visível (teto de 100) +
--            posto "Outro" e cadastro de postos pela gestão
-- AJBorges Transporte & Logística
--
-- A ficha deixou de ter 8 fretes e 10 abastecimentos fixos: o motorista vai
-- adicionando (a tela para em 100 por bloco). Hoje o banco corta calado o que
-- passa de 8 fretes (_limpar_fretes, passo 19) e de 10 abastecimentos
-- (_limpar_abastecimentos, passo 11). E a lista de postos da ficha era fixa no
-- relatorio.js; passa a vir da tabela nova public.postos. O que muda:
--   1. _limpar_fretes (a de 5 parâmetros, a que o trigger usa): igual à do
--      passo 19, sem o corte "i <= 8"; mais de 100 fretes = erro (nada é gravado).
--   2. _limpar_abastecimentos: igual à do passo 11, sem o corte "i <= 10";
--      mais de 100 abastecimentos = erro (nada é gravado). Guarda também
--      posto_outro (nome digitado quando o posto é "Outro"; até 80 letras,
--      limpo pela _txt como os outros textos; vazio nos outros postos).
--   As duas passam de "language sql" para "language plpgsql" só para poder dar o
--   erro; a limpeza de cada linha é a mesma.
--   3. Tabela public.postos (id, nome, ativo, criado_em, criado_por). Nome único
--      sem diferença de maiúsculas e de espaços (índice único em
--      lower(nome sem espaços sobrando)), de 1 a 80 letras.
--   4. Permissões por coluna: authenticated lê id, nome e ativo; cria só com o
--      nome; altera só o ativo. anon: nada. Apagar: nenhum grant.
--   5. RLS: quem não é da gestão só enxerga os postos ativos; a gestão
--      (public.is_admin()) enxerga todos, cria e ativa/desativa. Sem delete.
--   6. Cópia dos 38 postos da lista fixa de hoje (ativos; quem já existir não
--      é duplicado).
--
-- Não muda: trigger proteger_colunas_admin_fichas (continua chamando as duas do
-- mesmo jeito), a versão de 2 parâmetros da _limpar_fretes (o trigger não usa),
-- regra da comissão, _txt, RLS e colunas de fichas_viagem, is_admin(), login e
-- edge functions. A gestão continua sem passar pelas _limpar_* (a tela dela
-- também para em 100). Fichas já gravadas não são relidas: continuam como estão,
-- com o nome do posto que tinham (a ficha guarda o texto, não o id do posto).
--
-- Rodar no SQL Editor do Supabase até o "commit;". Tudo roda numa transação
-- (begin ... commit): se algo falhar, nada é alterado. Pode ser reexecutado.
-- As conferências ficam depois do commit: rode cada uma separadamente.
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. _limpar_fretes(p_novo, p_antigo, p_tipo, p_com_carreta, p_com_rodotrem)
--    Igual à do passo 19; sai o "i <= 8" e entra o teto de 100.
-- -----------------------------------------------------------------------------
create or replace function public._limpar_fretes(p_novo jsonb, p_antigo jsonb, p_tipo text,
                                                 p_com_carreta numeric, p_com_rodotrem numeric)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
begin
  if jsonb_typeof(p_novo) = 'array' and jsonb_array_length(p_novo) > 100 then
    raise exception 'No máximo 100 fretes por ficha.';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'data',     public._txt(n -> 'data', 20),
             'cliente',  to_jsonb(coalesce(c.cliente, '')),
             'origem',   public._txt(n -> 'origem'),
             'destino',  public._txt(n -> 'destino'),
             'veiculo',  to_jsonb(c.veiculo),
             'valor',    to_jsonb(coalesce(public._moeda_txt(c.valor), '')),
             'comissao', to_jsonb(coalesce(public._moeda_txt(
                           case
                             when c.cliente = 'mercado_livre' then 400.00
                             when c.valor is null or c.valor = 0 then null
                             when c.cliente = 'shopee'        then round(c.valor * 11 / 100, 2)
                             when c.cliente = 'alimenticio' and c.veiculo = 'rodotrem' then
                               round(c.valor * coalesce(p_com_rodotrem,
                                       case when public._eh_viana_es(public._txt(n -> 'destino') #>> '{}')
                                            then 8 else 9 end) / 100, 2)
                             when c.cliente = 'alimenticio' and c.veiculo = 'carreta' then
                               round(c.valor * coalesce(p_com_carreta, 11) / 100, 2)
                           end), '')),
             'descarga', to_jsonb(coalesce(public._moeda_txt(public._moeda(n -> 'descarga')), ''))
           ) order by i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_novo) = 'array' then p_novo else '[]'::jsonb end)
         with ordinality as t(n, i)
    cross join lateral (
      select case when (n ->> 'cliente') in ('alimenticio', 'shopee', 'mercado_livre')
                  then n ->> 'cliente' end as cliente,
             case when coalesce(p_tipo, 'carreta') not in ('rodotrem', 'carreta_rodotrem') then 'carreta'
                  when (n ->> 'veiculo') in ('carreta', 'rodotrem') then n ->> 'veiculo' end as veiculo,
             public._moeda(n -> 'valor') as valor
    ) c
    where jsonb_typeof(n) = 'object'
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. _limpar_abastecimentos(p)
--    Igual à do passo 11; sai o "i <= 10" e entra o teto de 100; + posto_outro.
-- -----------------------------------------------------------------------------
create or replace function public._limpar_abastecimentos(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $$
begin
  if jsonb_typeof(p) = 'array' and jsonb_array_length(p) > 100 then
    raise exception 'No máximo 100 abastecimentos por ficha.';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'posto',  public._txt(e -> 'posto'),
             -- nome digitado no posto "Outro" (nos outros postos fica vazio)
             'posto_outro', case when (e ->> 'posto') = 'Outro' then public._txt(e -> 'posto_outro', 80)
                                 else to_jsonb(''::text) end,
             'nf',     public._txt(e -> 'nf', 40),
             'km',     public._txt(e -> 'km', 20),
             'valor',  public._txt(e -> 'valor', 20),
             'litros', public._txt(e -> 'litros', 20),
             'combustivel', case when (e ->> 'combustivel') in ('diesel_s10', 'diesel_s500', 'arla')
                                 then e ->> 'combustivel' end,
             'placa',       case when (e ->> 'placa') in ('principal', 'secundaria')
                                 then e ->> 'placa' end
           ) order by i), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end)
         with ordinality as t(e, i)
    where jsonb_typeof(e) = 'object'
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Tabela public.postos
--    "Marília - Posto X", "marília - posto x" e "  Marília  -  Posto X " são o
--    mesmo posto (índice único no nome em minúsculas, sem espaços sobrando).
-- -----------------------------------------------------------------------------
create table if not exists public.postos (
  id          bigint generated always as identity primary key,
  nome        text not null,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now(),
  criado_por  uuid default auth.uid(),
  constraint postos_nome_tamanho check (char_length(btrim(nome)) between 1 and 80)
);

create unique index if not exists postos_nome_unico
  on public.postos (lower(regexp_replace(btrim(nome), '\s+', ' ', 'g')));


-- -----------------------------------------------------------------------------
-- 4. Permissões por coluna
--    O Supabase dá tudo para anon/authenticated em tabela nova: tira e devolve
--    só o necessário. criado_em e criado_por vêm do default.
-- -----------------------------------------------------------------------------
revoke all on public.postos from anon, authenticated;
grant select (id, nome, ativo) on public.postos to authenticated;
grant insert (nome) on public.postos to authenticated;
grant update (ativo) on public.postos to authenticated;


-- -----------------------------------------------------------------------------
-- 5. RLS
--    Motorista (e qualquer não-gestão): só os ativos. Gestão: todos (sem isso o
--    Postgres recusa desativar: a linha sairia da vista dela). Criar e
--    ativar/desativar: só a gestão. Sem policy de delete = ninguém apaga.
-- -----------------------------------------------------------------------------
alter table public.postos enable row level security;

drop policy if exists postos_ler_ativos on public.postos;
create policy postos_ler_ativos on public.postos
  for select to authenticated
  using (ativo);

drop policy if exists postos_gestao_le_todos on public.postos;
create policy postos_gestao_le_todos on public.postos
  for select to authenticated
  using (coalesce(public.is_admin(), false));

drop policy if exists postos_gestao_cria on public.postos;
create policy postos_gestao_cria on public.postos
  for insert to authenticated
  with check (coalesce(public.is_admin(), false));

drop policy if exists postos_gestao_ativa on public.postos;
create policy postos_gestao_ativa on public.postos
  for update to authenticated
  using (coalesce(public.is_admin(), false))
  with check (coalesce(public.is_admin(), false));


-- -----------------------------------------------------------------------------
-- 6. Os 38 postos da lista fixa de hoje (relatorio.js), ativos.
--    Reexecutar não duplica nem reativa posto desativado pela gestão.
-- -----------------------------------------------------------------------------
insert into public.postos (nome) values
  ('Açailândia - Posto Magnólia 06'),
  ('Anaurilândia - Posto Lala (93)'),
  ('Araporã - Posto Décio'),
  ('Araquari - Posto Russi'),
  ('Campo Grande - MS - Posto Fortaleza (IDEAL)'),
  ('Caxias do Sul - Posto Squizzato'),
  ('Centralina - MG Posto Décio'),
  ('Corumbataí - Monte Carlo'),
  ('Coxilha - Posto Buffon'),
  ('Dom Pedro de Alcântara - Posto Rota'),
  ('Guará - Posto Monte Carlo'),
  ('Gurupi - TO Posto Décio'),
  ('Juiz de Fora - Posto Dom Pedro'),
  ('Luz - Caxuxa Matriz'),
  ('Marília - Posto Esmeralda'),
  ('Marília - Posto Gigantão'),
  ('Mimoso do Sul - ES - Posto Cajú'),
  ('Mirassol - Monte Carlo'),
  ('Moema - Posto Caxuxa'),
  ('Montes Claros - Rede HG'),
  ('Nova Santa Rita - Posto Buffon'),
  ('Olímpia - Posto Rei do Suco'),
  ('Passo Fundo - Posto Buffon'),
  ('Ribeirão Preto - Monte Carlo'),
  ('Rio Claro - Monte Carlo'),
  ('Santa Cecília - Posto Cesca & Cia'),
  ('São José do Rio Preto - Posto Monte Carlo I'),
  ('Uberlândia - MG Posto Décio'),
  ('Várzea Grande - Monte Carlo'),
  ('São Gonçalo do Sapucaí - Posto Caxuxa (BR) Moinho I'),
  ('Posto Monte Carlo - Santópolis do Aguapeí'),
  ('Posto Marajó Aparecidão'),
  ('Posto Marajó Centralina'),
  ('Posto Marajó Araporã'),
  ('Posto Marajo Anapolis 1'),
  ('Posto Marajó Cariri 1'),
  ('Posto Marajó Grande Belém'),
  ('Posto Monte Carlo Nova Alexandria - Rod. Raposo Tavares')
on conflict do nothing;


commit;


-- =============================================================================
-- 7. Conferências (depois do commit; rode cada bloco separadamente)
--    Cada uma desfaz tudo no final (rollback). O resultado aparece como erro
--    "RESULTADO (nada foi salvo): ...".
--    Rodam como o primeiro perfil com role = 'motorista' (deixado como carreta,
--    sem comissão especial, dentro da mesma transação).
-- =============================================================================

-- 7.1 Motorista grava e envia 9 e 100 fretes e abastecimentos (esperado: fretes_9=9 | abast_9=9 | total_9=900.00 | fretes_100=100 | abast_100=100 | total_100=10000.00 | comissao_100=1100.00 | ultimo_frete=Destino 100 | ultimo_abast=Posto 100 | status=pendente)
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P22'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_id text;
  r9 record;
  r100 record;
  -- n fretes Shopee de 100,00 (comissão 11,00) e n abastecimentos de 50,00
  v_dc9   jsonb;
  v_dc100 jsonb;
  v_ab9   jsonb;
  v_ab100 jsonb;
begin
  select jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00', 'fretes',
           jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'shopee', 'origem', 'Origem ' || g,
                                        'destino', 'Destino ' || g, 'valor', '100,00') order by g)),
         jsonb_agg(jsonb_build_object('posto', 'Posto ' || g, 'valor', '50,00', 'litros', '10,000', 'combustivel', 'diesel_s10') order by g)
    into v_dc9, v_ab9 from generate_series(1, 9) g;
  select jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00', 'fretes',
           jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'shopee', 'origem', 'Origem ' || g,
                                        'destino', 'Destino ' || g, 'valor', '100,00') order by g)),
         jsonb_agg(jsonb_build_object('posto', 'Posto ' || g, 'valor', '50,00', 'litros', '10,000', 'combustivel', 'diesel_s10') order by g)
    into v_dc100, v_ab100 from generate_series(1, 100) g;

  -- rascunho com 9, depois com 100, e envio com 100
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('x', 'teste', 'rascunho', v_ab9, v_dc9)
  returning * into r9;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         abastecimentos = v_ab100, dados_completos = v_dc100
   where id = r9.id
  returning * into r100;
  raise exception 'RESULTADO (nada foi salvo): fretes_9=% | abast_9=% | total_9=% | fretes_100=% | abast_100=% | total_100=% | comissao_100=% | ultimo_frete=% | ultimo_abast=% | status=%',
    jsonb_array_length(r9.dados_completos -> 'fretes'), jsonb_array_length(r9.abastecimentos), r9.total_frete::numeric(14,2),
    jsonb_array_length(r100.dados_completos -> 'fretes'), jsonb_array_length(r100.abastecimentos),
    r100.total_frete::numeric(14,2), r100.vr_comissao::numeric(14,2),
    r100.dados_completos -> 'fretes' -> 99 ->> 'destino', r100.abastecimentos -> 99 ->> 'posto', r100.status;
end $$;
rollback;

-- 7.2 101 fretes ou 101 abastecimentos são recusados (esperado: fretes_101=recusado (No máximo 100 fretes por ficha.) | abast_101=recusado (No máximo 100 abastecimentos por ficha.) | fichas_gravadas=0)
begin;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_fretes text := 'GRAVOU';
  v_abast  text := 'GRAVOU';
begin
  begin
    insert into public.fichas_viagem (id, motorista, status, dados_completos)
    select 'x', 'teste', 'rascunho', jsonb_build_object('fretes',
             jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'shopee', 'origem', 'A', 'destino', 'B', 'valor', '100,00')))
      from generate_series(1, 101);
  exception when others then v_fretes := 'recusado (' || sqlerrm || ')';
  end;
  begin
    insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
    select 'x', 'teste', 'rascunho',
           jsonb_agg(jsonb_build_object('posto', 'Posto', 'valor', '50,00', 'litros', '10,000', 'combustivel', 'diesel_s10')), '{}'::jsonb
      from generate_series(1, 101);
  exception when others then v_abast := 'recusado (' || sqlerrm || ')';
  end;
  raise exception 'RESULTADO (nada foi salvo): fretes_101=% | abast_101=% | fichas_gravadas=%',
    v_fretes, v_abast, (select count(*) from public.fichas_viagem where motorista_id = auth.uid() and status = 'rascunho');
end $$;
rollback;

-- 7.3 Fichas antigas continuam válidas (esperado: fichas_com_mais_de_100=0 | antiga_8_fretes=8 | antiga_10_abast=10 | posto_antigo=Posto Antigo Fora da Lista | combustivel_vazio=(vazio) | status=pendente)
--     Uma ficha no formato de antes (8 fretes, 10 abastecimentos, sem combustível nem placa em um deles)
--     passa pelo trigger do motorista do mesmo jeito; e nenhuma ficha gravada passa do teto.
begin;
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P22'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
-- contagem feita antes do set role (a RLS do motorista esconderia as fichas dos outros)
select set_config('p22.mais_de_100', (select count(*)::text from public.fichas_viagem
         where jsonb_array_length(case when jsonb_typeof(abastecimentos) = 'array' then abastecimentos else '[]'::jsonb end) > 100
            or jsonb_array_length(case when jsonb_typeof(dados_completos -> 'fretes') = 'array' then dados_completos -> 'fretes' else '[]'::jsonb end) > 100), true);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  r record;
  v_dc jsonb;
  v_ab jsonb;
begin
  select jsonb_build_object('kmSaida', '100000', 'kmEntrada', '101500', 'valorAdiantamento', '0,00', 'fretes',
           jsonb_agg(jsonb_build_object('data', '01/10/2026', 'cliente', 'alimenticio', 'origem', 'Marília - SP',
                                        'destino', 'Santos - SP', 'valor', '1.000,00', 'comissao', '', 'descarga', '') order by g))
    into v_dc from generate_series(1, 8) g;
  select jsonb_build_array(jsonb_build_object('posto', 'Posto Antigo Fora da Lista', 'nf', '1', 'km', '100', 'valor', '600,00', 'litros', '100'))
         || jsonb_agg(jsonb_build_object('posto', 'Marília - Posto Esmeralda', 'valor', '50,00', 'litros', '10', 'combustivel', 'diesel_s10', 'placa', 'principal') order by g)
    into v_ab from generate_series(1, 9) g;
  insert into public.fichas_viagem (id, motorista, status, placas, data_saida, data_chegada, abastecimentos, dados_completos)
  values ('x', 'teste', 'pendente', 'ABC1D23', '2026-10-01', '2026-10-05', v_ab, v_dc)
  returning * into r;
  raise exception 'RESULTADO (nada foi salvo): fichas_com_mais_de_100=% | antiga_8_fretes=% | antiga_10_abast=% | posto_antigo=% | combustivel_vazio=% | status=%',
    current_setting('p22.mais_de_100'),
    jsonb_array_length(r.dados_completos -> 'fretes'), jsonb_array_length(r.abastecimentos),
    r.abastecimentos -> 0 ->> 'posto', coalesce(r.abastecimentos -> 0 ->> 'combustivel', '(vazio)'), r.status;
end $$;
rollback;

-- 7.4 Quem cria posto (esperado: anon=bloqueado | motorista=bloqueado | gestao=ok | repetido_maiusculas=recusado | repetido_espacos=recusado | criado_por_e_a_gestao=t | ativo=t)
--     "bloqueado"/"recusado" vêm com o motivo entre parênteses. O is_admin() lê o papel do JWT
--     (app_metadata.role), por isso ele vai nas claims da gestão.
begin;
-- visitante sem login
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$
begin
  begin
    insert into public.postos (nome) values ('Teste P22 Posto Anon');
    perform set_config('p22.anon', 'LIBERADO', true);
  exception when others then perform set_config('p22.anon', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
-- motorista
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
begin
  begin
    insert into public.postos (nome) values ('Teste P22 Posto Motorista');
    perform set_config('p22.motorista', 'LIBERADO', true);
  exception when others then perform set_config('p22.motorista', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
-- gestão: cria um posto e tenta o mesmo nome em minúsculas e com espaços sobrando
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' order by id limit 1), true);
set local role authenticated;
do $$
declare v_id bigint;
begin
  insert into public.postos (nome) values ('Teste P22 Posto Novo') returning id into v_id;
  perform set_config('p22.id', v_id::text, true);
  perform set_config('p22.gestao', 'ok', true);
  begin
    insert into public.postos (nome) values ('teste p22 posto novo');
    perform set_config('p22.maiusculas', 'ACEITOU', true);
  exception when others then perform set_config('p22.maiusculas', 'recusado (' || sqlerrm || ')', true);
  end;
  begin
    insert into public.postos (nome) values ('  Teste  P22   Posto Novo ');
    perform set_config('p22.espacos', 'ACEITOU', true);
  exception when others then perform set_config('p22.espacos', 'recusado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): anon=% | motorista=% | gestao=% | repetido_maiusculas=% | repetido_espacos=% | criado_por_e_a_gestao=% | ativo=%',
    current_setting('p22.anon'), current_setting('p22.motorista'), current_setting('p22.gestao'),
    current_setting('p22.maiusculas'), current_setting('p22.espacos'),
    (select criado_por = (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
       from public.postos where id = current_setting('p22.id')::bigint),
    (select ativo from public.postos where id = current_setting('p22.id')::bigint);
end $$;
rollback;

-- 7.5 Posto desativado some da lista ativa; a ficha antiga continua com o nome (esperado: motorista_via_antes=1 | b_ve_depois=0 | gestao_ve_desativado=1 | motorista_reativa=bloqueado | gestao_apaga=bloqueado | ficha_antiga=Teste P22 Posto Velho)
--     Rodam o primeiro motorista (A, que lança a ficha), o segundo (B, que lê a lista e tenta
--     reativar) e a gestão. Sem um segundo motorista, B é o próprio A.
begin;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
-- motorista B escolhido aqui (antes do set role: depois dele a RLS pode esconder o perfil de B)
select set_config('p22.b', coalesce((select id::text from public.perfis where role = 'motorista' order by id offset 1 limit 1),
                                    (select id::text from public.perfis where role = 'motorista' order by id limit 1)), true);
-- gestão cria o posto
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' order by id limit 1), true);
set local role authenticated;
do $$
declare v_id bigint;
begin
  insert into public.postos (nome) values ('Teste P22 Posto Velho') returning id into v_id;
  perform set_config('p22.id', v_id::text, true);
end $$;
reset role;
-- motorista A vê o posto e lança um abastecimento nele (rascunho)
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare v_id text;
begin
  perform set_config('p22.via_antes', (select count(*)::text from public.postos where nome = 'Teste P22 Posto Velho' and ativo), true);
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('x', 'teste', 'rascunho',
          '[{"posto":"Teste P22 Posto Velho","valor":"50,00","litros":"10,000","combustivel":"diesel_s10"}]'::jsonb, '{}'::jsonb)
  returning id into v_id;
  perform set_config('p22.ficha', v_id, true);
end $$;
reset role;
-- gestão desativa e tenta apagar
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated',
                                   'app_metadata', json_build_object('role', 'admin'))::text
            from public.perfis where role = 'admin' order by id limit 1), true);
set local role authenticated;
do $$
begin
  update public.postos set ativo = false where id = current_setting('p22.id')::bigint;
  perform set_config('p22.gestao_ve', (select count(*)::text from public.postos where id = current_setting('p22.id')::bigint and not ativo), true);
  begin
    delete from public.postos where id = current_setting('p22.id')::bigint;
    perform set_config('p22.apaga', 'LIBERADO', true);
  exception when others then perform set_config('p22.apaga', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
-- motorista B lê a lista e tenta reativar
select set_config('request.jwt.claims', json_build_object('sub', current_setting('p22.b'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$
declare v_linhas bigint;
begin
  perform set_config('p22.b_ve', (select count(*)::text from public.postos where nome = 'Teste P22 Posto Velho'), true);
  begin
    update public.postos set ativo = true where id = current_setting('p22.id')::bigint;
    get diagnostics v_linhas = row_count;
    perform set_config('p22.reativa', case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end, true);
  exception when others then perform set_config('p22.reativa', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): motorista_via_antes=% | b_ve_depois=% | gestao_ve_desativado=% | motorista_reativa=% | gestao_apaga=% | ficha_antiga=%',
    current_setting('p22.via_antes'), current_setting('p22.b_ve'), current_setting('p22.gestao_ve'),
    current_setting('p22.reativa'), current_setting('p22.apaga'),
    (select abastecimentos -> 0 ->> 'posto' from public.fichas_viagem where id = current_setting('p22.ficha'));
end $$;
rollback;

-- 7.6 Posto "Outro": o nome digitado é gravado limpo e com até 80 letras (esperado: posto=Outro | posto_outro=Posto da Estrada img src=x onerror=alert(1) | tamanho_100_vira=80 | outro_posto_sem_nome=(vazio) | relido=Posto da Estrada img src=x onerror=alert(1))
--     A _txt tira < > " ' ` (como em todo texto da ficha); a tela escapa o que mostra.
begin;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare r record;
begin
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('x', 'teste', 'rascunho', jsonb_build_array(
            jsonb_build_object('posto', 'Outro', 'posto_outro', 'Posto da Estrada <img src=x onerror=alert(1)>', 'valor', '50,00'),
            jsonb_build_object('posto', 'Outro', 'posto_outro', repeat('x', 100), 'valor', '50,00'),
            jsonb_build_object('posto', 'Marília - Posto Esmeralda', 'posto_outro', 'não vale', 'valor', '50,00')), '{}'::jsonb)
  returning * into r;
  raise exception 'RESULTADO (nada foi salvo): posto=% | posto_outro=% | tamanho_100_vira=% | outro_posto_sem_nome=% | relido=%',
    r.abastecimentos -> 0 ->> 'posto', r.abastecimentos -> 0 ->> 'posto_outro',
    char_length(r.abastecimentos -> 1 ->> 'posto_outro'),
    coalesce(nullif(r.abastecimentos -> 2 ->> 'posto_outro', ''), '(vazio)'),
    (select abastecimentos -> 0 ->> 'posto_outro' from public.fichas_viagem where id = r.id);
end $$;
rollback;

-- 7.7 Lista copiada e permissões da tabela (esperado: copiados_pelo_passo22=38 | ativos_copiados=38 | anon_le=bloqueado | policies=postos_gestao_ativa, postos_gestao_cria, postos_gestao_le_todos, postos_ler_ativos)
--     Os copiados são os sem criado_por (o SQL Editor não tem usuário); os que a gestão cadastrar têm.
begin;
set local role anon;
do $$
begin
  begin
    perform count(*) from public.postos;
    perform set_config('p22.anon_le', 'LIBERADO', true);
  exception when others then perform set_config('p22.anon_le', 'bloqueado (' || sqlerrm || ')', true);
  end;
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (só leitura): copiados_pelo_passo22=% | ativos_copiados=% | anon_le=% | policies=%',
    (select count(*) from public.postos where criado_por is null),
    (select count(*) from public.postos where criado_por is null and ativo),
    current_setting('p22.anon_le'),
    (select string_agg(policyname, ', ' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'postos');
end $$;
rollback;

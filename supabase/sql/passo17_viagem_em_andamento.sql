-- =============================================================================
-- PASSO 17 - Viagem em andamento: rascunho da ficha salvo no banco
-- AJBorges Transporte & Logística
--
-- O motorista vai preenchendo a ficha durante a viagem (status 'rascunho') e
-- envia no fim ('pendente'), na mesma linha. O que muda:
--   1. Coluna atualizado_em (gravada por um trigger novo, em toda gravação),
--      para o card "Viagem em andamento" e para a aba "Em andamento" da gestão.
--   2. No máximo 1 rascunho por motorista (índice único parcial).
--   3. proteger_colunas_admin_fichas: cópia do passo 14 (o passo 15 não mexeu
--      nela), mudando só a parte do motorista, em três pontos marcados com
--      "passo 17":
--        a) rascunho criado pelo motorista recebe um id provisório RASC-...
--           (o número AJB-... não é gasto enquanto é rascunho);
--        b) ao passar de 'rascunho' para 'pendente' (o envio), a ficha recebe
--           o número (public.reservar_numero_ficha(), a mesma do envio de
--           hoje) e data_envio = agora (o sino da frota conta por ela);
--        c) o motorista só altera ficha que ainda está em 'rascunho'
--           (pendente/aprovado: erro), qualquer que seja a RLS.
--   4. RLS de fichas_viagem: policies novas (só acrescentam) para o motorista
--      criar o próprio rascunho e atualizar só o próprio rascunho, podendo
--      passá-lo para 'pendente'.
--   5. Storage (bucket comprovantes): o motorista lê a própria pasta e apaga
--      arquivo da própria pasta só quando a ficha do caminho
--      (<id do usuário>/<id da ficha>/<arquivo>) é dele e está em 'rascunho'.
--      A consulta à ficha é feita por uma função security definer.
--   6. Auditoria (trigger trg_auditar_fichas -> gravar_auditoria_fichas()):
--      gravar rascunho (INSERT/UPDATE com status 'rascunho') não é mais
--      auditado, senão o salvamento automático enche auditoria_fichas. O envio
--      (rascunho -> pendente), as alterações da gestão e os DELETEs continuam.
--      Só entra uma linha logo depois do primeiro begin da função; o resto do
--      texto dela fica como está.
--
-- Não muda: admin/diretoria (continuam livres), regras do envio (placa, KM,
-- datas, destino, veículo do Alimentício), comissão, Viana, média, _limpar_*,
-- is_admin(), policies que já existem, envio direto como 'pendente' (aparelho
-- com a página antiga continua funcionando como hoje), login e edge functions.
--
-- ANTES DE RODAR: rode cada consulta do item 0 separadamente e confira.
-- Depois rode do "begin;" até o "commit;". Tudo roda numa transação: se algo
-- falhar, nada é alterado. Pode ser reexecutado.
-- As conferências ficam depois do commit: rode cada uma separadamente.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Consultas para rodar ANTES (só leitura; rode uma de cada vez)
-- -----------------------------------------------------------------------------

-- 0.1 Policies de hoje em fichas_viagem e storage.objects. As do passo 17
--     (item 4 e 5) só acrescentam permissão. Se aparecer uma policy de
--     DELETE em storage.objects para quem não é da gestão, me avise: ela
--     pode deixar o motorista apagar foto de ficha já enviada.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where (schemaname = 'public' and tablename = 'fichas_viagem')
   or (schemaname = 'storage' and tablename = 'objects');

-- 0.2 Triggers de fichas_viagem (o novo, zz_fichas_atualizado_em, roda depois
--     dos outros porque o Postgres dispara em ordem alfabética do nome)
select tgname, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.fichas_viagem'::regclass and not tgisinternal order by tgname;

-- 0.3 Como o número da ficha é gerado (o envio do rascunho usa esta função)
select pg_get_functiondef('public.reservar_numero_ficha'::regproc);

-- 0.4 Motorista com mais de um rascunho (tem que voltar 0 linhas; senão o
--     índice do item 2 falha e nada é alterado)
select motorista_id, count(*) from public.fichas_viagem
 where status = 'rascunho' group by motorista_id having count(*) > 1;

-- 0.5 Tabelas que apontam para fichas_viagem.id (o id do rascunho muda no
--     envio; tem que voltar 0 linhas)
select conname, conrelid::regclass from pg_constraint
 where confrelid = 'public.fichas_viagem'::regclass;

-- 0.6 Função da auditoria como está hoje (o item 6 acrescenta uma linha nela;
--     guarde este texto: é o que volta se precisar desfazer)
select pg_get_functiondef('public.gravar_auditoria_fichas()'::regprocedure);


begin;


-- -----------------------------------------------------------------------------
-- 1. atualizado_em: hora da última gravação da ficha (qualquer pessoa).
--    Gravada por trigger próprio, que roda depois do proteger_colunas_admin_fichas
--    (o INSERT do motorista zera as colunas que não são dele).
-- -----------------------------------------------------------------------------
alter table public.fichas_viagem add column if not exists atualizado_em timestamptz default now();

create or replace function public._fichas_marcar_atualizacao()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

drop trigger if exists zz_fichas_atualizado_em on public.fichas_viagem;
create trigger zz_fichas_atualizado_em
  before insert or update on public.fichas_viagem
  for each row execute function public._fichas_marcar_atualizacao();


-- -----------------------------------------------------------------------------
-- 2. Um rascunho por motorista
-- -----------------------------------------------------------------------------
create unique index if not exists fichas_viagem_um_rascunho_por_motorista
  on public.fichas_viagem (motorista_id) where status = 'rascunho';


-- -----------------------------------------------------------------------------
-- 3. proteger_colunas_admin_fichas: cópia do passo 14, mudando só a parte do
--    motorista. Mudanças em relação ao passo 14 marcadas com "passo 17".
-- -----------------------------------------------------------------------------
create or replace function public.proteger_colunas_admin_fichas()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_novo_dc    jsonb := case when jsonb_typeof(to_jsonb(new) -> 'dados_completos') = 'object'
                             then to_jsonb(new) -> 'dados_completos' else '{}'::jsonb end;
  v_antigo_dc  jsonb := '{}'::jsonb;
  v_antigo_row jsonb := '{}'::jsonb;
  v_abast      jsonb;
  v_fretes     jsonb;
  v_despesas   jsonb;
  v_anexos     jsonb;
  v_dc         jsonb;
  v_nulos      jsonb;
  v_perfil     record;
  -- passo 11: KMs e placa secundária
  v_km_saida    bigint;
  v_km_entrada  bigint;
  v_km_saida2   bigint;
  v_km_entrada2 bigint;
  v_km_total1   bigint;
  v_km_total2   bigint;
  v_km_total    bigint;
  v_placa_sec   text;
  v_km          jsonb;
  -- passo 12: placa principal e o texto que veio na secundária
  v_placa       text;
  v_placa_sec_enviada text;
  -- passo 13: veículo e comissões do perfil, destinos, adiantamento e totais
  v_tipo          text;
  v_com_carreta   numeric;
  v_com_rodotrem  numeric;
  v_destino_ini   text;
  v_destino_fim   text;
  v_adiantamento  numeric;
  v_total_frete   numeric;
  v_vr_comissao   numeric;
  v_saldo         numeric;
  v_fin           jsonb;
  -- passo 14: datas da viagem
  v_data_saida    date;
  v_data_chegada  date;
  v_datas         jsonb;
  -- passo 17: número e data do envio do rascunho
  v_envio         jsonb := '{}'::jsonb;
  v_numero        text;
begin
  -- ---------------- Admin / diretoria: livre ----------------
  if public.is_admin() then
    if new.status = 'aprovado'
       and (tg_op = 'INSERT' or old.status is distinct from 'aprovado') then
      new.aprovado_por := coalesce(auth.jwt() ->> 'email', 'admin');
      new.aprovado_em  := now();
    end if;
    return new;
  end if;

  -- ---------------- Motorista (qualquer não-admin) ----------------
  if new.status is null or new.status not in ('rascunho', 'pendente') then
    raise exception 'Acesso negado: status inválido para motorista.';
  end if;

  -- passo 17: depois de enviada (pendente, aprovado...), o motorista não altera mais
  if tg_op = 'UPDATE' and old.status is distinct from 'rascunho' then
    raise exception 'Acesso negado: esta ficha já foi enviada e não pode ser alterada.';
  end if;

  -- passo 13: perfil de quem está logado (INSERT e UPDATE): nome, CPF, tipo de
  -- veículo e comissões especiais do Alimentício
  select nome, cpf, tipo_veiculo, comissao_alim_carreta, comissao_alim_rodotrem
    into v_perfil from public.perfis where id = auth.uid();
  v_tipo         := coalesce(v_perfil.tipo_veiculo, 'carreta');
  v_com_carreta  := v_perfil.comissao_alim_carreta;
  v_com_rodotrem := v_perfil.comissao_alim_rodotrem;

  if tg_op = 'UPDATE' then
    v_antigo_row := to_jsonb(old);
    if jsonb_typeof(v_antigo_row -> 'dados_completos') = 'object' then
      v_antigo_dc := v_antigo_row -> 'dados_completos';
    end if;
  end if;

  -- Só os campos que o motorista pode preencher, já limpos
  v_abast    := public._limpar_abastecimentos(coalesce(to_jsonb(new) -> 'abastecimentos', v_novo_dc -> 'abastecimentos'));
  -- passo 13: comissão calculada pela regra, com o veículo de cada linha
  v_fretes   := public._limpar_fretes(v_novo_dc -> 'fretes', v_antigo_dc -> 'fretes', v_tipo, v_com_carreta, v_com_rodotrem);
  v_despesas := public._limpar_outras_despesas(
                  coalesce(to_jsonb(new) -> 'despesas_extras', v_novo_dc -> 'outrasDespesas'),
                  coalesce(v_antigo_row -> 'despesas_extras', v_antigo_dc -> 'outrasDespesas'));
  v_anexos   := public._limpar_comprovantes(coalesce(to_jsonb(new) -> 'comprovantes', v_novo_dc -> 'anexos'));

  -- passo 13: destinos e adiantamento (coluna; dados_completos é a reserva)
  v_destino_ini  := nullif(btrim(public._txt(coalesce(nullif(to_jsonb(new) -> 'destino_inicial', 'null'::jsonb),
                                                      v_novo_dc -> 'destinoInicial'), 120) #>> '{}'), '');
  v_destino_fim  := nullif(btrim(public._txt(coalesce(nullif(to_jsonb(new) -> 'destino_final', 'null'::jsonb),
                                                      v_novo_dc -> 'destinoFinal'), 120) #>> '{}'), '');
  -- (a coluna tem default 0: o 0 dela não pode esconder o valor de dados_completos)
  v_adiantamento := coalesce(nullif(public._moeda(to_jsonb(new) -> 'valor_adiantamento'), 0),
                             public._moeda(v_novo_dc -> 'valorAdiantamento'),
                             public._moeda(to_jsonb(new) -> 'valor_adiantamento'));
  -- total_frete, vr_comissao e saldo_comissao não são lidos da coluna: são calculados abaixo

  -- passo 13: totais calculados a partir das linhas limpas
  select coalesce(sum(public._moeda(f -> 'valor')), 0),
         coalesce(sum(public._moeda(f -> 'comissao')), 0)
    into v_total_frete, v_vr_comissao
    from jsonb_array_elements(v_fretes) f;
  v_saldo := v_vr_comissao - coalesce(v_adiantamento, 0);

  v_fin := jsonb_build_object(
             'destinoInicial',    coalesce(v_destino_ini, ''),
             'destinoFinal',      coalesce(v_destino_fim, ''),
             'valorAdiantamento', coalesce(public._moeda_txt(v_adiantamento), ''),
             'totalFrete',        public._moeda_txt(v_total_frete),
             'vrComissao',        public._moeda_txt(v_vr_comissao),
             'saldoComissao',     public._moeda_txt(v_saldo));

  -- passo 14: datas de saída e chegada (coluna; dados_completos é a reserva).
  -- Gravadas em dados_completos como a ficha usa (DD/MM/AAAA).
  v_data_saida   := coalesce(public._data(to_jsonb(new) -> 'data_saida'),
                             public._data(v_novo_dc -> 'dataSaida'));
  v_data_chegada := coalesce(public._data(to_jsonb(new) -> 'data_chegada'),
                             public._data(v_novo_dc -> 'dataChegada'));
  v_datas := jsonb_build_object(
               'dataSaida',   coalesce(to_char(v_data_saida, 'DD/MM/YYYY'), ''),
               'dataChegada', coalesce(to_char(v_data_chegada, 'DD/MM/YYYY'), ''));

  -- passo 12: placa principal da coluna placas; dados_completos.placas é a reserva
  v_placa := coalesce(public._placa(to_jsonb(new) -> 'placas'),
                      public._placa(v_novo_dc -> 'placas'));

  -- passo 11: KMs e placa secundária vindos do motorista (dados_completos)
  v_km_saida   := public._km(v_novo_dc -> 'kmSaida')::bigint;
  v_km_entrada := public._km(v_novo_dc -> 'kmEntrada')::bigint;
  v_placa_sec  := public._placa(v_novo_dc -> 'placaSecundaria');
  v_placa_sec_enviada := nullif(btrim(public._txt(v_novo_dc -> 'placaSecundaria', 20) #>> '{}'), '');
  -- O segundo trecho só existe quando há placa secundária
  if v_placa_sec is not null then
    v_km_saida2   := public._km(v_novo_dc -> 'kmSaida2')::bigint;
    v_km_entrada2 := public._km(v_novo_dc -> 'kmEntrada2')::bigint;
  end if;

  -- passo 12: regras do envio (só em 'pendente'; rascunho pode ficar incompleto)
  if new.status = 'pendente' then
    if v_placa is null then
      raise exception 'Informe a placa principal (ex.: ABC-1D23).';
    end if;
    if v_placa_sec_enviada is not null and v_placa_sec is null then
      raise exception 'Placa secundária inválida.';
    end if;
    if v_placa_sec = v_placa then
      raise exception 'A placa secundária não pode ser igual à principal.';
    end if;
    -- passo 14: datas obrigatórias e chegada não antes da saída
    if v_data_saida is null or v_data_chegada is null then
      raise exception 'Informe a data de saída e a data de chegada.';
    end if;
    if v_data_chegada < v_data_saida then
      raise exception 'A data de chegada não pode ser antes da data de saída.';
    end if;
    if v_km_saida is null or v_km_entrada is null then
      raise exception 'Informe o KM de saída e o KM de chegada.';
    end if;
    if v_placa_sec is not null and (v_km_saida2 is null or v_km_entrada2 is null) then
      raise exception 'Informe o KM de saída e o KM de chegada da placa secundária.';
    end if;
    if v_km_entrada < v_km_saida or v_km_entrada2 < v_km_saida2 then
      raise exception 'O KM de chegada não pode ser menor que o de saída.';
    end if;
    -- passo 13: rodotrem escolhe o veículo em cada frete do Alimentício com valor
    if v_tipo in ('rodotrem', 'carreta_rodotrem') and exists (
         select 1 from jsonb_array_elements(v_fretes) f
          where f ->> 'cliente' = 'alimenticio'
            and coalesce(public._moeda(f -> 'valor'), 0) > 0
            and f ->> 'veiculo' is null) then
      raise exception 'Escolha o veículo (carreta ou rodotrem) em cada frete do Alimentício.';
    end if;
  end if;

  -- Totais calculados aqui (o motorista não envia): entrada - saída,
  -- só quando os dois existem e entrada >= saída
  if v_km_entrada >= v_km_saida then
    v_km_total1 := v_km_entrada - v_km_saida;
  end if;
  if v_km_entrada2 >= v_km_saida2 then
    v_km_total2 := v_km_entrada2 - v_km_saida2;
  end if;
  -- Viagem toda: soma só os trechos que existem
  if v_km_total1 is not null or v_km_total2 is not null then
    v_km_total := coalesce(v_km_total1, 0) + coalesce(v_km_total2, 0);
  end if;

  v_km := jsonb_build_object(
            'kmSaida',         v_km_saida::text,
            'kmEntrada',       v_km_entrada::text,
            'kmTotal1',        v_km_total1::text,
            'placaSecundaria', v_placa_sec,
            'kmSaida2',        v_km_saida2::text,
            'kmEntrada2',      v_km_entrada2::text,
            'kmTotal2',        v_km_total2::text,
            'kmTotal',         v_km_total::text);

  -- dados_completos = o que já estava no banco + só as partes do motorista
  -- passo 12: + placas (a principal, limpa)
  -- passo 13: + destinos, adiantamento e totais de frete/comissão
  -- passo 14: + datas de saída e chegada
  v_dc := v_antigo_dc || jsonb_build_object(
            'placas',         v_placa,
            'abastecimentos', v_abast,
            'fretes',         v_fretes,
            'outrasDespesas', v_despesas,
            'despesas_extras',v_despesas,
            'anexos',         v_anexos,
            'comprovantes',   v_anexos) || v_km || v_fin || v_datas;

  if tg_op = 'INSERT' then
    -- passo 17: rascunho não gasta número; o id provisório só tem letras,
    -- números e hífen (é também o nome da pasta dos comprovantes)
    if new.status = 'rascunho' then
      new.id := 'RASC-' || replace(gen_random_uuid()::text, '-', '');
    end if;

    -- Dados do motorista vêm do perfil de quem está logado, não do navegador
    -- (passo 13: o perfil já foi lido no começo da parte do motorista)
    v_dc := v_dc || jsonb_build_object(
              'id',           new.id,
              'protocolo',    new.id,
              'motorista',    coalesce(v_perfil.nome, ''),
              'motoristaCpf', coalesce(v_perfil.cpf, ''),
              'motorista_cpf',coalesce(v_perfil.cpf, ''),
              'motoristaId',  auth.uid(),
              'dataEnvio',    to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS'),
              'origemEnvio',  'motorista_com_login',
              'status',       new.status);

    -- Zera todas as colunas que aceitam nulo (exceto as do motorista)...
    select coalesce(jsonb_object_agg(a.attname, null), '{}'::jsonb) into v_nulos
    from pg_attribute a
    where a.attrelid = 'public.fichas_viagem'::regclass
      and a.attnum > 0 and not a.attisdropped and not a.attnotnull
      and a.attname not in ('id','status','abastecimentos','comprovantes','despesas_extras','dados_completos');

    -- ...e aplica só o que é permitido/forçado.
    -- (chaves de colunas que não existirem na tabela são ignoradas)
    -- passo 11: km_saida, km_chegada e km_total vêm dos valores já limpos
    -- passo 12: placas vem da placa principal já limpa
    -- passo 13: destinos, adiantamento e totais de frete/comissão
    -- passo 14: data_saida e data_chegada
    new := jsonb_populate_record(new, v_nulos || jsonb_build_object(
             'motorista_id',    auth.uid(),
             'iniciada_em',     now(),
             'data_envio',      now(),
             'motorista',       v_perfil.nome,
             'motorista_cpf',   v_perfil.cpf,
             'origem_envio',    'motorista_com_login',
             'data_saida',      v_data_saida,
             'data_chegada',    v_data_chegada,
             'placas',          v_placa,
             'km_saida',        v_km_saida,
             'km_chegada',      v_km_entrada,
             'km_total',        v_km_total,
             'destino_inicial',    v_destino_ini,
             'destino_final',      v_destino_fim,
             'valor_adiantamento', v_adiantamento,
             'total_frete',        v_total_frete,
             'vr_comissao',        v_vr_comissao,
             'saldo_comissao',     v_saldo,
             'abastecimentos',  v_abast,
             'comprovantes',    v_anexos,
             'despesas_extras', v_despesas,
             'dados_completos', v_dc));
  else
    -- passo 17: envio do rascunho (rascunho -> pendente) = número da ficha e
    -- data do envio agora (no INSERT do rascunho a data_envio é a do começo da viagem)
    if old.status = 'rascunho' and new.status = 'pendente' then
      v_numero := public.reservar_numero_ficha();
      v_envio  := jsonb_build_object('id', v_numero, 'data_envio', now());
      v_dc := v_dc || jsonb_build_object(
                'id',        v_numero,
                'protocolo', v_numero,
                'dataEnvio', to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS'));
    end if;

    -- UPDATE: parte da linha antiga e troca só o que o motorista pode mexer
    -- passo 12: placas passa a ser a que o motorista mandou (limpa)
    -- passo 13: + destinos, adiantamento e totais de frete/comissão
    -- passo 14: + data_saida e data_chegada
    -- passo 17: + id e data_envio no envio do rascunho (v_envio; vazio nos outros casos)
    new := jsonb_populate_record(old, jsonb_build_object(
             'status',          new.status,
             'data_saida',      v_data_saida,
             'data_chegada',    v_data_chegada,
             'placas',          v_placa,
             'km_saida',        v_km_saida,
             'km_chegada',      v_km_entrada,
             'km_total',        v_km_total,
             'destino_inicial',    v_destino_ini,
             'destino_final',      v_destino_fim,
             'valor_adiantamento', v_adiantamento,
             'total_frete',        v_total_frete,
             'vr_comissao',        v_vr_comissao,
             'saldo_comissao',     v_saldo,
             'abastecimentos',  v_abast,
             'comprovantes',    v_anexos,
             'despesas_extras', v_despesas,
             'dados_completos', v_dc || jsonb_build_object('status', new.status)) || v_envio);
  end if;

  return new;
end;
$function$;


-- -----------------------------------------------------------------------------
-- 4. RLS de fichas_viagem (só acrescentam; as que já existem continuam iguais)
--    O motorista cria o próprio rascunho e atualiza só o próprio rascunho; no
--    envio ele passa a 'pendente' (o with check vale para a linha depois do
--    trigger, que grava motorista_id = auth.uid()).
-- -----------------------------------------------------------------------------
drop policy if exists fichas_motorista_cria_rascunho on public.fichas_viagem;
create policy fichas_motorista_cria_rascunho on public.fichas_viagem
  for insert to authenticated
  with check (motorista_id = auth.uid() and status = 'rascunho');

drop policy if exists fichas_motorista_atualiza_rascunho on public.fichas_viagem;
create policy fichas_motorista_atualiza_rascunho on public.fichas_viagem
  for update to authenticated
  using (motorista_id = auth.uid() and status = 'rascunho')
  with check (motorista_id = auth.uid() and status in ('rascunho', 'pendente'));


-- -----------------------------------------------------------------------------
-- 5. Storage, bucket comprovantes (caminho <id do usuário>/<id da ficha>/<arquivo>)
--    _comprovante_de_rascunho_meu(nome): o arquivo é da pasta de quem está
--    logado e a ficha da pasta é dele e está em 'rascunho'. Security definer
--    para ler a ficha sem depender da RLS dela.
--    Ler a própria pasta é preciso para o link assinado das miniaturas e para
--    o Postgres achar a linha no delete.
-- -----------------------------------------------------------------------------
create or replace function public._comprovante_de_rascunho_meu(p_nome text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(
           auth.uid() is not null
       and p_nome ~ '^[^/]+/[^/]+/[^/]+$'
       and split_part(p_nome, '/', 1) = auth.uid()::text
       and exists (select 1 from public.fichas_viagem f
                    where f.id = split_part(p_nome, '/', 2)
                      and f.motorista_id = auth.uid()
                      and f.status = 'rascunho'),
         false);
$$;

revoke all on function public._comprovante_de_rascunho_meu(text) from public;
grant execute on function public._comprovante_de_rascunho_meu(text) to authenticated;

drop policy if exists comprovantes_motorista_le_propria_pasta on storage.objects;
create policy comprovantes_motorista_le_propria_pasta on storage.objects
  for select to authenticated
  using (bucket_id = 'comprovantes' and split_part(name, '/', 1) = auth.uid()::text);

drop policy if exists comprovantes_motorista_apaga_do_rascunho on storage.objects;
create policy comprovantes_motorista_apaga_do_rascunho on storage.objects
  for delete to authenticated
  using (bucket_id = 'comprovantes' and public._comprovante_de_rascunho_meu(name));


-- -----------------------------------------------------------------------------
-- 6. Auditoria: gravar_auditoria_fichas() deixa de auditar a gravação do rascunho
--    Pega o texto atual da função, põe a linha abaixo logo depois do begin do
--    corpo e recria a função com o resto igual (dono, security definer,
--    search_path e permissões continuam). Dá erro (e nada é alterado) se o
--    texto não tiver exatamente um "begin". Se a linha já estiver lá, não mexe
--    (o arquivo pode rodar duas vezes).
-- -----------------------------------------------------------------------------
do $$
declare
  v_def    text := pg_get_functiondef('public.gravar_auditoria_fichas()'::regprocedure);
  v_regra  constant text := 'if tg_op in (''INSERT'',''UPDATE'') and new.status = ''rascunho'' then return new; end if;';
  v_begins int;
begin
  if position(v_regra in v_def) > 0 then
    raise notice 'gravar_auditoria_fichas já tem a regra do rascunho; nada foi alterado.';
    return;
  end if;
  select count(*) into v_begins from regexp_matches(v_def, '\mbegin\M', 'gi');
  if v_begins <> 1 then
    raise exception 'gravar_auditoria_fichas: esperava exatamente 1 "begin" no texto da função e achei %. Nada foi alterado.', v_begins;
  end if;
  execute regexp_replace(v_def, '(\mbegin\M)', '\1' || E'\n  ' || v_regra, 'i');
end $$;


commit;


-- =============================================================================
-- 7. Conferência (depois do commit; rode cada bloco separadamente)
--    Motorista A = primeiro perfil com role = 'motorista'; motorista B = o
--    segundo (com um só motorista cadastrado, os testes de "outro motorista"
--    não valem: aparece B=(sem segundo motorista)). Gestão = claims com
--    app_metadata.role = 'admin' (é o que o is_admin() lê). Tudo é desfeito
--    no final (rollback). Os perfis ficam como carreta, sem especial, só
--    dentro da transação.
--    Em 7.6 e 7.7 o reset role / set role fica fora do bloco do $$, como no passo 16.
--    Rode logo depois do commit, antes de publicar a página nova: o motorista
--    A ou B com rascunho aberto no banco faz o teste falhar (1 rascunho por
--    motorista).
-- =============================================================================

-- 7.1 Estrutura (esperado: coluna=t | triggers=<...>, zz_fichas_atualizado_em por último | indice=t | policies_fichas=fichas_motorista_atualiza_rascunho:UPDATE, fichas_motorista_cria_rascunho:INSERT | policies_storage=comprovantes_motorista_apaga_do_rascunho:DELETE, comprovantes_motorista_le_propria_pasta:SELECT)
do $$
begin
  raise exception 'RESULTADO: coluna=% | triggers=% | indice=% | policies_fichas=% | policies_storage=%',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'fichas_viagem' and column_name = 'atualizado_em'),
    (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'public.fichas_viagem'::regclass and not tgisinternal),
    exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'fichas_viagem_um_rascunho_por_motorista'),
    (select string_agg(policyname || ':' || cmd, ', ' order by policyname) from pg_policies
      where schemaname = 'public' and tablename = 'fichas_viagem' and policyname in ('fichas_motorista_cria_rascunho', 'fichas_motorista_atualiza_rascunho')),
    (select string_agg(policyname || ':' || cmd, ', ' order by policyname) from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname like 'comprovantes_motorista_%');
end $$;

-- 7.2 Motorista A começa a viagem só com KM e data de saída (esperado: id=RASC-... | status=rascunho | km_saida=100000 | data_saida=2026-10-01 | placas=(vazio) | atualizado_em=t | segundo_rascunho=bloqueado)
begin;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  r record;
  v_segundo text := 'LIBERADO';
begin
  insert into public.fichas_viagem (id, motorista, status, data_saida, dados_completos)
  values ('AJB-TESTE-P17', 'teste', 'rascunho', '2026-10-01', '{"kmSaida": "100.000", "dataSaida": "01/10/2026"}'::jsonb)
  returning * into r;
  begin
    insert into public.fichas_viagem (id, motorista, status, dados_completos)
    values ('AJB-TESTE-P17B', 'teste', 'rascunho', '{}'::jsonb);
  exception when unique_violation then v_segundo := 'bloqueado';
  end;
  raise exception 'RESULTADO (nada foi salvo): id=% | status=% | km_saida=% | data_saida=% | placas=% | atualizado_em=% | segundo_rascunho=%',
    left(r.id, 5) || '...', r.status, r.km_saida, r.data_saida, coalesce(r.placas, '(vazio)'),
    r.atualizado_em is not null, v_segundo;
end $$;
rollback;

-- 7.3 Outro dia: A acrescenta um abastecimento e uma despesa no rascunho (esperado: linhas=1 | km_saida=100000 | data_saida=2026-10-01 | abastecimentos=1 | despesa=Borracharia 150,00 | id_igual=t)
begin;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  r record;
  v_id text;
  v_linhas bigint;
begin
  insert into public.fichas_viagem (id, motorista, status, data_saida, dados_completos)
  values ('x', 'teste', 'rascunho', '2026-10-01', '{"kmSaida": "100000", "dataSaida": "01/10/2026"}'::jsonb)
  returning id into v_id;
  update public.fichas_viagem
     set data_saida = '2026-10-01',
         abastecimentos = '[{"posto":"Posto A","valor":"600,00","litros":"100,00","combustivel":"diesel_s10"}]'::jsonb,
         despesas_extras = '[{"desc":"Imposto Federal","valor":""},{"desc":"Borracharia","valor":"150,00"},{"desc":"","valor":""}]'::jsonb,
         dados_completos = '{"kmSaida": "100000", "dataSaida": "01/10/2026"}'::jsonb
   where id = v_id
  returning * into r;
  get diagnostics v_linhas = row_count;
  raise exception 'RESULTADO (nada foi salvo): linhas=% | km_saida=% | data_saida=% | abastecimentos=% | despesa=% | id_igual=%',
    v_linhas, r.km_saida, r.data_saida, jsonb_array_length(r.abastecimentos),
    (r.despesas_extras -> 1 ->> 'desc') || ' ' || (r.despesas_extras -> 1 ->> 'valor'), r.id = v_id;
end $$;
rollback;

-- 7.4 Motorista B não lê nem altera o rascunho de A (esperado: B_ve=0 | B_altera=0 linhas | B_envia=0 linhas | rascunho_de_A_intacto=t; ou B=(sem segundo motorista))
begin;
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_a uuid := auth.uid();
  v_b uuid := (select id from public.perfis where role = 'motorista' and id <> auth.uid() order by id limit 1);
  v_id text;
  v_ve bigint;
  v_altera bigint;
  v_envia bigint;
begin
  if v_b is null then
    raise exception 'RESULTADO: B=(sem segundo motorista)';
  end if;
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{"kmSaida": "100000"}'::jsonb)
  returning id into v_id;
  -- agora como B
  perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
  select count(*) into v_ve from public.fichas_viagem where id = v_id;
  update public.fichas_viagem set dados_completos = '{"kmSaida": "1"}'::jsonb where id = v_id;
  get diagnostics v_altera = row_count;
  update public.fichas_viagem set status = 'pendente' where id = v_id;
  get diagnostics v_envia = row_count;
  -- de volta como A
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  raise exception 'RESULTADO (nada foi salvo): B_ve=% | B_altera=% linhas | B_envia=% linhas | rascunho_de_A_intacto=%',
    v_ve, v_altera, v_envia,
    (select status = 'rascunho' and km_saida = 100000 from public.fichas_viagem where id = v_id);
end $$;
rollback;

-- 7.5 Envio incompleto e depois completo, na mesma ficha (esperado: incompleto=bloqueado: Informe a placa principal (ex.: ABC-1D23). | id=AJB-... | status=pendente | mesma_ficha=t | rascunhos_restantes=0 | data_envio_agora=t | data_envio_antes=3 dias atrás | dc_id=t | dc_data_envio=t | km_total=1500 | comissao=110,00)
--     Para provar a data do envio, a gestão volta a data_envio do rascunho 3 dias (dentro da transação tudo tem a mesma now()).
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P17'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_a uuid := auth.uid();
  v_id text;
  v_incompleto text := 'LIBERADO';
  v_antes timestamptz;
  r record;
begin
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{"kmSaida": "100000", "dataSaida": "01/10/2026"}'::jsonb)
  returning id into v_id;
  -- gestão: data_envio do rascunho = 3 dias atrás
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated',
                     'app_metadata', json_build_object('role', 'admin'))::text, true);
  update public.fichas_viagem set data_envio = now() - interval '3 days' where id = v_id
  returning data_envio into v_antes;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  -- envio sem placa: o banco recusa e o rascunho continua
  begin
    update public.fichas_viagem set status = 'pendente' where id = v_id;
  exception when others then v_incompleto := 'bloqueado: ' || sqlerrm;
  end;
  -- envio completo
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         destino_inicial = 'Marília - SP', valor_adiantamento = 0,
         dados_completos = '{"kmSaida": "100000", "kmEntrada": "101500", "fretes": [{"data":"01/10/2026","cliente":"shopee","origem":"Marília - SP","destino":"Santos - SP","valor":"1.000,00"}]}'::jsonb
   where id = v_id
  returning * into r;
  raise exception 'RESULTADO (nada foi salvo): incompleto=% | id=% | status=% | mesma_ficha=% | rascunhos_restantes=% | data_envio_agora=% | data_envio_antes=% | dc_id=% | dc_data_envio=% | km_total=% | comissao=%',
    v_incompleto, left(r.id, 4) || '...', r.status,
    (select count(*) = 1 from public.fichas_viagem where motorista_id = v_a and iniciada_em = r.iniciada_em)
      and not exists (select 1 from public.fichas_viagem where id = v_id),
    (select count(*) from public.fichas_viagem where motorista_id = v_a and status = 'rascunho'),
    r.data_envio = now(), case when v_antes = now() - interval '3 days' then '3 dias atrás' else v_antes::text end,
    r.dados_completos ->> 'id' = r.id, r.dados_completos ->> 'dataEnvio' = to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY, HH24:MI:SS'),
    r.km_total, r.dados_completos -> 'fretes' -> 0 ->> 'comissao';
end $$;
rollback;

-- 7.6 Motorista não altera ficha pendente nem aprovada, nem volta para rascunho (esperado: pendente_altera=bloqueado | pendente_volta_rascunho=bloqueado | aprovado_altera=bloqueado | km_continua=101500)
--     "bloqueado" = erro do trigger ou 0 linhas pela RLS. O 2º bloco lê como o usuário do SQL Editor.
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P17'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_a uuid := auth.uid();
  v_id text;
  v_linhas bigint;
  v_pend text;
  v_volta text;
  v_aprov text;
begin
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{}'::jsonb)
  returning id into v_id;
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         dados_completos = '{"kmSaida": "100000", "kmEntrada": "101500"}'::jsonb
   where id = v_id
  returning id into v_id;
  begin
    update public.fichas_viagem set placas = 'XYZ9A87', dados_completos = '{"kmSaida": "100000", "kmEntrada": "109999"}'::jsonb where id = v_id;
    get diagnostics v_linhas = row_count;
    v_pend := case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end;
  exception when others then v_pend := 'bloqueado (' || sqlerrm || ')';
  end;
  begin
    update public.fichas_viagem set status = 'rascunho' where id = v_id;
    get diagnostics v_linhas = row_count;
    v_volta := case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end;
  exception when others then v_volta := 'bloqueado (' || sqlerrm || ')';
  end;
  -- gestão aprova
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated',
                     'app_metadata', json_build_object('role', 'admin'))::text, true);
  update public.fichas_viagem set status = 'aprovado' where id = v_id;
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  begin
    update public.fichas_viagem set status = 'pendente', dados_completos = '{"kmSaida": "100000", "kmEntrada": "109999"}'::jsonb where id = v_id;
    get diagnostics v_linhas = row_count;
    v_aprov := case when v_linhas = 0 then 'bloqueado (0 linhas)' else 'LIBERADO' end;
  exception when others then v_aprov := 'bloqueado (' || sqlerrm || ')';
  end;
  perform set_config('p17.id', v_id, true);
  perform set_config('p17.pend', v_pend, true);
  perform set_config('p17.volta', v_volta, true);
  perform set_config('p17.aprov', v_aprov, true);
end $$;
reset role;
do $$
begin
  raise exception 'RESULTADO (nada foi salvo): pendente_altera=% | pendente_volta_rascunho=% | aprovado_altera=% | km_continua=% | status=%',
    current_setting('p17.pend'), current_setting('p17.volta'), current_setting('p17.aprov'),
    (select km_chegada from public.fichas_viagem where id = current_setting('p17.id')),
    (select status from public.fichas_viagem where id = current_setting('p17.id'));
end $$;
rollback;

-- 7.7 Fotos: A apaga foto do próprio rascunho, mas não a de ficha enviada nem a do rascunho de B (esperado: proprio_rascunho=1 | ficha_enviada=0 | rascunho_de_B=0 | B=<ok ou (sem segundo motorista)>)
--     Os arquivos de teste são só linhas em storage.objects (nada vai para o Storage de verdade).
--     O 1º bloco cria as fichas e os arquivos como o usuário do SQL Editor; o 2º apaga como A.
begin;
select set_config('storage.allow_delete_query', 'true', true);
do $$
declare
  v_a uuid := (select id from public.perfis where role = 'motorista' order by id limit 1);
  v_b uuid := (select id from public.perfis where role = 'motorista' and id <> v_a order by id limit 1);
  v_rasc text;
  v_env text;
  v_rasc_b text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
  insert into public.fichas_viagem (id, motorista, status, dados_completos) values ('x', 'teste', 'rascunho', '{}'::jsonb)
  returning id into v_rasc;
  -- ficha enviada de A (envio direto, como a página antiga)
  insert into public.fichas_viagem (id, motorista, status, placas, data_saida, data_chegada, dados_completos)
  values ('AJB-TESTE-P17', 'teste', 'pendente', 'ABC1D23', '2026-10-01', '2026-10-05', '{"kmSaida": "100000", "kmEntrada": "101500"}'::jsonb)
  returning id into v_env;
  if v_b is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_b, 'role', 'authenticated')::text, true);
    insert into public.fichas_viagem (id, motorista, status, dados_completos) values ('x', 'teste', 'rascunho', '{}'::jsonb)
    returning id into v_rasc_b;
    insert into storage.objects (bucket_id, name) values ('comprovantes', v_b || '/' || v_rasc_b || '/1_teste.jpg');
  end if;
  insert into storage.objects (bucket_id, name) values
    ('comprovantes', v_a || '/' || v_rasc || '/1_teste.jpg'),
    ('comprovantes', v_a || '/' || v_env || '/1_teste.jpg');
  perform set_config('p17.a', v_a::text, true);
  perform set_config('p17.b', coalesce(v_b::text, ''), true);
  perform set_config('p17.rasc', v_rasc, true);
  perform set_config('p17.env', v_env, true);
  perform set_config('p17.rasc_b', coalesce(v_rasc_b, ''), true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated')::text, true);
end $$;
set local role authenticated;
do $$
declare
  v_a text := current_setting('p17.a');
  v_b text := current_setting('p17.b');
  v_proprio bigint;
  v_enviada bigint;
  v_de_b bigint := 0;
begin
  delete from storage.objects where bucket_id = 'comprovantes' and name = v_a || '/' || current_setting('p17.rasc') || '/1_teste.jpg';
  get diagnostics v_proprio = row_count;
  delete from storage.objects where bucket_id = 'comprovantes' and name = v_a || '/' || current_setting('p17.env') || '/1_teste.jpg';
  get diagnostics v_enviada = row_count;
  if v_b <> '' then
    delete from storage.objects where bucket_id = 'comprovantes' and name = v_b || '/' || current_setting('p17.rasc_b') || '/1_teste.jpg';
    get diagnostics v_de_b = row_count;
  end if;
  raise exception 'RESULTADO (nada foi salvo): proprio_rascunho=% | ficha_enviada=% | rascunho_de_B=% | B=%',
    v_proprio, v_enviada, v_de_b, case when v_b = '' then '(sem segundo motorista)' else 'ok' end;
end $$;
rollback;

-- 7.8 Regras de antes continuam iguais pelo rascunho: comissão, Viana, KM/média e placa (esperado: sem_placa=bloqueado: Informe a placa principal (ex.: ABC-1D23). | viana_rodotrem=800,00 | outro_destino=900,00 | shopee=110,00 | ml=400,00 | km_total=1500 | litros=500,00 | placas=ABC1D23 | vr_comissao=2210.00)
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P17'::text $$;
update public.perfis set tipo_veiculo = 'rodotrem', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
set local role authenticated;
do $$
declare
  v_id text;
  v_sem_placa text := 'LIBERADO';
  v_dc jsonb := '{"kmSaida": "100000", "kmEntrada": "101500", "fretes": [
      {"data":"01/10/2026","cliente":"alimenticio","origem":"Marília - SP","destino":"Viana - ES","valor":"10.000,00","veiculo":"rodotrem"},
      {"data":"02/10/2026","cliente":"alimenticio","origem":"Viana - ES","destino":"Cravinhos - SP","valor":"10.000,00","veiculo":"rodotrem"},
      {"data":"03/10/2026","cliente":"shopee","origem":"A","destino":"B","valor":"1.000,00"},
      {"data":"04/10/2026","cliente":"mercado_livre","origem":"A","destino":"B","valor":"1.000,00"}]}'::jsonb;
  r record;
begin
  insert into public.fichas_viagem (id, motorista, status, abastecimentos, dados_completos)
  values ('x', 'teste', 'rascunho', '[{"posto":"Posto A","valor":"3.000,00","litros":"500,00","combustivel":"diesel_s10"}]'::jsonb, v_dc)
  returning id into v_id;
  begin
    update public.fichas_viagem set status = 'pendente', data_saida = '2026-10-01', data_chegada = '2026-10-05',
           abastecimentos = '[{"posto":"Posto A","valor":"3.000,00","litros":"500,00","combustivel":"diesel_s10"}]'::jsonb,
           dados_completos = v_dc where id = v_id;
  exception when others then v_sem_placa := 'bloqueado: ' || sqlerrm;
  end;
  update public.fichas_viagem set status = 'pendente', placas = 'abc-1d23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         abastecimentos = '[{"posto":"Posto A","valor":"3.000,00","litros":"500,00","combustivel":"diesel_s10"}]'::jsonb,
         dados_completos = v_dc where id = v_id
  returning * into r;
  raise exception 'RESULTADO (nada foi salvo): sem_placa=% | viana_rodotrem=% | outro_destino=% | shopee=% | ml=% | km_total=% | litros=% | placas=% | vr_comissao=%',
    v_sem_placa,
    r.dados_completos -> 'fretes' -> 0 ->> 'comissao', r.dados_completos -> 'fretes' -> 1 ->> 'comissao',
    r.dados_completos -> 'fretes' -> 2 ->> 'comissao', r.dados_completos -> 'fretes' -> 3 ->> 'comissao',
    r.km_total, r.abastecimentos -> 0 ->> 'litros', r.placas, r.vr_comissao::numeric(14,2);
end $$;
rollback;

-- 7.9 Auditoria: 5 gravações de rascunho, o envio e um update da gestão (esperado: rascunho_5_gravacoes=0 linhas | envio=1 linha(s) | gestao=1 linha(s) | regra_na_funcao=1)
--     Roda como o usuário do SQL Editor (lê auditoria_fichas sem depender da RLS dela); quem
--     grava é decidido pelas claims, como nos outros testes.
begin;
-- (número de teste só nesta transação: sequência não volta no rollback, e a conferência não pode gastar número)
create or replace function public.reservar_numero_ficha() returns text language sql as $$ select 'AJB-TESTE-P17'::text $$;
update public.perfis set tipo_veiculo = 'carreta', comissao_alim_carreta = null, comissao_alim_rodotrem = null
 where id = (select id from public.perfis where role = 'motorista' order by id limit 1);
select set_config('request.jwt.claims',
         (select json_build_object('sub', id, 'role', 'authenticated')::text
            from public.perfis where role = 'motorista' order by id limit 1), true);
do $$
declare
  v_a uuid := auth.uid();
  v_id text;
  v_antes bigint;
  v_rascunho bigint;
  v_envio bigint;
  v_gestao bigint;
begin
  select count(*) into v_antes from public.auditoria_fichas;
  -- 5 gravações do rascunho: a primeira cria, as outras 4 atualizam
  insert into public.fichas_viagem (id, motorista, status, dados_completos)
  values ('x', 'teste', 'rascunho', '{"kmSaida": "100000"}'::jsonb)
  returning id into v_id;
  for i in 1..4 loop
    update public.fichas_viagem set dados_completos = jsonb_build_object('kmSaida', (100000 + i)::text) where id = v_id;
  end loop;
  select count(*) into v_rascunho from public.auditoria_fichas;
  -- envio (rascunho -> pendente)
  update public.fichas_viagem
     set status = 'pendente', placas = 'ABC1D23', data_saida = '2026-10-01', data_chegada = '2026-10-05',
         dados_completos = '{"kmSaida": "100000", "kmEntrada": "101500"}'::jsonb
   where id = v_id
  returning id into v_id;
  select count(*) into v_envio from public.auditoria_fichas;
  -- gestão altera a ficha enviada
  perform set_config('request.jwt.claims', json_build_object('sub', v_a, 'role', 'authenticated',
                     'app_metadata', json_build_object('role', 'admin'))::text, true);
  update public.fichas_viagem set km_total = 1500 where id = v_id;
  select count(*) into v_gestao from public.auditoria_fichas;
  raise exception 'RESULTADO (nada foi salvo): rascunho_5_gravacoes=% linhas | envio=% linha(s) | gestao=% linha(s) | regra_na_funcao=%',
    v_rascunho - v_antes, v_envio - v_rascunho, v_gestao - v_envio,
    (select count(*) from regexp_matches(pg_get_functiondef('public.gravar_auditoria_fichas()'::regprocedure),
                                         'and new\.status = ''rascunho'' then return new', 'g'));
end $$;
rollback;

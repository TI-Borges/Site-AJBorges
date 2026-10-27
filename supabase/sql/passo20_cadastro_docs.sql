-- =============================================================================
-- PASSO 20 - Cadastro de terceiros: documentos só em PDF, selfie e rastreador
-- AJBorges Transporte & Logística
--
-- Este passo NÃO muda o banco. Não tem create, alter, update nem delete.
-- O formulário novo grava em public.cadastros_agregados do mesmo jeito de hoje:
--   - dados (jsonb): campos novos "rastreador-marca", "rastreador-id", "_papeis" e
--     "_so_pdf" (os dados digitados da CNH, do CRLV, do RNTRC e do endereço deixam
--     de vir nos cadastros novos);
--   - documentos (jsonb): item novo com campo = 'selfie' (foto JPG/PNG);
--   - os arquivos continuam em documentos-cadastro/terceiros/{id}/.
-- Nenhuma coluna nova. As linhas e os arquivos que já existem não são tocados.
--
-- Rode cada bloco separadamente no SQL Editor do Supabase:
--   1. ANTES de publicar a edge function e o site: guarde o resultado.
--   2. Constraints, triggers e colunas da tabela (só leitura).
--   3. Conferência: grava um cadastro de teste no formato novo e desfaz (rollback).
--   4. DEPOIS: a mesma consulta do 1, para comparar.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. ANTES (só leitura): os cadastros que existem hoje
-- -----------------------------------------------------------------------------
select id, nome, status, jsonb_array_length(coalesce(documentos, '[]'::jsonb)) as documentos
  from public.cadastros_agregados
 order by criado_em;


-- -----------------------------------------------------------------------------
-- 2. Só leitura: o que poderia limitar os campos novos
--    (esperado: nenhuma check/trigger que olhe dentro de dados ou documentos;
--     se aparecer alguma, me mande o resultado antes de publicar)
-- -----------------------------------------------------------------------------
select 'constraint' as tipo, conname as nome, pg_get_constraintdef(oid) as definicao
  from pg_constraint
 where conrelid = 'public.cadastros_agregados'::regclass
union all
select 'trigger', tgname, pg_get_triggerdef(oid)
  from pg_trigger
 where tgrelid = 'public.cadastros_agregados'::regclass and not tgisinternal
union all
select 'coluna', column_name, data_type || case when is_nullable = 'NO' then ' not null' else '' end
  from information_schema.columns
 where table_schema = 'public' and table_name = 'cadastros_agregados'
 order by 1, 2;


-- -----------------------------------------------------------------------------
-- 3. Conferência: um cadastro de TESTE no formato novo (dados inventados) é gravado
--    como a edge function grava e desfeito no fim (rollback). Não mexe nos existentes.
--    (esperado: gravou=sim | selfie=1 | rastreador=Sascar / TESTE-P20 | so_pdf=true |
--     papeis=["Cavalo", "Carreta"] | sem_pdf=(ausente) | existentes_iguais=sim)
-- -----------------------------------------------------------------------------
begin;
do $$
declare
  v_antes  text;
  v_depois text;
  v_id     uuid;
  r        record;
begin
  select string_agg(id::text || ':' || status || ':' || jsonb_array_length(coalesce(documentos, '[]'::jsonb)), ',' order by id)
    into v_antes from public.cadastros_agregados;

  insert into public.cadastros_agregados (user_id, tipo, status, nome, cpf, email, celular, sem_carreta, dados)
  values (null, 'pf', 'pendente', 'Fulano de Teste P20', '52316915930', null, '11900000000', false,
          jsonb_build_object(
            'motorista-nome', 'Fulano', 'motorista-sobrenome', 'de Teste P20',
            'cpf', '52316915930', 'celular', '(11) 90000-0000',
            'rastreador-marca', 'Sascar', 'rastreador-id', 'TESTE-P20',
            '_tipologia', 'Cavalo 6×2', '_papeis', jsonb_build_array('Cavalo', 'Carreta'), '_so_pdf', true,
            '_aceite_lgpd', jsonb_build_object('em', now(), 'versao', '2026-10-19')))
  returning id into v_id;

  update public.cadastros_agregados
     set documentos = jsonb_build_array(
           jsonb_build_object('campo', 'cnh', 'nome', 'cnh.pdf', 'tipo', 'application/pdf', 'tamanho', 2048,
                              'path', 'terceiros/' || v_id || '/cnh_1_cnh.pdf'),
           jsonb_build_object('campo', 'selfie', 'nome', 'selfie.jpg', 'tipo', 'image/jpeg', 'tamanho', 4096,
                              'path', 'terceiros/' || v_id || '/selfie_2_selfie.jpg'))
   where id = v_id
  returning * into r;

  select string_agg(id::text || ':' || status || ':' || jsonb_array_length(coalesce(documentos, '[]'::jsonb)), ',' order by id)
    into v_depois from public.cadastros_agregados where id <> v_id;

  raise exception 'RESULTADO (nada foi salvo): gravou=% | selfie=% | rastreador=% / % | so_pdf=% | papeis=% | sem_pdf=% | existentes_iguais=%',
    case when r.id is not null then 'sim' else 'NÃO' end,
    (select count(*) from jsonb_array_elements(r.documentos) e where e ->> 'campo' = 'selfie'),
    r.dados ->> 'rastreador-marca', r.dados ->> 'rastreador-id',
    r.dados ->> '_so_pdf', r.dados -> '_papeis',
    coalesce(r.dados ->> '_sem_pdf', '(ausente)'),
    case when coalesce(v_antes, '') = coalesce(v_depois, '') then 'sim' else 'NÃO' end;
end $$;
rollback;


-- -----------------------------------------------------------------------------
-- 4. DEPOIS (só leitura): a mesma consulta do item 1, para comparar
--    (esperado: as mesmas linhas, com o mesmo id, nome, status e número de documentos)
-- -----------------------------------------------------------------------------
select id, nome, status, jsonb_array_length(coalesce(documentos, '[]'::jsonb)) as documentos
  from public.cadastros_agregados
 order by criado_em;

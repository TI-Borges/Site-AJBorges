# Torre de Controle - Shoppe: contrato de dados

Este documento é a referência do que o site lê. A fase 2 tem que seguir o que está aqui.

## Regra principal

O site lê **somente** as views abaixo, no schema `torre` do Supabase do site. Nunca lê as tabelas
`torre.planilha_*`, as células cruas nem as cores.

- **Fase 1 (hoje):** as views leem a cópia da planilha "TORRE DE CONTROLE SHOPEE"
  (`torre.planilha_linhas`), que o Apps Script envia a cada 5 minutos.
- **Fase 2 (dados direto do Atlas/Shopee):** as **mesmas views**, com os **mesmos nomes e tipos de
  coluna**, passam a ler as tabelas definitivas (viagens, posições etc.). O site não muda.

Regras do contrato:

1. Nenhuma coluna é renomeada, removida ou muda de tipo. Coluna nova entra no fim da view, e o site
   pode ignorá-la. (O `create or replace view` do Postgres já recusa tirar ou renomear coluna.)
2. Todos os campos de dados são `text`, com o texto como a operação já vê hoje: datas, horas e
   "R$" formatados. Campo vazio vem como `null`, nunca `''`.
3. `<coluna>_situacao` é a situação daquele campo e tem um destes valores: `critico`, `ok`,
   `atencao`, `andamento`, `info`, `destaque` ou `null`. O site pinta a tela só por esse campo.
   - Fase 1: vem da cor da célula na planilha (tabela em `CORES.md`).
   - Fase 2: vem de regras (ex.: atrasado → `critico`; dentro do prazo → `ok`).
4. `<coluna>_url` é um link `http`/`https` (ou `null`). Nunca outro esquema, então o site pode usar
   direto num `href`.
5. `ordem` é a ordem de exibição. Na fase 1 é o número da linha na planilha; na fase 2 pode ser
   qualquer inteiro crescente.
6. Quem vê: só admin e diretoria (`public.is_admin()`, pelo `app_metadata.role` do login). Para
   qualquer outro usuário as views voltam vazias, e o `anon` nem chega ao schema. As views têm
   `security_invoker = true`, ou seja, a RLS vale para quem consulta.
7. Ninguém grava pela API. Na fase 1 os dados entram só pela RPC `torre.aplicar_planilha`, que
   apenas a `service_role` (a edge function `torre-receber-planilha`) pode chamar.

## Views

| View | Aba da planilha (fase 1) | Uma linha por |
|---|---|---|
| `torre.v_matriz` | MATRIZ (títulos na linha 6, blocos na linha 5, dados a partir da 7) | viagem/rota ativa |
| `torre.v_matriz_contadores` | MATRIZ, linhas 1–2 e "Última atualização" | — (uma linha só) |
| `torre.v_validacoes` | VALIDAÇÕES PRÉ CARREGAMENTO (títulos na linha 3) | viagem a validar |
| `torre.v_origem` | ORIGEM | viagem indo para a origem |
| `torre.v_carregamentos` | CARREGAMENTOS | carregamento em andamento |
| `torre.v_transito` | TRÂNSITO (colunas A–Z) | viagem em trânsito |
| `torre.v_descargas` | DESCARGAS | descarga em andamento |
| `torre.v_faturamento` | FATURAMENTO | viagem a faturar |
| `torre.v_links` | LINKS / TREINAMENTOS (título na col. B, link na C e às vezes na D) | link |
| `torre.v_enderecos` | ENDEREÇOS | endereço |
| `torre.v_status` | `torre.sincronizacao` | — (uma linha só; nenhuma enquanto não houver cópia) |

Para ler no site, use o cliente que já existe (`window.supabaseClient`):

```js
supabaseClient.schema('torre').from('v_transito').select('*').order('ordem')
```

Antes, o schema `torre` precisa estar em *Exposed schemas* (Project Settings → Data API).

### De onde vem cada coluna na fase 1

A coluna é encontrada pelo **título**, nunca pela letra. Por isso, mudar a ordem das colunas na
planilha não quebra nada. A comparação ignora maiúsculas, acentos, espaços e pontuação
("CIOT / VPO" = "ciot/vpo"). Quando há mais de um título possível, vale o primeiro que existir na
aba. Se o título não existir, a coluna vem `null`.

Os títulos da TRÂNSITO são os da planilha. Os das outras abas são **prováveis** e precisam ser
conferidos depois da primeira cópia (consulta no fim deste documento). Para trocar um título, não é
preciso mexer na view nem no site:

```sql
update torre.colunas set titulos = array['TÍTULO NA PLANILHA'] where aba = 'ORIGEM' and coluna = 'eta';
```

(Faça a mesma troca no `T01_copia_planilha.sql`, item 5: rodar o arquivo de novo regrava o mapa.)

Na MATRIZ, as colunas dos blocos são procuradas dentro do bloco da linha 5 (ORIGEM, CARREGAMENTO,
TRÂNSITO, DESCARGAS). Assim, "STATUS" do bloco TRÂNSITO e "STATUS" do bloco DESCARGAS não se
confundem.

### torre.v_carregamentos

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `lh` | text | "LH" ou "LT" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `motorista` | text | "MOTORISTA" |
| `motorista_situacao` | text | Situação de `motorista` (CORES.md) |
| `contato` | text | "CONTATO DO MOTORISTA" ou "CONTATO" ou "TELEFONE" |
| `contato_situacao` | text | Situação de `contato` (CORES.md) |
| `cavalo` | text | "CAVALO" ou "PLACA" ou "PLACA CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `carreta` | text | "CARRETA" ou "PLACA CARRETA" |
| `carreta_situacao` | text | Situação de `carreta` (CORES.md) |
| `vinculo` | text | "VÍNCULO" |
| `vinculo_situacao` | text | Situação de `vinculo` (CORES.md) |
| `origem` | text | "ORIGEM" |
| `origem_situacao` | text | Situação de `origem` (CORES.md) |
| `destino` | text | "DESTINO" |
| `destino_situacao` | text | Situação de `destino` (CORES.md) |
| `cpt` | text | "CPT" ou "CPT ORIGEM" |
| `cpt_situacao` | text | Situação de `cpt` (CORES.md) |
| `status` | text | "STATUS" |
| `status_situacao` | text | Situação de `status` (CORES.md) |
| `checklist` | text | "CHECKLIST" |
| `checklist_situacao` | text | Situação de `checklist` (CORES.md) |
| `macro` | text | "MACRO" |
| `macro_situacao` | text | Situação de `macro` (CORES.md) |
| `sm` | text | "SM" |
| `sm_situacao` | text | Situação de `sm` (CORES.md) |
| `status_cpt` | text | "STATUS CPT" |
| `status_cpt_situacao` | text | Situação de `status_cpt` (CORES.md) |
| `tag` | text | "TAG" |
| `tag_situacao` | text | Situação de `tag` (CORES.md) |
| `ultima_atualizacao` | text | "ULTIMA ATUALIZAÇÃO" |
| `ultima_atualizacao_situacao` | text | Situação de `ultima_atualizacao` (CORES.md) |

### torre.v_descargas

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `lh` | text | "LH" ou "LT" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `motorista` | text | "MOTORISTA" |
| `motorista_situacao` | text | Situação de `motorista` (CORES.md) |
| `contato` | text | "CONTATO DO MOTORISTA" ou "CONTATO" ou "TELEFONE" |
| `contato_situacao` | text | Situação de `contato` (CORES.md) |
| `cavalo` | text | "CAVALO" ou "PLACA" ou "PLACA CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `carreta` | text | "CARRETA" ou "PLACA CARRETA" |
| `carreta_situacao` | text | Situação de `carreta` (CORES.md) |
| `vinculo` | text | "VÍNCULO" |
| `vinculo_situacao` | text | Situação de `vinculo` (CORES.md) |
| `status` | text | "STATUS" |
| `status_situacao` | text | Situação de `status` (CORES.md) |
| `bipagem` | text | "BIPAGEM" |
| `bipagem_situacao` | text | Situação de `bipagem` (CORES.md) |
| `cd_de_descarga` | text | "CD DE DESCARGA" |
| `cd_de_descarga_situacao` | text | Situação de `cd_de_descarga` (CORES.md) |
| `eta_destino` | text | "ETA DESTINO" |
| `eta_destino_situacao` | text | Situação de `eta_destino` (CORES.md) |
| `macro` | text | "MACRO" |
| `macro_situacao` | text | Situação de `macro` (CORES.md) |
| `tempo_de_espera` | text | "TEMPO DE ESPERA" |
| `tempo_de_espera_situacao` | text | Situação de `tempo_de_espera` (CORES.md) |

### torre.v_enderecos

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `nome` | text | "NOME" ou "LOCAL" ou "UNIDADE" ou "CD" ou "HUB" |
| `endereco` | text | "ENDEREÇO" ou "ENDEREÇO COMPLETO" |
| `uf` | text | "UF" ou "ESTADO" |
| `cep` | text | "CEP" |
| `cnpj` | text | "CNPJ" |
| `cnpj_situacao` | text | Situação de `cnpj` (CORES.md) |
| `id_station` | text | "ID STATION" |
| `id_station_situacao` | text | Situação de `id_station` (CORES.md) |
| `sigla` | text | "SIGLA" |
| `sigla_situacao` | text | Situação de `sigla` (CORES.md) |
| `tipo` | text | "TIPO" |
| `tipo_situacao` | text | Situação de `tipo` (CORES.md) |

### torre.v_faturamento

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `lh` | text | "LH" ou "LT" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `motorista` | text | "MOTORISTA" |
| `motorista_situacao` | text | Situação de `motorista` (CORES.md) |
| `cavalo` | text | "CAVALO" ou "PLACA" ou "PLACA CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `carreta` | text | "CARRETA" ou "PLACA CARRETA" |
| `carreta_situacao` | text | Situação de `carreta` (CORES.md) |
| `vinculo` | text | "VÍNCULO" |
| `vinculo_situacao` | text | Situação de `vinculo` (CORES.md) |
| `origem` | text | "ORIGEM" |
| `origem_situacao` | text | Situação de `origem` (CORES.md) |
| `destino` | text | "DESTINO" |
| `destino_situacao` | text | Situação de `destino` (CORES.md) |
| `valor` | text | "VALOR" ou "VALOR FRETE" ou "FRETE" |
| `valor_situacao` | text | Situação de `valor` (CORES.md) |
| `ciot_vpo` | text | "CIOT / VPO" ou "CIOT" ou "VPO" |
| `ciot_vpo_situacao` | text | Situação de `ciot_vpo` (CORES.md) |
| `valor_da_carga` | text | "VALOR DA CARGA" |
| `valor_da_carga_situacao` | text | Situação de `valor_da_carga` (CORES.md) |

### torre.v_links

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `titulo` | text | "B" (coluna da planilha) |
| `link` | text | "C" (coluna da planilha) |
| `link_url` | text | Link de `link` (só http/https) |
| `link_2` | text | "D" (coluna da planilha) |
| `link_2_url` | text | Link de `link_2` (só http/https) |

### torre.v_matriz

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `etapa` | text | `origem`, `carregamento`, `transito` ou `descarga` (o bloco mais adiantado preenchido) |
| `lh` | text | "LH" ou "LT" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `cavalo` | text | "CAVALO" ou "PLACA" ou "PLACA CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `rota` | text | "ROTA" |
| `rota_situacao` | text | Situação de `rota` (CORES.md) |
| `validador_origem` | text | "VALIDADOR ORIGEM" |
| `validador_origem_situacao` | text | Situação de `validador_origem` (CORES.md) |
| `origem_eta` | text | bloco ORIGEM → "ETA" ou "ETA ORIGEM" |
| `origem_eta_situacao` | text | Situação de `origem_eta` (CORES.md) |
| `origem_localizacao` | text | bloco ORIGEM → "LOCALIZAÇÃO" ou "POSIÇÃO ATUAL" ou "POSIÇÃO" |
| `origem_localizacao_url` | text | Link de `origem_localizacao` (só http/https) |
| `origem_localizacao_situacao` | text | Situação de `origem_localizacao` (CORES.md) |
| `origem_km` | text | bloco ORIGEM → "KM" ou "KM RESTANTE" ou "DISTÂNCIA" |
| `origem_km_situacao` | text | Situação de `origem_km` (CORES.md) |
| `origem_timer` | text | bloco ORIGEM → "TIMER" |
| `origem_timer_situacao` | text | Situação de `origem_timer` (CORES.md) |
| `carregamento_cpt` | text | bloco CARREGAMENTO / CARREGAMENTOS → "CPT" |
| `carregamento_cpt_situacao` | text | Situação de `carregamento_cpt` (CORES.md) |
| `carregamento_timer` | text | bloco CARREGAMENTO / CARREGAMENTOS → "TIMER" |
| `carregamento_timer_situacao` | text | Situação de `carregamento_timer` (CORES.md) |
| `carregamento_status` | text | bloco CARREGAMENTO / CARREGAMENTOS → "STATUS" |
| `carregamento_status_situacao` | text | Situação de `carregamento_status` (CORES.md) |
| `transito_previsao_chegada` | text | bloco TRÂNSITO → "PREVISÃO DE CHEGADA" ou "PREVISÃO CHEGADA" ou "PREVISÃO" |
| `transito_previsao_chegada_situacao` | text | Situação de `transito_previsao_chegada` (CORES.md) |
| `transito_cpt` | text | bloco TRÂNSITO → "CPT" |
| `transito_cpt_situacao` | text | Situação de `transito_cpt` (CORES.md) |
| `transito_eta_destino` | text | bloco TRÂNSITO → "ETA DESTINO" ou "ETA" |
| `transito_eta_destino_situacao` | text | Situação de `transito_eta_destino` (CORES.md) |
| `transito_status` | text | bloco TRÂNSITO → "STATUS" |
| `transito_status_situacao` | text | Situação de `transito_status` (CORES.md) |
| `transito_parada` | text | bloco TRÂNSITO → "PARADA" ou "T PARADA" ou "TEMPO PARADO" |
| `transito_parada_situacao` | text | Situação de `transito_parada` (CORES.md) |
| `transito_kh` | text | bloco TRÂNSITO → "KM/H" ou "K/H" ou "KH" |
| `transito_kh_situacao` | text | Situação de `transito_kh` (CORES.md) |
| `transito_tt_restante` | text | bloco TRÂNSITO → "TT RESTANTE" ou "TEMPO RESTANTE" ou "TT" |
| `transito_tt_restante_situacao` | text | Situação de `transito_tt_restante` (CORES.md) |
| `transito_delta_tt` | text | bloco TRÂNSITO → "DELTA TT" |
| `transito_delta_tt_situacao` | text | Situação de `transito_delta_tt` (CORES.md) |
| `descarga_chegada` | text | bloco DESCARGAS / DESCARGA → "CHEGADA" |
| `descarga_chegada_situacao` | text | Situação de `descarga_chegada` (CORES.md) |
| `descarga_timer` | text | bloco DESCARGAS / DESCARGA → "TIMER" |
| `descarga_timer_situacao` | text | Situação de `descarga_timer` (CORES.md) |
| `descarga_status` | text | bloco DESCARGAS / DESCARGA → "STATUS" |
| `descarga_status_situacao` | text | Situação de `descarga_status` (CORES.md) |

### torre.v_matriz_contadores

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `rotas_ativas` | int | ROTAS ATIVAS (topo da MATRIZ) |
| `pendentes_chegada` | int | Pendentes Chegada |
| `carregamentos` | int | Carregamentos |
| `transito` | int | Trânsito |
| `atrasos` | int | Atrasos |
| `descarga` | int | Descarga |
| `atualizado_em` | timestamptz | "Última atualização" da MATRIZ (linha 5), em horário de Brasília |
| `copiado_em` | timestamptz | Quando a cópia chegou ao banco |

### torre.v_origem

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `lh` | text | "LH" ou "LT" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `motorista` | text | "MOTORISTA" |
| `motorista_situacao` | text | Situação de `motorista` (CORES.md) |
| `contato` | text | "CONTATO DO MOTORISTA" ou "CONTATO" ou "TELEFONE" |
| `contato_situacao` | text | Situação de `contato` (CORES.md) |
| `cavalo` | text | "CAVALO" ou "PLACA" ou "PLACA CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `carreta` | text | "CARRETA" ou "PLACA CARRETA" |
| `carreta_situacao` | text | Situação de `carreta` (CORES.md) |
| `vinculo` | text | "VÍNCULO" |
| `vinculo_situacao` | text | Situação de `vinculo` (CORES.md) |
| `origem` | text | "ORIGEM" |
| `origem_situacao` | text | Situação de `origem` (CORES.md) |
| `posicao_atual` | text | "POSIÇÃO ATUAL" ou "LOCALIZAÇÃO" ou "POSIÇÃO" |
| `posicao_atual_url` | text | Link de `posicao_atual` (só http/https) |
| `posicao_atual_situacao` | text | Situação de `posicao_atual` (CORES.md) |
| `eta` | text | "ETA" ou "ETA ORIGEM" ou "PREVISÃO DE CHEGADA" |
| `eta_situacao` | text | Situação de `eta` (CORES.md) |
| `status` | text | "STATUS" |
| `status_situacao` | text | Situação de `status` (CORES.md) |
| `checklist` | text | "CHECKLIST" |
| `checklist_situacao` | text | Situação de `checklist` (CORES.md) |
| `chega_a_tempo` | text | "CHEGA A TEMPO?" |
| `chega_a_tempo_situacao` | text | Situação de `chega_a_tempo` (CORES.md) |
| `espelhamento` | text | "ESPELHAMENTO" |
| `espelhamento_situacao` | text | Situação de `espelhamento` (CORES.md) |
| `km_faltante` | text | "KM FALTANTE" |
| `km_faltante_situacao` | text | Situação de `km_faltante` (CORES.md) |
| `km_h` | text | "KM/H" |
| `km_h_situacao` | text | Situação de `km_h` (CORES.md) |
| `macro` | text | "MACRO" |
| `macro_situacao` | text | Situação de `macro` (CORES.md) |
| `sm` | text | "SM" |
| `sm_situacao` | text | Situação de `sm` (CORES.md) |
| `tag` | text | "TAG" |
| `tag_situacao` | text | Situação de `tag` (CORES.md) |
| `tempo_para_bipagem` | text | "TEMPO PARA BIPAGEM" |
| `tempo_para_bipagem_situacao` | text | Situação de `tempo_para_bipagem` (CORES.md) |
| `ultima_atualizacao` | text | "ULTIMA ATUALIZAÇÃO" |
| `ultima_atualizacao_situacao` | text | Situação de `ultima_atualizacao` (CORES.md) |

### torre.v_status

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ultima_sincronizacao` | timestamptz | Fim da última cópia que aplicou pelo menos uma aba |
| `minutos_desde` | int | Minutos desde a última cópia boa |
| `abas` | int | Abas aplicadas nessa cópia |
| `linhas` | int | Linhas aplicadas nessa cópia |
| `ultima_tentativa` | timestamptz | Início da última tentativa (boa ou não) |
| `ultimo_erro` | text | Erro/aviso da última tentativa (null = tudo certo) |

### torre.v_transito

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `lh` | text | "LH" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `motorista` | text | "MOTORISTA" |
| `motorista_situacao` | text | Situação de `motorista` (CORES.md) |
| `carga` | text | "CARGA" |
| `carga_situacao` | text | Situação de `carga` (CORES.md) |
| `contato` | text | "CONTATO DO MOTORISTA" ou "CONTATO" |
| `contato_situacao` | text | Situação de `contato` (CORES.md) |
| `cavalo` | text | "CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `carreta` | text | "CARRETA" |
| `carreta_situacao` | text | Situação de `carreta` (CORES.md) |
| `vinculo` | text | "VÍNCULO" |
| `vinculo_situacao` | text | Situação de `vinculo` (CORES.md) |
| `origem` | text | "ORIGEM" |
| `origem_situacao` | text | Situação de `origem` (CORES.md) |
| `destino` | text | "DESTINO" |
| `destino_situacao` | text | Situação de `destino` (CORES.md) |
| `posicao_atual` | text | "POSIÇÃO ATUAL" |
| `posicao_atual_url` | text | Link de `posicao_atual` (só http/https) |
| `posicao_atual_situacao` | text | Situação de `posicao_atual` (CORES.md) |
| `cpt_origem` | text | "CPT ORIGEM" |
| `cpt_origem_situacao` | text | Situação de `cpt_origem` (CORES.md) |
| `cpt_realizado` | text | "CPT REALIZADO" |
| `cpt_realizado_situacao` | text | Situação de `cpt_realizado` (CORES.md) |
| `pct` | text | "PCT" |
| `pct_situacao` | text | Situação de `pct` (CORES.md) |
| `km_h` | text | "KM/H" |
| `km_h_situacao` | text | Situação de `km_h` (CORES.md) |
| `t_parada` | text | "T PARADA" |
| `t_parada_situacao` | text | Situação de `t_parada` (CORES.md) |
| `total_parada` | text | "TOTAL PARADA" |
| `total_parada_situacao` | text | Situação de `total_parada` (CORES.md) |
| `macro` | text | "MACRO" |
| `macro_situacao` | text | Situação de `macro` (CORES.md) |
| `atualizacao` | text | "ATUALIZAÇÃO" |
| `atualizacao_situacao` | text | Situação de `atualizacao` (CORES.md) |
| `previsao_chegada` | text | "PREVISÃO DE CHEGADA" |
| `previsao_chegada_situacao` | text | Situação de `previsao_chegada` (CORES.md) |
| `eta_destino` | text | "ETA DESTINO" |
| `eta_destino_situacao` | text | Situação de `eta_destino` (CORES.md) |
| `t_chegada` | text | "T CHEGADA" |
| `t_chegada_situacao` | text | Situação de `t_chegada` (CORES.md) |
| `status` | text | "STATUS" |
| `status_situacao` | text | Situação de `status` (CORES.md) |
| `progressao_viagem` | text | "PROGRESSÃO VIAGEM" ou "PROGRESSÃO DA VIAGEM" |
| `progressao_viagem_situacao` | text | Situação de `progressao_viagem` (CORES.md) |
| `faturamento` | text | "FATURAMENTO" |
| `faturamento_situacao` | text | Situação de `faturamento` (CORES.md) |
| `ciot_vpo` | text | "CIOT / VPO" |
| `ciot_vpo_situacao` | text | Situação de `ciot_vpo` (CORES.md) |
| `sm` | text | "SM" |
| `sm_situacao` | text | Situação de `sm` (CORES.md) |
| `diferenca_do_cpt` | text | "DIFERENÇA DO CPT" |
| `diferenca_do_cpt_situacao` | text | Situação de `diferenca_do_cpt` (CORES.md) |
| `limite_de_parada` | text | "LIMITE DE PARADA" |
| `limite_de_parada_situacao` | text | Situação de `limite_de_parada` (CORES.md) |

### torre.v_validacoes

| Coluna | Tipo | Conteúdo (fase 1: título na planilha) |
|---|---|---|
| `ordem` | int | Ordem de exibição (fase 1: número da linha na planilha) |
| `lh` | text | "LH" ou "LT" |
| `lh_situacao` | text | Situação de `lh` (CORES.md) |
| `motorista` | text | "MOTORISTA" |
| `motorista_situacao` | text | Situação de `motorista` (CORES.md) |
| `cavalo` | text | "CAVALO" ou "PLACA" ou "PLACA CAVALO" |
| `cavalo_situacao` | text | Situação de `cavalo` (CORES.md) |
| `origem` | text | "0RIGEM" ou "ORIGEM" |
| `origem_situacao` | text | Situação de `origem` (CORES.md) |
| `checklist` | text | "CHECKLIST" ou "CHECK LIST" |
| `checklist_situacao` | text | Situação de `checklist` (CORES.md) |
| `sm` | text | "SM" |
| `sm_situacao` | text | Situação de `sm` (CORES.md) |
| `status` | text | "STATUS ATUAL" ou "STATUS" |
| `status_situacao` | text | Situação de `status` (CORES.md) |
| `espelhamento` | text | "ESPELHAMENTO" |
| `espelhamento_situacao` | text | Situação de `espelhamento` (CORES.md) |
| `etapa` | text | "ETAPA" |
| `etapa_situacao` | text | Situação de `etapa` (CORES.md) |
| `timer` | text | "TIMER" |
| `timer_situacao` | text | Situação de `timer` (CORES.md) |

## Conferir os títulos depois da primeira cópia

Rode no SQL Editor. A consulta lista os títulos da planilha que não alimentam nenhuma coluna e as
colunas do contrato cujo título não apareceu na aba:

```sql
with cab as (
  select a.aba, torre.chave(e ->> 'g') || '|' || torre.chave(e ->> 'c') as k,
         coalesce((e ->> 'g') || ' / ', '') || (e ->> 'c') as titulo
    from torre.planilha_abas a, jsonb_array_elements(a.cabecalho) e
), usados as (
  select c.aba, c.coluna, k.k
    from torre.colunas c, jsonb_array_elements_text(torre.titulos(c.aba) -> c.coluna) k(k)
)
select 'título da planilha sem coluna' as tipo, cab.aba, cab.titulo as item
  from cab where not exists (select 1 from usados u where u.aba = cab.aba and u.k = cab.k)
union all
select 'coluna sem título na planilha', c.aba, c.coluna
  from torre.colunas c
 where exists (select 1 from torre.planilha_abas a where a.aba = c.aba)
   and not exists (select 1 from usados u join cab on cab.aba = u.aba and cab.k = u.k
                    where u.aba = c.aba and u.coluna = c.coluna)
order by 1, 2, 3;
```

## Fase 2: o que fazer

1. Criar as tabelas definitivas no schema `torre`, com RLS (select só para `torre.eh_operador()`) e
   sem escrita pela API.
2. Recriar cada view com `create or replace view torre.v_… with (security_invoker = true)`,
   mantendo **as mesmas colunas, na mesma ordem e com os mesmos tipos** das tabelas acima, agora
   lendo as tabelas novas. Os `_situacao` passam a vir de regras.
3. Desligar o gatilho do Apps Script. As tabelas `torre.planilha_*` podem ficar até a fase 2 estar
   estável e depois ser apagadas.
4. O site não muda.

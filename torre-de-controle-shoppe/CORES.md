# Torre de Controle - Shoppe: tradução das cores da planilha

Na planilha "TORRE DE CONTROLE SHOPEE", a cor da célula indica a situação (vermelho = atrasado
etc.). O site não usa a cor crua. Cada campo colorido ganha uma coluna `<campo>_situacao` nas views
(ver `CONTRATO_DADOS.md`), e a tela é pintada a partir dela.

| Família na planilha | Exemplos de valor | Situação |
|---|---|---|
| vermelho | NOK, ATRASADO, DELAY, PENDENTE CIOT, timer estourado | `critico` |
| verde | OK, NO PRAZO, CHEGOU, FORECAST, Carregando | `ok` |
| amarelo | FORA DO CD, Chegada Destino, FATURAR, REVERSA | `atencao` |
| laranja | Em trânsito, SPOT | `andamento` |
| azul | Descarregando | `info` |
| preto | (destaque especial) | `destaque` |
| branco, cinza ou cor do bloco | sem significado | `null` |

## Como a família é decidida (fase 1)

A comparação é feita pela **família** da cor, de forma aproximada, e não pelo hex exato. Assim, os
tons claros e escuros da paleta do Google Sheets caem na mesma família. A função
`torre.familia_cor` converte a cor para matiz, saturação e luminosidade e aplica as faixas abaixo:

| Condição | Família |
|---|---|
| luminosidade ≤ 15% | preto |
| luminosidade ≥ 97% ou saturação < 20% | neutro (branco/cinza) |
| matiz < 15° ou ≥ 330° | vermelho |
| matiz 15°–42° | laranja |
| matiz 42°–70° | amarelo |
| matiz 70°–165° | verde |
| matiz 165°–260° | azul |
| matiz 260°–330° (roxo, rosa) | neutro |

Exemplos da paleta do Sheets:

| Cor | Hex | Família |
|---|---|---|
| vermelho claro 3 / vermelho | `#f4cccc` / `#ff0000` | vermelho |
| laranja claro 3 / laranja | `#fce5cd` / `#ff9900` | laranja |
| amarelo claro 3 / amarelo | `#fff2cc` / `#ffff00` | amarelo |
| verde claro 3 / verde claro 1 | `#d9ead3` / `#b6d7a8` | verde |
| azul claro 3 | `#cfe2f3` | azul |
| preto | `#000000` | preto |
| cinza claro / branco | `#efefef` / `#ffffff` | neutro |

Regras:

1. **Primeiro o fundo.** Se o fundo for neutro (branco ou cinza), vale a **cor do texto**, quando ela
   for vermelha, verde, amarela ou laranja. Texto azul não conta, porque é a cor padrão de link.
   Texto preto também não.
2. **Cor do bloco ou do cabeçalho não tem significado.** O Apps Script marca com `"cb": true` a
   célula cujo fundo é igual ao do título da coluna ou do nome do bloco (linha 5 da MATRIZ). Nesse
   caso o fundo é ignorado.
3. **Limites entre famílias.** Os limites (por exemplo, 42° entre laranja e amarelo) foram
   escolhidos para a paleta padrão do Sheets. Se a planilha usar um tom personalizado que caia na
   família errada, ajuste as faixas em `torre.familia_cor` no `T01_copia_planilha.sql`. As views não
   mudam.

Na fase 2, `_situacao` deixa de vir da cor e passa a vir de regras (ex.: atrasado → `critico`), com
os mesmos valores.

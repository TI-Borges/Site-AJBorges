// Regra da média de combustível (passo 24) direto na função única (JavaScript/media-combustivel.js),
// com dados INVENTADOS: saída + durante + chegada (a saída não entra); sem chegada = "Em aberto";
// 2 placas separadas; ARLA não entra; ficha antiga com aviso; Σ KM ÷ Σ litros ≠ média das médias.
// Uso: node testes/t_media_combustivel.js
const path = require('path');
const RAIZ = process.env.RAIZ || path.resolve(__dirname, '..');
const M = require(path.join(RAIZ, 'JavaScript/media-combustivel.js'));

const erros = [];
const igual = (nome, obtido, esperado) => {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}: ${JSON.stringify(obtido)}${ok ? '' : ` (esperado ${JSON.stringify(esperado)})`}`);
  if (!ok) erros.push(nome);
};
const d = (momento, litros, extra = {}) => ({ combustivel: 'diesel_s10', momento, litros, ...extra });

// 1. Exemplo real: 1.250 km; saída completou 100 L (repõe a viagem anterior), durante 200 L, chegada 100 L.
//    Conta antiga: 1250 ÷ 400 = 3,13. Conta nova: 1250 ÷ 300 = 4,17 (a Scania mostrou 4,17).
const real = M.calcular({ km: { principal: 1250 }, abastecimentos: [d('saida', '100,000'), d('durante', '200'), d('chegada', '100')] });
igual('saida+durante+chegada: situação', real.placas.principal.situacao, 'fechada');
igual('saida+durante+chegada: litros (sem a saída)', real.placas.principal.litros, 300);
igual('saida+durante+chegada: média 2 casas', real.placas.principal.texto, '4,17 km/l');
igual('saida+durante+chegada: litros da saída à parte', real.placas.principal.litrosSaida, 100);
igual('saida+durante+chegada: sem aviso', real.placas.principal.aviso, '');

// 2. Sem chegada (foi para a manutenção): em aberto
const aberto = M.calcular({ km: { principal: 1250 }, abastecimentos: [d('saida', '100'), d('durante', '200')] });
igual('sem chegada: situação', aberto.placas.principal.situacao, 'em_aberto');
igual('sem chegada: texto', aberto.placas.principal.texto, 'Em aberto, falta o abastecimento de chegada');
igual('sem chegada: média', aberto.placas.principal.media, null);
igual('sem chegada: fora do histórico', aberto.placas.principal.entraNoHistorico, false);
igual('sem chegada: ficha em aberto', aberto.emAberto, true);
// ficha nova sem nenhum abastecimento de diesel (motorista) também fica em aberto
igual('ficha nova sem diesel: em aberto', M.calcular({ km: { principal: 500 }, abastecimentos: [], novaFicha: true }).placas.principal.situacao, 'em_aberto');
// linha de diesel sem Momento numa ficha nova: em aberto até escolher
igual('ficha nova com linha sem Momento', M.calcular({ km: { principal: 500 }, abastecimentos: [d('chegada', '100'), d('', '50')] }).placas.principal.situacao, 'falta_momento');

// 3. Chegada com 0 litros e KM: litros 0 = "—"
igual('litros 0 → —', M.calcular({ km: { principal: 500 }, abastecimentos: [d('saida', '100'), d('chegada', '0')] }).placas.principal.texto, '—');

// 4. Duas placas: tudo separado; cada uma com a sua saída, durante, chegada e média
const duas = M.calcular({
  km: { principal: 1000, secundaria: 900 }, temSecundaria: true,
  abastecimentos: [
    d('saida', '300', { placa: 'principal' }), d('durante', '200', { placa: 'principal' }), d('chegada', '200', { placa: 'principal' }),
    d('saida', '500', { placa: 'secundaria' }), d('durante', '300', { placa: 'secundaria' })
  ]
});
igual('2 placas: principal fechada 1000 ÷ 400', [duas.placas.principal.situacao, duas.placas.principal.texto], ['fechada', '2,50 km/l']);
igual('2 placas: secundária sem chegada = em aberto', [duas.placas.secundaria.situacao, duas.placas.secundaria.litros], ['em_aberto', 300]);
igual('2 placas: não existe média somando as duas (só por placa)', Object.keys(duas.placas), ['principal', 'secundaria']);
// sem placa secundária, linha marcada "secundaria" (resto antigo) conta na principal
igual('sem 2ª placa: tudo na principal', M.calcular({ km: { principal: 600 }, abastecimentos: [d('chegada', '100', { placa: 'secundaria' }), d('durante', '100')] }).placas.principal.litros, 200);

// 5. ARLA não entra (nem com Momento)
const arla = M.calcular({ km: { principal: 1000 }, abastecimentos: [d('durante', '200'), d('chegada', '200'), { combustivel: 'arla', momento: 'chegada', litros: '50' }, { combustivel: 'arla', litros: '10' }] });
igual('ARLA fora: litros', arla.placas.principal.litros, 400);
igual('ARLA fora: média', arla.placas.principal.texto, '2,50 km/l');
igual('ARLA sem Momento não deixa a ficha "faltando Momento"', arla.placas.principal.situacao, 'fechada');
// diesel S500 e linha sem tipo entram
igual('S500 e sem tipo entram', M.calcular({ km: { principal: 900 }, abastecimentos: [{ combustivel: 'diesel_s500', momento: 'durante', litros: '100' }, { momento: 'chegada', litros: '200' }] }).placas.principal.litros, 300);

// 6. Ficha antiga (nenhum Momento): conta de antes (com a saída) e aviso; nada é gravado
const fichaAntiga = { abastecimentos: [{ combustivel: 'diesel_s10', litros: '100' }, { combustivel: 'diesel_s10', litros: '200' }, { combustivel: 'diesel_s10', litros: '100' }] };
const copia = JSON.stringify(fichaAntiga);
const antiga = M.calcular({ km: { principal: 1250 }, abastecimentos: fichaAntiga.abastecimentos });
igual('antiga: situação', antiga.placas.principal.situacao, 'antiga');
igual('antiga: conta de antes 1250 ÷ 400', antiga.placas.principal.texto, '3,13 km/l');
igual('antiga: aviso', antiga.placas.principal.aviso, 'média antiga (inclui o acerto da saída)');
igual('antiga: ficha não foi alterada', JSON.stringify(fichaAntiga), copia);
igual('antiga sem lista: total de litros gravado', M.calcular({ km: { principal: 1000 }, abastecimentos: [], litrosSemLista: 400 }).placas.principal.texto, '2,50 km/l');
igual('antiga sem nada: —', M.calcular({ km: { principal: 0 }, abastecimentos: [] }).placas.principal.texto, '—');

// 7. Histórico: Σ KM ÷ Σ litros ≠ média das médias; em aberto fora; antigas entram com a conta de antes
const v1 = M.calcular({ km: { principal: 1000 }, abastecimentos: [d('saida', '999'), d('chegada', '500')] }).placas.principal; // 2,00
const v2 = M.calcular({ km: { principal: 3000 }, abastecimentos: [d('durante', '500'), d('chegada', '500')] }).placas.principal; // 3,00
const v3 = M.calcular({ km: { principal: 800 }, abastecimentos: [d('durante', '100')] }).placas.principal; // em aberto
const h = M.somarHistorico([v1, v2, v3]);
const mediaDasMedias = (v1.media + v2.media) / 2;
igual('Σ: km e litros só das fechadas', [h.km, h.litros, h.viagens, h.emAberto], [4000, 1500, 2, 1]);
igual('Σ KM ÷ Σ litros = 2,67', M.formatarMedia(h.media), '2,67');
igual('média das médias seria 2,50 (diferente)', [M.formatarMedia(mediaDasMedias), h.media !== mediaDasMedias], ['2,50', true]);
const hAntiga = M.somarHistorico([v1, antiga.placas.principal]);
igual('Σ com antiga: entra com a conta de antes e é contada', [hAntiga.km, hAntiga.litros, hAntiga.antigas], [2250, 900, 1]);

console.log(erros.length ? `FALHOU (${erros.length})` : 'OK');
process.exit(erros.length ? 1 : 0);

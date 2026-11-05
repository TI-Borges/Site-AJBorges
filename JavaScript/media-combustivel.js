// =============================================================================
// Média de combustível (passo 24) - UMA regra só, usada na ficha (relatorio.js) e no
// dashboard da frota (dashboard-admin.js). Tanque cheio a tanque cheio, por placa:
//   - Momento "Saída" (completar o tanque antes de sair) NÃO entra na média desta viagem:
//     repõe o diesel da viagem anterior.
//   - "Durante a viagem" e "Chegada" entram.
//   - Sem abastecimento de Chegada naquela placa: a média fica EM ABERTO.
//   - Litros = só diesel (S10, S500 e linha sem combustível); ARLA nunca entra.
//   - KM = KM chegada - KM saída daquela placa.
//   - Com placa secundária, cada placa tem a sua média; não existe média somando as duas.
// Ficha ANTIGA (nenhum abastecimento com Momento): a conta de antes (KM ÷ todo o diesel da
// placa), com o aviso "média antiga (inclui o acerto da saída)". Nada é recalculado nem gravado.
// Histórico (por veículo, por motorista, da frota): Σ KM ÷ Σ litros só das placas que entram
// no histórico (fechadas e antigas com média), nunca a média das médias.
// =============================================================================
(function (raiz) {
    'use strict';

    const MOMENTOS = ['saida', 'durante', 'chegada'];
    const ROTULOS_MOMENTO = { saida: 'Saída', durante: 'Durante a viagem', chegada: 'Chegada' };
    const AJUDA_MOMENTO = 'Saída = completar o tanque antes de sair; não entra na média desta viagem.';
    const AVISO_ANTIGA = 'média antiga (inclui o acerto da saída)';
    const TEXTO_EM_ABERTO = 'Em aberto, falta o abastecimento de chegada';
    const TEXTO_FALTA_MOMENTO = 'Em aberto, falta escolher o Momento de um abastecimento de diesel';

    const momentoValido = (m) => (MOMENTOS.includes(m) ? m : '');
    const ehArla = (a) => !!a && a.combustivel === 'arla';

    // Litros com a mesma regra da ficha: com vírgula, ela é o decimal ("150,5"); sem vírgula,
    // o ponto é milhar ("1.000" = 1000 L)
    function parseLitros(valor) {
        if (typeof valor === 'number') return isFinite(valor) ? valor : 0;
        const s = String(valor ?? '').trim();
        if (!s) return 0;
        if (s.includes(',')) {
            const [inteiro, ...decimais] = s.split(',');
            const n = parseFloat((inteiro.replace(/\D/g, '') || '0') + '.' + (decimais.join('').replace(/\D/g, '') || '0'));
            return isNaN(n) ? 0 : n;
        }
        const n = parseInt(s.replace(/\D/g, ''), 10);
        return isNaN(n) ? 0 : n;
    }

    // "x,xx" (2 casas, vírgula)
    function formatarMedia(n) {
        return Number(n).toFixed(2).replace('.', ',');
    }

    /**
     * entrada = {
     *   abastecimentos: [{ combustivel, placa, momento, litros }],
     *   km: { principal: n, secundaria: n },     // KM de cada placa (chegada - saída)
     *   temSecundaria: bool,
     *   novaFicha: bool,           // true = trata como ficha nova mesmo sem Momento (ficha do motorista)
     *   litrosSemLista: n          // ficha muito antiga sem a lista: total de litros gravado (conta antiga)
     * }
     * Devolve { antiga, placas: { principal, secundaria|null }, emAberto }
     * Cada placa: { situacao: 'fechada'|'em_aberto'|'falta_momento'|'antiga', km, litros, media (número|null),
     *              texto ('x,xx km/l' | '—' | 'Em aberto, ...'), aviso ('' | 'média antiga ...'),
     *              entraNoHistorico, temChegada, litrosSaida }
     */
    function calcular(entrada) {
        const e = entrada || {};
        const abasts = (Array.isArray(e.abastecimentos) ? e.abastecimentos : []).filter(a => a && typeof a === 'object');
        const temSecundaria = !!e.temSecundaria;
        const km = e.km || {};
        const nova = !!e.novaFicha || abasts.some(a => momentoValido(a.momento));
        const qualDaLinha = (a) => (temSecundaria && a.placa === 'secundaria' ? 'secundaria' : 'principal');

        const placa = (qual) => {
            const kmPlaca = Math.max(0, Number(km[qual]) || 0);
            const diesel = abasts.filter(a => !ehArla(a) && qualDaLinha(a) === qual);
            const r = { situacao: '', km: kmPlaca, litros: 0, media: null, texto: '—', aviso: '', entraNoHistorico: false, temChegada: false, litrosSaida: 0 };

            if (!nova) {
                // Conta de antes: KM ÷ todo o diesel da placa (inclui o acerto da saída)
                r.situacao = 'antiga';
                r.aviso = AVISO_ANTIGA;
                r.litros = diesel.reduce((s, a) => s + parseLitros(a.litros), 0);
                if (!diesel.length && qual === 'principal') r.litros = Math.max(0, Number(e.litrosSemLista) || 0);
            } else {
                r.temChegada = diesel.some(a => momentoValido(a.momento) === 'chegada');
                diesel.forEach(a => {
                    const m = momentoValido(a.momento);
                    const l = parseLitros(a.litros);
                    if (m === 'durante' || m === 'chegada') r.litros += l;
                    else if (m === 'saida') r.litrosSaida += l;
                });
                if (diesel.some(a => !momentoValido(a.momento))) {
                    r.situacao = 'falta_momento';
                    r.texto = TEXTO_FALTA_MOMENTO;
                    return r;
                }
                if (!r.temChegada) {
                    r.situacao = 'em_aberto';
                    r.texto = TEXTO_EM_ABERTO;
                    return r;
                }
                r.situacao = 'fechada';
            }
            if (r.km > 0 && r.litros > 0 && isFinite(r.km / r.litros)) {
                r.media = r.km / r.litros;
                r.texto = `${formatarMedia(r.media)} km/l`;
                r.entraNoHistorico = true;
            }
            return r;
        };

        const placas = { principal: placa('principal'), secundaria: temSecundaria ? placa('secundaria') : null };
        const lista = [placas.principal, placas.secundaria].filter(Boolean);
        return {
            antiga: !nova,
            placas,
            emAberto: lista.some(p => p.situacao === 'em_aberto' || p.situacao === 'falta_momento')
        };
    }

    // Σ KM ÷ Σ litros das partes que entram no histórico (nunca a média das médias).
    // partes = lista de resultados de placa (ver calcular). Devolve { km, litros, media|null, viagens, emAberto, antigas }
    function somarHistorico(partes) {
        const t = { km: 0, litros: 0, media: null, viagens: 0, emAberto: 0, antigas: 0 };
        (partes || []).forEach(p => {
            if (!p) return;
            if (p.situacao === 'em_aberto' || p.situacao === 'falta_momento') { t.emAberto += 1; return; }
            if (!p.entraNoHistorico) return;
            t.km += p.km;
            t.litros += p.litros;
            t.viagens += 1;
            if (p.situacao === 'antiga') t.antigas += 1;
        });
        t.media = t.litros > 0 && t.km > 0 ? t.km / t.litros : null;
        return t;
    }

    const api = { MOMENTOS, ROTULOS_MOMENTO, AJUDA_MOMENTO, AVISO_ANTIGA, TEXTO_EM_ABERTO, TEXTO_FALTA_MOMENTO, momentoValido, parseLitros, formatarMedia, calcular, somarHistorico };
    raiz.MediaCombustivel = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

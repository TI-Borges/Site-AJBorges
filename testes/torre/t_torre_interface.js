/**
 * Suite completa de testes da Torre de Controle - Shoppe (Puppeteer).
 * Segue o padrão do projeto (testes/harness.js e testes/t_torre_painel.js)
 * com respostas simuladas das views do schema `torre` (sem dados reais de motorista).
 * Também salva as capturas em `testes/capturas/` (MATRIZ, TRÂNSITO e Modo TV).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { abrir } = require('../harness');

const RAIZ = path.resolve(__dirname, '..', '..');
const TORRE = '/torre-de-controle-shoppe/HTML/index.html';
const PASTA_CAPTURAS = path.resolve(__dirname, '..', 'capturas');

let falhas = 0;
const ok = (cond, msg, extra = '') => {
    console.log(`${cond ? 'OK   ' : 'FALHA'} ${msg}${extra ? ` (${extra})` : ''}`);
    if (!cond) falhas++;
};

/**
 * Massa de dados simulada para as views do contrato (`CONTRATO_DADOS.md`).
 * Nomes e telefones 100% fictícios.
 */
function criarViewsSimuladas({ minutosDesde = 4, semCopia = false, injetarXss = false } = {}) {
    if (semCopia) {
        return {
            v_status: [{
                ultima_sincronizacao: null,
                minutos_desde: null,
                abas: 0,
                linhas: 0,
                ultima_tentativa: null,
                ultimo_erro: null
            }],
            v_matriz_contadores: [{
                rotas_ativas: 0,
                pendentes_chegada: 0,
                carregamentos: 0,
                transito: 0,
                atrasos: 0,
                descarga: 0,
                atualizado_em: null,
                copiado_em: null
            }],
            v_matriz: [],
            v_validacoes: [],
            v_origem: [],
            v_carregamentos: [],
            v_transito: [],
            v_descargas: [],
            v_faturamento: [],
            v_links: [],
            v_enderecos: []
        };
    }

    const etapasCiclo = ['origem', 'carregamento', 'transito', 'descarga'];
    const rotasCiclo = [
        'PR-PGU × SP-GRU (Hub Leste)',
        'SC-JOI × SP-CAJ (CD Principal)',
        'PR-CWB × RJ-DUQ (Hub Rio)',
        'RS-POA × SP-SUM (Hub Campinas)',
        'MG-BHZ × SP-GRU (Expresso)',
        'PR-LON × SP-Beri (Rota Sul)'
    ];

    const v_matriz = Array.from({ length: 32 }, (_, i) => {
        const num = i + 1;
        const etapa = etapasCiclo[i % etapasCiclo.length];
        const ehCritico = i % 5 === 0;
        const ehAtencao = i % 5 === 1;
        const sitStatus = ehCritico ? 'critico' : (ehAtencao ? 'atencao' : 'ok');

        return {
            ordem: num,
            lh: `LH2026${String(num).padStart(4, '0')}`,
            etapa,
            etapa_situacao: etapa === 'transito' ? 'andamento' : 'info',
            cavalo: `ABC${String(1000 + num)}`,
            cavalo_situacao: null,
            rota: i === 0 && injetarXss
                ? 'Rota XSS <img src=x onerror="window.__xssExecutou=true">'
                : rotasCiclo[i % rotasCiclo.length],
            rota_situacao: null,
            validador_origem: ehCritico ? 'Pendente GR' : 'Liberado',
            validador_origem_situacao: ehCritico ? 'critico' : 'ok',
            origem_eta: `0${(i % 8) + 1}:30`,
            origem_eta_situacao: ehCritico ? 'critico' : 'ok',
            origem_localizacao: `Ponta Grossa - KM ${40 + i}`,
            origem_localizacao_url: 'https://maps.google.com/?q=-25.09,-50.16',
            origem_localizacao_situacao: null,
            origem_km: `${15 + (i * 3)} km`,
            origem_km_situacao: null,
            origem_timer: ehCritico ? '-00:42' : '01:15',
            origem_timer_situacao: ehCritico ? 'critico' : 'ok',
            carregamento_cpt: `${String(10 + (i % 10)).padStart(2, '0')}:00`,
            carregamento_cpt_situacao: ehCritico ? 'critico' : 'ok',
            carregamento_timer: ehCritico ? '02:35' : '00:40',
            carregamento_timer_situacao: ehCritico ? 'critico' : 'ok',
            carregamento_status: ehCritico ? 'Atrasado Doca' : (etapa === 'carregamento' ? 'Carregando' : 'Concluído'),
            carregamento_status_situacao: ehCritico ? 'critico' : (etapa === 'carregamento' ? 'andamento' : 'ok'),
            transito_previsao_chegada: `${String(14 + (i % 9)).padStart(2, '0')}:20`,
            transito_previsao_chegada_situacao: sitStatus,
            transito_cpt: `${String(11 + (i % 8)).padStart(2, '0')}:00`,
            transito_cpt_situacao: 'ok',
            transito_eta_destino: `${String(18 + (i % 5)).padStart(2, '0')}:45`,
            transito_eta_destino_situacao: sitStatus,
            transito_status: ehCritico ? 'Atrasado' : (ehAtencao ? 'Atenção Risco' : 'No prazo'),
            transito_status_situacao: sitStatus,
            transito_parada: ehCritico ? '01:45' : '00:15',
            transito_parada_situacao: ehCritico ? 'critico' : 'ok',
            transito_kh: i % 4 === 0 ? '0' : String(72 + (i % 16)),
            transito_kh_situacao: i % 4 === 0 ? 'critico' : 'ok',
            transito_tt_restante: `0${(i % 6) + 1}:20`,
            transito_tt_restante_situacao: null,
            transito_delta_tt: ehCritico ? '-01:10' : '+00:25',
            transito_delta_tt_situacao: ehCritico ? 'critico' : 'ok',
            descarga_chegada: etapa === 'descarga' ? '19:10' : '',
            descarga_chegada_situacao: etapa === 'descarga' ? 'ok' : null,
            descarga_timer: etapa === 'descarga' ? '00:35' : '',
            descarga_timer_situacao: etapa === 'descarga' ? 'ok' : null,
            descarga_status: etapa === 'descarga' ? 'Em Descarga' : 'Aguardando',
            descarga_status_situacao: etapa === 'descarga' ? 'andamento' : 'info'
        };
    });

    const cargasCiclo = ['Forecast', 'Reversa', 'Spot'];
    const vinculosCiclo = ['Frota', 'Terceiro', 'Agregado'];
    const situacoesPills = ['critico', 'ok', 'atencao', 'andamento', 'info', 'destaque'];

    const v_transito = Array.from({ length: 28 }, (_, i) => {
        const num = i + 1;
        const carga = cargasCiclo[i % cargasCiclo.length];
        const vinculo = vinculosCiclo[i % vinculosCiclo.length];
        const atrasado = i % 4 === 0;
        const paradaCritica = i % 6 === 0;
        const ciotPendente = i % 5 === 0;
        const faturarPend = i % 3 === 0;
        const sitExemplo = situacoesPills[i % situacoesPills.length];

        return {
            ordem: num,
            lh: `LH2026${String(100 + num).padStart(4, '0')}`,
            lh_situacao: null,
            motorista: i === 0 && injetarXss
                ? 'Condutor Exemplo <img src=x onerror="window.__xssExecutou=true">'
                : `Motorista Simulado ${String(num).padStart(2, '0')}`,
            motorista_situacao: null,
            carga,
            carga_situacao: carga === 'Spot' ? 'destaque' : (carga === 'Reversa' ? 'info' : 'ok'),
            contato: i === 0
                ? '(42) 99911-0001 / (42) 98822-0002'
                : `(42) 99900-${String(1000 + num)}`,
            contato_situacao: null,
            cavalo: `TRK${String(2000 + num)}`,
            cavalo_situacao: null,
            carreta: `SRR${String(5000 + num)}`,
            carreta_situacao: null,
            vinculo,
            vinculo_situacao: vinculo === 'Frota' ? 'ok' : (vinculo === 'Agregado' ? 'info' : 'andamento'),
            origem: 'SC-JOI',
            origem_situacao: null,
            destino: 'SP-GRU',
            destino_situacao: null,
            posicao_atual: `BR-116 KM ${120 + i * 5}`,
            posicao_atual_url: 'https://maps.google.com/?q=-23.55,-46.63',
            posicao_atual_situacao: null,
            cpt_origem: '08:00',
            cpt_origem_situacao: 'ok',
            cpt_realizado: atrasado ? '09:15' : '07:55',
            cpt_realizado_situacao: atrasado ? 'critico' : 'ok',
            pct: '07:30',
            pct_situacao: 'ok',
            km_h: i % 3 === 0 ? '0 km/h' : `${65 + (i % 25)} km/h`,
            km_h_situacao: i % 3 === 0 ? 'critico' : 'ok',
            t_parada: paradaCritica ? '01:50' : '00:12',
            t_parada_situacao: paradaCritica ? 'critico' : 'ok',
            total_parada: paradaCritica ? '02:30' : `00:${String(10 + (i % 40)).padStart(2, '0')}`,
            total_parada_situacao: paradaCritica ? 'critico' : 'ok',
            macro: sitExemplo.toUpperCase(),
            macro_situacao: sitExemplo,
            atualizacao: '14:20',
            atualizacao_situacao: 'ok',
            previsao_chegada: '18:00',
            previsao_chegada_situacao: atrasado ? 'critico' : 'ok',
            eta_destino: atrasado ? '19:40' : '17:50',
            eta_destino_situacao: atrasado ? 'critico' : 'ok',
            t_chegada: '03:30',
            t_chegada_situacao: null,
            status: atrasado ? 'Atrasado' : 'No prazo',
            status_situacao: atrasado ? 'critico' : 'ok',
            progressao_viagem: `${Math.min(98, 18 + i * 3)}%`,
            progressao_viagem_situacao: atrasado ? 'critico' : 'ok',
            faturamento: faturarPend ? 'Faturar' : 'Faturado',
            faturamento_situacao: faturarPend ? 'atencao' : 'ok',
            ciot_vpo: ciotPendente ? 'Pendente' : 'Emitido',
            ciot_vpo_situacao: ciotPendente ? 'critico' : 'ok',
            sm: atrasado ? 'Revisar SM' : 'SM Ativa',
            sm_situacao: atrasado ? 'atencao' : 'ok',
            diferenca_do_cpt: atrasado ? '-01:40' : '+00:10',
            diferenca_do_cpt_situacao: atrasado ? 'critico' : 'ok',
            limite_de_parada: '01:30',
            limite_de_parada_situacao: null
        };
    });

    const v_validacoes = [
        {
            ordem: 1,
            lh: 'LH20260301',
            motorista: 'Motorista Simulado Val 01',
            cavalo: 'VAL1001',
            origem: 'PR-PGU',
            checklist: 'Vencido',
            checklist_situacao: 'critico',
            sm: 'Regular',
            sm_situacao: 'ok',
            status: 'Bloqueado',
            status_situacao: 'critico',
            espelhamento: 'Ativo',
            espelhamento_situacao: 'ok',
            etapa: 'Validação GR',
            etapa_situacao: 'andamento',
            timer: '00:48',
            timer_situacao: 'critico'
        },
        {
            ordem: 2,
            lh: 'LH20260302',
            motorista: 'Motorista Simulado Val 02',
            cavalo: 'VAL1002',
            origem: 'SC-JOI',
            checklist: 'Aprovado',
            checklist_situacao: 'ok',
            sm: 'Sem sinal',
            sm_situacao: 'critico',
            status: 'Em análise',
            status_situacao: 'atencao',
            espelhamento: 'Falha Espelhamento',
            espelhamento_situacao: 'critico',
            etapa: 'Checklist',
            etapa_situacao: 'info',
            timer: '00:12',
            timer_situacao: 'ok'
        },
        {
            ordem: 3,
            lh: 'LH20260303',
            motorista: 'Motorista Simulado Val 03',
            cavalo: 'VAL1003',
            origem: 'SP-GRU',
            checklist: 'Aprovado',
            checklist_situacao: 'ok',
            sm: 'Regular',
            sm_situacao: 'ok',
            status: 'Liberado',
            status_situacao: 'ok',
            espelhamento: 'Ativo',
            espelhamento_situacao: 'ok',
            etapa: 'Concluído',
            etapa_situacao: 'ok',
            timer: '00:05',
            timer_situacao: 'ok'
        }
    ];

    const v_origem = [
        {
            ordem: 1,
            lh: 'LH20260401',
            motorista: 'Motorista Simulado Origem 01',
            contato: '(42) 99911-2233 / (42) 99944-5566',
            cavalo: 'ORI2001',
            carreta: 'CAR3001',
            vinculo: 'Frota',
            vinculo_situacao: 'ok',
            origem: 'PR-PGU',
            posicao_atual: 'Rod. BR-376 KM 490',
            posicao_atual_url: 'https://maps.google.com/?q=-25.10,-50.15',
            eta: '10:30',
            eta_situacao: 'ok',
            status: 'A caminho',
            status_situacao: 'andamento',
            checklist: 'OK',
            checklist_situacao: 'ok',
            chega_a_tempo: 'Sim',
            chega_a_tempo_situacao: 'ok',
            espelhamento: 'OK',
            espelhamento_situacao: 'ok',
            km_faltante: '18 km',
            km_h: '78 km/h',
            macro: 'EM VIAGEM',
            macro_situacao: 'info',
            sm: 'Emitida',
            sm_situacao: 'ok',
            tag: 'Ativa',
            tag_situacao: 'ok',
            tempo_para_bipagem: '01:10',
            tempo_para_bipagem_situacao: 'ok',
            ultima_atualizacao: '10:05',
            ultima_atualizacao_situacao: 'ok'
        },
        {
            ordem: 2,
            lh: 'LH20260402',
            motorista: 'Motorista Simulado Origem 02',
            contato: '(41) 98877-6655',
            cavalo: 'ORI2002',
            carreta: 'CAR3002',
            vinculo: 'Terceiro',
            vinculo_situacao: 'info',
            origem: 'PR-CWB',
            posicao_atual: 'Curitiba Contorno Sul',
            posicao_atual_url: 'https://maps.google.com/?q=-25.50,-49.30',
            eta: '11:45',
            eta_situacao: 'critico',
            status: 'Risco Atraso',
            status_situacao: 'critico',
            checklist: 'OK',
            checklist_situacao: 'ok',
            chega_a_tempo: 'Não',
            chega_a_tempo_situacao: 'critico',
            espelhamento: 'OK',
            espelhamento_situacao: 'ok',
            km_faltante: '95 km',
            km_h: '0 km/h',
            macro: 'PARADO',
            macro_situacao: 'critico',
            sm: 'Pendente',
            sm_situacao: 'critico',
            tag: 'Sem TAG',
            tag_situacao: 'atencao',
            tempo_para_bipagem: '-00:20',
            tempo_para_bipagem_situacao: 'critico',
            ultima_atualizacao: '10:02',
            ultima_atualizacao_situacao: 'ok'
        }
    ];

    const v_carregamentos = [
        {
            ordem: 1,
            lh: 'LH20260501',
            motorista: 'Motorista Simulado Carreg 01',
            contato: '(47) 99123-4567',
            cavalo: 'CRG101',
            carreta: 'SR101',
            vinculo: 'Frota',
            vinculo_situacao: 'ok',
            origem: 'SC-JOI',
            destino: 'SP-GRU',
            cpt: '12:00',
            cpt_situacao: 'ok',
            status: 'Em Doca',
            status_situacao: 'andamento',
            checklist: 'OK',
            checklist_situacao: 'ok',
            macro: 'CARREGANDO',
            macro_situacao: 'andamento',
            sm: 'OK',
            sm_situacao: 'ok',
            status_cpt: 'No Prazo',
            status_cpt_situacao: 'ok',
            tag: 'OK',
            tag_situacao: 'ok',
            ultima_atualizacao: '11:30',
            ultima_atualizacao_situacao: 'ok'
        },
        {
            ordem: 2,
            lh: 'LH20260502',
            motorista: 'Motorista Simulado Carreg 02',
            contato: '(47) 99234-5678',
            cavalo: 'CRG102',
            carreta: 'SR102',
            vinculo: 'Agregado',
            vinculo_situacao: 'destaque',
            origem: 'SC-BLN',
            destino: 'SP-CAJ',
            cpt: '11:00',
            cpt_situacao: 'critico',
            status: 'Aguardando NFe',
            status_situacao: 'critico',
            checklist: 'OK',
            checklist_situacao: 'ok',
            macro: 'PATIO',
            macro_situacao: 'atencao',
            sm: 'Pendente',
            sm_situacao: 'critico',
            status_cpt: 'Estourado',
            status_cpt_situacao: 'critico',
            tag: 'OK',
            tag_situacao: 'ok',
            ultima_atualizacao: '11:28',
            ultima_atualizacao_situacao: 'ok'
        }
    ];

    const v_descargas = [
        {
            ordem: 1,
            lh: 'LH20260601',
            motorista: 'Motorista Simulado Desc 01',
            contato: '(11) 97766-5544',
            cavalo: 'DSC401',
            carreta: 'SR401',
            vinculo: 'Frota',
            vinculo_situacao: 'ok',
            status: 'Descarregando',
            status_situacao: 'andamento',
            bipagem: 'Concluída',
            bipagem_situacao: 'ok',
            cd_de_descarga: 'SP-GRU Hub 02',
            eta_destino: '13:00',
            eta_destino_situacao: 'ok',
            macro: 'DOCA DESCARGA',
            macro_situacao: 'info',
            tempo_de_espera: '00:25',
            tempo_de_espera_situacao: 'ok'
        },
        {
            ordem: 2,
            lh: 'LH20260602',
            motorista: 'Motorista Simulado Desc 02',
            contato: '(11) 96655-4433',
            cavalo: 'DSC402',
            carreta: 'SR402',
            vinculo: 'Terceiro',
            vinculo_situacao: 'info',
            status: 'Fila Externa',
            status_situacao: 'critico',
            bipagem: 'Pendente',
            bipagem_situacao: 'atencao',
            cd_de_descarga: 'SP-CAJ CD 01',
            eta_destino: '11:30',
            eta_destino_situacao: 'critico',
            macro: 'AGUARDANDO',
            macro_situacao: 'critico',
            tempo_de_espera: '02:40',
            tempo_de_espera_situacao: 'critico'
        }
    ];

    const v_faturamento = [
        {
            ordem: 1,
            lh: 'LH20260701',
            motorista: 'Motorista Simulado Fat 01',
            cavalo: 'FAT501',
            carreta: 'SR501',
            vinculo: 'Frota',
            vinculo_situacao: 'ok',
            origem: 'PR-PGU',
            destino: 'SP-GRU',
            valor: 'R$ 4.850,00',
            ciot_vpo: 'Emitido',
            ciot_vpo_situacao: 'ok',
            valor_da_carga: 'R$ 320.000,00'
        },
        {
            ordem: 2,
            lh: 'LH20260702',
            motorista: 'Motorista Simulado Fat 02',
            cavalo: 'FAT502',
            carreta: 'SR502',
            vinculo: 'Terceiro',
            vinculo_situacao: 'andamento',
            origem: 'SC-JOI',
            destino: 'RJ-DUQ',
            valor: 'R$ 6.120,00',
            ciot_vpo: 'Pendente CIOT',
            ciot_vpo_situacao: 'critico',
            valor_da_carga: 'R$ 410.000,00'
        }
    ];

    const v_links = [
        {
            ordem: 1,
            titulo: 'Endereços e Rotas dos CDs Shopee',
            link: 'Catálogo oficial de bases',
            link_url: 'https://shopee.com.br/rotas-cds',
            link_2: null,
            link_2_url: null
        },
        {
            ordem: 2,
            titulo: 'Formulário de Solicitação de Escolta',
            link: 'login: operador@ajborges.com.br / senha: 999999',
            link_url: 'https://forms.gle/escolta-ajborges',
            link_2: 'senha secreta 123',
            link_2_url: 'https://forms.gle/escolta-backup'
        },
        {
            ordem: 3,
            titulo: 'Documentos Operacionais - Manual de Bipagem',
            link: 'Versão atualizada 2026',
            link_url: 'https://docs.google.com/document/d/manual-bipagem',
            link_2: null,
            link_2_url: null
        },
        {
            ordem: 4,
            titulo: 'Liberações Gerenciadora de Risco - senha: abc',
            link: 'suporte@gerenciadora.com',
            link_url: 'https://portalgr.exemplo.com.br/liberacoes',
            link_2: null,
            link_2_url: null
        },
        {
            ordem: 5,
            titulo: 'Link Inválido Malicioso',
            link: 'javascript:alert(1)',
            link_url: 'javascript:alert(1)',
            link_2: null,
            link_2_url: null
        }
    ];

    const v_enderecos = [
        {
            ordem: 1,
            nome: 'Hub Shopee Guarulhos',
            sigla: 'SP-GRU',
            sigla_situacao: 'info',
            tipo: 'Fulfillment / Hub',
            tipo_situacao: 'ok',
            id_station: 'ST-GRU-01',
            id_station_situacao: null,
            endereco: 'Av. Monteiro Lobato, 4500 - Guarulhos/SP https://maps.google.com/?q=Hub+Guarulhos',
            uf: 'SP',
            cep: '07190-000',
            cnpj: '11.222.333/0001-44'
        },
        {
            ordem: 2,
            nome: 'Cross Docking Joinville',
            sigla: 'SC-JOI',
            sigla_situacao: 'info',
            tipo: 'Cross Docking',
            tipo_situacao: 'andamento',
            id_station: 'ST-JOI-02',
            id_station_situacao: null,
            endereco: 'Rod. BR-101, KM 38 - Joinville/SC',
            uf: 'SC',
            cep: '89200-000',
            cnpj: '11.222.333/0002-25'
        }
    ];

    return {
        v_status: [{
            ultima_sincronizacao: '2026-10-30T14:25:00-03:00',
            minutos_desde: minutosDesde,
            abas: 9,
            linhas: 120,
            ultima_tentativa: '2026-10-30T14:25:00-03:00',
            ultimo_erro: null
        }],
        v_matriz_contadores: [{
            rotas_ativas: v_matriz.length,
            pendentes_chegada: v_matriz.filter((r) => r.etapa === 'origem').length,
            carregamentos: v_matriz.filter((r) => r.etapa === 'carregamento').length,
            transito: v_matriz.filter((r) => r.etapa === 'transito').length,
            atrasos: v_matriz.filter((r) => r.transito_status_situacao === 'critico').length,
            descarga: v_matriz.filter((r) => r.etapa === 'descarga').length,
            atualizado_em: '14:25',
            copiado_em: '2026-10-30T14:25:00-03:00'
        }],
        v_matriz,
        v_validacoes,
        v_origem,
        v_carregamentos,
        v_transito,
        v_descargas,
        v_faturamento,
        v_links,
        v_enderecos
    };
}

function servidorReal() {
    const tipos = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png'
    };
    return new Promise((res) => {
        const srv = http.createServer((req, resp) => {
            const arq = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]));
            fs.readFile(arq, (err, dados) => {
                if (err) {
                    resp.writeHead(404);
                    return resp.end();
                }
                resp.writeHead(200, {
                    'Content-Type': tipos[path.extname(arq).toLowerCase()] || 'application/octet-stream'
                });
                resp.end(dados);
            });
        });
        srv.listen(0, () => res(srv));
    });
}

const SUPABASE_FALSO_AUTH = `
window.supabase = { createClient: () => ({
  auth: {
    getUser: async () => {
      const papel = localStorage.getItem('teste_papel');
      return papel ? { data: { user: { id: 'u1', email: 't@t', app_metadata: { role: papel }, user_metadata: {} } }, error: null }
                   : { data: { user: null }, error: { message: 'sem sessão' } };
    },
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({})
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  schema: () => ({ from: () => ({ select: () => ({ order: async () => ({ data: [], error: null }), then: (cb) => Promise.resolve({ data: [], error: null }).then(cb) }) }) })
}) };`;

(async () => {
    if (!fs.existsSync(PASTA_CAPTURAS)) {
        fs.mkdirSync(PASTA_CAPTURAS, { recursive: true });
    }

    // ========================================================================
    // 1. Controle de Acesso Real (Admin entra, Motorista vai para o login)
    // ========================================================================
    {
        const srvAuth = await servidorReal();
        const baseAuth = `http://127.0.0.1:${srvAuth.address().port}`;
        const browserAuth = await puppeteer.launch({
            executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            headless: true,
            args: ['--no-sandbox']
        });
        const pageAuth = await browserAuth.newPage();
        await pageAuth.setRequestInterception(true);
        pageAuth.on('request', (r) => {
            const u = r.url();
            if (u.includes('@supabase/supabase-js')) {
                return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO_AUTH });
            }
            if (!u.startsWith(baseAuth)) {
                return r.respond({ status: 200, contentType: 'text/css', body: '' });
            }
            r.continue();
        });

        // Motorista -> Login
        await pageAuth.goto(`${baseAuth}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
        await pageAuth.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('teste_papel', 'motorista');
        });
        await pageAuth.goto(`${baseAuth}${TORRE}`, { waitUntil: 'load' });
        await new Promise((r) => setTimeout(r, 700));
        ok(
            pageAuth.url().replace(baseAuth, '') === '/HTML/Login.html#admin',
            'Motorista é redirecionado para /HTML/Login.html#admin'
        );

        // Admin -> Entra na Torre
        await pageAuth.evaluate(() => {
            localStorage.clear();
            localStorage.setItem('teste_papel', 'admin');
        });
        await pageAuth.goto(`${baseAuth}${TORRE}`, { waitUntil: 'load' });
        await new Promise((r) => setTimeout(r, 700));
        const visAdmin = await pageAuth.evaluate(() => document.documentElement.style.visibility);
        ok(
            pageAuth.url().replace(baseAuth, '') === TORRE && visAdmin === '',
            'Admin entra na Torre de Controle'
        );

        await browserAuth.close();
        srvAuth.close();
    }

    // ========================================================================
    // 2. Interface Completa com Views Simuladas (sem dados reais de motorista)
    // ========================================================================
    const viewsPadrao = criarViewsSimuladas({ minutosDesde: 4, injetarXss: false });
    const viewsComXss = criarViewsSimuladas({ minutosDesde: 4, injetarXss: true });
    const { srv, base, browser, page, erros } = await abrir({ largura: 1920, altura: 1080 });

    await page.evaluateOnNewDocument((dadosIniciais) => {
        localStorage.setItem('teste_usuario', JSON.stringify({
            role: 'admin',
            nome: 'Admin Simulado',
            id: 'adm-1'
        }));
        window.__torreViewsMock = JSON.parse(JSON.stringify(dadosIniciais));
        window.__torreConsultasRealizadas = [];

        const criarMockSchemaClient = () => ({
            auth: {
                getUser: async () => ({ data: { user: { id: 'adm-1' } }, error: null }),
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
                signOut: async () => ({})
            },
            schema: (nomeSchema) => ({
                from: (nomeView) => {
                    const resolver = () => {
                        window.__torreConsultasRealizadas.push(`${nomeSchema}.${nomeView}`);
                        if (window.__torreSimularErroRede) {
                            return Promise.resolve({
                                data: null,
                                error: { message: 'Falha simulada de rede' }
                            });
                        }
                        const linhas = (window.__torreViewsMock && window.__torreViewsMock[nomeView]) || [];
                        return Promise.resolve({ data: linhas, error: null });
                    };
                    return {
                        select: () => ({
                            order: () => resolver(),
                            single: () => resolver().then((r) => ({
                                data: Array.isArray(r.data) ? (r.data[0] || null) : r.data,
                                error: r.error
                            })),
                            then: (onFulfilled, onRejected) => resolver().then(onFulfilled, onRejected)
                        })
                    };
                }
            })
        });

        window.supabase = { createClient: () => criarMockSchemaClient() };
        window.supabaseClient = criarMockSchemaClient();
    }, viewsPadrao);

    await page.goto(`${base}${TORRE}`, { waitUntil: 'load' });
    await page.waitForSelector('#torre-tabela-dados tbody tr');

    const estadoInicial = await page.evaluate(() => ({
        abaTitulo: document.getElementById('torre-aba-titulo')?.textContent.trim(),
        gruposMatriz: Array.from(document.querySelectorAll('.matriz-header-grupos th')).map((th) => th.textContent.trim()),
        bolinhasEtapa: document.querySelectorAll('.etapa-indicador .etapa-bolinha').length,
        statusTexto: document.getElementById('torre-status-atualizacao')?.textContent.trim(),
        statusOk: document.getElementById('torre-status-atualizacao')?.classList.contains('status-ok')
    }));

    ok(estadoInicial.abaTitulo === 'MATRIZ', 'MATRIZ abre primeiro ao acessar a página');
    ok(
        ['ORIGEM', 'CARREGAMENTO', 'TRÂNSITO', 'DESCARGAS'].every((b) => estadoInicial.gruposMatriz.includes(b)),
        'MATRIZ tem cabeçalho em 2 níveis (ORIGEM, CARREGAMENTO, TRÂNSITO e DESCARGAS)'
    );
    ok(estadoInicial.bolinhasEtapa >= 4, 'MATRIZ exibe indicador visual de 4 bolinhas para a etapa');
    ok(
        estadoInicial.statusTexto.startsWith('Atualizado às ') && estadoInicial.statusOk,
        'Topo exibe "Atualizado às hh:mm" quando sincronizado há menos de 15 min',
        estadoInicial.statusTexto
    );

    // Captura 1: MATRIZ
    await page.screenshot({
        path: path.join(PASTA_CAPTURAS, 'torre_matriz.png'),
        fullPage: false
    });

    // Verifica escapeHtml contra <img onerror>
    await page.evaluate((vx) => {
        window.__torreViewsMock = vx;
    }, viewsComXss);
    await page.click('#btn-atualizar-dados');
    await new Promise((r) => setTimeout(r, 120));

    const segurancaXss = await page.evaluate(() => ({
        xssExecutou: Boolean(window.__xssExecutou),
        imgsDentroTabela: document.querySelectorAll('#torre-tabela-dados img').length,
        textoLiteralEscapado: document.querySelector('#torre-tabela-dados tbody')?.textContent.includes('<img src=x onerror=')
    }));
    ok(
        !segurancaXss.xssExecutou && segurancaXss.imgsDentroTabela === 0 && segurancaXss.textoLiteralEscapado,
        'escapeHtml neutraliza <img onerror> em todas as células da tabela'
    );

    await page.evaluate((vp) => {
        window.__torreViewsMock = vp;
    }, viewsPadrao);
    await page.click('#btn-atualizar-dados');
    await new Promise((r) => setTimeout(r, 120));

    // ========================================================================
    // 3. Contadores da MATRIZ filtram, Ordenação, Filtro de Coluna, Busca e Paginação
    // ========================================================================
    const paginacaoInfoInicial = await page.evaluate(() => ({
        linhasVisiveis: document.querySelectorAll('#torre-tabela-dados tbody tr').length,
        textoContagem: document.querySelector('.paginacao-contagem')?.textContent.replace(/\s+/g, ' ').trim()
    }));
    ok(
        paginacaoInfoInicial.linhasVisiveis === 25 && paginacaoInfoInicial.textoContagem.includes('32'),
        'Paginação padrão mostra 25 linhas por página de 32 totais'
    );

    await page.select('#select-por-pagina', '0');
    const linhasTodos = await page.evaluate(() => document.querySelectorAll('#torre-tabela-dados tbody tr').length);
    ok(linhasTodos === 32, 'Paginação "Todos" exibe todas as 32 linhas');
    await page.select('#select-por-pagina', '25');

    // Filtro por card KPI na MATRIZ
    await page.click('[data-acao="kpi-filtro"][data-kpi-id="atrasos"]');
    const linhasAtrasos = await page.evaluate(() => document.querySelectorAll('#torre-tabela-dados tbody tr').length);
    ok(linhasAtrasos > 0 && linhasAtrasos < 25, `Card KPI "Atrasos" filtra a tabela (${linhasAtrasos} linhas)`);

    await page.click('[data-acao="kpi-filtro"][data-kpi-id="atrasos"]');
    const linhasRestauradas = await page.evaluate(() => document.querySelectorAll('#torre-tabela-dados tbody tr').length);
    ok(linhasRestauradas === 25, 'Clicar novamente no card KPI remove o filtro');

    // Ordenação clicando no cabeçalho (LH)
    await page.click('th[data-coluna="lh"] [data-acao="ordenar-coluna"]');
    await page.click('th[data-coluna="lh"] [data-acao="ordenar-coluna"]'); // desc
    const primeiroLhDesc = await page.evaluate(() => (
        document.querySelector('#torre-tabela-dados tbody tr td.col-fixa-lh')?.textContent.trim()
    ));
    ok(primeiroLhDesc === 'LH20260032', 'Ordenação clicando no cabeçalho funciona (asc/desc)', primeiroLhDesc);

    // Filtro de coluna (popover no cabeçalho)
    await page.click('th[data-coluna="cavalo"] [data-acao="abrir-filtro-coluna"]');
    await page.waitForSelector('#torre-filtro-popover:not([hidden])');
    await page.evaluate(() => {
        const cb = document.querySelector('#torre-filtro-popover .popover-checkbox-valor[value="ABC1005"]');
        if (cb) cb.checked = true;
    });
    await page.click('#torre-filtro-popover [data-acao="aplicar-filtro-coluna"]');
    const linhasFiltroColuna = await page.evaluate(() => ({
        qtd: document.querySelectorAll('#torre-tabela-dados tbody tr').length,
        lh: document.querySelector('#torre-tabela-dados tbody tr td.col-fixa-lh')?.textContent.trim()
    }));
    ok(
        linhasFiltroColuna.qtd === 1 && linhasFiltroColuna.lh === 'LH20260005',
        'Filtro em cada coluna (popover com valores existentes) funciona'
    );

    await page.click('[data-acao="limpar-filtros"]');

    // Busca no topo
    await page.type('#torre-busca', 'LH20260012');
    const resultadoBusca = await page.evaluate(() => ({
        qtd: document.querySelectorAll('#torre-tabela-dados tbody tr').length,
        lh: document.querySelector('#torre-tabela-dados tbody tr td.col-fixa-lh')?.textContent.trim()
    }));
    ok(resultadoBusca.qtd === 1 && resultadoBusca.lh === 'LH20260012', 'Busca no topo filtra a tabela');
    await page.click('#btn-limpar-busca');

    // ========================================================================
    // 4. Atualização mantém filtros e rolagem
    // ========================================================================
    await page.click('[data-acao="etapa-rapida"][data-etapa="transito"]');
    await page.evaluate(() => {
        const sc = document.getElementById('torre-tabela-scroll');
        if (sc) {
            sc.scrollLeft = 180;
            sc.scrollTop = 20;
        }
    });
    await page.click('#btn-atualizar-dados');
    await new Promise((r) => setTimeout(r, 150));
    const posAposRefresh = await page.evaluate(() => {
        const sc = document.getElementById('torre-tabela-scroll');
        const btnAtivo = document.querySelector('.btn-etapa-rapida.ativo')?.getAttribute('data-etapa');
        return {
            scrollLeft: sc ? sc.scrollLeft : 0,
            etapaAtiva: btnAtivo
        };
    });
    ok(
        posAposRefresh.etapaAtiva === 'transito' && posAposRefresh.scrollLeft === 180,
        'Atualização mantém filtros e posição de rolagem da tabela'
    );
    await page.click('[data-acao="limpar-filtros"]');

    // ========================================================================
    // 5. Navegação pelas 9 telas + Verificações de TRÂNSITO, Links, Endereços e Voltar
    // ========================================================================
    const abasEsperadas = [
        { hash: '#validacoes', titulo: 'Validações' },
        { hash: '#origem', titulo: 'Origem' },
        { hash: '#carregamentos', titulo: 'Carregamentos' },
        { hash: '#transito', titulo: 'Trânsito' },
        { hash: '#descargas', titulo: 'Descargas' },
        { hash: '#faturamento', titulo: 'Faturamento' },
        { hash: '#links', titulo: 'Links' },
        { hash: '#enderecos', titulo: 'Endereços' },
        { hash: '#matriz', titulo: 'MATRIZ' }
    ];

    for (const item of abasEsperadas) {
        await page.click(`#torre-nav-list a[href="${item.hash}"]`);
        await page.waitForFunction(
            (t) => document.getElementById('torre-aba-titulo')?.textContent.trim() === t,
            {},
            item.titulo
        );
        const tituloAtual = await page.$eval('#torre-aba-titulo', (el) => el.textContent.trim());
        ok(tituloAtual === item.titulo, `Tela "${item.titulo}" (${item.hash}) abre corretamente`);

        if (item.hash === '#transito') {
            await new Promise((r) => setTimeout(r, 120));
            // Captura 2: TRÂNSITO
            await page.screenshot({
                path: path.join(PASTA_CAPTURAS, 'torre_transito.png'),
                fullPage: false
            });

            const detalhesTransito = await page.evaluate(() => {
                const todasPills = ['critico', 'ok', 'atencao', 'andamento', 'info', 'destaque'].every(
                    (s) => document.querySelectorAll(`.torre-pilula.situacao-${s}`).length > 0
                );
                const tempoEl = document.querySelector('.torre-tempo-situacao.texto-situacao-critico');
                const tempoSemPilula = tempoEl
                    ? window.getComputedStyle(tempoEl).backgroundColor === 'rgba(0, 0, 0, 0)'
                    : false;

                const trCritica = document.querySelector('tr.linha-critica');
                const tdPrimeira = trCritica ? trCritica.querySelector('td:first-child') : null;
                const tdSegunda = trCritica ? trCritica.querySelector('td:nth-child(2)') : null;
                const boxPrimeira = tdPrimeira ? window.getComputedStyle(tdPrimeira).boxShadow : '';
                const bgSegunda = tdSegunda ? window.getComputedStyle(tdSegunda).backgroundColor : '';

                const primeiraLinhaWa = document.querySelectorAll('#torre-tabela-dados tbody tr:first-child .btn-whatsapp');
                const segundaLinhaWa = document.querySelectorAll('#torre-tabela-dados tbody tr:nth-child(2) .btn-whatsapp');

                return {
                    todasPills,
                    tempoSemPilula,
                    faixaEsquerdaVermelha: boxPrimeira.includes('rgb(220, 38, 38)') && boxPrimeira.includes('inset'),
                    linhaNaoPintadaInteira: bgSegunda !== 'rgb(254, 226, 226)' && bgSegunda !== 'rgb(220, 38, 38)',
                    waDoisNumeros: primeiraLinhaWa.length === 2 &&
                        Array.from(primeiraLinhaWa).every((a) => a.href.startsWith('https://wa.me/55')),
                    waUmNumero: segundaLinhaWa.length === 1 &&
                        segundaLinhaWa[0].href.startsWith('https://wa.me/55'),
                    barrasProgresso: document.querySelectorAll('.barra-progresso-celula').length,
                    barrasParada: document.querySelectorAll('.parada-proporcional-celula').length,
                    pontoVerdeMovimento: document.querySelectorAll('.velocidade-ponto.em-movimento').length > 0,
                    pontoVermelhoParado: document.querySelectorAll('.velocidade-ponto.parado').length > 0
                };
            });

            ok(detalhesTransito.todasPills, 'As 6 situações viram as pílulas certas (critico, ok, atencao, andamento, info, destaque)');
            ok(detalhesTransito.tempoSemPilula, 'Tempos e datas com situação pintam apenas o texto, sem pílula');
            ok(
                detalhesTransito.faixaEsquerdaVermelha && detalhesTransito.linhaNaoPintadaInteira,
                'Linha crítica tem apenas a faixa vermelha fina na esquerda (não pinta a linha inteira)'
            );
            ok(
                detalhesTransito.waUmNumero && detalhesTransito.waDoisNumeros,
                'WhatsApp renderiza 1 botão com 1 número e 2 botões com 2 números separados por "/"'
            );
            ok(
                detalhesTransito.barrasProgresso > 0 && detalhesTransito.barrasParada > 0 &&
                detalhesTransito.pontoVerdeMovimento && detalhesTransito.pontoVermelhoParado,
                'TRÂNSITO exibe barra de progressão, barrinha proporcional de parada e ponto verde/vermelho em km/h'
            );

            await page.click('[data-acao="kpi-filtro"][data-kpi-id="pendencia:parada_alta"]');
            const qtdParadaAlta = await page.evaluate(() => document.querySelectorAll('#torre-tabela-dados tbody tr').length);
            await page.click('[data-acao="kpi-filtro"][data-kpi-id="pendencia:parada_alta"]');
            const qtdSemFiltro = await page.evaluate(() => document.querySelectorAll('#torre-tabela-dados tbody tr').length);
            ok(qtdParadaAlta < qtdSemFiltro, 'Contadores do TRÂNSITO filtram ao clicar e tiram o filtro ao clicar de novo');
        }

        if (item.hash === '#links') {
            const segurancaLinks = await page.evaluate(() => {
                const area = document.getElementById('torre-area-principal');
                const texto = (area ? area.textContent : '').toLowerCase();
                const links = Array.from(area ? area.querySelectorAll('a') : []);
                return {
                    qtdLinks: links.length,
                    todosHttp: links.every((a) => /^https?:\/\//i.test(a.getAttribute('href') || '')),
                    todosNoopener: links.every(
                        (a) => a.getAttribute('target') === '_blank' &&
                               (a.getAttribute('rel') || '').includes('noopener') &&
                               (a.getAttribute('rel') || '').includes('noreferrer')
                    ),
                    temSenhaOuArroba: texto.includes('senha') || texto.includes('@')
                };
            });
            ok(
                segurancaLinks.qtdLinks >= 4 && segurancaLinks.todosHttp && segurancaLinks.todosNoopener,
                'Links aceita apenas http/https com target="_blank" rel="noopener noreferrer"'
            );
            ok(
                !segurancaLinks.temSenhaOuArroba,
                'Nada parecido com senha ("senha" ou "@") aparece na tela de Links'
            );
        }

        if (item.hash === '#enderecos') {
            const botaoMapa = await page.evaluate(() => {
                const btn = document.querySelector('.btn-abrir-mapa');
                return btn ? {
                    texto: btn.textContent.trim(),
                    href: btn.getAttribute('href')
                } : null;
            });
            ok(
                botaoMapa && botaoMapa.texto === 'Abrir no mapa' && /^https?:\/\//i.test(botaoMapa.href),
                'Endereços mostra botão "Abrir no mapa" quando houver link http/https'
            );
        }
    }

    // Testa botão Voltar do navegador
    await page.goBack();
    await page.waitForFunction(
        () => document.getElementById('torre-aba-titulo')?.textContent.trim() === 'Endereços'
    );
    ok(true, 'Voltar do navegador funciona pela hash (#matriz -> #enderecos)');
    await page.goForward();

    // ========================================================================
    // 6. Barra lateral recolhe e lembra a escolha
    // ========================================================================
    await page.click('#sidebar-brand');
    const recolheu = await page.evaluate(() => ({
        classe: document.getElementById('torre-sidebar')?.classList.contains('sidebar-recolhida'),
        storage: localStorage.getItem('ajborges_sidebar_recolhida_torre')
    }));
    ok(
        recolheu.classe && recolheu.storage === '1',
        'Barra lateral recolhe clicando no logo e salva em ajborges_sidebar_recolhida_torre'
    );

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#torre-tabela-dados tbody tr');
    const lembrouEscolha = await page.evaluate(() => (
        document.getElementById('torre-sidebar')?.classList.contains('sidebar-recolhida')
    ));
    ok(lembrouEscolha, 'Navegador lembra a escolha da barra lateral recolhida');
    await page.click('#sidebar-brand');

    // ========================================================================
    // 7. Modo TV: tela cheia, tema escuro, alterna MATRIZ <-> TRÂNSITO, Esc sai
    // ========================================================================
    await page.evaluate(() => {
        window.TORRE_MODO_TV_MS = 1200;
    });
    await page.click('#btn-modo-tv');
    await new Promise((r) => setTimeout(r, 150));

    // Captura 3: Modo TV
    await page.screenshot({
        path: path.join(PASTA_CAPTURAS, 'torre_modo_tv.png'),
        fullPage: false
    });

    const estadoModoTvInicial = await page.evaluate(() => ({
        temaEscuro: document.body.classList.contains('modo-tv'),
        sidebarOculta: window.getComputedStyle(document.getElementById('torre-sidebar')).display === 'none',
        buscaOculta: window.getComputedStyle(document.getElementById('torre-busca-wrapper')).display === 'none',
        relogioVisivel: window.getComputedStyle(document.getElementById('tv-info-canto')).display !== 'none',
        abaAntes: document.getElementById('torre-aba-titulo')?.textContent.trim()
    }));

    await page.waitForFunction(
        (abaAnterior) => document.getElementById('torre-aba-titulo')?.textContent.trim() !== abaAnterior,
        { timeout: 3000 },
        estadoModoTvInicial.abaAntes
    );
    const abaDepoisAlternancia = await page.$eval('#torre-aba-titulo', (el) => el.textContent.trim());

    ok(
        estadoModoTvInicial.temaEscuro && estadoModoTvInicial.sidebarOculta &&
        estadoModoTvInicial.buscaOculta && estadoModoTvInicial.relogioVisivel,
        'Modo TV aplica tema escuro, esconde barra lateral/busca/filtros e mostra relógio no canto'
    );
    ok(
        estadoModoTvInicial.abaAntes !== abaDepoisAlternancia &&
        ['MATRIZ', 'Trânsito'].includes(abaDepoisAlternancia),
        `Modo TV alterna MATRIZ <-> TRÂNSITO (${estadoModoTvInicial.abaAntes} -> ${abaDepoisAlternancia})`
    );

    await page.keyboard.press('Escape');
    const saiuModoTv = await page.evaluate(() => !document.body.classList.contains('modo-tv'));
    ok(saiuModoTv, 'Esc sai do Modo TV');

    // ========================================================================
    // 8. "Atualizado às" fica vermelho depois de 15 min e "Sem dados ainda"
    // ========================================================================
    await page.evaluate(() => {
        window.__torreViewsMock.v_status = [{
            ultima_sincronizacao: '2026-10-30T13:50:00-03:00',
            minutos_desde: 25,
            abas: 9,
            linhas: 120
        }];
    });
    await page.click('#btn-atualizar-dados');
    await new Promise((r) => setTimeout(r, 120));
    const statusVermelho = await page.evaluate(() => {
        const el = document.getElementById('torre-status-atualizacao');
        return {
            classeAtrasado: el?.classList.contains('status-atrasado'),
            corTexto: el ? window.getComputedStyle(el).color : ''
        };
    });
    ok(
        statusVermelho.classeAtrasado && statusVermelho.corTexto === 'rgb(185, 28, 28)',
        '"Atualizado às" fica vermelho depois de 15 min'
    );

    await page.evaluate((viewsVazias) => {
        window.__torreViewsMock = viewsVazias;
    }, criarViewsSimuladas({ semCopia: true }));
    await page.click('#btn-atualizar-dados');
    await new Promise((r) => setTimeout(r, 120));
    const estadoSemCopia = await page.evaluate(() => ({
        pill: document.getElementById('torre-status-atualizacao')?.textContent.trim(),
        vazioTexto: document.querySelector('.torre-estado-vazio h3')?.textContent.trim()
    }));
    ok(
        estadoSemCopia.pill === 'Sem dados ainda' &&
        estadoSemCopia.vazioTexto === 'Aguardando a primeira cópia da planilha',
        'Sem cópia exibe "Sem dados ainda" e "Aguardando a primeira cópia da planilha"'
    );

    // Restaura dados para teste de larguras
    await page.evaluate((viewsCheias) => {
        window.__torreViewsMock = viewsCheias;
    }, viewsPadrao);
    await page.click('#btn-atualizar-dados');
    await new Promise((r) => setTimeout(r, 150));

    // ========================================================================
    // 9. 1366, 1920 (TV) e 390 px, sem rolagem lateral na página
    // ========================================================================
    for (const vp of [
        { l: 1366, a: 768, tv: false, nome: '1366px' },
        { l: 1920, a: 1080, tv: true, nome: '1920px (TV)' },
        { l: 390, a: 844, tv: false, nome: '390px' }
    ]) {
        await page.setViewport({ width: vp.l, height: vp.a });
        if (vp.tv) await page.click('#btn-modo-tv');
        await new Promise((r) => setTimeout(r, 150));
        const semOverflowHorizontal = await page.evaluate(() => (
            document.documentElement.scrollWidth <= window.innerWidth
        ));
        ok(semOverflowHorizontal, `${vp.nome}: sem rolagem lateral na página`);
        if (vp.tv) await page.keyboard.press('Escape');
    }

    ok(erros.length === 0, `sem erros de JS ${erros.length ? JSON.stringify(erros) : ''}`);

    await browser.close();
    srv.close();

    console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
    process.exit(falhas ? 1 : 0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});

/**
 * ============================================================================
 * TORRE DE CONTROLE - SHOPPEE • AJBORGES
 * ============================================================================
 * Leitura exclusiva das views do schema `torre` via window.supabaseClient.
 * Nunca lê tabelas planilha_* nem cores cruas: toda cor vem de <col>_situacao.
 */

/* ============================================================================
   CONFIGURAÇÕES NO TOPO DO ARQUIVO
   ============================================================================ */
const MODO_TV_ALTERNAR_MS = 30000;       // Alterna MATRIZ <-> TRÂNSITO a cada 30 s no Modo TV
const AUTO_ATUALIZAR_MS = 60000;         // Atualiza os dados a cada 60 s com aba visível
const RETRY_REDE_MS = 15000;             // Nova tentativa automática em caso de erro de rede
const LIMITE_ATRASO_SINC_MIN = 15;       // Acima de 15 min sem sincronizar -> alerta vermelho

const STORAGE_KEY_SIDEBAR = 'ajborges_sidebar_recolhida_torre';
const STORAGE_KEY_ESTADO_ABAS = 'ajborges_torre_estado_abas_v1';

/* ============================================================================
   CATÁLOGO DE ABAS E COLUNAS (FIEL AO CONTRATO_DADOS.MD / T01b)
   ============================================================================ */
const ABAS_ORDEM = [
    'matriz',
    'validacoes',
    'origem',
    'carregamentos',
    'transito',
    'descargas',
    'faturamento',
    'links',
    'enderecos'
];

const ABAS_META = {
    matriz: {
        titulo: 'MATRIZ',
        view: 'v_matriz',
        temOrdem: true
    },
    validacoes: {
        titulo: 'Validações',
        view: 'v_validacoes',
        temOrdem: true,
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'motorista', rotulo: 'Motorista' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'origem', rotulo: 'Origem' },
            { campo: 'checklist', rotulo: 'Checklist', tipo: 'pilula' },
            { campo: 'sm', rotulo: 'SM', tipo: 'pilula' },
            { campo: 'status', rotulo: 'Status', tipo: 'pilula' },
            { campo: 'espelhamento', rotulo: 'Espelhamento', tipo: 'pilula' },
            { campo: 'etapa', rotulo: 'Etapa', tipo: 'pilula' },
            { campo: 'timer', rotulo: 'Timer', tipo: 'tempo' }
        ]
    },
    origem: {
        titulo: 'Origem',
        view: 'v_origem',
        temOrdem: true,
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'motorista', rotulo: 'Motorista' },
            { campo: 'contato', rotulo: 'Contato', tipo: 'whatsapp' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'carreta', rotulo: 'Carreta' },
            { campo: 'vinculo', rotulo: 'Vínculo' },
            { campo: 'origem', rotulo: 'Origem' },
            { campo: 'posicao_atual', rotulo: 'Posição Atual', urlCampo: 'posicao_atual_url' },
            { campo: 'eta', rotulo: 'ETA', tipo: 'tempo' },
            { campo: 'status', rotulo: 'Status', tipo: 'pilula' },
            { campo: 'checklist', rotulo: 'Checklist', tipo: 'pilula' },
            { campo: 'chega_a_tempo', rotulo: 'Chega a tempo?', tipo: 'pilula' },
            { campo: 'espelhamento', rotulo: 'Espelhamento', tipo: 'pilula' },
            { campo: 'km_faltante', rotulo: 'KM Faltante' },
            { campo: 'km_h', rotulo: 'KM/H', tipo: 'velocidade' },
            { campo: 'macro', rotulo: 'Macro' },
            { campo: 'sm', rotulo: 'SM', tipo: 'pilula' },
            { campo: 'tag', rotulo: 'TAG', tipo: 'pilula' },
            { campo: 'tempo_para_bipagem', rotulo: 'Tempo p/ Bipagem', tipo: 'tempo' },
            { campo: 'ultima_atualizacao', rotulo: 'Última Atualização', tipo: 'tempo' }
        ]
    },
    carregamentos: {
        titulo: 'Carregamentos',
        view: 'v_carregamentos',
        temOrdem: true,
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'motorista', rotulo: 'Motorista' },
            { campo: 'contato', rotulo: 'Contato', tipo: 'whatsapp' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'carreta', rotulo: 'Carreta' },
            { campo: 'vinculo', rotulo: 'Vínculo' },
            { campo: 'origem', rotulo: 'Origem' },
            { campo: 'destino', rotulo: 'Destino' },
            { campo: 'cpt', rotulo: 'CPT', tipo: 'tempo' },
            { campo: 'status', rotulo: 'Status', tipo: 'pilula' },
            { campo: 'checklist', rotulo: 'Checklist', tipo: 'pilula' },
            { campo: 'macro', rotulo: 'Macro' },
            { campo: 'sm', rotulo: 'SM', tipo: 'pilula' },
            { campo: 'status_cpt', rotulo: 'Status CPT', tipo: 'pilula' },
            { campo: 'tag', rotulo: 'TAG', tipo: 'pilula' },
            { campo: 'ultima_atualizacao', rotulo: 'Última Atualização', tipo: 'tempo' }
        ]
    },
    transito: {
        titulo: 'Trânsito',
        view: 'v_transito',
        temOrdem: true,
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'motorista', rotulo: 'Motorista' },
            { campo: 'carga', rotulo: 'Carga', tipo: 'pilula' },
            { campo: 'contato', rotulo: 'Contato', tipo: 'whatsapp' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'carreta', rotulo: 'Carreta' },
            { campo: 'vinculo', rotulo: 'Vínculo' },
            { campo: 'origem', rotulo: 'Origem' },
            { campo: 'destino', rotulo: 'Destino' },
            { campo: 'posicao_atual', rotulo: 'Posição Atual', urlCampo: 'posicao_atual_url' },
            { campo: 'cpt_origem', rotulo: 'CPT Origem', tipo: 'tempo' },
            { campo: 'cpt_realizado', rotulo: 'CPT Realizado', tipo: 'tempo' },
            { campo: 'pct', rotulo: 'PCT', tipo: 'tempo' },
            { campo: 'km_h', rotulo: 'KM/H', tipo: 'velocidade' },
            { campo: 't_parada', rotulo: 'T. Parada', tipo: 'tempo' },
            { campo: 'total_parada', rotulo: 'Total Parada', tipo: 'parada_barra' },
            { campo: 'macro', rotulo: 'Macro' },
            { campo: 'atualizacao', rotulo: 'Atualização', tipo: 'tempo' },
            { campo: 'previsao_chegada', rotulo: 'Previsão Chegada', tipo: 'tempo' },
            { campo: 'eta_destino', rotulo: 'ETA Destino', tipo: 'tempo' },
            { campo: 't_chegada', rotulo: 'T. Chegada', tipo: 'tempo' },
            { campo: 'status', rotulo: 'Status', tipo: 'pilula' },
            { campo: 'progressao_viagem', rotulo: 'Progressão Viagem', tipo: 'progresso_barra' },
            { campo: 'faturamento', rotulo: 'Faturamento' },
            { campo: 'ciot_vpo', rotulo: 'CIOT / VPO', tipo: 'pilula' },
            { campo: 'sm', rotulo: 'SM', tipo: 'pilula' },
            { campo: 'diferenca_do_cpt', rotulo: 'Diferença do CPT', tipo: 'tempo' },
            { campo: 'limite_de_parada', rotulo: 'Limite de Parada', tipo: 'tempo' }
        ]
    },
    descargas: {
        titulo: 'Descargas',
        view: 'v_descargas',
        temOrdem: true,
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'motorista', rotulo: 'Motorista' },
            { campo: 'contato', rotulo: 'Contato', tipo: 'whatsapp' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'carreta', rotulo: 'Carreta' },
            { campo: 'vinculo', rotulo: 'Vínculo' },
            { campo: 'status', rotulo: 'Status', tipo: 'pilula' },
            { campo: 'bipagem', rotulo: 'Bipagem' },
            { campo: 'cd_de_descarga', rotulo: 'CD de Descarga' },
            { campo: 'eta_destino', rotulo: 'ETA Destino', tipo: 'tempo' },
            { campo: 'macro', rotulo: 'Macro' },
            { campo: 'tempo_de_espera', rotulo: 'Tempo de Espera', tipo: 'tempo' }
        ]
    },
    faturamento: {
        titulo: 'Faturamento',
        view: 'v_faturamento',
        temOrdem: true,
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'motorista', rotulo: 'Motorista' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'carreta', rotulo: 'Carreta' },
            { campo: 'vinculo', rotulo: 'Vínculo' },
            { campo: 'origem', rotulo: 'Origem' },
            { campo: 'destino', rotulo: 'Destino' },
            { campo: 'valor', rotulo: 'Valor' },
            { campo: 'ciot_vpo', rotulo: 'CIOT / VPO', tipo: 'pilula' },
            { campo: 'valor_da_carga', rotulo: 'Valor da Carga' }
        ]
    },
    links: {
        titulo: 'Links',
        view: 'v_links',
        temOrdem: true
    },
    enderecos: {
        titulo: 'Endereços',
        view: 'v_enderecos',
        temOrdem: true,
        colunas: [
            { campo: 'nome', rotulo: 'Nome / CD', fixa: true },
            { campo: 'sigla', rotulo: 'Sigla' },
            { campo: 'tipo', rotulo: 'Tipo' },
            { campo: 'id_station', rotulo: 'ID Station' },
            { campo: 'endereco', rotulo: 'Endereço' },
            { campo: 'uf', rotulo: 'UF' },
            { campo: 'cep', rotulo: 'CEP' },
            { campo: 'cnpj', rotulo: 'CNPJ' },
            { campo: '_mapa', rotulo: 'Mapa', tipo: 'mapa_acao' }
        ]
    }
};

/* Definição de colunas em 2 níveis para a MATRIZ */
const MATRIZ_BLOCOS = [
    {
        id: 'base',
        titulo: 'IDENTIFICAÇÃO',
        classeTh: 'bloco-base-th',
        classeSub: 'bloco-base-th',
        colunas: [
            { campo: 'lh', rotulo: 'LH', fixa: true },
            { campo: 'etapa', rotulo: 'Etapa', tipo: 'etapa_bolinhas' },
            { campo: 'cavalo', rotulo: 'Cavalo' },
            { campo: 'rota', rotulo: 'Rota' }
        ]
    },
    {
        id: 'origem',
        titulo: 'ORIGEM',
        classeTh: 'bloco-origem-th',
        classeSub: 'bloco-origem-sub',
        colunas: [
            { campo: 'validador_origem', rotulo: 'Validador', tipo: 'pilula' },
            { campo: 'origem_eta', rotulo: 'ETA Origem', tipo: 'tempo' },
            { campo: 'origem_localizacao', rotulo: 'Localização', urlCampo: 'origem_localizacao_url' },
            { campo: 'origem_km', rotulo: 'KM' },
            { campo: 'origem_timer', rotulo: 'Timer', tipo: 'tempo' }
        ]
    },
    {
        id: 'carregamento',
        titulo: 'CARREGAMENTO',
        classeTh: 'bloco-carregamento-th',
        classeSub: 'bloco-carregamento-sub',
        colunas: [
            { campo: 'carregamento_cpt', rotulo: 'CPT', tipo: 'tempo' },
            { campo: 'carregamento_timer', rotulo: 'Timer', tipo: 'tempo' },
            { campo: 'carregamento_status', rotulo: 'Status', tipo: 'pilula' }
        ]
    },
    {
        id: 'transito',
        titulo: 'TRÂNSITO',
        classeTh: 'bloco-transito-th',
        classeSub: 'bloco-transito-sub',
        colunas: [
            { campo: 'transito_previsao_chegada', rotulo: 'Prev. Chegada', tipo: 'tempo' },
            { campo: 'transito_cpt', rotulo: 'CPT', tipo: 'tempo' },
            { campo: 'transito_eta_destino', rotulo: 'ETA Destino', tipo: 'tempo' },
            { campo: 'transito_status', rotulo: 'Status', tipo: 'pilula' },
            { campo: 'transito_parada', rotulo: 'Parada', tipo: 'tempo' },
            { campo: 'transito_kh', rotulo: 'KM/H', tipo: 'velocidade' },
            { campo: 'transito_tt_restante', rotulo: 'TT Restante', tipo: 'tempo' },
            { campo: 'transito_delta_tt', rotulo: 'Delta TT', tipo: 'tempo' }
        ]
    },
    {
        id: 'descarga',
        titulo: 'DESCARGAS',
        classeTh: 'bloco-descarga-th',
        classeSub: 'bloco-descarga-sub',
        colunas: [
            { campo: 'descarga_chegada', rotulo: 'Chegada', tipo: 'tempo' },
            { campo: 'descarga_timer', rotulo: 'Timer', tipo: 'tempo' },
            { campo: 'descarga_status', rotulo: 'Status', tipo: 'pilula' }
        ]
    }
];

const MATRIZ_COLUNAS_PLANAS = MATRIZ_BLOCOS.reduce((acc, b) => acc.concat(b.colunas), []);

const SITUACOES_VALIDAS = new Set(['critico', 'ok', 'atencao', 'andamento', 'info', 'destaque']);

/* Na MATRIZ, o STATUS da linha é o do bloco da etapa atual (origem não tem coluna de status) */
const MATRIZ_STATUS_POR_ETAPA = {
    carregamento: 'carregamento_status_situacao',
    transito: 'transito_status_situacao',
    descarga: 'descarga_status_situacao'
};

/* Abas cujas linhas só valem com LH preenchido (linhas vazias da planilha ficam de fora) */
const ABAS_COM_LH = new Set(['matriz', 'validacoes', 'origem', 'carregamentos', 'transito', 'descargas', 'faturamento']);

/* ============================================================================
   ESTADO DA APLICAÇÃO
   ============================================================================ */
const estadoTorre = {
    abaAtual: 'matriz',
    dadosPorAba: {},
    matrizContadores: null,
    statusSinc: null,
    carregando: false,
    erroRede: false,
    modoTvAtivo: false,
    timerModoTv: null,
    timerRelogioTv: null,
    timerAutoRefresh: null,
    timerRetryRede: null,
    popoverColunaAberta: null,
    configAbas: {}
};

/* ============================================================================
   UTILITÁRIOS DE SEGURANÇA E FORMATAÇÃO
   ============================================================================ */
function escapeHtml(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizarTexto(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function urlSeguraHttp(url) {
    if (!url || typeof url !== 'string') return null;
    const limpa = url.trim();
    if (/^https?:\/\/[^\s]+$/i.test(limpa)) {
        return limpa;
    }
    return null;
}

function contemCredencialOuSenha(texto) {
    if (!texto || typeof texto !== 'string') return false;
    const norm = normalizarTexto(texto);
    return norm.includes('senha') || texto.includes('@');
}

function limparTextoCredencial(texto) {
    if (!texto || typeof texto !== 'string') return '';
    if (!contemCredencialOuSenha(texto)) return texto.trim();
    // Se o título tiver um trecho como " - senha: ..." ou " (user@dominio)", corta a parte sensível
    const partes = texto.split(/\s+[-|–—:/]\s+|\s*\(/);
    const seguras = partes.filter((p) => !contemCredencialOuSenha(p));
    return seguras.length > 0 ? seguras[0].replace(/\)+$/, '').trim() : 'Link Operacional';
}

function obterEstadoPadraoAba() {
    return {
        busca: '',
        ordenarPor: '',
        ordemDir: 'asc',
        porPagina: 25,
        pagina: 1,
        filtrosColuna: {}, // { campo: [valoresSelecionados] }
        filtroKpi: null,   // identificador do contador ativo
        filtroEtapa: ''    // para MATRIZ
    };
}

function carregarEstadoSalvoAbas() {
    try {
        const bruto = localStorage.getItem(STORAGE_KEY_ESTADO_ABAS);
        if (bruto) {
            const parsed = JSON.parse(bruto);
            if (parsed && typeof parsed === 'object') {
                ABAS_ORDEM.forEach((aba) => {
                    estadoTorre.configAbas[aba] = Object.assign(
                        obterEstadoPadraoAba(),
                        parsed[aba] || {}
                    );
                    if (!estadoTorre.configAbas[aba].filtrosColuna) {
                        estadoTorre.configAbas[aba].filtrosColuna = {};
                    }
                });
                return;
            }
        }
    } catch (_) {
        // Ignora erro de localStorage bloqueado
    }
    ABAS_ORDEM.forEach((aba) => {
        estadoTorre.configAbas[aba] = obterEstadoPadraoAba();
    });
}

function salvarEstadoAbas() {
    try {
        localStorage.setItem(STORAGE_KEY_ESTADO_ABAS, JSON.stringify(estadoTorre.configAbas));
    } catch (_) {
        // Ignora erro de localStorage bloqueado
    }
}

function cfgAba(aba = estadoTorre.abaAtual) {
    if (!estadoTorre.configAbas[aba]) {
        estadoTorre.configAbas[aba] = obterEstadoPadraoAba();
    }
    return estadoTorre.configAbas[aba];
}

/* ============================================================================
   LEITURA EXCLUSIVA DAS VIEWS DO SCHEMA `torre`
   ============================================================================ */
async function consultarViewTorre(nomeView, temOrdem = true) {
    if (!window.supabaseClient || typeof window.supabaseClient.schema !== 'function') {
        throw new Error('Cliente Supabase indisponível.');
    }
    const queryBase = window.supabaseClient
        .schema('torre')
        .from(nomeView)
        .select('*');

    const resultado = (temOrdem && typeof queryBase.order === 'function')
        ? await queryBase.order('ordem')
        : await queryBase;

    if (resultado && resultado.error) {
        throw resultado.error;
    }
    const dados = resultado ? resultado.data : [];
    if (Array.isArray(dados)) return dados;
    if (dados && typeof dados === 'object') return [dados];
    return [];
}

async function carregarDadosAbaAtual({ silencioso = false } = {}) {
    const aba = estadoTorre.abaAtual;
    const meta = ABAS_META[aba] || ABAS_META.matriz;
    const btnAtualizar = document.getElementById('btn-atualizar-dados');

    if (btnAtualizar) btnAtualizar.classList.add('girando');
    estadoTorre.carregando = true;

    try {
        const promessas = [
            consultarViewTorre('v_status', false),
            consultarViewTorre(meta.view, meta.temOrdem)
        ];
        if (aba === 'matriz') {
            promessas.push(consultarViewTorre('v_matriz_contadores', false));
        }

        const respostas = await Promise.all(promessas);
        const statusRows = respostas[0];
        const linhasAba = respostas[1];

        estadoTorre.statusSinc = statusRows && statusRows.length > 0 ? statusRows[0] : null;
        estadoTorre.dadosPorAba[aba] = filtrarLinhasValidas(aba, Array.isArray(linhasAba) ? linhasAba : []);

        if (aba === 'matriz' && respostas[2]) {
            estadoTorre.matrizContadores = respostas[2].length > 0 ? respostas[2][0] : null;
        }

        estadoTorre.erroRede = false;
        ocultarAvisoRede();
        atualizarIndicadorSincronizacao();
        renderizarTelaCompleta({ preservarRolagem: silencioso });
    } catch (erro) {
        console.warn('[Torre] Falha ao buscar dados:', erro);
        estadoTorre.erroRede = true;
        mostrarAvisoRede();
        if (!estadoTorre.dadosPorAba[aba]) {
            renderizarTelaCompleta({ preservarRolagem: false });
        }
        agendarRetryRede();
    } finally {
        estadoTorre.carregando = false;
        if (btnAtualizar) btnAtualizar.classList.remove('girando');
    }
}

function textoPreenchido(valor) {
    return valor !== null && valor !== undefined && String(valor).trim() !== '';
}

function filtrarLinhasValidas(aba, linhas) {
    if (!ABAS_COM_LH.has(aba)) return linhas;
    return linhas.filter((l) => (
        l && textoPreenchido(l.lh) && (aba !== 'matriz' || textoPreenchido(l.etapa))
    ));
}

function mostrarAvisoRede() {
    const el = document.getElementById('torre-aviso-rede');
    if (el) el.hidden = false;
}

function ocultarAvisoRede() {
    const el = document.getElementById('torre-aviso-rede');
    if (el) el.hidden = true;
    if (estadoTorre.timerRetryRede) {
        clearTimeout(estadoTorre.timerRetryRede);
        estadoTorre.timerRetryRede = null;
    }
}

function agendarRetryRede() {
    if (estadoTorre.timerRetryRede) clearTimeout(estadoTorre.timerRetryRede);
    const ms = window.TORRE_RETRY_REDE_MS || RETRY_REDE_MS;
    estadoTorre.timerRetryRede = setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
            carregarDadosAbaAtual({ silencioso: true });
        }
    }, ms);
}

/* ============================================================================
   STATUS DE SINCRONIZAÇÃO ("Atualizado às hh:mm" / "Sem dados ainda")
   ============================================================================ */
function atualizarIndicadorSincronizacao() {
    const pill = document.getElementById('torre-status-atualizacao');
    if (!pill) return;

    pill.classList.remove('status-ok', 'status-atrasado');

    const st = estadoTorre.statusSinc;
    const tsSinc = st && (st.ultima_sincronizacao || st.copiado_em || st.atualizado_em);

    if (!st || !tsSinc) {
        pill.textContent = 'Sem dados ainda';
        return;
    }

    let hhmm = '';
    let minutosDesde = typeof st.minutos_desde === 'number' ? st.minutos_desde : null;

    const matchHoraDireta = String(tsSinc).match(/(\d{2}:\d{2})/);
    const dataObj = new Date(tsSinc);

    if (!Number.isNaN(dataObj.getTime())) {
        const hh = String(dataObj.getHours()).padStart(2, '0');
        const mm = String(dataObj.getMinutes()).padStart(2, '0');
        hhmm = `${hh}:${mm}`;
        if (minutosDesde === null) {
            minutosDesde = (Date.now() - dataObj.getTime()) / 60000;
        }
    } else if (matchHoraDireta) {
        hhmm = matchHoraDireta[1];
    } else {
        hhmm = String(tsSinc);
    }

    pill.textContent = `Atualizado às ${hhmm}`;

    if (minutosDesde !== null && minutosDesde > LIMITE_ATRASO_SINC_MIN) {
        pill.classList.add('status-atrasado');
    } else {
        pill.classList.add('status-ok');
    }
}

/* ============================================================================
   RENDERIZAÇÃO PRINCIPAL (PRESERVANDO ROLAGEM, FILTROS, ORDENAÇÃO E PÁGINA)
   ============================================================================ */
function capturarRolagemAtual() {
    const scrollEl = document.querySelector('.torre-tabela-scroll');
    return {
        windowY: window.scrollY || 0,
        tableTop: scrollEl ? scrollEl.scrollTop : 0,
        tableLeft: scrollEl ? scrollEl.scrollLeft : 0
    };
}

function restaurarRolagem(pos) {
    if (!pos) return;
    const scrollEl = document.querySelector('.torre-tabela-scroll');
    if (scrollEl) {
        scrollEl.scrollTop = pos.tableTop;
        scrollEl.scrollLeft = pos.tableLeft;
    }
    if (pos.windowY) {
        window.scrollTo(0, pos.windowY);
    }
}

function renderizarTelaCompleta({ preservarRolagem = false } = {}) {
    const posRolagem = preservarRolagem ? capturarRolagemAtual() : null;
    const aba = estadoTorre.abaAtual;
    const meta = ABAS_META[aba] || ABAS_META.matriz;
    const config = cfgAba(aba);

    // Atualiza título da aba e input de busca
    const tituloEl = document.getElementById('torre-aba-titulo');
    if (tituloEl) tituloEl.textContent = meta.titulo;

    const inputBusca = document.getElementById('torre-busca');
    const btnLimparBusca = document.getElementById('btn-limpar-busca');
    if (inputBusca && document.activeElement !== inputBusca) {
        inputBusca.value = config.busca || '';
    }
    if (btnLimparBusca) {
        btnLimparBusca.hidden = !(config.busca && config.busca.length > 0);
    }

    // Destaca item na barra lateral
    document.querySelectorAll('#torre-nav-list .nav-link').forEach((link) => {
        const ativa = link.getAttribute('data-aba') === aba;
        link.classList.toggle('active', ativa);
        if (ativa) {
            link.setAttribute('aria-current', 'page');
        } else {
            link.removeAttribute('aria-current');
        }
    });

    const linhasBrutas = estadoTorre.dadosPorAba[aba] || [];
    const painelContadores = document.getElementById('torre-painel-contadores');
    const barraSubfiltros = document.getElementById('torre-barra-subfiltros');
    const areaPrincipal = document.getElementById('torre-area-principal');

    if (!painelContadores || !barraSubfiltros || !areaPrincipal) return;

    // Sem dados ainda na planilha
    const semCopiaPlanilha = (
        linhasBrutas.length === 0 &&
        (!estadoTorre.statusSinc || !estadoTorre.statusSinc.ultima_sincronizacao)
    );

    if (aba === 'links') {
        painelContadores.innerHTML = '';
        barraSubfiltros.hidden = true;
        barraSubfiltros.innerHTML = '';
        if (semCopiaPlanilha) {
            areaPrincipal.innerHTML = renderizarEstadoVazio('Aguardando a primeira cópia da planilha');
        } else {
            areaPrincipal.innerHTML = renderizarTelaLinks(linhasBrutas, config);
        }
        if (preservarRolagem) restaurarRolagem(posRolagem);
        return;
    }

    // 1. Renderiza Contadores do Topo conforme a aba
    painelContadores.innerHTML = renderizarContadoresTopo(aba, linhasBrutas, config);

    // 2. Renderiza Barra de Subfiltros (Etapas rápidas na MATRIZ ou botão limpar filtros)
    renderizarBarraSubfiltros(aba, barraSubfiltros, config);

    // 3. Se não houver nenhuma linha copiada ainda, mostra estado vazio oficial
    if (semCopiaPlanilha) {
        areaPrincipal.innerHTML = renderizarEstadoVazio('Aguardando a primeira cópia da planilha');
        if (preservarRolagem) restaurarRolagem(posRolagem);
        return;
    }

    // 4. Filtra, ordena e pagina as linhas para a tabela densa
    const colunasAba = aba === 'matriz' ? MATRIZ_COLUNAS_PLANAS : (meta.colunas || []);
    const linhasFiltradas = aplicarFiltrosNasLinhas(aba, linhasBrutas, colunasAba, config);
    const linhasOrdenadas = aplicarOrdenacaoNasLinhas(linhasFiltradas, colunasAba, config);

    areaPrincipal.innerHTML = renderizarTabelaDensa(aba, linhasBrutas, linhasOrdenadas, colunasAba, config);

    if (preservarRolagem) {
        restaurarRolagem(posRolagem);
    }
}

function renderizarEstadoVazio(mensagem, subtitulo = 'Assim que a sincronização automática concluir, os dados aparecerão aqui.') {
    return `
        <div class="torre-estado-vazio" role="status">
            <h3>${escapeHtml(mensagem)}</h3>
            <p>${escapeHtml(subtitulo)}</p>
        </div>
    `;
}

/* ============================================================================
   CONTADORES CLICÁVEIS DO TOPO (MATRIZ, TRÂNSITO E DEMAIS ABAS)
   ============================================================================ */
function linhaTemStatusCritico(linha) {
    if (!linha || typeof linha !== 'object') return false;
    if (linha.status_situacao === 'critico') return true;
    const campoStatusEtapa = MATRIZ_STATUS_POR_ETAPA[normalizarTexto(linha.etapa)];
    return Boolean(campoStatusEtapa && linha[campoStatusEtapa] === 'critico');
}

/* Ícones pequenos dos chips (traço simples, cor herdada do tom do chip) */
const ICONES_CHIP = {
    total: '<line x1="9" y1="6" x2="20" y2="6"></line><line x1="9" y1="12" x2="20" y2="12"></line><line x1="9" y1="18" x2="20" y2="18"></line><circle cx="4.5" cy="6" r="1"></circle><circle cx="4.5" cy="12" r="1"></circle><circle cx="4.5" cy="18" r="1"></circle>',
    pino: '<circle cx="12" cy="10" r="3"></circle><path d="M12 21.7C17.3 17 20 13 20 10a8 8 0 1 0-16 0c0 3 2.7 7 8 11.7z"></path>',
    caixa: '<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"></path><polyline points="3.3 7 12 12 20.7 7"></polyline><line x1="12" y1="22" x2="12" y2="12"></line>',
    caminhao: '<rect x="1" y="4" width="14" height="12" rx="1"></rect><polygon points="15 8 19 8 23 12 23 16 15 16 15 8"></polygon><circle cx="5.5" cy="18.5" r="2"></circle><circle cx="18.5" cy="18.5" r="2"></circle>',
    descarga: '<line x1="12" y1="3" x2="12" y2="15"></line><polyline points="7 10 12 15 17 10"></polyline><polyline points="4 17 4 21 20 21 20 17"></polyline>',
    alerta: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    relogio: '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>',
    check: '<circle cx="12" cy="12" r="9"></circle><polyline points="8 12 11 15 16 9"></polyline>',
    documento: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
    pausa: '<circle cx="12" cy="12" r="9"></circle><line x1="10" y1="9" x2="10" y2="15"></line><line x1="14" y1="9" x2="14" y2="15"></line>',
    pessoa: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"></path>',
    etiqueta: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"></path><circle cx="7" cy="7" r="1.5"></circle>'
};

const TOM_POR_SITUACAO = {
    critico: 'critico',
    ok: 'ok',
    atencao: 'atencao',
    andamento: 'andamento',
    info: 'info',
    destaque: 'neutro'
};

function renderizarContadoresTopo(aba, linhas, config) {
    let grupos;
    if (aba === 'matriz') {
        grupos = gruposChipsMatriz();
    } else if (aba === 'transito') {
        grupos = gruposChipsTransito(linhas);
    } else {
        grupos = gruposChipsDinamicos(aba, linhas);
    }
    return renderizarFaixaChips(grupos, config);
}

/* Faixa de chips no estilo eLog: grupos com título pequeno, chips compactos lado a lado */
function renderizarFaixaChips(grupos, config) {
    return `
        <div class="chips-faixa">
            ${grupos.filter((g) => g.chips.length > 0).map((g) => `
                <div class="chips-grupo" role="group" aria-label="${escapeHtml(g.titulo)}">
                    <span class="chips-grupo-titulo">${escapeHtml(g.titulo)}</span>
                    <div class="chips-linha">
                        ${g.chips.map((c) => renderizarChip(c, config)).join('')}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderizarChip(chip, config) {
    // "todas" só limpa os filtros; nunca fica destacado
    const ativo = chip.id !== 'todas' && config.filtroKpi === chip.id;
    const valor = chip.valor === null || chip.valor === undefined || chip.valor === '' ? '—' : chip.valor;
    return `
        <button type="button"
            class="torre-chip chip-tom-${chip.tom || 'neutro'}${ativo ? ' ativo' : ''}"
            data-acao="kpi-filtro"
            data-kpi-id="${escapeHtml(chip.id)}"
            aria-pressed="${ativo ? 'true' : 'false'}"
            title="${escapeHtml(chip.nome)}">
            <span class="chip-icone" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONES_CHIP[chip.icone] || ICONES_CHIP.total}</svg>
            </span>
            <span class="chip-nome">${escapeHtml(chip.nome)}</span>
            <span class="chip-num">${escapeHtml(valor)}</span>
        </button>
    `;
}

/* MATRIZ: os números vêm só de torre.v_matriz_contadores (sem valor na view = "—") */
function gruposChipsMatriz() {
    const mc = estadoTorre.matrizContadores || {};
    return [
        {
            titulo: 'Rotas',
            chips: [
                { id: 'todas', nome: 'Rotas ativas', valor: mc.rotas_ativas, tom: 'marca', icone: 'total' }
            ]
        },
        {
            titulo: 'Etapas',
            chips: [
                { id: 'etapa:origem', nome: 'Pendentes chegada', valor: mc.pendentes_chegada, tom: 'atencao', icone: 'pino' },
                { id: 'etapa:carregamento', nome: 'Carregamentos', valor: mc.carregamentos, tom: 'andamento', icone: 'caixa' },
                { id: 'etapa:transito', nome: 'Trânsito', valor: mc.transito, tom: 'info', icone: 'caminhao' },
                { id: 'etapa:descarga', nome: 'Descarga', valor: mc.descarga, tom: 'ok', icone: 'descarga' }
            ]
        },
        {
            titulo: 'Alertas',
            chips: [
                { id: 'atrasos', nome: 'Atrasos', valor: mc.atrasos, tom: 'critico', icone: 'alerta' }
            ]
        }
    ];
}

function linhaMatrizAtrasada(linha) {
    return linhaTemStatusCritico(linha) ||
        normalizarTexto(linha.carregamento_status).includes('atras') ||
        normalizarTexto(linha.transito_status).includes('atras') ||
        normalizarTexto(linha.descarga_status).includes('atras');
}

function classificarFiltroTransito(linha, chaveChip) {
    const cargaNorm = normalizarTexto(linha.carga);
    const statusNorm = normalizarTexto(linha.status);
    const vinculoNorm = normalizarTexto(linha.vinculo);
    const ciotNorm = normalizarTexto(linha.ciot_vpo);
    const fatNorm = normalizarTexto(linha.faturamento);

    switch (chaveChip) {
        case 'carga:forecast':
            return cargaNorm.includes('forecast');
        case 'carga:reversa':
            return cargaNorm.includes('reversa');
        case 'carga:spot':
            return cargaNorm.includes('spot');
        case 'status:no_prazo':
            return statusNorm.includes('no prazo') || statusNorm.includes('pontual') ||
                   (linha.status_situacao === 'ok' && !statusNorm.includes('atras'));
        case 'status:atrasado':
            return statusNorm.includes('atras') || linha.status_situacao === 'critico';
        case 'pendencia:ciot_vpo':
            return linha.ciot_vpo_situacao === 'critico' ||
                   linha.ciot_vpo_situacao === 'atencao' ||
                   ciotNorm.includes('pendente') ||
                   ciotNorm.includes('sem ') ||
                   ciotNorm === 'nao' ||
                   ciotNorm === '';
        case 'pendencia:faturar':
            return linha.faturamento_situacao === 'critico' ||
                   linha.faturamento_situacao === 'atencao' ||
                   fatNorm.includes('faturar') ||
                   fatNorm.includes('pendente');
        case 'pendencia:parada_alta':
            return linha.total_parada_situacao === 'critico';
        case 'vinculo:frota':
            return vinculoNorm.includes('frota') || vinculoNorm.includes('propri');
        case 'vinculo:terceiro':
            return vinculoNorm.includes('terceiro') || vinculoNorm.includes('tac');
        case 'vinculo:agregado':
            return vinculoNorm.includes('agregado');
        default:
            return true;
    }
}

function gruposChipsTransito(linhas) {
    const contar = (chave) => linhas.filter((l) => classificarFiltroTransito(l, chave)).length;
    const chip = (id, nome, tom, icone) => ({ id, nome, valor: contar(id), tom, icone });

    return [
        {
            titulo: 'Carga',
            chips: [
                chip('carga:forecast', 'Forecast', 'ok', 'etiqueta'),
                chip('carga:reversa', 'Reversa', 'atencao', 'etiqueta'),
                chip('carga:spot', 'Spot', 'andamento', 'etiqueta')
            ]
        },
        {
            titulo: 'Status',
            chips: [
                chip('status:no_prazo', 'No prazo', 'ok', 'relogio'),
                chip('status:atrasado', 'Atrasado', 'critico', 'alerta')
            ]
        },
        {
            titulo: 'Pendências',
            chips: [
                chip('pendencia:ciot_vpo', 'CIOT/VPO pendente', 'critico', 'documento'),
                chip('pendencia:faturar', 'Faturar', 'atencao', 'documento'),
                chip('pendencia:parada_alta', 'Parada alta', 'critico', 'pausa')
            ]
        },
        {
            titulo: 'Vínculo',
            chips: [
                chip('vinculo:frota', 'Frota', 'neutro', 'pessoa'),
                chip('vinculo:terceiro', 'Terceiro', 'neutro', 'pessoa'),
                chip('vinculo:agregado', 'Agregado', 'neutro', 'pessoa')
            ]
        }
    ];
}

function gruposChipsDinamicos(aba, linhas) {
    const grupos = [
        {
            titulo: 'Registros',
            chips: [{ id: 'todas', nome: 'Total na aba', valor: linhas.length, tom: 'marca', icone: 'total' }]
        }
    ];

    if (aba === 'validacoes') {
        const contarCritico = (campo) => linhas.filter((l) => l[`${campo}_situacao`] === 'critico').length;
        grupos.push({
            titulo: 'Pendências',
            chips: [
                { id: 'sit_critico:checklist', nome: 'Checklist crítico', valor: contarCritico('checklist'), tom: 'critico', icone: 'check' },
                { id: 'sit_critico:espelhamento', nome: 'Espelhamento crítico', valor: contarCritico('espelhamento'), tom: 'critico', icone: 'caminhao' },
                { id: 'sit_critico:sm', nome: 'SM crítico', valor: contarCritico('sm'), tom: 'critico', icone: 'documento' }
            ]
        });
        return grupos;
    }

    // Chips com os valores reais existentes na coluna-chave da aba (os mais frequentes primeiro)
    const colunaChavePorAba = {
        origem: 'chega_a_tempo',
        carregamentos: 'status',
        descargas: 'status',
        faturamento: 'ciot_vpo',
        enderecos: 'tipo'
    };
    const campoContagem = colunaChavePorAba[aba] || 'status';
    const colunaMeta = ((ABAS_META[aba] || {}).colunas || []).find((c) => c.campo === campoContagem);
    const mapaValores = new Map();

    linhas.forEach((l) => {
        const val = l[campoContagem] != null ? String(l[campoContagem]).trim() : '';
        if (!val) return;
        const atual = mapaValores.get(val) || { qtd: 0, situacao: l[`${campoContagem}_situacao`] || null };
        atual.qtd += 1;
        if (l[`${campoContagem}_situacao`] === 'critico') atual.situacao = 'critico';
        mapaValores.set(val, atual);
    });

    const chipsValores = Array.from(mapaValores.entries())
        .sort((a, b) => b[1].qtd - a[1].qtd)
        .slice(0, 6)
        .map(([valorTexto, info]) => {
            const tom = TOM_POR_SITUACAO[info.situacao] || 'neutro';
            let icone = 'etiqueta';
            if (tom === 'critico') icone = 'alerta';
            else if (tom === 'ok') icone = 'check';
            return {
                id: `col_val:${campoContagem}:${valorTexto}`,
                nome: valorTexto,
                valor: info.qtd,
                tom,
                icone
            };
        });

    grupos.push({
        titulo: colunaMeta ? colunaMeta.rotulo : campoContagem.replace(/_/g, ' '),
        chips: chipsValores
    });
    return grupos;
}

function renderizarBarraSubfiltros(aba, container, config) {
    const temFiltrosColuna = Object.keys(config.filtrosColuna || {}).some(
        (c) => Array.isArray(config.filtrosColuna[c]) && config.filtrosColuna[c].length > 0
    );
    const temQualquerFiltro = Boolean(
        config.busca || config.filtroKpi || config.filtroEtapa || temFiltrosColuna
    );

    if (aba !== 'matriz' && !temQualquerFiltro) {
        container.hidden = true;
        container.innerHTML = '';
        return;
    }

    container.hidden = false;

    const etapas = [
        { id: '', nome: 'Todas as etapas' },
        { id: 'origem', nome: '1. Origem' },
        { id: 'carregamento', nome: '2. Carregamento' },
        { id: 'transito', nome: '3. Trânsito' },
        { id: 'descarga', nome: '4. Descargas' }
    ];

    container.innerHTML = `
        ${aba === 'matriz' ? `
            <div class="subfiltros-etapas" role="group" aria-label="Filtros rápidos por etapa">
                <span class="subfiltros-label">Etapa:</span>
                ${etapas.map((et) => `
                    <button type="button"
                        class="btn-etapa-rapida ${config.filtroEtapa === et.id ? 'ativo' : ''}"
                        data-acao="etapa-rapida"
                        data-etapa="${escapeHtml(et.id)}">
                        ${escapeHtml(et.nome)}
                    </button>
                `).join('')}
            </div>
        ` : '<div></div>'}
        ${temQualquerFiltro ? `
            <button type="button" class="btn-limpar-todos-filtros" data-acao="limpar-filtros">
                Limpar filtros ativos
            </button>
        ` : ''}
    `;
}

/* ============================================================================
   FILTRAGEM E ORDENAÇÃO DE LINHAS
   ============================================================================ */
function aplicarFiltrosNasLinhas(aba, linhas, colunas, config) {
    const termoBusca = normalizarTexto(config.busca);
    const filtroKpi = config.filtroKpi;
    const filtroEtapa = config.filtroEtapa;
    const filtrosColuna = config.filtrosColuna || {};

    return linhas.filter((linha) => {
        // 1. Filtro rápido de etapa (MATRIZ)
        if (aba === 'matriz' && filtroEtapa) {
            if (normalizarTexto(linha.etapa) !== normalizarTexto(filtroEtapa)) {
                return false;
            }
        }

        // 2. Filtro de card KPI clicável
        if (filtroKpi && filtroKpi !== 'todas') {
            if (aba === 'matriz') {
                if (filtroKpi.startsWith('etapa:')) {
                    const etAlvo = filtroKpi.split(':')[1];
                    if (normalizarTexto(linha.etapa) !== etAlvo) return false;
                } else if (filtroKpi === 'atrasos') {
                    if (!linhaMatrizAtrasada(linha)) return false;
                }
            } else if (aba === 'transito') {
                if (!classificarFiltroTransito(linha, filtroKpi)) return false;
            } else if (filtroKpi.startsWith('sit_critico:')) {
                const colCrit = filtroKpi.split(':')[1];
                if (linha[`${colCrit}_situacao`] !== 'critico') return false;
            } else if (filtroKpi.startsWith('col_val:')) {
                const partes = filtroKpi.split(':');
                const colNome = partes[1];
                const valEsperado = partes.slice(2).join(':');
                const valLinha = linha[colNome] != null ? String(linha[colNome]).trim() : '';
                if (valLinha !== valEsperado) return false;
            }
        }

        // 3. Filtros por coluna (popover de cabeçalho)
        for (const [campo, valoresAceitos] of Object.entries(filtrosColuna)) {
            if (Array.isArray(valoresAceitos) && valoresAceitos.length > 0) {
                const valorCelula = obterTextoBrutoCelula(linha, campo);
                if (!valoresAceitos.includes(valorCelula)) {
                    return false;
                }
            }
        }

        // 4. Busca textual livre
        if (termoBusca) {
            const bateu = colunas.some((col) => {
                const v = linha[col.campo];
                return v != null && normalizarTexto(v).includes(termoBusca);
            });
            if (!bateu) return false;
        }

        return true;
    });
}

function obterTextoBrutoCelula(linha, campo) {
    if (!linha) return '(Vazio)';
    const val = linha[campo];
    if (val === null || val === undefined || String(val).trim() === '') {
        return '(Vazio)';
    }
    return String(val).trim();
}

function extrairNumeroParaOrdenacao(valor) {
    if (valor === null || valor === undefined) return null;
    if (typeof valor === 'number') return valor;
    const str = String(valor).trim();
    if (!str) return null;

    // Hora/duração hh:mm(:ss)
    const matchHora = str.match(/^(-?\d{1,3}):(\d{2})(?::(\d{2}))?$/);
    if (matchHora) {
        const sinal = matchHora[1].startsWith('-') ? -1 : 1;
        const h = Math.abs(parseInt(matchHora[1], 10));
        const m = parseInt(matchHora[2], 10);
        const s = matchHora[3] ? parseInt(matchHora[3], 10) : 0;
        return sinal * (h * 3600 + m * 60 + s);
    }

    // Percentual, moeda ou número com km/h
    const limpo = str
        .replace(/R\$\s*/gi, '')
        .replace(/\s*km\/h/gi, '')
        .replace(/\s*km/gi, '')
        .replace(/%/g, '')
        .replace(/\./g, '')
        .replace(',', '.')
        .trim();

    if (/^-?\d+(\.\d+)?$/.test(limpo)) {
        return parseFloat(limpo);
    }
    return null;
}

function aplicarOrdenacaoNasLinhas(linhas, colunas, config) {
    const campo = config.ordenarPor;
    if (!campo) return linhas.slice();

    const fator = config.ordemDir === 'desc' ? -1 : 1;

    return linhas.slice().sort((a, b) => {
        const va = a[campo];
        const vb = b[campo];

        const vaVazio = va === null || va === undefined || String(va).trim() === '';
        const vbVazio = vb === null || vb === undefined || String(vb).trim() === '';
        if (vaVazio && vbVazio) return (a.ordem || 0) - (b.ordem || 0);
        if (vaVazio) return 1;
        if (vbVazio) return -1;

        const na = extrairNumeroParaOrdenacao(va);
        const nb = extrairNumeroParaOrdenacao(vb);
        if (na !== null && nb !== null) {
            if (na !== nb) return (na - nb) * fator;
            return (a.ordem || 0) - (b.ordem || 0);
        }

        const cmp = String(va).localeCompare(String(vb), 'pt-BR', { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp * fator;
        return (a.ordem || 0) - (b.ordem || 0);
    });
}

/* ============================================================================
   RENDERIZAÇÃO DA TABELA DENSA E COMPONENTES DE CÉLULAS
   ============================================================================ */
function calcularMaxParadaMinutos(linhas) {
    let max = 60;
    linhas.forEach((l) => {
        const min = converterTempoEmMinutos(l.total_parada);
        if (min > max) max = min;
    });
    return max;
}

function converterTempoEmMinutos(valor) {
    if (!valor) return 0;
    const str = String(valor).trim();
    const matchHM = str.match(/(\d+)\s*h\s*(\d+)?/i);
    if (matchHM) {
        return parseInt(matchHM[1], 10) * 60 + (matchHM[2] ? parseInt(matchHM[2], 10) : 0);
    }
    const matchDoisPontos = str.match(/(\d{1,3}):(\d{2})/);
    if (matchDoisPontos) {
        return parseInt(matchDoisPontos[1], 10) * 60 + parseInt(matchDoisPontos[2], 10);
    }
    const num = parseFloat(str.replace(',', '.'));
    return Number.isNaN(num) ? 0 : num;
}

function renderizarTabelaDensa(aba, linhasBrutas, linhasOrdenadas, colunas, config) {
    const totalFiltrado = linhasOrdenadas.length;
    const porPagina = Number(config.porPagina) || 0; // 0 = Todos
    let paginaAtual = Number(config.pagina) || 1;
    let totalPaginas = 1;
    let linhasPagina = linhasOrdenadas;

    if (porPagina > 0 && !estadoTorre.modoTvAtivo) {
        totalPaginas = Math.max(1, Math.ceil(totalFiltrado / porPagina));
        if (paginaAtual > totalPaginas) {
            paginaAtual = totalPaginas;
            config.pagina = paginaAtual;
        }
        const inicio = (paginaAtual - 1) * porPagina;
        linhasPagina = linhasOrdenadas.slice(inicio, inicio + porPagina);
    }

    const maxParadaMin = aba === 'transito' ? calcularMaxParadaMinutos(linhasBrutas) : 60;

    const cabecalhoHtml = aba === 'matriz'
        ? renderizarTheadMatriz(config)
        : renderizarTheadPadrao(colunas, config);

    const corpoHtml = linhasPagina.length > 0
        ? linhasPagina.map((linha) => renderizarLinhaTabela(aba, linha, colunas, maxParadaMin)).join('')
        : `
            <tr>
                <td colspan="${colunas.length}" style="text-align:center; padding: 28px; color: var(--text-muted);">
                    Nenhum registro encontrado para os filtros aplicados.
                </td>
            </tr>
        `;

    const inicioExibido = totalFiltrado === 0 ? 0 : ((porPagina > 0 ? (paginaAtual - 1) * porPagina : 0) + 1);
    const fimExibido = totalFiltrado === 0 ? 0 : (porPagina > 0 ? Math.min(totalFiltrado, paginaAtual * porPagina) : totalFiltrado);

    return `
        <div class="torre-card-tabela">
            <div class="torre-tabela-scroll" id="torre-tabela-scroll">
                <table class="torre-tabela ${aba === 'matriz' ? 'tabela-matriz' : ''}" id="torre-tabela-dados">
                    <thead>
                        ${cabecalhoHtml}
                    </thead>
                    <tbody>
                        ${corpoHtml}
                    </tbody>
                </table>
            </div>
            <div class="torre-paginacao" id="torre-paginacao">
                <div class="paginacao-esquerda">
                    <label for="select-por-pagina">Registros por página:</label>
                    <select id="select-por-pagina" class="select-por-pagina" aria-label="Registros por página">
                        <option value="25" ${porPagina === 25 ? 'selected' : ''}>25</option>
                        <option value="50" ${porPagina === 50 ? 'selected' : ''}>50</option>
                        <option value="100" ${porPagina === 100 ? 'selected' : ''}>100</option>
                        <option value="0" ${porPagina === 0 ? 'selected' : ''}>Todos</option>
                    </select>
                    <span class="paginacao-contagem">
                        Exibindo <strong>${inicioExibido}–${fimExibido}</strong> de <strong>${totalFiltrado}</strong>
                    </span>
                </div>
                <nav class="paginacao-direita" aria-label="Páginas da tabela">
                    <button type="button" class="btn-pagina" data-acao="pagina-anterior"
                        aria-label="Página anterior"
                        ${paginaAtual <= 1 || porPagina === 0 ? 'disabled' : ''}>&lsaquo;</button>
                    ${gerarNumerosPagina(porPagina === 0 ? 1 : paginaAtual, porPagina === 0 ? 1 : totalPaginas).map((n) => (
                        n === '…'
                            ? '<span class="paginacao-reticencias" aria-hidden="true">…</span>'
                            : `<button type="button" class="btn-pagina btn-pagina-num${n === (porPagina === 0 ? 1 : paginaAtual) ? ' atual' : ''}"
                                data-acao="pagina-ir" data-pagina="${n}"
                                ${n === (porPagina === 0 ? 1 : paginaAtual) ? 'aria-current="page"' : ''}>${n}</button>`
                    )).join('')}
                    <button type="button" class="btn-pagina" data-acao="pagina-proxima"
                        aria-label="Próxima página"
                        ${paginaAtual >= totalPaginas || porPagina === 0 ? 'disabled' : ''}>&rsaquo;</button>
                </nav>
            </div>
        </div>
    `;
}

/* Números de página: 1 … 4 5 6 … 20 (sempre a primeira, a última e as vizinhas da atual) */
function gerarNumerosPagina(atual, total) {
    const numeros = [];
    for (let n = 1; n <= total; n++) {
        if (n === 1 || n === total || Math.abs(n - atual) <= 1 || (atual <= 3 && n <= 4) || (atual >= total - 2 && n >= total - 3)) {
            numeros.push(n);
        } else if (numeros[numeros.length - 1] !== '…') {
            numeros.push('…');
        }
    }
    return numeros;
}

function renderizarCelulaTh(col, config, classeExtra = '') {
    const ordenado = config.ordenarPor === col.campo;
    const seta = ordenado ? (config.ordemDir === 'desc' ? '▼' : '▲') : '↕';
    const temFiltroAtivo = Array.isArray(config.filtrosColuna?.[col.campo]) &&
        config.filtrosColuna[col.campo].length > 0;
    const classes = [
        col.fixa ? 'col-fixa-lh' : '',
        classeExtra
    ].filter(Boolean).join(' ');

    if (col.tipo === 'mapa_acao') {
        return `<th class="${classes}" scope="col">${escapeHtml(col.rotulo)}</th>`;
    }

    return `
        <th class="${classes}" scope="col" data-coluna="${escapeHtml(col.campo)}">
            <div class="th-conteudo">
                <button type="button"
                    class="th-btn-ordenar ${ordenado ? 'ordenado' : ''}"
                    data-acao="ordenar-coluna"
                    data-coluna="${escapeHtml(col.campo)}"
                    title="Ordenar por ${escapeHtml(col.rotulo)}">
                    <span>${escapeHtml(col.rotulo)}</span>
                    <span class="th-icone-ordem" aria-hidden="true">${seta}</span>
                </button>
                <button type="button"
                    class="th-btn-filtro ${temFiltroAtivo ? 'filtro-ativo' : ''}"
                    data-acao="abrir-filtro-coluna"
                    data-coluna="${escapeHtml(col.campo)}"
                    data-rotulo="${escapeHtml(col.rotulo)}"
                    aria-label="Filtrar coluna ${escapeHtml(col.rotulo)}"
                    title="Filtrar coluna ${escapeHtml(col.rotulo)}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"
                        stroke-linejoin="round" aria-hidden="true">
                        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                    </svg>
                </button>
            </div>
        </th>
    `;
}

function renderizarTheadPadrao(colunas, config) {
    return `
        <tr>
            ${colunas.map((col) => renderizarCelulaTh(col, config)).join('')}
        </tr>
    `;
}

function renderizarTheadMatriz(config) {
    const linhaGrupos = MATRIZ_BLOCOS.map((b) => `
        <th colspan="${b.colunas.length}" class="${b.classeTh}" scope="colgroup">
            ${escapeHtml(b.titulo)}
        </th>
    `).join('');

    const linhaColunas = MATRIZ_BLOCOS.map((b) => (
        b.colunas.map((col) => renderizarCelulaTh(col, config, b.classeSub)).join('')
    )).join('');

    return `
        <tr class="matriz-header-grupos">${linhaGrupos}</tr>
        <tr class="matriz-header-colunas">${linhaColunas}</tr>
    `;
}

function renderizarLinhaTabela(aba, linha, colunas, maxParadaMin) {
    const ehCritica = linhaTemStatusCritico(linha);
    return `
        <tr class="${ehCritica ? 'linha-critica' : ''}">
            ${colunas.map((col) => {
                const classeFixa = col.fixa ? ' class="col-fixa-lh"' : '';
                return `<td${classeFixa}>${renderizarConteudoCelula(aba, linha, col, maxParadaMin)}</td>`;
            }).join('')}
        </tr>
    `;
}

function renderizarConteudoCelula(aba, linha, col, maxParadaMin) {
    const campo = col.campo;

    // Ação de abrir mapa na tela de Endereços
    if (col.tipo === 'mapa_acao') {
        return renderizarCelulaMapaEndereco(linha);
    }

    const valorBruto = linha[campo];
    const situacaoRaw = linha[`${campo}_situacao`];
    const situacao = SITUACOES_VALIDAS.has(situacaoRaw) ? situacaoRaw : null;

    // 1. Indicador visual de etapa na MATRIZ (4 bolinhas + nome da etapa)
    if (col.tipo === 'etapa_bolinhas') {
        return renderizarIndicadorEtapaMatriz(valorBruto, situacao);
    }

    // 2. Contato -> Botão(ões) do WhatsApp (https://wa.me/55 + só os números)
    if (col.tipo === 'whatsapp') {
        return renderizarBotoesWhatsapp(valorBruto);
    }

    // 3. Barra de Progressão da Viagem (TRÂNSITO)
    if (col.tipo === 'progresso_barra') {
        return renderizarBarraProgressaoViagem(valorBruto, situacao);
    }

    // 4. Barrinha proporcional de Total Parada (TRÂNSITO)
    if (col.tipo === 'parada_barra') {
        return renderizarBarraTotalParada(valorBruto, situacao, maxParadaMin);
    }

    // 5. Velocidade (km/h com ponto verde em movimento ou vermelho parado = 0)
    if (col.tipo === 'velocidade') {
        return renderizarVelocidadeKmH(valorBruto, situacao);
    }

    // Valor vazio
    if (valorBruto === null || valorBruto === undefined || String(valorBruto).trim() === '') {
        return '<span class="texto-vazio">—</span>';
    }

    const textoSeguro = escapeHtml(valorBruto);

    // 6. Link seguro http/https quando houver coluna <col>_url
    const urlSegura = col.urlCampo ? urlSeguraHttp(linha[col.urlCampo]) : null;

    // 7. Tempos e timers com situação -> bloco de cor sólida atrás do número (sem pílula)
    if (col.tipo === 'tempo') {
        if (situacao) {
            return `<span class="torre-tempo-bloco tempo-${situacao}">${textoSeguro}</span>`;
        }
        return `<span class="torre-tempo-normal">${textoSeguro}</span>`;
    }

    // 8. Pílulas SÓ nas colunas de status/flag; as demais ficam em texto normal mesmo com situação
    if (col.tipo === 'pilula' && situacao) {
        const pilula = `<span class="torre-pilula situacao-${situacao}">${textoSeguro}</span>`;
        if (urlSegura) {
            return `<a href="${escapeHtml(urlSegura)}" class="torre-link-celula" target="_blank" rel="noopener noreferrer">${pilula}</a>`;
        }
        return pilula;
    }

    if (urlSegura) {
        return `<a href="${escapeHtml(urlSegura)}" class="torre-link-celula" target="_blank" rel="noopener noreferrer">${textoSeguro}</a>`;
    }

    return textoSeguro;
}

function renderizarIndicadorEtapaMatriz(etapaBruta) {
    const ordemEtapas = ['origem', 'carregamento', 'transito', 'descarga'];
    const etapaNorm = normalizarTexto(etapaBruta);
    let idxAtual = ordemEtapas.indexOf(etapaNorm);
    if (idxAtual === -1) {
        if (etapaNorm.includes('orig')) idxAtual = 0;
        else if (etapaNorm.includes('carreg')) idxAtual = 1;
        else if (etapaNorm.includes('transit')) idxAtual = 2;
        else if (etapaNorm.includes('descarg')) idxAtual = 3;
    }

    const bolinhas = ordemEtapas.map((et, idx) => {
        let classe = '';
        if (idx === idxAtual) classe = 'atual';
        else if (idxAtual > -1 && idx < idxAtual) classe = 'concluida';
        return `<span class="etapa-bolinha ${classe}" title="${escapeHtml(et.toUpperCase())}"></span>`;
    }).join('');

    const rotulo = etapaBruta ? escapeHtml(etapaBruta) : '—';
    return `
        <div class="etapa-indicador" aria-label="Etapa ${rotulo}">
            <span class="etapa-bolinhas" aria-hidden="true">${bolinhas}</span>
            <span class="etapa-texto">${rotulo}</span>
        </div>
    `;
}

function renderizarBotoesWhatsapp(contatoBruto) {
    if (!contatoBruto || String(contatoBruto).trim() === '') {
        return '<span class="texto-vazio">—</span>';
    }
    const partes = String(contatoBruto).split('/');
    const botoes = [];

    partes.forEach((parte) => {
        let digitos = parte.replace(/\D+/g, '');
        if (!digitos) return;
        // Se já vier com DDI 55 e 12/13 dígitos, remove o 55 inicial para concatenar com https://wa.me/55
        if (digitos.length >= 12 && digitos.startsWith('55')) {
            digitos = digitos.slice(2);
        }
        if (digitos.length < 8) return;

        const urlWa = `https://wa.me/55${digitos}`;
        const labelCurto = digitos.length >= 10
            ? `(${digitos.slice(0, 2)}) ${digitos.slice(2)}`
            : digitos;

        botoes.push(`
            <a href="${escapeHtml(urlWa)}"
               class="btn-whatsapp"
               target="_blank"
               rel="noopener noreferrer"
               title="Conversar no WhatsApp: ${escapeHtml(labelCurto)}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
                     aria-hidden="true">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                </svg>
                <span>${escapeHtml(labelCurto)}</span>
            </a>
        `);
    });

    if (botoes.length === 0) {
        return escapeHtml(contatoBruto);
    }
    return `<div class="whatsapp-grupo">${botoes.join('')}</div>`;
}

function renderizarBarraProgressaoViagem(valorBruto, situacao) {
    if (valorBruto === null || valorBruto === undefined || String(valorBruto).trim() === '') {
        return '<span class="texto-vazio">—</span>';
    }
    // A planilha manda o texto com quadradinhos (ex.: "■■■□□ 60%"): fica só o número do %
    const texto = String(valorBruto).trim();
    const matchPct = texto.match(/(\d+(?:[.,]\d+)?)\s*%/) || texto.match(/(\d+(?:[.,]\d+)?)/);
    if (!matchPct) {
        return '<span class="texto-vazio">—</span>';
    }
    let pct = parseFloat(matchPct[1].replace(',', '.'));
    if (Number.isNaN(pct)) pct = 0;
    const pctClamped = Math.max(0, Math.min(100, Math.round(pct)));

    return `
        <div class="barra-progresso-celula" title="${pctClamped}%">
            <div class="barra-progresso-trilha" role="progressbar"
                 aria-valuenow="${pctClamped}" aria-valuemin="0" aria-valuemax="100">
                <div class="barra-progresso-preenchimento ${situacao === 'critico' ? 'critico' : ''}"
                     style="width: ${pctClamped}%;"></div>
            </div>
            <span class="barra-progresso-label">${pctClamped}%</span>
        </div>
    `;
}

function renderizarBarraTotalParada(valorBruto, situacao, maxParadaMin) {
    if (valorBruto === null || valorBruto === undefined || String(valorBruto).trim() === '') {
        return '<span class="texto-vazio">—</span>';
    }
    const minutos = converterTempoEmMinutos(valorBruto);
    const refMax = Math.max(30, maxParadaMin || 60);
    const pct = Math.max(6, Math.min(100, Math.round((minutos / refMax) * 100)));
    const classeCor = situacao === 'critico' ? 'critico' : (situacao === 'ok' ? 'ok' : '');
    const classeTexto = situacao ? `torre-tempo-bloco tempo-${situacao}` : 'torre-tempo-normal';

    return `
        <div class="parada-proporcional-celula">
            <span class="${classeTexto}">${escapeHtml(valorBruto)}</span>
            <div class="parada-proporcional-trilha" aria-hidden="true">
                <div class="parada-proporcional-fill ${classeCor}" style="width: ${pct}%;"></div>
            </div>
        </div>
    `;
}

function renderizarVelocidadeKmH(valorBruto, situacao) {
    if (valorBruto === null || valorBruto === undefined || String(valorBruto).trim() === '') {
        return '<span class="texto-vazio">—</span>';
    }
    const num = extrairNumeroParaOrdenacao(valorBruto);
    const vel = num !== null ? num : 0;
    const emMovimento = vel > 0;
    const texto = String(valorBruto).toLowerCase().includes('km')
        ? String(valorBruto).trim()
        : `${String(valorBruto).trim()} km/h`;

    return `
        <span class="velocidade-celula ${situacao ? `texto-situacao-${situacao}` : ''}">
            <span class="velocidade-ponto ${emMovimento ? 'em-movimento' : 'parado'}"
                  title="${emMovimento ? 'Em movimento' : 'Parado (0 km/h)'}"></span>
            <span>${escapeHtml(texto)}</span>
        </span>
    `;
}

function renderizarCelulaMapaEndereco(linha) {
    // Verifica se há URL http/https explícita ou embutida no endereço
    const candidatos = [
        linha.mapa_url,
        linha.mapa,
        linha.endereco_url,
        linha.link_url
    ];

    for (const cand of candidatos) {
        const url = urlSeguraHttp(cand);
        if (url) {
            return `
                <a href="${escapeHtml(url)}" class="btn-abrir-mapa" target="_blank" rel="noopener noreferrer">
                    Abrir no mapa
                </a>
            `;
        }
    }

    if (typeof linha.endereco === 'string') {
        const matchUrl = linha.endereco.match(/https?:\/\/[^\s)]+/i);
        if (matchUrl) {
            const url = urlSeguraHttp(matchUrl[0]);
            if (url) {
                return `
                    <a href="${escapeHtml(url)}" class="btn-abrir-mapa" target="_blank" rel="noopener noreferrer">
                        Abrir no mapa
                    </a>
                `;
            }
        }
    }

    return '<span class="texto-vazio">—</span>';
}

/* ============================================================================
   TELA DE LINKS (CARDS AGRUPADOS, SEM SENHAS/EMAILS, SÓ HTTP/HTTPS)
   ============================================================================ */
function classificarGrupoLink(titulo) {
    const norm = normalizarTexto(titulo);
    if (norm.includes('enderec') || norm.includes('mapa') || norm.includes('cd ') || norm.includes('station')) {
        return 'Endereços';
    }
    if (norm.includes('form') || norm.includes('solicit') || norm.includes('check')) {
        return 'Formulários';
    }
    if (norm.includes('doc') || norm.includes('manual') || norm.includes('procedimento') || norm.includes('planilha')) {
        return 'Documentos';
    }
    if (norm.includes('liberac') || norm.includes('cadastro') || norm.includes('gr ') || norm.includes('escolta')) {
        return 'Liberações';
    }
    return 'Sistemas e Operação';
}

function renderizarTelaLinks(linhas, config) {
    const termoBusca = normalizarTexto(config.busca);
    const gruposOrdem = ['Endereços', 'Formulários', 'Documentos', 'Liberações', 'Sistemas e Operação'];
    const mapaGrupos = new Map();
    gruposOrdem.forEach((g) => mapaGrupos.set(g, []));

    linhas.forEach((item) => {
        const tituloLimpo = limparTextoCredencial(item.titulo || 'Link Operacional');
        if (termoBusca && !normalizarTexto(tituloLimpo).includes(termoBusca)) {
            return;
        }

        // Coleta apenas links http/https válidos
        const botoesLinks = [];
        const url1 = urlSeguraHttp(item.link_url) || urlSeguraHttp(item.link);
        const url2 = urlSeguraHttp(item.link_2_url) || urlSeguraHttp(item.link_2);

        if (url1) {
            botoesLinks.push({ url: url1, rotulo: 'Abrir' });
        }
        if (url2 && url2 !== url1) {
            botoesLinks.push({ url: url2, rotulo: botoesLinks.length > 0 ? 'Abrir (Link 2)' : 'Abrir' });
        }

        // Ignora linhas sem nenhum link http/https válido
        if (botoesLinks.length === 0) return;

        // Subtítulo opcional: NUNCA mostra se tiver "senha" ou "@"
        let descricaoSegura = '';
        if (item.link && !urlSeguraHttp(item.link) && !contemCredencialOuSenha(item.link)) {
            descricaoSegura = String(item.link).trim();
        }

        const nomeGrupo = item.grupo && !contemCredencialOuSenha(item.grupo)
            ? String(item.grupo).trim()
            : classificarGrupoLink(tituloLimpo);

        if (!mapaGrupos.has(nomeGrupo)) {
            mapaGrupos.set(nomeGrupo, []);
        }
        mapaGrupos.get(nomeGrupo).push({
            titulo: tituloLimpo,
            descricao: descricaoSegura,
            botoes: botoesLinks
        });
    });

    const secoesHtml = [];
    for (const [nomeGrupo, itens] of mapaGrupos.entries()) {
        if (!itens || itens.length === 0) continue;
        secoesHtml.push(`
            <section class="links-grupo-secao" aria-label="${escapeHtml(nomeGrupo)}">
                <div class="links-grupo-header">
                    <h3 class="links-grupo-titulo">${escapeHtml(nomeGrupo)}</h3>
                    <span class="links-grupo-badge">${itens.length}</span>
                </div>
                <div class="links-cards-grid">
                    ${itens.map((card) => `
                        <article class="link-item-card">
                            <div>
                                <h4 class="link-card-titulo">${escapeHtml(card.titulo)}</h4>
                                ${card.descricao ? `<p class="link-card-sub">${escapeHtml(card.descricao)}</p>` : ''}
                            </div>
                            <div class="link-card-acoes">
                                ${card.botoes.map((b) => `
                                    <a href="${escapeHtml(b.url)}"
                                       class="btn-abrir-link"
                                       target="_blank"
                                       rel="noopener noreferrer">
                                        <span>${escapeHtml(b.rotulo)}</span>
                                    </a>
                                `).join('')}
                            </div>
                        </article>
                    `).join('')}
                </div>
            </section>
        `);
    }

    if (secoesHtml.length === 0) {
        return renderizarEstadoVazio('Nenhum link válido encontrado para a busca atual.');
    }

    return `<div class="links-grupos-container">${secoesHtml.join('')}</div>`;
}

/* ============================================================================
   POPOVER DE FILTRO POR COLUNA
   ============================================================================ */
function abrirPopoverFiltroColuna(botaoEl, campo, rotulo) {
    const popover = document.getElementById('torre-filtro-popover');
    if (!popover) return;

    if (estadoTorre.popoverColunaAberta === campo && !popover.hidden) {
        fecharPopoverFiltroColuna();
        return;
    }

    const aba = estadoTorre.abaAtual;
    const linhas = estadoTorre.dadosPorAba[aba] || [];
    const config = cfgAba(aba);
    const selecionadosAtuais = new Set(config.filtrosColuna?.[campo] || []);

    const valoresUnicos = Array.from(
        new Set(linhas.map((l) => obterTextoBrutoCelula(l, campo)))
    ).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }));

    popover.innerHTML = `
        <div class="popover-cabecalho">
            <span>Filtrar: ${escapeHtml(rotulo)}</span>
            <button type="button" class="btn-limpar-busca" data-acao="fechar-popover" aria-label="Fechar">&times;</button>
        </div>
        <input type="search" class="popover-busca" id="popover-busca-input"
               placeholder="Filtrar opções..." aria-label="Filtrar opções da coluna">
        <div class="popover-lista-valores" id="popover-lista-valores">
            ${valoresUnicos.map((val) => {
                const marcado = selecionadosAtuais.size === 0 ? false : selecionadosAtuais.has(val);
                return `
                    <label class="popover-item-label" data-valor-item="${escapeHtml(normalizarTexto(val))}">
                        <input type="checkbox" class="popover-checkbox-valor" value="${escapeHtml(val)}"
                            ${marcado ? 'checked' : ''}>
                        <span>${escapeHtml(val)}</span>
                    </label>
                `;
            }).join('')}
        </div>
        <div class="popover-rodape">
            <button type="button" class="btn-popover" data-acao="limpar-filtro-coluna" data-coluna="${escapeHtml(campo)}">
                Todos
            </button>
            <button type="button" class="btn-popover btn-popover-primario" data-acao="aplicar-filtro-coluna" data-coluna="${escapeHtml(campo)}">
                Aplicar
            </button>
        </div>
    `;

    const rect = botaoEl.getBoundingClientRect();
    const larguraPopover = 240;
    const left = Math.max(8, Math.min(window.innerWidth - larguraPopover - 8, rect.left));
    const top = Math.min(window.innerHeight - 310, rect.bottom + 6);

    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(8, top)}px`;
    popover.hidden = false;
    estadoTorre.popoverColunaAberta = campo;

    const inputBuscaOpcoes = document.getElementById('popover-busca-input');
    if (inputBuscaOpcoes) {
        inputBuscaOpcoes.addEventListener('input', () => {
            const q = normalizarTexto(inputBuscaOpcoes.value);
            popover.querySelectorAll('.popover-item-label').forEach((lbl) => {
                const v = lbl.getAttribute('data-valor-item') || '';
                lbl.style.display = !q || v.includes(q) ? 'flex' : 'none';
            });
        });
    }
}

function fecharPopoverFiltroColuna() {
    const popover = document.getElementById('torre-filtro-popover');
    if (popover) {
        popover.hidden = true;
        popover.innerHTML = '';
    }
    estadoTorre.popoverColunaAberta = null;
}

/* ============================================================================
   BARRA LATERAL (RECOLHIMENTO COM LOCALSTORAGE E GAVETA MOBILE)
   ============================================================================ */
function inicializarSidebar() {
    const sidebar = document.getElementById('torre-sidebar');
    const brandBtn = document.getElementById('sidebar-brand');
    const btnMobile = document.getElementById('btn-mobile-menu');
    const btnFechar = document.getElementById('btn-fechar-sidebar');
    const backdrop = document.getElementById('torre-sidebar-backdrop');

    if (!sidebar || !brandBtn) return;

    const aplicarRecolhimento = (recolhida) => {
        sidebar.classList.toggle('sidebar-recolhida', recolhida);
        brandBtn.setAttribute('aria-expanded', recolhida ? 'false' : 'true');
        brandBtn.setAttribute('aria-label', recolhida ? 'Expandir menu' : 'Recolher menu');
        brandBtn.setAttribute('title', recolhida ? 'Expandir menu' : 'Recolher menu');
    };

    try {
        if (localStorage.getItem(STORAGE_KEY_SIDEBAR) === '1') {
            aplicarRecolhimento(true);
        }
    } catch (_) {
        // Ignora erro de localStorage
    }

    const alternarSidebarDesktop = () => {
        const recolhida = !sidebar.classList.contains('sidebar-recolhida');
        aplicarRecolhimento(recolhida);
        try {
            localStorage.setItem(STORAGE_KEY_SIDEBAR, recolhida ? '1' : '0');
        } catch (_) {
            // Ignora erro de localStorage
        }
    };

    brandBtn.addEventListener('click', alternarSidebarDesktop);
    brandBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            alternarSidebarDesktop();
        }
    });

    const abrirGavetaMobile = () => {
        sidebar.classList.add('sidebar-aberta');
        if (backdrop) backdrop.classList.add('visivel');
    };

    const fecharGavetaMobile = () => {
        sidebar.classList.remove('sidebar-aberta');
        if (backdrop) backdrop.classList.remove('visivel');
    };

    if (btnMobile) btnMobile.addEventListener('click', abrirGavetaMobile);
    if (btnFechar) btnFechar.addEventListener('click', fecharGavetaMobile);
    if (backdrop) backdrop.addEventListener('click', fecharGavetaMobile);

    document.querySelectorAll('#torre-nav-list .nav-link').forEach((link) => {
        link.addEventListener('click', () => {
            fecharGavetaMobile();
        });
    });
}

/* ============================================================================
   MODO TV (TELA CHEIA, TEMA ESCURO, ALTERNA MATRIZ <-> TRÂNSITO A CADA 30S)
   ============================================================================ */
function atualizarRelogioModoTv() {
    const el = document.getElementById('tv-relogio');
    if (!el) return;
    const agora = new Date();
    const hh = String(agora.getHours()).padStart(2, '0');
    const mm = String(agora.getMinutes()).padStart(2, '0');
    const ss = String(agora.getSeconds()).padStart(2, '0');
    el.textContent = `${hh}:${mm}:${ss}`;
}

function entrarModoTv() {
    if (estadoTorre.modoTvAtivo) return;
    estadoTorre.modoTvAtivo = true;
    document.body.classList.add('modo-tv');

    const btnTexto = document.getElementById('btn-modo-tv-texto');
    if (btnTexto) btnTexto.textContent = 'Sair Modo TV';

    try {
        if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    } catch (_) {
        // Ignora bloqueio de Fullscreen API sem gesto
    }

    // Garante que inicia em MATRIZ ou TRÂNSITO
    if (estadoTorre.abaAtual !== 'matriz' && estadoTorre.abaAtual !== 'transito') {
        navegarParaAba('matriz');
    } else {
        renderizarTelaCompleta({ preservarRolagem: false });
    }

    atualizarRelogioModoTv();
    if (estadoTorre.timerRelogioTv) clearInterval(estadoTorre.timerRelogioTv);
    estadoTorre.timerRelogioTv = setInterval(atualizarRelogioModoTv, 1000);

    if (estadoTorre.timerModoTv) clearInterval(estadoTorre.timerModoTv);
    const intervaloTv = window.TORRE_MODO_TV_MS || MODO_TV_ALTERNAR_MS;
    estadoTorre.timerModoTv = setInterval(() => {
        if (!estadoTorre.modoTvAtivo) return;
        const proximaAba = estadoTorre.abaAtual === 'matriz' ? 'transito' : 'matriz';
        navegarParaAba(proximaAba);
    }, intervaloTv);
}

function sairModoTv() {
    if (!estadoTorre.modoTvAtivo) return;
    estadoTorre.modoTvAtivo = false;
    document.body.classList.remove('modo-tv');

    const btnTexto = document.getElementById('btn-modo-tv-texto');
    if (btnTexto) btnTexto.textContent = 'Modo TV';

    if (estadoTorre.timerModoTv) {
        clearInterval(estadoTorre.timerModoTv);
        estadoTorre.timerModoTv = null;
    }
    if (estadoTorre.timerRelogioTv) {
        clearInterval(estadoTorre.timerRelogioTv);
        estadoTorre.timerRelogioTv = null;
    }

    try {
        if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
        }
    } catch (_) {
        // Ignora erro ao sair do fullscreen
    }

    renderizarTelaCompleta({ preservarRolagem: false });
}

/* ============================================================================
   NAVEGAÇÃO POR HASH E EVENTOS DE INTERAÇÃO
   ============================================================================ */
function obterAbaDaHash() {
    const raw = (window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
    return ABAS_META[raw] ? raw : 'matriz';
}

function navegarParaAba(novaAba) {
    const abaValida = ABAS_META[novaAba] ? novaAba : 'matriz';
    fecharPopoverFiltroColuna();

    if (window.location.hash !== `#${abaValida}`) {
        window.location.hash = `#${abaValida}`;
        return;
    }

    estadoTorre.abaAtual = abaValida;
    if (estadoTorre.dadosPorAba[abaValida]) {
        renderizarTelaCompleta({ preservarRolagem: false });
        carregarDadosAbaAtual({ silencioso: true });
    } else {
        carregarDadosAbaAtual({ silencioso: false });
    }
}

function registrarEventosGlobais() {
    // Mudança de hash (suporta botão Voltar / Avançar do navegador)
    window.addEventListener('hashchange', () => {
        const abaHash = obterAbaDaHash();
        estadoTorre.abaAtual = abaHash;
        fecharPopoverFiltroColuna();
        if (estadoTorre.dadosPorAba[abaHash]) {
            renderizarTelaCompleta({ preservarRolagem: false });
            carregarDadosAbaAtual({ silencioso: true });
        } else {
            carregarDadosAbaAtual({ silencioso: false });
        }
    });

    // Busca no topo
    const inputBusca = document.getElementById('torre-busca');
    const btnLimparBusca = document.getElementById('btn-limpar-busca');

    if (inputBusca) {
        inputBusca.addEventListener('input', () => {
            const config = cfgAba();
            config.busca = inputBusca.value;
            config.pagina = 1;
            if (btnLimparBusca) btnLimparBusca.hidden = !config.busca;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        });
    }

    if (btnLimparBusca) {
        btnLimparBusca.addEventListener('click', () => {
            const config = cfgAba();
            config.busca = '';
            config.pagina = 1;
            if (inputBusca) inputBusca.value = '';
            btnLimparBusca.hidden = true;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        });
    }

    // Botão Atualizar
    const btnAtualizar = document.getElementById('btn-atualizar-dados');
    if (btnAtualizar) {
        btnAtualizar.addEventListener('click', () => {
            carregarDadosAbaAtual({ silencioso: true });
        });
    }

    // Botão Tentar Agora (banner de erro de rede)
    const btnTentarAgora = document.getElementById('btn-tentar-agora');
    if (btnTentarAgora) {
        btnTentarAgora.addEventListener('click', () => {
            carregarDadosAbaAtual({ silencioso: true });
        });
    }

    // Botão Modo TV
    const btnModoTv = document.getElementById('btn-modo-tv');
    if (btnModoTv) {
        btnModoTv.addEventListener('click', () => {
            if (estadoTorre.modoTvAtivo) sairModoTv();
            else entrarModoTv();
        });
    }

    // Tecla Escape sai do Modo TV ou fecha o popover de coluna
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (estadoTorre.modoTvAtivo) {
                sairModoTv();
            }
            if (estadoTorre.popoverColunaAberta) {
                fecharPopoverFiltroColuna();
            }
        }
    });

    // Delegação de cliques na área de conteúdo e no popover
    document.addEventListener('click', (e) => {
        const alvoAcao = e.target.closest('[data-acao]');
        const dentroPopover = e.target.closest('#torre-filtro-popover');

        if (!dentroPopover && (!alvoAcao || alvoAcao.getAttribute('data-acao') !== 'abrir-filtro-coluna')) {
            if (estadoTorre.popoverColunaAberta) {
                fecharPopoverFiltroColuna();
            }
        }

        if (!alvoAcao) return;
        const acao = alvoAcao.getAttribute('data-acao');
        const config = cfgAba();

        if (acao === 'kpi-filtro') {
            const kpiId = alvoAcao.getAttribute('data-kpi-id');
            if (kpiId === 'todas' || config.filtroKpi === kpiId) {
                config.filtroKpi = null;
                if (estadoTorre.abaAtual === 'matriz') config.filtroEtapa = '';
            } else {
                config.filtroKpi = kpiId;
                if (estadoTorre.abaAtual === 'matriz' && kpiId.startsWith('etapa:')) {
                    config.filtroEtapa = kpiId.split(':')[1];
                } else if (estadoTorre.abaAtual === 'matriz') {
                    config.filtroEtapa = '';
                }
            }
            config.pagina = 1;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        } else if (acao === 'etapa-rapida') {
            const etapa = alvoAcao.getAttribute('data-etapa') || '';
            config.filtroEtapa = config.filtroEtapa === etapa ? '' : etapa;
            config.filtroKpi = config.filtroEtapa ? `etapa:${config.filtroEtapa}` : null;
            config.pagina = 1;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        } else if (acao === 'limpar-filtros') {
            config.busca = '';
            config.filtroKpi = null;
            config.filtroEtapa = '';
            config.filtrosColuna = {};
            config.pagina = 1;
            if (inputBusca) inputBusca.value = '';
            if (btnLimparBusca) btnLimparBusca.hidden = true;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        } else if (acao === 'ordenar-coluna') {
            const col = alvoAcao.getAttribute('data-coluna');
            if (config.ordenarPor === col) {
                config.ordemDir = config.ordemDir === 'asc' ? 'desc' : 'asc';
            } else {
                config.ordenarPor = col;
                config.ordemDir = 'asc';
            }
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: true });
        } else if (acao === 'abrir-filtro-coluna') {
            e.stopPropagation();
            const col = alvoAcao.getAttribute('data-coluna');
            const rotulo = alvoAcao.getAttribute('data-rotulo') || col;
            abrirPopoverFiltroColuna(alvoAcao, col, rotulo);
        } else if (acao === 'fechar-popover') {
            fecharPopoverFiltroColuna();
        } else if (acao === 'limpar-filtro-coluna') {
            const col = alvoAcao.getAttribute('data-coluna');
            if (config.filtrosColuna) delete config.filtrosColuna[col];
            config.pagina = 1;
            salvarEstadoAbas();
            fecharPopoverFiltroColuna();
            renderizarTelaCompleta({ preservarRolagem: true });
        } else if (acao === 'aplicar-filtro-coluna') {
            const col = alvoAcao.getAttribute('data-coluna');
            const popover = document.getElementById('torre-filtro-popover');
            const marcados = popover
                ? Array.from(popover.querySelectorAll('.popover-checkbox-valor:checked')).map((cb) => cb.value)
                : [];
            if (!config.filtrosColuna) config.filtrosColuna = {};
            if (marcados.length > 0) {
                config.filtrosColuna[col] = marcados;
            } else {
                delete config.filtrosColuna[col];
            }
            config.pagina = 1;
            salvarEstadoAbas();
            fecharPopoverFiltroColuna();
            renderizarTelaCompleta({ preservarRolagem: true });
        } else if (acao === 'pagina-anterior') {
            if (config.pagina > 1) {
                config.pagina -= 1;
                salvarEstadoAbas();
                renderizarTelaCompleta({ preservarRolagem: false });
            }
        } else if (acao === 'pagina-ir') {
            const destino = parseInt(alvoAcao.getAttribute('data-pagina'), 10);
            if (destino > 0 && destino !== config.pagina) {
                config.pagina = destino;
                salvarEstadoAbas();
                renderizarTelaCompleta({ preservarRolagem: false });
            }
        } else if (acao === 'pagina-proxima') {
            config.pagina = (config.pagina || 1) + 1;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        }
    });

    // Mudança de "Registros por página"
    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'select-por-pagina') {
            const config = cfgAba();
            config.porPagina = parseInt(e.target.value, 10);
            config.pagina = 1;
            salvarEstadoAbas();
            renderizarTelaCompleta({ preservarRolagem: false });
        }
    });

    // Atualização automática a cada 60s apenas quando a aba do navegador está visível
    if (estadoTorre.timerAutoRefresh) clearInterval(estadoTorre.timerAutoRefresh);
    const intervaloRefresh = window.TORRE_AUTO_ATUALIZAR_MS || AUTO_ATUALIZAR_MS;
    estadoTorre.timerAutoRefresh = setInterval(() => {
        if (document.visibilityState === 'visible') {
            carregarDadosAbaAtual({ silencioso: true });
        }
    }, intervaloRefresh);
}

/* ============================================================================
   INICIALIZAÇÃO AUTENTICADA (ADMIN E DIRETORIA)
   ============================================================================ */
ajbAoAutenticar(['admin', 'diretoria'], '/HTML/Login.html#admin', async () => {
    window.ajbAuth.vigiarSessao(['admin', 'diretoria'], '/HTML/Login.html#admin');

    const botaoSair = document.getElementById('torre-sair');
    if (botaoSair) {
        botaoSair.addEventListener('click', (e) => {
            e.preventDefault();
            window.ajbAuth.sair('/HTML/Login.html#admin');
        });
    }

    carregarEstadoSalvoAbas();
    inicializarSidebar();
    registrarEventosGlobais();

    estadoTorre.abaAtual = obterAbaDaHash();
    await carregarDadosAbaAtual({ silencioso: false });
});

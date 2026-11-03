/**
 * ============================================================================
 * AJBorges Transportes - Dashboard de Recursos Humanos (RH)
 * Dados no Supabase, schema rh (supabase/sql/rh/R01 + R01b + R03). Quem pode
 * o quê é decidido no banco (RLS): admin e rh leem e gravam; rh_restrito lê e
 * só grava observações e conclusão/reabertura de etapas. A tela só esconde os
 * botões que o papel não pode usar. Depois de cada gravação, relê tudo.
 * Anexos: arquivo no bucket privado rh-anexos (abre só por link assinado de
 * 60 segundos) e dados em rh.anexos.
 * Lixeira (R05): excluir/restaurar colaborador pelas RPCs do schema rh (nada é
 * apagado); o banco já esconde o excluído e tudo que é dele de todas as leituras.
 * ============================================================================
 */

const RH_LOGIN = '/HTML/Login.html#admin';
const CHAVE_SIDEBAR = 'ajborges_sidebar_recolhida_rh';
const PAPEIS_RH = ['admin', 'rh', 'rh_restrito'];
const TABELAS_RH = [
    'colaboradores', 'modelos', 'modelo_etapas', 'processos', 'etapas',
    'observacoes', 'contratos_pj', 'exames', 'ferias', 'anexos'
];

// Anexos: mesmo limite e tipos do bucket (o Storage também barra)
const BUCKET_ANEXOS = 'rh-anexos';
const LIMITE_ANEXO_BYTES = 10 * 1024 * 1024;
const EXTENSAO_POR_TIPO = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
const TIPO_POR_EXTENSAO = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const SEGUNDOS_LINK_ANEXO = 60;

/* ============================================================================
   ESTADO DA TELA (OS DADOS VÊM DO BANCO EM carregarDados)
   ============================================================================ */
const estadoRh = {
    abaAtual: 'painel',
    usuarioEmail: '',
    usuarioNome: 'Recursos Humanos',
    papel: '',
    sidebarRecolhida: false,

    colaboradores: [],
    processos: [],
    exames: [],

    // Seleções e filtros ativos na tela
    colaboradorSelecionadoId: null,
    processoSelecionadoId: null,
    filtroTipoProcesso: '',
    filtroExameSituacao: '',
    filtroExameTipo: '',
    modeloSelecionadoId: 'rescisao_clt',
    etapaEditandoNomeId: null,
    modeloIndexEditando: null,
    // Envios de anexo em andamento: etapaId -> texto da barra de envio
    enviosAnexo: {},
    // Lixeira: lida pela RPC rh.lixeira() ao abrir a tela (só rh e admin)
    lixeira: [],

    // Modelos de etapas por chave (rescisao_clt, distrato_pj, exame_periodico, admissao_clt)
    modelos: {}
};

function podeEditar() {
    return estadoRh.papel !== 'rh_restrito';
}

/* ============================================================================
   UTILITÁRIOS DE SEGURANÇA (escapeHtml) E DATAS
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

function normalizarBusca(valor) {
    if (!valor) return '';
    return String(valor)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function formatarDataBr(dataIso) {
    if (!dataIso || typeof dataIso !== 'string') return '—';
    const partes = dataIso.trim().split('-');
    if (partes.length !== 3) return dataIso;
    return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

// Data e hora no fuso do navegador (carimbo do servidor em ISO ou agora)
function formatarDataHora(valor) {
    const data = valor ? new Date(valor) : new Date();
    if (Number.isNaN(data.getTime())) return '—';
    const dd = String(data.getDate()).padStart(2, '0');
    const mm = String(data.getMonth() + 1).padStart(2, '0');
    const yyyy = data.getFullYear();
    const hh = String(data.getHours()).padStart(2, '0');
    const min = String(data.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function diferencaDiasParaHoje(dataIso) {
    if (!dataIso || typeof dataIso !== 'string') return null;
    const partes = dataIso.trim().split('-').map(Number);
    if (partes.length !== 3 || partes.some(Number.isNaN)) return null;

    const hoje = new Date();
    const hojeMeiaNoite = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
    const alvoMeiaNoite = new Date(partes[0], partes[1] - 1, partes[2]);

    return Math.round((alvoMeiaNoite.getTime() - hojeMeiaNoite.getTime()) / 86400000);
}

function nomeMesAno(ym) {
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym;
    const [ano, mes] = ym.split('-').map(Number);
    const nomes = [
        'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
    ];
    return `${nomes[mes - 1] || mes}/${ano}`;
}

function isoParaData(dataIso) {
    if (!dataIso || !/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) return null;
    const [ano, mes, dia] = dataIso.split('-').map(Number);
    return new Date(ano, mes - 1, dia);
}

function dataParaIso(data) {
    const yyyy = data.getFullYear();
    const mm = String(data.getMonth() + 1).padStart(2, '0');
    const dd = String(data.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Desloca uma data ISO em anos e dias (usado nos períodos de férias)
function deslocarDataIso(dataIso, anos, dias) {
    const base = isoParaData(dataIso);
    if (!base) return '';
    base.setFullYear(base.getFullYear() + anos);
    base.setDate(base.getDate() + dias);
    return dataParaIso(base);
}

function formatarMoedaBr(valor) {
    if (valor === null || valor === undefined || valor === '' || Number.isNaN(Number(valor))) return '—';
    return Number(valor).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarTamanho(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} bytes`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

/* ============================================================================
   BANCO: LEITURA E GRAVAÇÃO NO SCHEMA rh
   Sem delete: "remover" grava ativo = false. Carimbos (autor, hora, quem
   alterou) são do servidor; o navegador nunca manda esses campos.
   ============================================================================ */
function bancoRh() {
    const cliente = window.supabaseClient;
    if (!cliente || typeof cliente.schema !== 'function') {
        throw new Error('Cliente Supabase indisponível.');
    }
    return cliente.schema('rh');
}

async function lerTabelaRh(tabela) {
    const { data, error } = await bancoRh().from(tabela).select('*');
    if (error) throw error;
    return Array.isArray(data) ? data : [];
}

async function inserirRh(tabela, valores) {
    const { data, error } = await bancoRh().from(tabela).insert(valores).select();
    if (error) throw error;
    return Array.isArray(data) ? data : [];
}

// Update que não volta nenhuma linha foi barrado pela RLS (o PostgREST não dá erro nesse caso)
async function atualizarRh(tabela, id, valores) {
    const { data, error } = await bancoRh().from(tabela).update(valores).eq('id', id).select();
    if (error) throw error;
    if (!Array.isArray(data) || data.length === 0) {
        const semLinha = new Error('Nenhuma linha alterada.');
        semLinha.code = '42501';
        throw semLinha;
    }
    return data;
}

async function chamarRpcRh(funcao, argumentos) {
    const { data, error } = await bancoRh().rpc(funcao, argumentos);
    if (error) throw error;
    return data;
}

function mensagemDeErro(erro, acao) {
    const texto = String((erro && (erro.message || erro.details)) || erro || '');
    const codigo = String((erro && erro.code) || '');
    const status = Number(erro && erro.status) || 0;

    if (codigo === 'PGRST301' || status === 401 || /jwt expired/i.test(texto)) {
        return `Sua sessão expirou: não foi possível ${acao}. Entre de novo; o que você digitou continua na tela.`;
    }
    if (codigo === '42501' || status === 403 || /permission denied|row-level security/i.test(texto)) {
        return `Sem permissão para ${acao} com o seu usuário. Nada foi alterado.`;
    }
    if (codigo === 'P0002') {
        return `Não foi possível ${acao}: o colaborador não foi encontrado (pode já ter sido excluído ou restaurado em outra tela).`;
    }
    if (codigo === 'PGRST106') {
        return `Não foi possível ${acao}: o schema "rh" ainda não está liberado na API do Supabase.`;
    }
    // Recusas do Storage (o bucket rh-anexos tem limite e tipos próprios)
    if (status === 413 || /maximum allowed size|too large/i.test(texto)) {
        return `Não foi possível ${acao}: o arquivo passa do limite de 10 MB.`;
    }
    if (status === 415 || /mime type/i.test(texto)) {
        return `Não foi possível ${acao}: tipo de arquivo não aceito (só PDF, JPG ou PNG).`;
    }
    if (/object not found/i.test(texto)) {
        return `Não foi possível ${acao}: o arquivo não foi encontrado ou o seu usuário não pode abri-lo.`;
    }
    if (!codigo && /fetch|network|failed|timeout|indisponível/i.test(texto)) {
        return `Sem conexão com o servidor: não foi possível ${acao}. Confira a internet e tente de novo; o que você digitou continua na tela.`;
    }
    return `Não foi possível ${acao}: ${texto || 'erro desconhecido'}. O que você digitou continua na tela.`;
}

function mostrarAvisoErro(mensagem, { tentarDeNovo = false } = {}) {
    const aviso = document.getElementById('rh-aviso-erro');
    const textoEl = document.getElementById('rh-aviso-erro-texto');
    const btnTentar = document.getElementById('rh-aviso-erro-tentar');
    if (!aviso || !textoEl) return;
    textoEl.textContent = mensagem;
    if (btnTentar) btnTentar.hidden = !tentarDeNovo;
    aviso.hidden = false;
}

function ocultarAvisoErro() {
    const aviso = document.getElementById('rh-aviso-erro');
    if (aviso) aviso.hidden = true;
}

// Monta o estado da tela a partir das linhas do banco (nomes snake_case -> camelCase da tela)
function montarEstado(linhas) {
    const porOrdem = (a, b) => a.ordem - b.ordem;
    const porCriacao = (a, b) => String(a.criado_em).localeCompare(String(b.criado_em));

    const chavePorModeloId = {};
    const modelos = {};
    linhas.modelos.forEach((m) => {
        chavePorModeloId[m.id] = m.chave;
        if (m.ativo) modelos[m.chave] = { id: m.id, chave: m.chave, nome: m.nome, etapas: [] };
    });
    linhas.modelo_etapas
        .filter((e) => e.ativo && modelos[chavePorModeloId[e.modelo_id]])
        .sort(porOrdem)
        .forEach((e) => {
            modelos[chavePorModeloId[e.modelo_id]].etapas.push({ id: e.id, nome: e.nome, ordem: e.ordem });
        });

    const excluidos = new Set(linhas.colaboradores.filter((c) => c.excluido_em).map((c) => c.id));
    const colaboradores = linhas.colaboradores
        .filter((c) => c.ativo && !c.excluido_em)
        .sort(porCriacao)
        .map((c) => ({
            id: c.id,
            nome: c.nome,
            cargo: c.cargo || '',
            setor: c.setor || '',
            vinculo: c.vinculo,
            situacao: c.situacao,
            dataAdmissao: c.data_admissao || '',
            dataProximoExame: c.data_proximo_exame || '',
            contratoPj: null,
            ferias: null
        }));
    const colabPorId = Object.fromEntries(colaboradores.map((c) => [c.id, c]));

    linhas.contratos_pj.filter((ct) => ct.ativo && colabPorId[ct.colaborador_id]).forEach((ct) => {
        colabPorId[ct.colaborador_id].contratoPj = {
            id: ct.id,
            inicio: ct.inicio,
            fim: ct.fim,
            valor: Number(ct.valor),
            avisoDias: ct.aviso_dias
        };
    });

    // Vale o período aquisitivo mais recente de cada colaborador
    linhas.ferias
        .filter((f) => f.ativo && colabPorId[f.colaborador_id])
        .sort((a, b) => String(a.aquisitivo_inicio).localeCompare(String(b.aquisitivo_inicio)))
        .forEach((f) => {
            colabPorId[f.colaborador_id].ferias = {
                id: f.id,
                aquisitivoInicio: f.aquisitivo_inicio,
                saldoDias: f.saldo_dias,
                programacaoInicio: f.programacao_inicio || '',
                programacaoFim: f.programacao_fim || ''
            };
        });

    // Ordem de registro: no empate de data, vale o registrado por último (exameSubstituido)
    const exames = linhas.exames
        .filter((ex) => ex.ativo && !excluidos.has(ex.colaborador_id))
        .sort(porCriacao)
        .map((ex) => ({
            id: ex.id,
            colaboradorId: ex.colaborador_id,
            tipo: ex.tipo,
            dataRealizacao: ex.data_realizacao,
            vencimento: ex.vencimento || ''
        }));

    const obsPorEtapa = {};
    linhas.observacoes.slice().sort(porCriacao).forEach((o) => {
        (obsPorEtapa[o.etapa_id] = obsPorEtapa[o.etapa_id] || []).push({
            autor: o.autor_email || 'Usuário sem e-mail',
            dataHora: formatarDataHora(o.criado_em),
            texto: o.texto
        });
    });

    // Anexos com arquivo (rh.anexos); os removidos (ativo = false) não aparecem
    const anexosPorEtapa = {};
    linhas.anexos.filter((a) => a.ativo).sort(porCriacao).forEach((a) => {
        (anexosPorEtapa[a.etapa_id] = anexosPorEtapa[a.etapa_id] || []).push({
            id: a.id,
            caminho: a.caminho,
            nome: a.nome_original,
            tamanho: a.tamanho,
            enviadoPor: a.criado_por_email || 'Usuário sem e-mail',
            enviadoEm: formatarDataHora(a.criado_em)
        });
    });

    const etapasPorProcesso = {};
    linhas.etapas.filter((e) => e.ativo).sort(porOrdem).forEach((e) => {
        (etapasPorProcesso[e.processo_id] = etapasPorProcesso[e.processo_id] || []).push({
            id: e.id,
            ordem: e.ordem,
            nome: e.nome,
            concluida: Boolean(e.concluida),
            responsavel: e.responsavel || '',
            prazo: e.prazo || '',
            anexos: anexosPorEtapa[e.id] || [],
            // Antes do R03 só o nome era gravado (rh.etapas.anexos): registro antigo, sem arquivo
            anexosAntigos: Array.isArray(e.anexos) ? e.anexos : [],
            observacoes: obsPorEtapa[e.id] || []
        });
    });

    const processos = linhas.processos
        .filter((p) => !p.cancelado && !excluidos.has(p.colaborador_id))
        .sort(porCriacao)
        .map((p) => ({
            id: p.id,
            colaboradorId: p.colaborador_id,
            modeloId: chavePorModeloId[p.modelo_id] || '',
            modeloNome: p.modelo_nome,
            etapas: etapasPorProcesso[p.id] || []
        }));

    estadoRh.modelos = modelos;
    estadoRh.colaboradores = colaboradores;
    estadoRh.exames = exames;
    estadoRh.processos = processos;
}

async function carregarDados() {
    const resultados = await Promise.all(TABELAS_RH.map(lerTabelaRh));
    montarEstado(Object.fromEntries(TABELAS_RH.map((t, i) => [t, resultados[i]])));
}

// Relê tudo e redesenha; se falhar, mantém a tela como está e avisa
async function recarregarDados() {
    try {
        await carregarDados();
    } catch (erro) {
        console.warn('[RH] Falha ao carregar os dados:', erro);
        mostrarAvisoErro(mensagemDeErro(erro, 'carregar os dados do RH'), { tentarDeNovo: true });
        return false;
    }
    atualizarTudo();
    return true;
}

// Gravações em fila (uma de cada vez). Se der certo, relê tudo; se der errado,
// mostra o aviso e não redesenha: o que foi digitado continua nos campos.
let filaGravacao = Promise.resolve();
function executarGravacao(gravar, { form = null } = {}) {
    const botoes = form ? Array.from(form.querySelectorAll('button[type="submit"]')) : [];
    botoes.forEach((b) => { b.disabled = true; });

    const tarefa = filaGravacao.then(async () => {
        try {
            await gravar();
        } catch (erro) {
            console.warn('[RH] Falha ao gravar:', erro);
            mostrarAvisoErro(mensagemDeErro(erro, 'salvar esta alteração'));
            return false;
        } finally {
            botoes.forEach((b) => { b.disabled = false; });
        }
        ocultarAvisoErro();
        await recarregarDados();
        return true;
    });
    filaGravacao = tarefa;
    return tarefa;
}

/* ============================================================================
   SITUAÇÃO DE CONTRATOS PJ, EXAMES (SST) E FÉRIAS
   ============================================================================ */
const TIPOS_EXAME = {
    admissional: 'Admissional',
    periodico: 'Periódico',
    retorno: 'Retorno ao trabalho',
    demissional: 'Demissional'
};

function situacaoContratoPj(colab) {
    const contrato = colab.contratoPj;
    if (!contrato || !contrato.fim) {
        return { dias: null, rotulo: 'Sem contrato', badgeClasse: 'badge-neutro', faixa: '' };
    }
    const dias = diferencaDiasParaHoje(contrato.fim);
    if (dias === null) return { dias: null, rotulo: '—', badgeClasse: 'badge-neutro', faixa: '' };
    if (dias < 0) {
        return { dias, rotulo: `Encerrado há ${Math.abs(dias)}d`, badgeClasse: 'badge-vermelho', faixa: 'Vencido' };
    }
    if (dias <= 7) {
        return { dias, rotulo: dias === 0 ? 'Termina hoje' : `Faltam ${dias}d`, badgeClasse: 'badge-vermelho', faixa: '7 dias' };
    }
    if (dias <= 15) return { dias, rotulo: `Faltam ${dias}d`, badgeClasse: 'badge-laranja', faixa: '15 dias' };
    if (dias <= 30) return { dias, rotulo: `Faltam ${dias}d`, badgeClasse: 'badge-amarelo', faixa: '30 dias' };
    return { dias, rotulo: 'Vigente', badgeClasse: 'badge-verde', faixa: '' };
}

// Por colaborador e tipo, só vale o exame com a realização mais recente (empate: o registrado por último);
// os anteriores ficam como histórico
function exameSubstituido(exame) {
    const posicao = estadoRh.exames.indexOf(exame);
    return estadoRh.exames.some((outro, idx) => (
        outro !== exame &&
        outro.colaboradorId === exame.colaboradorId &&
        outro.tipo === exame.tipo &&
        (outro.dataRealizacao > exame.dataRealizacao ||
            (outro.dataRealizacao === exame.dataRealizacao && idx > posicao))
    ));
}

function situacaoExame(exame) {
    if (exameSubstituido(exame)) {
        return { chave: 'substituido', dias: null, rotulo: 'Substituído', badgeClasse: 'badge-neutro' };
    }
    if (!exame.vencimento) {
        return { chave: 'sem_vencimento', dias: null, rotulo: 'Sem vencimento', badgeClasse: 'badge-neutro' };
    }
    const dias = diferencaDiasParaHoje(exame.vencimento);
    if (dias !== null && dias < 0) {
        return { chave: 'vencido', dias, rotulo: `Vencido há ${Math.abs(dias)}d`, badgeClasse: 'badge-vermelho' };
    }
    if (dias !== null && dias <= 30) {
        return { chave: 'a_vencer', dias, rotulo: dias === 0 ? 'Vence hoje' : `Vence em ${dias}d`, badgeClasse: 'badge-amarelo' };
    }
    return { chave: 'em_dia', dias, rotulo: 'Em dia', badgeClasse: 'badge-verde' };
}

// Aquisitivo = 12 meses a partir do início; concessivo = 12 meses seguintes (CLT art. 134)
function calcularPeriodosFerias(aquisitivoInicio) {
    if (!isoParaData(aquisitivoInicio)) return null;
    return {
        aquisitivoInicio,
        aquisitivoFim: deslocarDataIso(aquisitivoInicio, 1, -1),
        concessivoInicio: deslocarDataIso(aquisitivoInicio, 1, 0),
        concessivoFim: deslocarDataIso(aquisitivoInicio, 2, -1)
    };
}

function situacaoFerias(colab) {
    const ferias = colab.ferias;
    const periodos = ferias ? calcularPeriodosFerias(ferias.aquisitivoInicio) : null;
    if (!ferias || !periodos) {
        return { periodos: null, dias: null, rotulo: 'Não informado', badgeClasse: 'badge-neutro' };
    }
    const dias = diferencaDiasParaHoje(periodos.concessivoFim);
    if (ferias.saldoDias === 0) {
        return { periodos, dias, rotulo: 'Sem saldo', badgeClasse: 'badge-verde' };
    }
    if (dias !== null && dias < 0) {
        return { periodos, dias, rotulo: `Concessivo vencido há ${Math.abs(dias)}d`, badgeClasse: 'badge-vermelho' };
    }
    if (dias !== null && dias <= 60) {
        return { periodos, dias, rotulo: `Concessivo vence em ${dias}d`, badgeClasse: 'badge-amarelo' };
    }
    return { periodos, dias, rotulo: 'Em dia', badgeClasse: 'badge-verde' };
}

/* ============================================================================
   CÁLCULO DE PROGRESSO, PRÓXIMA AÇÃO E ALERTAS
   ============================================================================ */
function calcularProgressoProcesso(proc) {
    const total = Array.isArray(proc.etapas) ? proc.etapas.length : 0;
    const concluidas = total > 0 ? proc.etapas.filter((e) => e.concluida).length : 0;
    const pct = total > 0 ? Math.round((concluidas / total) * 100) : 0;
    return {
        concluidas,
        total,
        pct,
        texto: `${concluidas} de ${total} – ${pct}%`
    };
}

function obterProximaEtapaAberta(proc) {
    if (!proc || !Array.isArray(proc.etapas)) return null;
    return proc.etapas.find((e) => !e.concluida) || null;
}

function obterTextoProximaAcao(proc) {
    if (!proc || !Array.isArray(proc.etapas) || proc.etapas.length === 0) {
        return 'Próxima ação: Nenhuma etapa cadastrada';
    }
    const prox = obterProximaEtapaAberta(proc);
    if (!prox) {
        return 'Próxima ação: Processo concluído (100%)';
    }
    const resp = prox.responsavel && prox.responsavel.trim() ? prox.responsavel.trim() : 'A definir';
    return `Próxima ação: ${prox.nome} com ${resp}`;
}

function processoEmAndamento(proc) {
    if (!proc || !Array.isArray(proc.etapas)) return true;
    if (proc.etapas.length === 0) return true;
    return proc.etapas.some((e) => !e.concluida);
}

// Junta o próximo exame do cadastro e os vencimentos da tela Exames (SST), sem os substituídos:
// um item por colaborador, valendo o vencimento mais próximo
function coletarVencimentosExame() {
    return estadoRh.colaboradores.map((colab) => {
        const candidatos = [];
        if (colab.dataProximoExame) {
            candidatos.push({ data: colab.dataProximoExame, rotulo: 'Exame periódico', origem: 'cadastro' });
        }
        estadoRh.exames.forEach((exame) => {
            if (exame.colaboradorId !== colab.id || !exame.vencimento || exameSubstituido(exame)) return;
            candidatos.push({
                data: exame.vencimento,
                rotulo: `Exame ${(TIPOS_EXAME[exame.tipo] || exame.tipo).toLowerCase()}`,
                origem: 'sst'
            });
        });
        if (candidatos.length === 0) return null;
        candidatos.sort((a, b) => a.data.localeCompare(b.data));
        return { colab, ...candidatos[0] };
    }).filter(Boolean);
}

function coletarAlertasSessao() {
    const alertas = [];

    // 1. Exames (cadastro + SST, sem duplicar colaborador) vencendo em 30 / 15 / 7 dias (ou vencidos)
    coletarVencimentosExame().forEach(({ colab, data, rotulo, origem }) => {
        const dias = diferencaDiasParaHoje(data);
        if (dias === null || dias > 30) return;

        let faixa = '30 dias';
        let badgeClasse = 'badge-amarelo';
        let detalheDias = `Vence em ${dias} dia(s)`;

        if (dias < 0) {
            faixa = 'Vencido';
            badgeClasse = 'badge-vermelho';
            detalheDias = `Vencido há ${Math.abs(dias)} dia(s)`;
        } else if (dias <= 7) {
            faixa = '7 dias';
            badgeClasse = 'badge-vermelho';
            detalheDias = dias === 0 ? 'Vence hoje (alerta 7 dias)' : `Vence em ${dias} dia(s) (alerta 7 dias)`;
        } else if (dias <= 15) {
            faixa = '15 dias';
            badgeClasse = 'badge-laranja';
            detalheDias = `Vence em ${dias} dias (alerta 15 dias)`;
        } else {
            faixa = '30 dias';
            badgeClasse = 'badge-amarelo';
            detalheDias = `Vence em ${dias} dias (alerta 30 dias)`;
        }

        alertas.push({
            tipo: 'exame',
            dias,
            faixa,
            badgeClasse,
            titulo: `${rotulo} (${faixa}): ${colab.nome}`,
            subtitulo: `${detalheDias} • Data: ${formatarDataBr(data)} • Setor: ${colab.setor}`,
            colabId: colab.id,
            view: origem === 'sst' ? 'exames' : ''
        });
    });

    // 2. Prazos de etapas vencidos nos processos
    estadoRh.processos.forEach((proc) => {
        const colab = estadoRh.colaboradores.find((c) => c.id === proc.colaboradorId);
        const nomeColab = colab ? colab.nome : 'Colaborador';

        (proc.etapas || []).forEach((etapa) => {
            if (etapa.concluida || !etapa.prazo) return;
            const dias = diferencaDiasParaHoje(etapa.prazo);
            if (dias !== null && dias < 0) {
                alertas.push({
                    tipo: 'etapa_vencida',
                    dias,
                    faixa: 'Prazo vencido',
                    badgeClasse: 'badge-vermelho',
                    titulo: `Prazo de etapa vencido: ${etapa.nome}`,
                    subtitulo: `${nomeColab} (${proc.modeloNome}) • Prazo: ${formatarDataBr(etapa.prazo)} (${Math.abs(dias)}d atraso) • Resp.: ${etapa.responsavel || 'A definir'}`,
                    processoId: proc.id
                });
            }
        });
    });

    // 3. Fim de contrato PJ em 30 / 15 / 7 dias (ou já vencido)
    estadoRh.colaboradores.forEach((colab) => {
        if (colab.vinculo !== 'PJ') return;
        const sit = situacaoContratoPj(colab);
        if (sit.dias === null || sit.dias > 30) return;

        const aviso = colab.contratoPj.avisoDias;
        alertas.push({
            tipo: 'contrato_pj',
            dias: sit.dias,
            faixa: sit.faixa,
            badgeClasse: sit.badgeClasse,
            titulo: `Fim de contrato PJ (${sit.faixa}): ${colab.nome}`,
            subtitulo: `${sit.rotulo} • Fim: ${formatarDataBr(colab.contratoPj.fim)} • Aviso contratual: ${aviso === null || aviso === undefined ? '—' : `${aviso} dia(s)`}`,
            view: 'prestadores'
        });
    });

    // 4. Período concessivo de férias a 60 dias de vencer (ou já vencido)
    estadoRh.colaboradores.forEach((colab) => {
        if (colab.vinculo !== 'CLT' || !colab.ferias) return;
        const sit = situacaoFerias(colab);
        if (!sit.periodos || sit.dias === null || sit.dias > 60 || colab.ferias.saldoDias === 0) return;

        const vencido = sit.dias < 0;
        alertas.push({
            tipo: 'ferias',
            dias: sit.dias,
            faixa: vencido ? 'Vencido' : '60 dias',
            badgeClasse: vencido ? 'badge-vermelho' : 'badge-amarelo',
            titulo: `Férias: concessivo ${vencido ? 'vencido' : 'a vencer'} — ${colab.nome}`,
            subtitulo: `${sit.rotulo} • Fim do concessivo: ${formatarDataBr(sit.periodos.concessivoFim)} • Saldo: ${colab.ferias.saldoDias} dia(s)`,
            view: 'ferias'
        });
    });

    return alertas.sort((a, b) => a.dias - b.dias);
}

function coletarItensAgenda() {
    const itens = [];

    // Exames periódicos com data
    estadoRh.colaboradores.forEach((colab) => {
        if (!colab.dataProximoExame) return;
        const dias = diferencaDiasParaHoje(colab.dataProximoExame);
        itens.push({
            origem: 'exame',
            dataIso: colab.dataProximoExame,
            mesAno: colab.dataProximoExame.slice(0, 7),
            titulo: `Exame periódico — ${colab.nome}`,
            subtitulo: `${colab.cargo} • ${colab.setor} (${colab.vinculo})`,
            responsavel: 'Saúde Ocupacional / RH',
            concluida: false,
            vencido: dias !== null && dias < 0,
            diasRestantes: dias,
            colabId: colab.id
        });
    });

    // Etapas de processos com prazo
    estadoRh.processos.forEach((proc) => {
        const colab = estadoRh.colaboradores.find((c) => c.id === proc.colaboradorId);
        const nomeColab = colab ? colab.nome : 'Colaborador';

        (proc.etapas || []).forEach((etapa) => {
            if (!etapa.prazo) return;
            const dias = diferencaDiasParaHoje(etapa.prazo);
            itens.push({
                origem: 'etapa',
                dataIso: etapa.prazo,
                mesAno: etapa.prazo.slice(0, 7),
                titulo: `${etapa.nome} — ${nomeColab}`,
                subtitulo: `Processo: ${proc.modeloNome}`,
                responsavel: etapa.responsavel || 'A definir',
                concluida: Boolean(etapa.concluida),
                vencido: !etapa.concluida && dias !== null && dias < 0,
                diasRestantes: dias,
                processoId: proc.id
            });
        });
    });

    return itens.sort((a, b) => a.dataIso.localeCompare(b.dataIso));
}

/* ============================================================================
   ATUALIZAÇÃO GLOBAL DAS 5 TELAS E CONTADORES
   ============================================================================ */
function atualizarTudo() {
    atualizarBadgesSidebar();
    renderizarPainel();
    renderizarColaboradores();
    renderizarProcessos();
    renderizarModelos();
    renderizarAgenda();
    renderizarPrestadoresPj();
    renderizarExames();
    renderizarFerias();
}

function atualizarBadgesSidebar() {
    const elColab = document.getElementById('nav-count-colaboradores');
    const elProc = document.getElementById('nav-count-processos');
    const elAgenda = document.getElementById('nav-count-agenda');
    const elPj = document.getElementById('nav-count-prestadores');
    const elExames = document.getElementById('nav-count-exames');
    const elFerias = document.getElementById('nav-count-ferias');

    if (elColab) elColab.textContent = String(estadoRh.colaboradores.length);
    if (elProc) elProc.textContent = String(estadoRh.processos.length);
    if (elAgenda) elAgenda.textContent = String(coletarItensAgenda().length);
    if (elPj) elPj.textContent = String(estadoRh.colaboradores.filter((c) => c.vinculo === 'PJ').length);
    if (elExames) elExames.textContent = String(estadoRh.exames.length);
    if (elFerias) elFerias.textContent = String(estadoRh.colaboradores.filter((c) => c.vinculo === 'CLT').length);
}

/* ============================================================================
   TELA 1: PAINEL
   ============================================================================ */
function renderizarPainel() {
    const admAndamento = estadoRh.processos.filter(
        (p) => p.modeloId === 'admissao_clt' && processoEmAndamento(p)
    ).length;

    const rescisoesDistratos = estadoRh.processos.filter(
        (p) => (p.modeloId === 'rescisao_clt' || p.modeloId === 'distrato_pj') && processoEmAndamento(p)
    ).length;

    const examesAVencer = coletarVencimentosExame().filter(({ data }) => {
        const dias = diferencaDiasParaHoje(data);
        return dias !== null && dias <= 30;
    }).length;

    let tarefasAtrasadas = 0;
    estadoRh.processos.forEach((p) => {
        (p.etapas || []).forEach((e) => {
            if (!e.concluida && e.prazo) {
                const dias = diferencaDiasParaHoje(e.prazo);
                if (dias !== null && dias < 0) tarefasAtrasadas += 1;
            }
        });
    });

    const elAdm = document.getElementById('kpi-valor-admissoes');
    const elRes = document.getElementById('kpi-valor-rescisoes');
    const elExa = document.getElementById('kpi-valor-exames');
    const elTar = document.getElementById('kpi-valor-tarefas');

    if (elAdm) elAdm.textContent = String(admAndamento);
    if (elRes) elRes.textContent = String(rescisoesDistratos);
    if (elExa) elExa.textContent = String(examesAVencer);
    if (elTar) elTar.textContent = String(tarefasAtrasadas);

    // Lista "Próximas ações"
    const proximasContainer = document.getElementById('painel-proximas-acoes-lista');
    const badgeProximas = document.getElementById('badge-count-proximas');
    const processosComAcao = estadoRh.processos
        .map((proc) => {
            const prox = obterProximaEtapaAberta(proc);
            if (!prox) return null;
            const colab = estadoRh.colaboradores.find((c) => c.id === proc.colaboradorId);
            return {
                proc,
                prox,
                nomeColab: colab ? colab.nome : 'Colaborador'
            };
        })
        .filter(Boolean);

    if (badgeProximas) badgeProximas.textContent = String(processosComAcao.length);

    if (proximasContainer) {
        if (processosComAcao.length === 0) {
            proximasContainer.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        } else {
            proximasContainer.innerHTML = processosComAcao.map(({ proc, prox, nomeColab }) => {
                const prog = calcularProgressoProcesso(proc);
                const diasPrazo = prox.prazo ? diferencaDiasParaHoje(prox.prazo) : null;
                const vencido = diasPrazo !== null && diasPrazo < 0;
                return `
                    <div class="rh-item-lista" data-acao="abrir-processo-painel" data-proc-id="${escapeHtml(proc.id)}">
                        <div class="item-info-principal">
                            <span class="item-titulo">${escapeHtml(nomeColab)} • ${escapeHtml(proc.modeloNome)}</span>
                            <span class="item-sub">
                                <strong>Próxima ação:</strong> ${escapeHtml(prox.nome)} com ${escapeHtml(prox.responsavel || 'A definir')}
                                ${prox.prazo ? ` • Prazo: ${escapeHtml(formatarDataBr(prox.prazo))}` : ''}
                            </span>
                        </div>
                        <div class="item-badges">
                            ${vencido ? '<span class="rh-badge badge-vermelho">Atrasada</span>' : ''}
                            <span class="rh-badge badge-violeta">${escapeHtml(prog.texto)}</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    // Lista "Alertas"
    const alertasContainer = document.getElementById('painel-alertas-lista');
    const badgeAlertas = document.getElementById('badge-count-alertas');
    const alertas = coletarAlertasSessao();

    if (badgeAlertas) badgeAlertas.textContent = String(alertas.length);

    if (alertasContainer) {
        if (alertas.length === 0) {
            alertasContainer.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        } else {
            alertasContainer.innerHTML = alertas.map((al) => `
                <div class="rh-item-lista"
                     data-acao="${al.processoId ? 'abrir-processo-painel' : (al.view ? 'ir-tela' : 'abrir-colab-painel')}"
                     data-proc-id="${escapeHtml(al.processoId || '')}"
                     data-colab-id="${escapeHtml(al.colabId || '')}"
                     data-view="${escapeHtml(al.view || '')}">
                    <div class="item-info-principal">
                        <span class="item-titulo">${escapeHtml(al.titulo)}</span>
                        <span class="item-sub">${escapeHtml(al.subtitulo)}</span>
                    </div>
                    <div class="item-badges">
                        <span class="rh-badge ${al.badgeClasse}">${escapeHtml(al.faixa)}</span>
                    </div>
                </div>
            `).join('');
        }
    }
}

/* ============================================================================
   TELA 2: COLABORADORES E FICHA DO COLABORADOR
   ============================================================================ */
function renderizarColaboradores() {
    const listaEl = document.getElementById('colaboradores-lista-container');
    const fichaEl = document.getElementById('colaborador-ficha-container');
    const totalBadge = document.getElementById('colab-total-badge');

    const busca = normalizarBusca(document.getElementById('colab-busca')?.value || '');
    const filtroVinculo = document.getElementById('colab-filtro-vinculo')?.value || '';
    const filtroSituacao = document.getElementById('colab-filtro-situacao')?.value || '';

    const filtrados = estadoRh.colaboradores.filter((c) => {
        if (filtroVinculo && c.vinculo !== filtroVinculo) return false;
        if (filtroSituacao && c.situacao !== filtroSituacao) return false;
        if (busca) {
            const texto = normalizarBusca(`${c.nome} ${c.cargo} ${c.setor}`);
            if (!texto.includes(busca)) return false;
        }
        return true;
    });

    if (totalBadge) totalBadge.textContent = String(filtrados.length);

    if (listaEl) {
        if (filtrados.length === 0) {
            listaEl.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        } else {
            listaEl.innerHTML = filtrados.map((c) => {
                const selecionado = c.id === estadoRh.colaboradorSelecionadoId;
                const qtdProc = estadoRh.processos.filter((p) => p.colaboradorId === c.id).length;
                return `
                    <div class="rh-item-lista ${selecionado ? 'selecionado' : ''}"
                         data-acao="selecionar-colaborador"
                         data-colab-id="${escapeHtml(c.id)}">
                        <div class="item-info-principal">
                            <span class="item-titulo">${escapeHtml(c.nome)}</span>
                            <span class="item-sub">${escapeHtml(c.cargo)} • ${escapeHtml(c.setor)}</span>
                        </div>
                        <div class="item-badges">
                            <span class="rh-badge badge-violeta">${escapeHtml(c.vinculo)}</span>
                            <span class="rh-badge badge-neutro">${escapeHtml(c.situacao)}</span>
                            <span class="rh-badge badge-verde">${qtdProc} proc.</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    if (!fichaEl) return;

    const colabAtivo = estadoRh.colaboradores.find((c) => c.id === estadoRh.colaboradorSelecionadoId) ||
                       estadoRh.colaboradores[0] || null;

    if (!colabAtivo) {
        fichaEl.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        return;
    }

    estadoRh.colaboradorSelecionadoId = colabAtivo.id;
    const processosColab = estadoRh.processos.filter((p) => p.colaboradorId === colabAtivo.id);
    const diasExame = colabAtivo.dataProximoExame ? diferencaDiasParaHoje(colabAtivo.dataProximoExame) : null;

    let badgeExameHtml = '';
    if (diasExame !== null) {
        if (diasExame < 0) {
            badgeExameHtml = `<span class="rh-badge badge-vermelho">Vencido há ${Math.abs(diasExame)}d</span>`;
        } else if (diasExame <= 7) {
            badgeExameHtml = `<span class="rh-badge badge-vermelho">Vence em ${diasExame}d (7d)</span>`;
        } else if (diasExame <= 15) {
            badgeExameHtml = `<span class="rh-badge badge-laranja">Vence em ${diasExame}d (15d)</span>`;
        } else if (diasExame <= 30) {
            badgeExameHtml = `<span class="rh-badge badge-amarelo">Vence em ${diasExame}d (30d)</span>`;
        } else {
            badgeExameHtml = '<span class="rh-badge badge-verde">Em dia</span>';
        }
    }

    fichaEl.innerHTML = `
        <div class="ficha-cabecalho">
            <div>
                <h4 class="item-titulo" style="font-size: 1.12rem;">${escapeHtml(colabAtivo.nome)}</h4>
                <p class="item-sub">${escapeHtml(colabAtivo.cargo)} • Setor: ${escapeHtml(colabAtivo.setor)}</p>
            </div>
            <div class="ficha-acoes">
                <button type="button" class="rh-btn rh-btn-pequeno rh-btn-primario" data-so-edicao
                    data-acao="novo-processo-para-colab"
                    data-colab-id="${escapeHtml(colabAtivo.id)}">
                    + Novo processo para este colaborador
                </button>
                <button type="button" class="rh-btn rh-btn-pequeno rh-btn-perigo" data-so-edicao
                    data-acao="excluir-colaborador" id="btn-excluir-colaborador"
                    data-colab-id="${escapeHtml(colabAtivo.id)}">
                    Excluir colaborador
                </button>
            </div>
        </div>

        <div class="ficha-grade-dados">
            <div class="ficha-dado-box">
                <span class="ficha-dado-label">Vínculo</span>
                <span class="ficha-dado-valor">${escapeHtml(colabAtivo.vinculo)}</span>
            </div>
            <div class="ficha-dado-box">
                <span class="ficha-dado-label">Situação</span>
                <span class="ficha-dado-valor">${escapeHtml(colabAtivo.situacao)}</span>
            </div>
            <div class="ficha-dado-box">
                <span class="ficha-dado-label">Data de admissão</span>
                <span class="ficha-dado-valor">${escapeHtml(formatarDataBr(colabAtivo.dataAdmissao))}</span>
            </div>
            <div class="ficha-dado-box">
                <span class="ficha-dado-label">Próximo exame periódico</span>
                <span class="ficha-dado-valor">
                    ${escapeHtml(formatarDataBr(colabAtivo.dataProximoExame))} ${badgeExameHtml}
                </span>
            </div>
        </div>

        <div class="ficha-processos-secao">
            <h5 class="etapa-subsecao-titulo">Processos deste colaborador (${processosColab.length})</h5>
            ${processosColab.length === 0 ? `
                <p class="rh-vazio-msg">Nenhum registro ainda</p>
            ` : processosColab.map((proc) => {
                const prog = calcularProgressoProcesso(proc);
                const proxTexto = obterTextoProximaAcao(proc);
                return `
                    <div class="rh-item-lista" data-acao="abrir-processo-painel" data-proc-id="${escapeHtml(proc.id)}">
                        <div class="item-info-principal">
                            <span class="item-titulo">${escapeHtml(proc.modeloNome)}</span>
                            <span class="item-sub">${escapeHtml(proxTexto)}</span>
                        </div>
                        <div class="item-badges">
                            <span class="rh-badge badge-violeta">${escapeHtml(prog.texto)}</span>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

/* ============================================================================
   LIXEIRA: EXCLUIR E RESTAURAR COLABORADOR (NADA É APAGADO)
   ============================================================================ */
function abrirModalExcluirColaborador(colabId) {
    const colab = estadoRh.colaboradores.find((c) => c.id === colabId);
    if (!colab || !podeEditar()) return;
    document.getElementById('excluir-colab-id').value = colab.id;
    document.getElementById('excluir-colab-nome').textContent = colab.nome;
    const modal = document.getElementById('modal-excluir-colaborador');
    if (modal) modal.hidden = false;
}

async function carregarLixeira() {
    if (!podeEditar()) return;
    try {
        const linhas = await chamarRpcRh('lixeira', {});
        estadoRh.lixeira = Array.isArray(linhas) ? linhas : [];
    } catch (erro) {
        console.warn('[RH] Falha ao ler a lixeira:', erro);
        mostrarAvisoErro(mensagemDeErro(erro, 'ler a lixeira'), { tentarDeNovo: true });
    }
    renderizarLixeira();
}

function renderizarLixeira() {
    const listaEl = document.getElementById('lixeira-lista-container');
    const totalEl = document.getElementById('lixeira-total-badge');
    if (totalEl) totalEl.textContent = String(estadoRh.lixeira.length);
    if (!listaEl) return;
    if (estadoRh.lixeira.length === 0) {
        listaEl.innerHTML = '<p class="rh-vazio-msg">A lixeira está vazia</p>';
        return;
    }
    listaEl.innerHTML = estadoRh.lixeira.map((c) => `
        <div class="rh-item-lista" data-lixeira-id="${escapeHtml(c.id)}">
            <div class="item-info-principal">
                <span class="item-titulo">${escapeHtml(c.nome)}</span>
                <span class="item-sub">Excluído em ${escapeHtml(formatarDataHora(c.excluido_em))} por ${escapeHtml(c.excluido_por_email || 'usuário sem e-mail')}</span>
            </div>
            <div class="lixeira-item-acoes">
                <span class="rh-badge badge-neutro">${escapeHtml(c.vinculo || '')}</span>
                <button type="button" class="rh-btn rh-btn-pequeno rh-btn-suave" data-so-edicao
                    data-acao="restaurar-colaborador" data-colab-id="${escapeHtml(c.id)}">
                    Restaurar
                </button>
            </div>
        </div>
    `).join('');
}

async function restaurarColaborador(colabId) {
    const item = estadoRh.lixeira.find((c) => c.id === colabId);
    const ok = await executarGravacao(() => chamarRpcRh('restaurar_colaborador', { p_id: colabId }));
    if (!ok) return;
    await carregarLixeira();
    exibirToast(`${item ? item.nome : 'Colaborador'} restaurado.`);
}

/* ============================================================================
   TELA 3: PROCESSOS E CHECKLIST DE ETAPAS
   ============================================================================ */
function renderizarProcessos() {
    const listaEl = document.getElementById('processos-lista-container');
    const detalheEl = document.getElementById('processo-detalhe-container');
    const totalBadge = document.getElementById('proc-total-badge');

    const filtro = estadoRh.filtroTipoProcesso;
    const filtrados = estadoRh.processos.filter((p) => {
        if (!filtro) return true;
        if (filtro === 'desligamentos') {
            return p.modeloId === 'rescisao_clt' || p.modeloId === 'distrato_pj';
        }
        return p.modeloId === filtro;
    });

    if (totalBadge) totalBadge.textContent = String(filtrados.length);

    if (listaEl) {
        if (filtrados.length === 0) {
            listaEl.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        } else {
            listaEl.innerHTML = filtrados.map((proc) => {
                const colab = estadoRh.colaboradores.find((c) => c.id === proc.colaboradorId);
                const nomeColab = colab ? colab.nome : 'Colaborador';
                const prog = calcularProgressoProcesso(proc);
                const selecionado = proc.id === estadoRh.processoSelecionadoId;

                return `
                    <div class="rh-item-lista ${selecionado ? 'selecionado' : ''}"
                         data-acao="selecionar-processo"
                         data-proc-id="${escapeHtml(proc.id)}">
                        <div class="item-info-principal">
                            <span class="item-titulo">${escapeHtml(nomeColab)}</span>
                            <span class="item-sub">${escapeHtml(proc.modeloNome)} • ${escapeHtml(obterTextoProximaAcao(proc))}</span>
                        </div>
                        <div class="item-badges">
                            <span class="rh-badge ${prog.pct === 100 && prog.total > 0 ? 'badge-verde' : 'badge-violeta'}">
                                ${escapeHtml(prog.texto)}
                            </span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    if (!detalheEl) return;

    const procAtivo = estadoRh.processos.find((p) => p.id === estadoRh.processoSelecionadoId) ||
                      filtrados[0] || null;

    if (!procAtivo) {
        detalheEl.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        return;
    }

    estadoRh.processoSelecionadoId = procAtivo.id;
    const colab = estadoRh.colaboradores.find((c) => c.id === procAtivo.colaboradorId);
    const nomeColab = colab ? colab.nome : 'Colaborador';
    const prog = calcularProgressoProcesso(procAtivo);
    const textoProximaAcao = obterTextoProximaAcao(procAtivo);

    detalheEl.innerHTML = `
        <div class="checklist-resumo-box">
            <div class="progresso-linha-topo">
                <div>
                    <h4 class="item-titulo" style="font-size: 1.05rem;">
                        ${escapeHtml(procAtivo.modeloNome)} — ${escapeHtml(nomeColab)}
                    </h4>
                    <span class="item-sub">Vínculo: ${escapeHtml(colab ? colab.vinculo : '—')}</span>
                </div>
                <div class="progresso-acoes">
                    <span class="progresso-texto-forte" id="processo-progresso-texto">${escapeHtml(prog.texto)}</span>
                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                            data-acao="imprimir-processo"
                            data-proc-id="${escapeHtml(procAtivo.id)}"
                            title="Imprimir checklist deste processo">
                        Imprimir
                    </button>
                </div>
            </div>

            <div class="progresso-trilha" role="progressbar"
                 aria-valuenow="${prog.pct}" aria-valuemin="0" aria-valuemax="100">
                <div class="progresso-preenchimento" style="width: ${prog.pct}%;"></div>
            </div>

            <div class="proxima-acao-banner" id="processo-proxima-acao">
                ${escapeHtml(textoProximaAcao)}
            </div>

            <!-- Adicionar nova etapa ao processo -->
            <form class="nova-etapa-form-linha" data-so-edicao data-form="adicionar-etapa-processo" data-proc-id="${escapeHtml(procAtivo.id)}">
                <input type="text" class="rh-input input-nova-etapa-proc"
                       placeholder="Nova etapa neste processo..." required aria-label="Nome da nova etapa">
                <input type="text" class="rh-input input-resp-nova-etapa-proc"
                       placeholder="Responsável (opcional)" style="max-width: 175px;" aria-label="Responsável da etapa">
                <input type="date" class="rh-input input-prazo-nova-etapa-proc"
                       style="max-width: 155px;" aria-label="Prazo da etapa">
                <button type="submit" class="rh-btn rh-btn-suave">+ Adicionar etapa</button>
            </form>
        </div>

        <div class="etapas-checklist-lista" style="display: flex; flex-direction: column; gap: 0.85rem;">
            ${procAtivo.etapas.length === 0 ? `
                <p class="rh-vazio-msg">
                    ${procAtivo.modeloId === 'admissao_clt'
                        ? 'Aguardando a lista dos 19 passos do RH. Você pode adicionar etapas acima.'
                        : 'Nenhum registro ainda'}
                </p>
            ` : procAtivo.etapas.map((etapa, idx) => renderizarCardEtapaProcesso(procAtivo, etapa, idx)).join('')}
        </div>
    `;
}

function renderizarCardEtapaProcesso(proc, etapa, idx) {
    const diasPrazo = etapa.prazo ? diferencaDiasParaHoje(etapa.prazo) : null;
    const prazoVencido = !etapa.concluida && diasPrazo !== null && diasPrazo < 0;
    const editandoNome = podeEditar() && estadoRh.etapaEditandoNomeId === etapa.id;
    const somenteLeitura = podeEditar() ? '' : 'disabled';

    return `
        <article class="etapa-card ${etapa.concluida ? 'etapa-concluida' : ''} ${prazoVencido ? 'etapa-vencida' : ''}"
                 data-etapa-id="${escapeHtml(etapa.id)}">
            <div class="etapa-topo">
                <div class="etapa-titulo-grupo">
                    <span class="etapa-ordem-num">${idx + 1}</span>
                    ${editandoNome ? `
                        <div class="obs-form-linha" style="flex: 1;">
                            <input type="text" class="rh-input input-renomear-etapa-proc"
                                   id="input-renomear-${escapeHtml(etapa.id)}"
                                   value="${escapeHtml(etapa.nome)}" aria-label="Novo nome da etapa">
                            <button type="button" class="rh-btn rh-btn-pequeno rh-btn-primario"
                                    data-acao="salvar-nome-etapa-proc"
                                    data-proc-id="${escapeHtml(proc.id)}"
                                    data-etapa-id="${escapeHtml(etapa.id)}">
                                Salvar
                            </button>
                            <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                    data-acao="cancelar-nome-etapa-proc">
                                Cancelar
                            </button>
                        </div>
                    ` : `
                        <span class="etapa-nome-texto">${escapeHtml(etapa.nome)}</span>
                        ${etapa.concluida
                            ? '<span class="rh-badge badge-verde">Concluída</span>'
                            : (prazoVencido ? '<span class="rh-badge badge-vermelho">Prazo vencido</span>' : '')}
                    `}
                </div>

                <div class="etapa-acoes-topo">
                    <button type="button"
                            class="rh-btn rh-btn-pequeno ${etapa.concluida ? 'rh-btn-neutro' : 'rh-btn-verde'}"
                            data-acao="alternar-conclusao-etapa"
                            data-proc-id="${escapeHtml(proc.id)}"
                            data-etapa-id="${escapeHtml(etapa.id)}">
                        ${etapa.concluida ? 'Reabrir' : 'Concluir'}
                    </button>
                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro" data-so-edicao
                            data-acao="iniciar-renomear-etapa-proc"
                            data-etapa-id="${escapeHtml(etapa.id)}"
                            title="Renomear etapa">
                        Renomear
                    </button>
                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro" data-so-edicao
                            data-acao="mover-etapa-proc"
                            data-proc-id="${escapeHtml(proc.id)}"
                            data-etapa-id="${escapeHtml(etapa.id)}"
                            data-direcao="-1"
                            ${idx === 0 ? 'disabled' : ''}
                            title="Mover etapa para cima">
                        &uarr;
                    </button>
                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro" data-so-edicao
                            data-acao="mover-etapa-proc"
                            data-proc-id="${escapeHtml(proc.id)}"
                            data-etapa-id="${escapeHtml(etapa.id)}"
                            data-direcao="1"
                            ${idx === proc.etapas.length - 1 ? 'disabled' : ''}
                            title="Mover etapa para baixo">
                        &darr;
                    </button>
                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-perigo" data-so-edicao
                            data-acao="remover-etapa-proc"
                            data-proc-id="${escapeHtml(proc.id)}"
                            data-etapa-id="${escapeHtml(etapa.id)}"
                            title="Remover etapa">
                        Remover
                    </button>
                </div>
            </div>

            <!-- Campos de Responsável e Prazo -->
            <div class="etapa-campos-grid">
                <div class="etapa-campo-item">
                    <label>Responsável</label>
                    <input type="text" class="rh-input input-etapa-responsavel"
                           data-proc-id="${escapeHtml(proc.id)}"
                           data-etapa-id="${escapeHtml(etapa.id)}"
                           value="${escapeHtml(etapa.responsavel || '')}"
                           placeholder="Ex.: DP, RH, Gestor..." ${somenteLeitura}>
                </div>
                <div class="etapa-campo-item">
                    <label>Prazo</label>
                    <input type="date"
                           class="rh-input input-etapa-prazo ${prazoVencido ? 'prazo-vencido-input' : ''}"
                           data-proc-id="${escapeHtml(proc.id)}"
                           data-etapa-id="${escapeHtml(etapa.id)}"
                           value="${escapeHtml(etapa.prazo || '')}" ${somenteLeitura}>
                    ${prazoVencido ? `
                        <span class="prazo-vencido-texto">
                            Prazo vencido (${escapeHtml(formatarDataBr(etapa.prazo))})
                        </span>
                    ` : ''}
                </div>
            </div>

            <!-- Histórico de Observações (só insert; autor e hora gravados pelo servidor) -->
            <div class="etapa-subsecao">
                <span class="etapa-subsecao-titulo">
                    Observações em histórico (${(etapa.observacoes || []).length})
                </span>
                ${(etapa.observacoes && etapa.observacoes.length > 0) ? `
                    <div class="obs-historico-lista">
                        ${etapa.observacoes.map((obs) => `
                            <div class="obs-historico-item">
                                <div class="obs-meta">
                                    ${escapeHtml(obs.autor)} • ${escapeHtml(obs.dataHora)}
                                </div>
                                <div>${escapeHtml(obs.texto)}</div>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                <form class="obs-form-linha" data-form="adicionar-observacao-etapa"
                      data-proc-id="${escapeHtml(proc.id)}"
                      data-etapa-id="${escapeHtml(etapa.id)}">
                    <input type="text" class="rh-input input-nova-obs"
                           placeholder="Registrar observação no histórico..." required
                           aria-label="Nova observação da etapa">
                    <button type="submit" class="rh-btn rh-btn-pequeno rh-btn-suave">
                        Adicionar observação
                    </button>
                </form>
            </div>

            <!-- Anexos: arquivo no bucket privado; "Abrir" gera link assinado de 60 s -->
            <div class="etapa-subsecao">
                <span class="etapa-subsecao-titulo">
                    Anexos (${etapa.anexos.length + etapa.anexosAntigos.length})
                </span>
                ${etapa.anexos.length > 0 ? `
                    <ul class="anexos-lista">
                        ${etapa.anexos.map((anexo) => `
                            <li class="anexo-item">
                                <div class="anexo-info">
                                    <span class="anexo-nome">📎 ${escapeHtml(anexo.nome)}</span>
                                    <span class="anexo-meta">
                                        ${escapeHtml(formatarTamanho(anexo.tamanho))} • enviado por
                                        ${escapeHtml(anexo.enviadoPor)} em ${escapeHtml(anexo.enviadoEm)}
                                    </span>
                                </div>
                                <div class="anexo-acoes">
                                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-suave"
                                            data-acao="abrir-anexo"
                                            data-proc-id="${escapeHtml(proc.id)}"
                                            data-etapa-id="${escapeHtml(etapa.id)}"
                                            data-anexo-id="${escapeHtml(anexo.id)}">
                                        Abrir
                                    </button>
                                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-perigo" data-so-edicao
                                            data-acao="remover-anexo"
                                            data-proc-id="${escapeHtml(proc.id)}"
                                            data-etapa-id="${escapeHtml(etapa.id)}"
                                            data-anexo-id="${escapeHtml(anexo.id)}">
                                        Remover
                                    </button>
                                </div>
                            </li>
                        `).join('')}
                    </ul>
                ` : ''}
                ${etapa.anexosAntigos.length > 0 ? `
                    <div class="anexos-chips-lista">
                        ${etapa.anexosAntigos.map((nomeArq) => `
                            <span class="anexo-chip anexo-antigo">
                                📎 ${escapeHtml(nomeArq)}
                                <em>registro antigo, sem arquivo</em>
                            </span>
                        `).join('')}
                    </div>
                ` : ''}
                ${estadoRh.enviosAnexo[etapa.id] ? htmlBarraEnvio(estadoRh.enviosAnexo[etapa.id]) : ''}
                <label class="label-upload-anexo" data-so-edicao>
                    <span>📎 Anexar</span>
                    <small>PDF, JPG ou PNG, até 10 MB</small>
                    <input type="file" class="input-anexo-etapa" hidden
                           accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                           data-proc-id="${escapeHtml(proc.id)}"
                           data-etapa-id="${escapeHtml(etapa.id)}">
                </label>
            </div>
        </article>
    `;
}

function htmlBarraEnvio(texto) {
    return `
        <div class="anexo-envio" role="status" aria-live="polite">
            <span class="anexo-envio-texto">${escapeHtml(texto)}</span>
            <div class="anexo-envio-barra"><span></span></div>
        </div>
    `;
}

/* ============================================================================
   ANEXOS: ENVIO, ABRIR (LINK ASSINADO) E REMOVER (ativo = false)
   ============================================================================ */
function storageAnexos() {
    const cliente = window.supabaseClient;
    if (!cliente || !cliente.storage) throw new Error('Cliente Supabase indisponível.');
    return cliente.storage.from(BUCKET_ANEXOS);
}

// Tipo pelo que o navegador informa; se vier vazio, pela extensão do nome
function tipoDoAnexo(arquivo) {
    if (arquivo.type) return EXTENSAO_POR_TIPO[arquivo.type] ? arquivo.type : '';
    const extensao = String(arquivo.name || '').split('.').pop().toLowerCase();
    return TIPO_POR_EXTENSAO[extensao] || '';
}

// Mensagem de recusa antes de enviar (ou '' se o arquivo pode ir)
function recusaDoAnexo(arquivo) {
    const nome = arquivo.name || 'arquivo';
    if (!tipoDoAnexo(arquivo)) {
        return `"${nome}" não foi anexado: só são aceitos arquivos PDF, JPG ou PNG.`;
    }
    if (arquivo.size > LIMITE_ANEXO_BYTES) {
        return `"${nome}" tem ${formatarTamanho(arquivo.size)} e não foi anexado: o limite é 10 MB por arquivo.`;
    }
    if (arquivo.size === 0) {
        return `"${nome}" está vazio e não foi anexado.`;
    }
    return '';
}

// Caminho gerado aqui (<processo>/<etapa>/<uuid>.<ext>); o nome digitado vai só para nome_original
async function enviarAnexo(proc, etapa, arquivo) {
    const tipo = tipoDoAnexo(arquivo);
    const caminho = `${proc.id}/${etapa.id}/${crypto.randomUUID()}.${EXTENSAO_POR_TIPO[tipo]}`;
    const { error } = await storageAnexos().upload(caminho, arquivo, {
        contentType: tipo,
        upsert: false,
        cacheControl: '3600'
    });
    if (error) throw error;
    await inserirRh('anexos', {
        etapa_id: etapa.id,
        caminho,
        nome_original: String(arquivo.name || '').trim().slice(0, 255) || 'arquivo',
        tipo,
        tamanho: arquivo.size
    });
}

function anexarArquivo(input) {
    const etapa = acharEtapa(input);
    const proc = estadoRh.processos.find((p) => p.id === input.getAttribute('data-proc-id'));
    const arquivo = (input.files || [])[0];
    input.value = '';
    if (!etapa || !proc || !arquivo) return;

    const recusa = recusaDoAnexo(arquivo);
    if (recusa) {
        mostrarAvisoErro(recusa);
        return;
    }

    // Barra de envio no card (o supabase-js não informa a porcentagem)
    const textoBarra = `Enviando "${arquivo.name}" (${formatarTamanho(arquivo.size)})...`;
    estadoRh.enviosAnexo[etapa.id] = textoBarra;
    const label = input.closest('.label-upload-anexo');
    if (label) label.insertAdjacentHTML('beforebegin', htmlBarraEnvio(textoBarra));

    executarGravacao(async () => {
        try {
            await enviarAnexo(proc, etapa, arquivo);
        } finally {
            delete estadoRh.enviosAnexo[etapa.id];
        }
    }).then((ok) => {
        if (ok) return;
        // Deu erro: o aviso fica na tela e a barra some (sem redesenhar o resto)
        document.querySelectorAll(`.etapa-card[data-etapa-id="${CSS.escape(etapa.id)}"] .anexo-envio`)
            .forEach((barra) => barra.remove());
    });
}

// Abre a aba já no clique (senão o navegador bloqueia) e só depois põe o link assinado nela
async function abrirAnexo(anexo) {
    const janela = window.open('', '_blank');
    try {
        const { data, error } = await storageAnexos().createSignedUrl(anexo.caminho, SEGUNDOS_LINK_ANEXO);
        if (error) throw error;
        if (!data || !data.signedUrl) throw new Error('Link do anexo não foi gerado.');
        if (janela) {
            janela.opener = null;
            janela.location.replace(data.signedUrl);
        } else {
            window.open(data.signedUrl, '_blank', 'noopener');
        }
    } catch (erro) {
        if (janela) janela.close();
        console.warn('[RH] Falha ao abrir anexo:', erro);
        mostrarAvisoErro(mensagemDeErro(erro, 'abrir o anexo'));
    }
}

/* ============================================================================
   TELA 4: MODELOS DE ETAPAS (EDITÁVEIS NA TELA)
   ============================================================================ */
function renderizarModelos() {
    const idModelo = estadoRh.modeloSelecionadoId || 'rescisao_clt';
    const modelo = estadoRh.modelos[idModelo];
    if (!modelo) return;

    const tituloEl = document.getElementById('modelo-editor-titulo');
    const contagemEl = document.getElementById('modelo-editor-contagem');
    const containerEl = document.getElementById('modelo-editor-container');

    if (tituloEl) tituloEl.textContent = `Modelo: ${modelo.nome}`;
    if (contagemEl) contagemEl.textContent = `${modelo.etapas.length} etapa(s)`;

    document.querySelectorAll('[data-modelo-id]').forEach((btn) => {
        btn.classList.toggle('ativo', btn.getAttribute('data-modelo-id') === idModelo);
    });

    if (!containerEl) return;

    const avisoAdmissao = (idModelo === 'admissao_clt' && modelo.etapas.length === 0)
        ? `<div class="modelo-aviso-19-passos">Aguardando a lista dos 19 passos do RH</div>`
        : '';

    containerEl.innerHTML = `
        ${avisoAdmissao}

        <form class="nova-etapa-form-linha" id="form-adicionar-etapa-modelo" data-so-edicao data-modelo-id="${escapeHtml(idModelo)}">
            <input type="text" id="input-nova-etapa-modelo" class="rh-input"
                   placeholder="Digite o nome de uma nova etapa para ${escapeHtml(modelo.nome)}..." required>
            <button type="submit" class="rh-btn rh-btn-primario">+ Adicionar etapa ao modelo</button>
        </form>

        <div style="display: flex; flex-direction: column; gap: 8px;">
            ${modelo.etapas.length === 0 ? `
                <p class="rh-vazio-msg">Nenhum registro ainda</p>
            ` : modelo.etapas.map((etapaModelo, idx) => {
                const nomeEtapa = etapaModelo.nome;
                const editando = podeEditar() && estadoRh.modeloIndexEditando === `${idModelo}:${idx}`;
                return `
                    <div class="modelo-etapa-linha">
                        <div class="etapa-titulo-grupo">
                            <span class="etapa-ordem-num">${idx + 1}</span>
                            ${editando ? `
                                <div class="obs-form-linha" style="flex: 1;">
                                    <input type="text" class="rh-input"
                                           id="input-renomear-modelo-${idx}"
                                           value="${escapeHtml(nomeEtapa)}">
                                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-primario"
                                            data-acao="salvar-etapa-modelo"
                                            data-modelo-id="${escapeHtml(idModelo)}"
                                            data-idx="${idx}">
                                        Salvar
                                    </button>
                                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                            data-acao="cancelar-etapa-modelo">
                                        Cancelar
                                    </button>
                                </div>
                            ` : `
                                <span class="etapa-nome-texto">${escapeHtml(nomeEtapa)}</span>
                            `}
                        </div>
                        <div class="etapa-acoes-topo" data-so-edicao>
                            <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                    data-acao="iniciar-renomear-modelo"
                                    data-modelo-id="${escapeHtml(idModelo)}"
                                    data-idx="${idx}">
                                Renomear
                            </button>
                            <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                    data-acao="mover-etapa-modelo"
                                    data-modelo-id="${escapeHtml(idModelo)}"
                                    data-idx="${idx}"
                                    data-direcao="-1"
                                    ${idx === 0 ? 'disabled' : ''}>
                                &uarr;
                            </button>
                            <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                    data-acao="mover-etapa-modelo"
                                    data-modelo-id="${escapeHtml(idModelo)}"
                                    data-idx="${idx}"
                                    data-direcao="1"
                                    ${idx === modelo.etapas.length - 1 ? 'disabled' : ''}>
                                &darr;
                            </button>
                            <button type="button" class="rh-btn rh-btn-pequeno rh-btn-perigo"
                                    data-acao="remover-etapa-modelo"
                                    data-modelo-id="${escapeHtml(idModelo)}"
                                    data-idx="${idx}">
                                Remover
                            </button>
                        </div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

/* ============================================================================
   TELA 5: AGENDA (POR DATA COM FILTRO POR MÊS)
   ============================================================================ */
function renderizarAgenda() {
    const selectMes = document.getElementById('agenda-filtro-mes');
    const selectOrigem = document.getElementById('agenda-filtro-origem');
    const container = document.getElementById('agenda-lista-container');
    const badgeTotal = document.getElementById('agenda-total-badge');

    const todosItens = coletarItensAgenda();
    const mesSelecionadoAntes = selectMes ? selectMes.value : '';
    const origemSelecionada = selectOrigem ? selectOrigem.value : '';

    // Popula opções de mês com base nos prazos cadastrados
    if (selectMes) {
        const mesesUnicos = Array.from(new Set(todosItens.map((i) => i.mesAno))).sort();
        selectMes.innerHTML = `<option value="">Todos os meses</option>` +
            mesesUnicos.map((ym) => (
                `<option value="${escapeHtml(ym)}" ${ym === mesSelecionadoAntes ? 'selected' : ''}>${escapeHtml(nomeMesAno(ym))}</option>`
            )).join('');
    }

    const mesAtivo = selectMes ? selectMes.value : '';
    const filtrados = todosItens.filter((item) => {
        if (mesAtivo && item.mesAno !== mesAtivo) return false;
        if (origemSelecionada && item.origem !== origemSelecionada) return false;
        return true;
    });

    if (badgeTotal) badgeTotal.textContent = String(filtrados.length);
    if (!container) return;

    if (filtrados.length === 0) {
        container.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        return;
    }

    container.innerHTML = filtrados.map((item) => {
        let statusBadge = '<span class="rh-badge badge-violeta">Programado</span>';
        if (item.concluida) {
            statusBadge = '<span class="rh-badge badge-verde">Concluída</span>';
        } else if (item.vencido) {
            statusBadge = '<span class="rh-badge badge-vermelho">Prazo vencido</span>';
        } else if (item.diasRestantes !== null && item.diasRestantes <= 7) {
            statusBadge = `<span class="rh-badge badge-vermelho">Em ${item.diasRestantes}d</span>`;
        } else if (item.diasRestantes !== null && item.diasRestantes <= 15) {
            statusBadge = `<span class="rh-badge badge-laranja">Em ${item.diasRestantes}d</span>`;
        } else if (item.diasRestantes !== null && item.diasRestantes <= 30) {
            statusBadge = `<span class="rh-badge badge-amarelo">Em ${item.diasRestantes}d</span>`;
        }

        const acaoItem = item.processoId ? 'abrir-processo-painel' : 'abrir-colab-painel';
        return `
            <div class="rh-item-lista"
                 data-acao="${acaoItem}"
                 data-proc-id="${escapeHtml(item.processoId || '')}"
                 data-colab-id="${escapeHtml(item.colabId || '')}">
                <div class="item-info-principal">
                    <span class="item-titulo">
                        ${escapeHtml(formatarDataBr(item.dataIso))} — ${escapeHtml(item.titulo)}
                    </span>
                    <span class="item-sub">
                        ${escapeHtml(item.subtitulo)} • Responsável: ${escapeHtml(item.responsavel)}
                    </span>
                </div>
                <div class="item-badges">
                    <span class="rh-badge badge-neutro">
                        ${item.origem === 'exame' ? 'Exame periódico' : 'Etapa'}
                    </span>
                    ${statusBadge}
                </div>
            </div>
        `;
    }).join('');
}

/* ============================================================================
   TELA 6: PRESTADORES PJ (CONTRATO, VALOR E AVISO CONTRATUAL)
   ============================================================================ */
function renderizarPrestadoresPj() {
    const container = document.getElementById('prestadores-lista-container');
    const badgeTotal = document.getElementById('pj-total-badge');
    const prestadores = estadoRh.colaboradores.filter((c) => c.vinculo === 'PJ');

    if (badgeTotal) badgeTotal.textContent = String(prestadores.length);
    if (!container) return;

    if (prestadores.length === 0) {
        container.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        return;
    }

    container.innerHTML = `
        <div class="rh-tabela-wrapper">
            <table class="rh-tabela">
                <thead>
                    <tr>
                        <th>Prestador</th>
                        <th>Início</th>
                        <th>Fim</th>
                        <th>Valor</th>
                        <th>Aviso</th>
                        <th>Situação</th>
                        <th class="th-acoes">Ações</th>
                    </tr>
                </thead>
                <tbody>
                    ${prestadores.map((colab) => {
                        const contrato = colab.contratoPj || null;
                        const sit = situacaoContratoPj(colab);
                        return `
                            <tr>
                                <td data-label="Prestador">
                                    <div class="td-conteudo"><span class="td-principal">${escapeHtml(colab.nome)}</span>
                                    <span class="td-sub">${escapeHtml(colab.cargo)} • ${escapeHtml(colab.setor)}</span></div>
                                </td>
                                <td data-label="Início" class="td-curta">${escapeHtml(formatarDataBr(contrato ? contrato.inicio : ''))}</td>
                                <td data-label="Fim" class="td-curta">${escapeHtml(formatarDataBr(contrato ? contrato.fim : ''))}</td>
                                <td data-label="Valor" class="td-curta">${escapeHtml(formatarMoedaBr(contrato ? contrato.valor : ''))}</td>
                                <td data-label="Aviso" class="td-curta">${contrato && contrato.avisoDias !== null ? `${escapeHtml(contrato.avisoDias)} dia(s)` : '—'}</td>
                                <td data-label="Situação" class="td-curta"><span class="rh-badge ${sit.badgeClasse}">${escapeHtml(sit.rotulo)}</span></td>
                                <td data-label="Ações">
                                    <div class="tabela-acoes" data-so-edicao>
                                        <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                                data-acao="editar-contrato-pj"
                                                data-colab-id="${escapeHtml(colab.id)}">
                                            ${contrato ? 'Editar contrato' : 'Cadastrar contrato'}
                                        </button>
                                        <button type="button" class="rh-btn rh-btn-pequeno rh-btn-perigo"
                                                data-acao="abrir-distrato-pj"
                                                data-colab-id="${escapeHtml(colab.id)}">
                                            Abrir distrato
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

/* ============================================================================
   TELA 7: EXAMES (SST) DE TODOS OS COLABORADORES
   ============================================================================ */
function renderizarExames() {
    const container = document.getElementById('exames-lista-container');
    const badgeTotal = document.getElementById('exames-total-badge');
    const filtroSituacao = estadoRh.filtroExameSituacao;
    const filtroTipo = estadoRh.filtroExameTipo;

    const filtrados = estadoRh.exames
        .map((exame) => ({
            exame,
            sit: situacaoExame(exame),
            colab: estadoRh.colaboradores.find((c) => c.id === exame.colaboradorId) || null
        }))
        .filter(({ exame, sit }) => {
            if (filtroSituacao && sit.chave !== filtroSituacao) return false;
            if (filtroTipo && exame.tipo !== filtroTipo) return false;
            return true;
        })
        .sort((a, b) => (a.exame.vencimento || '9999').localeCompare(b.exame.vencimento || '9999'));

    if (badgeTotal) badgeTotal.textContent = String(filtrados.length);
    if (!container) return;

    if (filtrados.length === 0) {
        container.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        return;
    }

    container.innerHTML = `
        <div class="rh-tabela-wrapper">
            <table class="rh-tabela">
                <thead>
                    <tr>
                        <th>Colaborador</th>
                        <th>Tipo</th>
                        <th>Realização</th>
                        <th>Vencimento</th>
                        <th>Situação</th>
                        <th class="th-acoes">Ações</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtrados.map(({ exame, sit, colab }) => `
                        <tr>
                            <td data-label="Colaborador">
                                <div class="td-conteudo"><span class="td-principal">${escapeHtml(colab ? colab.nome : 'Colaborador')}</span>
                                <span class="td-sub">${escapeHtml(colab ? `${colab.cargo} • ${colab.vinculo}` : '')}</span></div>
                            </td>
                            <td data-label="Tipo">${escapeHtml(TIPOS_EXAME[exame.tipo] || exame.tipo)}</td>
                            <td data-label="Realização" class="td-curta">${escapeHtml(formatarDataBr(exame.dataRealizacao))}</td>
                            <td data-label="Vencimento" class="td-curta">${escapeHtml(formatarDataBr(exame.vencimento))}</td>
                            <td data-label="Situação" class="td-curta"><span class="rh-badge ${sit.badgeClasse}">${escapeHtml(sit.rotulo)}</span></td>
                            <td data-label="Ações">
                                <div class="tabela-acoes" data-so-edicao>
                                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-suave"
                                            data-acao="agendar-exame"
                                            data-colab-id="${escapeHtml(exame.colaboradorId)}">
                                        Agendar
                                    </button>
                                    <button type="button" class="rh-btn rh-btn-pequeno rh-btn-perigo"
                                            data-acao="remover-exame"
                                            data-exame-id="${escapeHtml(exame.id)}">
                                        Remover
                                    </button>
                                </div>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
}

/* ============================================================================
   TELA 8: FÉRIAS DOS COLABORADORES CLT
   ============================================================================ */
function renderizarFerias() {
    const container = document.getElementById('ferias-lista-container');
    const badgeTotal = document.getElementById('ferias-total-badge');
    const clts = estadoRh.colaboradores.filter((c) => c.vinculo === 'CLT');

    if (badgeTotal) badgeTotal.textContent = String(clts.length);
    if (!container) return;

    if (clts.length === 0) {
        container.innerHTML = '<p class="rh-vazio-msg">Nenhum registro ainda</p>';
        return;
    }

    container.innerHTML = `
        <div class="rh-tabela-wrapper">
            <table class="rh-tabela">
                <thead>
                    <tr>
                        <th>Colaborador</th>
                        <th>Período aquisitivo</th>
                        <th>Período concessivo</th>
                        <th>Saldo</th>
                        <th>Programação</th>
                        <th>Situação</th>
                        <th class="th-acoes">Ações</th>
                    </tr>
                </thead>
                <tbody>
                    ${clts.map((colab) => {
                        const ferias = colab.ferias || null;
                        const sit = situacaoFerias(colab);
                        const per = sit.periodos;
                        const programacao = ferias && ferias.programacaoInicio
                            ? `${formatarDataBr(ferias.programacaoInicio)} a ${formatarDataBr(ferias.programacaoFim)}`
                            : '—';
                        return `
                            <tr>
                                <td data-label="Colaborador">
                                    <div class="td-conteudo"><span class="td-principal">${escapeHtml(colab.nome)}</span>
                                    <span class="td-sub">${escapeHtml(colab.cargo)} • Admissão: ${escapeHtml(formatarDataBr(colab.dataAdmissao))}</span></div>
                                </td>
                                <td data-label="Aquisitivo">
                                    ${per ? `${escapeHtml(formatarDataBr(per.aquisitivoInicio))} a ${escapeHtml(formatarDataBr(per.aquisitivoFim))}` : '—'}
                                </td>
                                <td data-label="Concessivo">
                                    ${per ? `${escapeHtml(formatarDataBr(per.concessivoInicio))} a ${escapeHtml(formatarDataBr(per.concessivoFim))}` : '—'}
                                </td>
                                <td data-label="Saldo" class="td-curta">${ferias ? `${escapeHtml(ferias.saldoDias)} dia(s)` : '—'}</td>
                                <td data-label="Programação">${escapeHtml(programacao)}</td>
                                <td data-label="Situação" class="td-curta"><span class="rh-badge ${sit.badgeClasse}">${escapeHtml(sit.rotulo)}</span></td>
                                <td data-label="Ações">
                                    <div class="tabela-acoes" data-so-edicao>
                                        <button type="button" class="rh-btn rh-btn-pequeno rh-btn-neutro"
                                                data-acao="editar-ferias"
                                                data-colab-id="${escapeHtml(colab.id)}">
                                            ${ferias ? 'Editar' : 'Informar férias'}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
}

/* ============================================================================
   IMPRESSÃO DO CHECKLIST DE UM PROCESSO (SEM BARRA LATERAL NEM BOTÕES)
   ============================================================================ */
function imprimirChecklistProcesso(procId) {
    const proc = estadoRh.processos.find((p) => p.id === procId);
    const area = document.getElementById('rh-area-impressao');
    if (!proc || !area) return;

    const colab = estadoRh.colaboradores.find((c) => c.id === proc.colaboradorId);
    const prog = calcularProgressoProcesso(proc);

    area.innerHTML = `
        <header class="impressao-cabecalho">
            <span class="impressao-marca">AJBorges Transportes • Recursos Humanos</span>
            <h1 class="impressao-titulo">${escapeHtml(proc.modeloNome)} — ${escapeHtml(colab ? colab.nome : 'Colaborador')}</h1>
            <p class="impressao-meta">
                Vínculo: ${escapeHtml(colab ? colab.vinculo : '—')} •
                Progresso: ${escapeHtml(prog.texto)} •
                Impresso em ${escapeHtml(formatarDataHora())} por ${escapeHtml(estadoRh.usuarioEmail)}
            </p>
        </header>
        <table class="impressao-tabela">
            <thead>
                <tr>
                    <th>#</th>
                    <th>Etapa</th>
                    <th>Situação</th>
                    <th>Responsável</th>
                    <th>Prazo</th>
                    <th>Observações</th>
                </tr>
            </thead>
            <tbody>
                ${proc.etapas.length === 0 ? `
                    <tr><td colspan="6">Nenhuma etapa cadastrada</td></tr>
                ` : proc.etapas.map((etapa, idx) => {
                    const dias = etapa.prazo ? diferencaDiasParaHoje(etapa.prazo) : null;
                    let situacao = 'Pendente';
                    if (etapa.concluida) situacao = 'Concluída';
                    else if (dias !== null && dias < 0) situacao = 'Prazo vencido';
                    return `
                        <tr>
                            <td>${idx + 1}</td>
                            <td>${escapeHtml(etapa.nome)}</td>
                            <td>${escapeHtml(situacao)}</td>
                            <td>${escapeHtml(etapa.responsavel || 'A definir')}</td>
                            <td>${escapeHtml(formatarDataBr(etapa.prazo))}</td>
                            <td>
                                ${(etapa.observacoes || []).length === 0 ? '—' : etapa.observacoes.map((obs) => `
                                    <div class="impressao-obs">
                                        <span class="impressao-obs-meta">${escapeHtml(obs.autor)} • ${escapeHtml(obs.dataHora)}</span>
                                        ${escapeHtml(obs.texto)}
                                    </div>
                                `).join('')}
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
        <p class="impressao-rodape">Documento gerado a partir dos dados do RH gravados no sistema.</p>
    `;

    document.body.classList.add('rh-imprimindo');
    window.print();
}

function limparImpressao() {
    document.body.classList.remove('rh-imprimindo');
    const area = document.getElementById('rh-area-impressao');
    if (area) area.innerHTML = '';
}

/* ============================================================================
   CRIAÇÃO DE PROCESSOS (MODAL, DISTRATO PJ E AGENDAMENTO DE EXAME)
   ============================================================================ */
// Grava o processo e copia as etapas do modelo (modelo_nome guarda o nome da época)
async function criarProcessoNoBanco(colaboradorId, modeloId, respPadrao = '', prazoBase = '') {
    const modelo = estadoRh.modelos[modeloId];
    if (!colaboradorId || !modelo) throw new Error('colaborador ou modelo não encontrado');

    const [novoProc] = await inserirRh('processos', {
        colaborador_id: colaboradorId,
        modelo_id: modelo.id,
        modelo_nome: modelo.nome
    });
    if (modelo.etapas.length > 0) {
        await inserirRh('etapas', modelo.etapas.map((etapa, idx) => ({
            processo_id: novoProc.id,
            ordem: idx + 1,
            nome: etapa.nome,
            responsavel: respPadrao || null,
            prazo: prazoBase || null
        })));
    }
    return { id: novoProc.id, modeloNome: novoProc.modelo_nome };
}

function abrirProcessoNaTela(procId) {
    estadoRh.processoSelecionadoId = procId;
    estadoRh.filtroTipoProcesso = '';
    document.querySelectorAll('[data-filtro-tipo-proc]').forEach((b) => {
        b.classList.toggle('ativo', b.getAttribute('data-filtro-tipo-proc') === '');
    });
    alternarTelaRh('processos');
}

// Evita duplicar: se já houver processo do mesmo modelo em andamento, abre o existente
async function abrirOuCriarProcesso(colaboradorId, modeloId) {
    const existente = estadoRh.processos.find(
        (p) => p.colaboradorId === colaboradorId && p.modeloId === modeloId && processoEmAndamento(p)
    );
    if (existente) {
        abrirProcessoNaTela(existente.id);
        exibirToast(`Já existe um processo "${existente.modeloNome}" em andamento para este colaborador.`);
        return;
    }
    let novo = null;
    const ok = await executarGravacao(async () => {
        novo = await criarProcessoNoBanco(colaboradorId, modeloId);
    });
    if (!ok) return;
    abrirProcessoNaTela(novo.id);
    exibirToast(`Processo "${novo.modeloNome}" criado.`);
}

// Troca a ordem de dois itens vizinhos (etapas do processo ou do modelo)
async function trocarOrdem(tabela, itemA, itemB) {
    await atualizarRh(tabela, itemA.id, { ordem: itemB.ordem });
    await atualizarRh(tabela, itemB.id, { ordem: itemA.ordem });
}

function proximaOrdem(lista) {
    return lista.reduce((maior, item) => Math.max(maior, item.ordem || 0), 0) + 1;
}

/* ============================================================================
   MODAIS DE CADASTRO (COLABORADOR, PROCESSO, CONTRATO PJ, EXAME E FÉRIAS)
   ============================================================================ */
function preencherSelectColaboradores(selectId, lista, alvoId) {
    const select = document.getElementById(selectId);
    if (!select) return;
    select.innerHTML = lista.map((c) => (
        `<option value="${escapeHtml(c.id)}" ${c.id === alvoId ? 'selected' : ''}>${escapeHtml(c.nome)} (${escapeHtml(c.vinculo)})</option>`
    )).join('');
}

function definirValorCampo(id, valor) {
    const el = document.getElementById(id);
    if (el) el.value = valor === null || valor === undefined ? '' : String(valor);
}

function preencherCamposContratoPj(colabId) {
    const colab = estadoRh.colaboradores.find((c) => c.id === colabId);
    const contrato = colab && colab.contratoPj ? colab.contratoPj : {};
    definirValorCampo('pj-inicio', contrato.inicio);
    definirValorCampo('pj-fim', contrato.fim);
    definirValorCampo('pj-valor', contrato.valor);
    definirValorCampo('pj-aviso', contrato.avisoDias);
}

function abrirModalContratoPj(colabId = '') {
    const prestadores = estadoRh.colaboradores.filter((c) => c.vinculo === 'PJ');
    if (prestadores.length === 0) {
        exibirToast('Cadastre primeiro um colaborador com vínculo PJ.');
        return;
    }
    const alvoId = prestadores.some((c) => c.id === colabId) ? colabId : prestadores[0].id;
    preencherSelectColaboradores('pj-colaborador', prestadores, alvoId);
    preencherCamposContratoPj(alvoId);
    const modal = document.getElementById('modal-contrato-pj');
    if (modal) modal.hidden = false;
}

function abrirModalExame() {
    if (estadoRh.colaboradores.length === 0) {
        exibirToast('Cadastre primeiro um colaborador para registrar o exame.');
        abrirModalColaborador();
        return;
    }
    const form = document.getElementById('form-exame');
    if (form) form.reset();
    preencherSelectColaboradores('exame-colaborador', estadoRh.colaboradores, estadoRh.colaboradorSelecionadoId);
    const modal = document.getElementById('modal-exame');
    if (modal) modal.hidden = false;
}

function preencherCamposFerias(colabId) {
    const colab = estadoRh.colaboradores.find((c) => c.id === colabId);
    const ferias = colab && colab.ferias ? colab.ferias : {};
    definirValorCampo('ferias-aquisitivo-inicio', ferias.aquisitivoInicio);
    definirValorCampo('ferias-saldo', ferias.saldoDias);
    definirValorCampo('ferias-prog-inicio', ferias.programacaoInicio);
    definirValorCampo('ferias-prog-fim', ferias.programacaoFim);
}

function abrirModalFerias(colabId = '') {
    const clts = estadoRh.colaboradores.filter((c) => c.vinculo === 'CLT');
    if (clts.length === 0) {
        exibirToast('Cadastre primeiro um colaborador com vínculo CLT.');
        return;
    }
    const alvoId = clts.some((c) => c.id === colabId) ? colabId : clts[0].id;
    preencherSelectColaboradores('ferias-colaborador', clts, alvoId);
    preencherCamposFerias(alvoId);
    const modal = document.getElementById('modal-ferias');
    if (modal) modal.hidden = false;
}

function abrirModalColaborador() {
    const modal = document.getElementById('modal-colaborador');
    const form = document.getElementById('form-novo-colaborador');
    if (form) form.reset();
    if (modal) modal.hidden = false;
    const inputNome = document.getElementById('colab-nome');
    if (inputNome) setTimeout(() => inputNome.focus(), 40);
}

function abrirModalProcesso(colaboradorPreSelecionadoId = '') {
    if (estadoRh.colaboradores.length === 0) {
        exibirToast('Cadastre primeiro um colaborador para vincular ao processo.');
        abrirModalColaborador();
        return;
    }

    const selectColab = document.getElementById('proc-colaborador');
    if (selectColab) {
        const alvoId = colaboradorPreSelecionadoId || estadoRh.colaboradorSelecionadoId || estadoRh.colaboradores[0].id;
        selectColab.innerHTML = estadoRh.colaboradores.map((c) => (
            `<option value="${escapeHtml(c.id)}" ${c.id === alvoId ? 'selected' : ''}>${escapeHtml(c.nome)} (${escapeHtml(c.vinculo)})</option>`
        )).join('');
    }

    const modal = document.getElementById('modal-processo');
    if (modal) modal.hidden = false;
}

function fecharModalPorId(idModal) {
    const modal = document.getElementById(idModal);
    if (modal) modal.hidden = true;
}

/* ============================================================================
   NAVEGAÇÃO, BARRA LATERAL RECOLHÍVEL E EVENTOS
   ============================================================================ */
const TITULOS_TELAS = {
    painel: 'Painel',
    colaboradores: 'Colaboradores',
    processos: 'Processos',
    prestadores: 'Prestadores PJ',
    exames: 'Exames (SST)',
    ferias: 'Férias',
    modelos: 'Modelos de Etapas',
    agenda: 'Agenda',
    lixeira: 'Lixeira'
};

function alternarTelaRh(viewId) {
    const viewNormalizada = viewId === 'painel-inicial' ? 'painel' : viewId;
    let destino = TITULOS_TELAS[viewNormalizada] ? viewNormalizada : 'painel';
    // Lixeira só para quem edita (rh e admin); o banco também barra
    if (destino === 'lixeira' && !podeEditar()) destino = 'painel';
    estadoRh.abaAtual = destino;

    document.querySelectorAll('#rh-nav-list .nav-link').forEach((link) => {
        link.classList.toggle('active', link.getAttribute('data-view') === destino);
    });

    Object.keys(TITULOS_TELAS).forEach((id) => {
        const sec = document.getElementById(`view-${id}`);
        if (sec) {
            sec.style.display = id === destino ? 'flex' : 'none';
            sec.classList.toggle('active', id === destino);
        }
    });

    const topbarTitulo = document.getElementById('topbar-titulo');
    if (topbarTitulo) topbarTitulo.textContent = TITULOS_TELAS[destino];

    if (typeof window.fecharSidebarMobile === 'function') {
        window.fecharSidebarMobile();
    }
    atualizarTudo();
    if (destino === 'lixeira') carregarLixeira();
}

function inicializarSidebarRecolhivelEMobile() {
    const layout = document.getElementById('rh-app-layout');
    const sidebar = document.getElementById('rh-sidebar');
    const brand = document.getElementById('sidebar-brand');
    const btnToggleDesktop = document.getElementById('btn-toggle-sidebar');
    const btnMobileMenu = document.getElementById('btn-mobile-menu');
    const btnFecharSidebar = document.getElementById('btn-fechar-sidebar');
    const backdrop = document.getElementById('rh-sidebar-backdrop');

    function aplicarEstadoRecolhido(recolhida) {
        estadoRh.sidebarRecolhida = recolhida;
        if (layout) layout.classList.toggle('sidebar-recolhida', recolhida);
        if (sidebar) sidebar.classList.toggle('sidebar-recolhida', recolhida);
        if (brand) {
            brand.setAttribute('aria-expanded', recolhida ? 'false' : 'true');
            brand.setAttribute('aria-label', recolhida ? 'Expandir menu lateral' : 'Recolher menu lateral');
            brand.setAttribute('title', recolhida ? 'Expandir menu lateral' : 'Recolher menu lateral');
        }
    }

    function alternarRecolhimento() {
        // No celular o logo abre e fecha a gaveta; no computador recolhe e lembra a escolha
        if (window.matchMedia('(max-width: 900px)').matches) {
            if (sidebar && sidebar.classList.contains('sidebar-aberta')) fecharSidebarMobile();
            else abrirSidebarMobile();
            return;
        }
        aplicarEstadoRecolhido(!estadoRh.sidebarRecolhida);
        try { localStorage.setItem(CHAVE_SIDEBAR, estadoRh.sidebarRecolhida ? '1' : '0'); } catch (e) { /* só nesta aba */ }
    }

    // Volta como estava (ajborges_sidebar_recolhida_rh)
    let recolhidaAntes = false;
    try { recolhidaAntes = localStorage.getItem(CHAVE_SIDEBAR) === '1'; } catch (e) { /* aberta */ }
    if (recolhidaAntes) aplicarEstadoRecolhido(true);

    if (brand) {
        brand.addEventListener('click', (e) => {
            e.preventDefault();
            alternarRecolhimento();
        });
        brand.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                alternarRecolhimento();
            }
        });
    }

    if (btnToggleDesktop) {
        btnToggleDesktop.addEventListener('click', alternarRecolhimento);
    }

    function abrirSidebarMobile() {
        if (sidebar) sidebar.classList.add('sidebar-aberta');
        if (backdrop) backdrop.classList.add('ativo');
    }

    function fecharSidebarMobile() {
        if (sidebar) sidebar.classList.remove('sidebar-aberta');
        if (backdrop) backdrop.classList.remove('ativo');
    }

    if (btnMobileMenu) btnMobileMenu.addEventListener('click', abrirSidebarMobile);
    if (btnFecharSidebar) btnFecharSidebar.addEventListener('click', fecharSidebarMobile);
    if (backdrop) backdrop.addEventListener('click', fecharSidebarMobile);

    window.fecharSidebarMobile = fecharSidebarMobile;
}

function registrarEventosRh() {
    // Links da barra lateral
    document.querySelectorAll('#rh-nav-list .nav-link[data-view]').forEach((link) => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const view = link.getAttribute('data-view');
            alternarTelaRh(view);
        });
    });

    // Botões do topo e das telas para abrir modais
    document.getElementById('topbar-btn-novo-colab')?.addEventListener('click', abrirModalColaborador);
    document.getElementById('btn-novo-colaborador')?.addEventListener('click', abrirModalColaborador);
    document.getElementById('topbar-btn-novo-proc')?.addEventListener('click', () => abrirModalProcesso());
    document.getElementById('btn-novo-processo')?.addEventListener('click', () => abrirModalProcesso());

    // Cards KPI clicáveis no Painel
    document.querySelectorAll('.rh-kpi-card.kpi-clicavel').forEach((card) => {
        card.addEventListener('click', () => {
            const view = card.getAttribute('data-ir-view');
            const filtroProc = card.getAttribute('data-filtro-proc');
            if (filtroProc !== null) {
                estadoRh.filtroTipoProcesso = filtroProc;
                document.querySelectorAll('[data-filtro-tipo-proc]').forEach((b) => {
                    b.classList.toggle('ativo', b.getAttribute('data-filtro-tipo-proc') === filtroProc);
                });
            }
            if (view) alternarTelaRh(view);
        });
    });

    // Fechamento de modais
    document.querySelectorAll('[data-fechar-modal]').forEach((btn) => {
        btn.addEventListener('click', () => {
            fecharModalPorId(btn.getAttribute('data-fechar-modal'));
        });
    });

    // Confirmação: Excluir colaborador (vai para a Lixeira; nada é apagado)
    document.getElementById('form-excluir-colaborador')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const colabId = document.getElementById('excluir-colab-id')?.value || '';
        const nome = document.getElementById('excluir-colab-nome')?.textContent || 'Colaborador';
        if (!colabId) return;
        const ok = await executarGravacao(() => chamarRpcRh('excluir_colaborador', { p_id: colabId }), { form: e.target });
        if (!ok) return;
        if (estadoRh.colaboradorSelecionadoId === colabId) estadoRh.colaboradorSelecionadoId = null;
        fecharModalPorId('modal-excluir-colaborador');
        renderizarColaboradores();
        exibirToast(`${nome} foi para a Lixeira.`);
    });

    // Submissão: Novo Colaborador
    const formColab = document.getElementById('form-novo-colaborador');
    if (formColab) {
        formColab.addEventListener('submit', async (e) => {
            e.preventDefault();
            const nome = (document.getElementById('colab-nome')?.value || '').trim();
            const cargo = (document.getElementById('colab-cargo')?.value || '').trim();
            const setor = (document.getElementById('colab-setor')?.value || '').trim();
            const vinculo = document.getElementById('colab-vinculo')?.value || 'CLT';
            const situacao = document.getElementById('colab-situacao')?.value || 'Ativo';
            const dataAdmissao = document.getElementById('colab-data-admissao')?.value || '';
            const dataProximoExame = document.getElementById('colab-data-exame')?.value || '';

            if (!nome) return;

            let novoId = null;
            const ok = await executarGravacao(async () => {
                const [novo] = await inserirRh('colaboradores', {
                    nome,
                    cargo: cargo || null,
                    setor: setor || null,
                    vinculo,
                    situacao,
                    data_admissao: dataAdmissao || null,
                    data_proximo_exame: dataProximoExame || null
                });
                novoId = novo.id;
            }, { form: formColab });
            if (!ok) return;

            estadoRh.colaboradorSelecionadoId = novoId;
            fecharModalPorId('modal-colaborador');
            atualizarTudo();
            exibirToast('Colaborador cadastrado.');
        });
    }

    // Submissão: Novo Processo
    const formProc = document.getElementById('form-novo-processo');
    if (formProc) {
        formProc.addEventListener('submit', async (e) => {
            e.preventDefault();
            const colaboradorId = document.getElementById('proc-colaborador')?.value || '';
            const modeloId = document.getElementById('proc-modelo')?.value || 'admissao_clt';
            const respPadrao = (document.getElementById('proc-responsavel-padrao')?.value || '').trim();
            const prazoBase = document.getElementById('proc-prazo-inicial')?.value || '';

            let novoProc = null;
            const ok = await executarGravacao(async () => {
                novoProc = await criarProcessoNoBanco(colaboradorId, modeloId, respPadrao, prazoBase);
            }, { form: formProc });
            if (!ok) return;

            fecharModalPorId('modal-processo');
            abrirProcessoNaTela(novoProc.id);
            exibirToast(`Processo "${novoProc.modeloNome}" criado.`);
        });
    }

    // Prestadores PJ, Exames (SST) e Férias: botões das telas
    document.getElementById('btn-cadastrar-contrato-pj')?.addEventListener('click', () => abrirModalContratoPj());
    document.getElementById('btn-registrar-exame')?.addEventListener('click', abrirModalExame);
    document.getElementById('btn-informar-ferias')?.addEventListener('click', () => abrirModalFerias());
    document.getElementById('pj-colaborador')?.addEventListener('change', (e) => preencherCamposContratoPj(e.target.value));
    document.getElementById('ferias-colaborador')?.addEventListener('change', (e) => preencherCamposFerias(e.target.value));

    // Submissão: Contrato PJ
    document.getElementById('form-contrato-pj')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const colab = estadoRh.colaboradores.find((c) => c.id === document.getElementById('pj-colaborador')?.value);
        const inicio = document.getElementById('pj-inicio')?.value || '';
        const fim = document.getElementById('pj-fim')?.value || '';
        const valor = parseFloat(document.getElementById('pj-valor')?.value || '');
        const avisoDias = parseInt(document.getElementById('pj-aviso')?.value || '', 10);

        if (!colab || !inicio || !fim || Number.isNaN(valor) || Number.isNaN(avisoDias)) return;
        if (fim < inicio) {
            exibirToast('O fim do contrato não pode ser anterior ao início.');
            return;
        }

        const valores = { inicio, fim, valor, aviso_dias: avisoDias };
        const ok = await executarGravacao(() => (colab.contratoPj
            ? atualizarRh('contratos_pj', colab.contratoPj.id, valores)
            : inserirRh('contratos_pj', { colaborador_id: colab.id, ...valores })
        ), { form: e.target });
        if (!ok) return;

        fecharModalPorId('modal-contrato-pj');
        exibirToast('Contrato PJ salvo.');
    });

    // Submissão: Exame (SST)
    document.getElementById('form-exame')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const colaboradorId = document.getElementById('exame-colaborador')?.value || '';
        const tipo = document.getElementById('exame-tipo')?.value || '';
        const dataRealizacao = document.getElementById('exame-data-realizacao')?.value || '';
        const vencimento = document.getElementById('exame-vencimento')?.value || '';

        if (!colaboradorId || !TIPOS_EXAME[tipo] || !dataRealizacao) return;
        if (vencimento && vencimento < dataRealizacao) {
            exibirToast('O vencimento não pode ser anterior à data de realização.');
            return;
        }

        const ok = await executarGravacao(() => inserirRh('exames', {
            colaborador_id: colaboradorId,
            tipo,
            data_realizacao: dataRealizacao,
            vencimento: vencimento || null
        }), { form: e.target });
        if (!ok) return;

        fecharModalPorId('modal-exame');
        exibirToast('Exame registrado.');
    });

    // Submissão: Férias
    document.getElementById('form-ferias')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const colab = estadoRh.colaboradores.find((c) => c.id === document.getElementById('ferias-colaborador')?.value);
        const aquisitivoInicio = document.getElementById('ferias-aquisitivo-inicio')?.value || '';
        const saldoDias = parseInt(document.getElementById('ferias-saldo')?.value || '', 10);
        const programacaoInicio = document.getElementById('ferias-prog-inicio')?.value || '';
        const programacaoFim = document.getElementById('ferias-prog-fim')?.value || '';

        if (!colab || !aquisitivoInicio || Number.isNaN(saldoDias)) return;
        if (saldoDias < 0 || saldoDias > 30) {
            exibirToast('O saldo de dias deve ficar entre 0 e 30.');
            return;
        }
        if ((programacaoInicio && !programacaoFim) || (!programacaoInicio && programacaoFim)) {
            exibirToast('Informe o início e o fim da programação (ou deixe os dois vazios).');
            return;
        }
        if (programacaoFim && programacaoFim < programacaoInicio) {
            exibirToast('O fim da programação não pode ser anterior ao início.');
            return;
        }

        const valores = {
            aquisitivo_inicio: aquisitivoInicio,
            saldo_dias: saldoDias,
            programacao_inicio: programacaoInicio || null,
            programacao_fim: programacaoFim || null
        };
        const ok = await executarGravacao(() => (colab.ferias
            ? atualizarRh('ferias', colab.ferias.id, valores)
            : inserirRh('ferias', { colaborador_id: colab.id, ...valores })
        ), { form: e.target });
        if (!ok) return;

        fecharModalPorId('modal-ferias');
        exibirToast('Férias salvas.');
    });

    // Filtros da tela Exames (SST)
    document.getElementById('exame-filtro-situacao')?.addEventListener('change', (e) => {
        estadoRh.filtroExameSituacao = e.target.value;
        renderizarExames();
    });
    document.getElementById('exame-filtro-tipo')?.addEventListener('change', (e) => {
        estadoRh.filtroExameTipo = e.target.value;
        renderizarExames();
    });

    window.addEventListener('afterprint', limparImpressao);

    // Busca e filtros de Colaboradores
    ['colab-busca', 'colab-filtro-vinculo', 'colab-filtro-situacao'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', renderizarColaboradores);
            el.addEventListener('change', renderizarColaboradores);
        }
    });

    // Filtros de tipo de Processo
    document.querySelectorAll('[data-filtro-tipo-proc]').forEach((btn) => {
        btn.addEventListener('click', () => {
            estadoRh.filtroTipoProcesso = btn.getAttribute('data-filtro-tipo-proc') || '';
            document.querySelectorAll('[data-filtro-tipo-proc]').forEach((b) => {
                b.classList.toggle('ativo', b === btn);
            });
            renderizarProcessos();
        });
    });

    // Abas de escolha de Modelo na tela Modelos
    document.querySelectorAll('[data-modelo-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            estadoRh.modeloSelecionadoId = btn.getAttribute('data-modelo-id') || 'rescisao_clt';
            estadoRh.modeloIndexEditando = null;
            renderizarModelos();
        });
    });

    // Filtros da Agenda
    ['agenda-filtro-mes', 'agenda-filtro-origem'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', renderizarAgenda);
    });

    // Delegação global de cliques para ações dinâmicas
    document.addEventListener('click', (e) => {
        const btnAcao = e.target.closest('[data-acao]');
        if (!btnAcao) return;

        const acao = btnAcao.getAttribute('data-acao');

        if (acao === 'selecionar-colaborador') {
            estadoRh.colaboradorSelecionadoId = btnAcao.getAttribute('data-colab-id');
            renderizarColaboradores();
        } else if (acao === 'excluir-colaborador') {
            abrirModalExcluirColaborador(btnAcao.getAttribute('data-colab-id') || '');
        } else if (acao === 'restaurar-colaborador') {
            restaurarColaborador(btnAcao.getAttribute('data-colab-id') || '');
        } else if (acao === 'novo-processo-para-colab') {
            abrirModalProcesso(btnAcao.getAttribute('data-colab-id') || '');
        } else if (acao === 'selecionar-processo') {
            estadoRh.processoSelecionadoId = btnAcao.getAttribute('data-proc-id');
            renderizarProcessos();
        } else if (acao === 'abrir-processo-painel') {
            const procId = btnAcao.getAttribute('data-proc-id');
            if (procId) {
                estadoRh.processoSelecionadoId = procId;
                estadoRh.filtroTipoProcesso = '';
                alternarTelaRh('processos');
            }
        } else if (acao === 'abrir-colab-painel') {
            const colabId = btnAcao.getAttribute('data-colab-id');
            if (colabId) {
                estadoRh.colaboradorSelecionadoId = colabId;
                alternarTelaRh('colaboradores');
            }
        } else if (acao === 'ir-tela') {
            const view = btnAcao.getAttribute('data-view');
            if (view) alternarTelaRh(view);
        } else if (acao === 'editar-contrato-pj') {
            abrirModalContratoPj(btnAcao.getAttribute('data-colab-id') || '');
        } else if (acao === 'abrir-distrato-pj') {
            abrirOuCriarProcesso(btnAcao.getAttribute('data-colab-id') || '', 'distrato_pj');
        } else if (acao === 'agendar-exame') {
            abrirOuCriarProcesso(btnAcao.getAttribute('data-colab-id') || '', 'exame_periodico');
        } else if (acao === 'remover-exame') {
            const exameId = btnAcao.getAttribute('data-exame-id');
            if (exameId) executarGravacao(() => atualizarRh('exames', exameId, { ativo: false }));
        } else if (acao === 'editar-ferias') {
            abrirModalFerias(btnAcao.getAttribute('data-colab-id') || '');
        } else if (acao === 'imprimir-processo') {
            imprimirChecklistProcesso(btnAcao.getAttribute('data-proc-id') || '');
        } else if (acao === 'alternar-conclusao-etapa') {
            const etapa = acharEtapa(btnAcao);
            if (etapa) executarGravacao(() => atualizarRh('etapas', etapa.id, { concluida: !etapa.concluida }));
        } else if (acao === 'iniciar-renomear-etapa-proc') {
            estadoRh.etapaEditandoNomeId = btnAcao.getAttribute('data-etapa-id');
            renderizarProcessos();
        } else if (acao === 'cancelar-nome-etapa-proc') {
            estadoRh.etapaEditandoNomeId = null;
            renderizarProcessos();
        } else if (acao === 'salvar-nome-etapa-proc') {
            const etapa = acharEtapa(btnAcao);
            const input = document.getElementById(`input-renomear-${btnAcao.getAttribute('data-etapa-id')}`);
            const novoNome = (input?.value || '').trim();
            if (etapa && novoNome) {
                executarGravacao(() => atualizarRh('etapas', etapa.id, { nome: novoNome })).then((ok) => {
                    if (!ok) return;
                    estadoRh.etapaEditandoNomeId = null;
                    renderizarProcessos();
                });
            }
        } else if (acao === 'mover-etapa-proc') {
            const proc = estadoRh.processos.find((p) => p.id === btnAcao.getAttribute('data-proc-id'));
            const dir = parseInt(btnAcao.getAttribute('data-direcao') || '0', 10);
            if (proc) {
                const idx = proc.etapas.findIndex((et) => et.id === btnAcao.getAttribute('data-etapa-id'));
                const destino = idx + dir;
                if (idx >= 0 && destino >= 0 && destino < proc.etapas.length) {
                    executarGravacao(() => trocarOrdem('etapas', proc.etapas[idx], proc.etapas[destino]));
                }
            }
        } else if (acao === 'remover-etapa-proc') {
            const etapa = acharEtapa(btnAcao);
            if (etapa) executarGravacao(() => atualizarRh('etapas', etapa.id, { ativo: false }));
        } else if (acao === 'abrir-anexo' || acao === 'remover-anexo') {
            const etapa = acharEtapa(btnAcao);
            const anexo = etapa?.anexos.find((a) => a.id === btnAcao.getAttribute('data-anexo-id'));
            if (!anexo) return;
            if (acao === 'abrir-anexo') {
                abrirAnexo(anexo);
            } else if (window.confirm(`Remover "${anexo.nome}" desta etapa? O arquivo continua guardado para histórico.`)) {
                // Só marca ativo = false: o arquivo fica no bucket
                executarGravacao(() => atualizarRh('anexos', anexo.id, { ativo: false }));
            }
        } else if (acao === 'iniciar-renomear-modelo') {
            const modId = btnAcao.getAttribute('data-modelo-id');
            const idx = btnAcao.getAttribute('data-idx');
            estadoRh.modeloIndexEditando = `${modId}:${idx}`;
            renderizarModelos();
        } else if (acao === 'cancelar-etapa-modelo') {
            estadoRh.modeloIndexEditando = null;
            renderizarModelos();
        } else if (acao === 'salvar-etapa-modelo') {
            const modId = btnAcao.getAttribute('data-modelo-id');
            const idx = parseInt(btnAcao.getAttribute('data-idx') || '-1', 10);
            const input = document.getElementById(`input-renomear-modelo-${idx}`);
            const novoNome = (input?.value || '').trim();
            const modelo = estadoRh.modelos[modId];
            if (modelo && idx >= 0 && idx < modelo.etapas.length && novoNome) {
                executarGravacao(() => atualizarRh('modelo_etapas', modelo.etapas[idx].id, { nome: novoNome })).then((ok) => {
                    if (!ok) return;
                    estadoRh.modeloIndexEditando = null;
                    renderizarModelos();
                });
            }
        } else if (acao === 'mover-etapa-modelo') {
            const modId = btnAcao.getAttribute('data-modelo-id');
            const idx = parseInt(btnAcao.getAttribute('data-idx') || '-1', 10);
            const dir = parseInt(btnAcao.getAttribute('data-direcao') || '0', 10);
            const modelo = estadoRh.modelos[modId];
            const destino = idx + dir;
            if (modelo && idx >= 0 && destino >= 0 && destino < modelo.etapas.length) {
                executarGravacao(() => trocarOrdem('modelo_etapas', modelo.etapas[idx], modelo.etapas[destino]));
            }
        } else if (acao === 'remover-etapa-modelo') {
            const modId = btnAcao.getAttribute('data-modelo-id');
            const idx = parseInt(btnAcao.getAttribute('data-idx') || '-1', 10);
            const modelo = estadoRh.modelos[modId];
            if (modelo && idx >= 0 && idx < modelo.etapas.length) {
                executarGravacao(() => atualizarRh('modelo_etapas', modelo.etapas[idx].id, { ativo: false }));
            }
        }
    });

    // Submissão de formulários dinâmicos (adicionar etapa no processo, observação no histórico, etapa no modelo)
    document.addEventListener('submit', (e) => {
        const form = e.target;
        if (!form) return;

        const tipoForm = form.getAttribute('data-form');

        if (tipoForm === 'adicionar-etapa-processo') {
            e.preventDefault();
            const procId = form.getAttribute('data-proc-id');
            const nome = (form.querySelector('.input-nova-etapa-proc')?.value || '').trim();
            const responsavel = (form.querySelector('.input-resp-nova-etapa-proc')?.value || '').trim();
            const prazo = form.querySelector('.input-prazo-nova-etapa-proc')?.value || '';
            const proc = estadoRh.processos.find((p) => p.id === procId);

            if (proc && nome) {
                executarGravacao(() => inserirRh('etapas', {
                    processo_id: proc.id,
                    ordem: proximaOrdem(proc.etapas),
                    nome,
                    responsavel: responsavel || null,
                    prazo: prazo || null
                }), { form });
            }
        } else if (tipoForm === 'adicionar-observacao-etapa') {
            e.preventDefault();
            const etapa = acharEtapa(form);
            const texto = (form.querySelector('.input-nova-obs')?.value || '').trim();

            if (etapa && texto) {
                // Só insert: autor, e-mail e hora são gravados pelo servidor
                executarGravacao(() => inserirRh('observacoes', { etapa_id: etapa.id, texto }), { form });
            }
        } else if (form.id === 'form-adicionar-etapa-modelo') {
            e.preventDefault();
            const modId = form.getAttribute('data-modelo-id');
            const input = document.getElementById('input-nova-etapa-modelo');
            const nome = (input?.value || '').trim();
            const modelo = estadoRh.modelos[modId];
            if (modelo && nome) {
                executarGravacao(() => inserirRh('modelo_etapas', {
                    modelo_id: modelo.id,
                    ordem: proximaOrdem(modelo.etapas),
                    nome
                }), { form });
            }
        }
    });

    // Atualização de responsável, prazo e anexo nas etapas
    document.addEventListener('change', (e) => {
        const alvo = e.target;
        if (!alvo) return;

        if (alvo.classList.contains('input-etapa-responsavel')) {
            const etapa = acharEtapa(alvo);
            if (etapa) executarGravacao(() => atualizarRh('etapas', etapa.id, { responsavel: alvo.value.trim() || null }));
        } else if (alvo.classList.contains('input-etapa-prazo')) {
            const etapa = acharEtapa(alvo);
            if (etapa) executarGravacao(() => atualizarRh('etapas', etapa.id, { prazo: alvo.value || null }));
        } else if (alvo.classList.contains('input-anexo-etapa')) {
            anexarArquivo(alvo);
        }
    });
}

// Etapa a partir de um elemento com data-proc-id e data-etapa-id
function acharEtapa(el) {
    const proc = estadoRh.processos.find((p) => p.id === el.getAttribute('data-proc-id'));
    return proc?.etapas.find((et) => et.id === el.getAttribute('data-etapa-id')) || null;
}

/* ============================================================================
   PERFIL DO USUÁRIO E LOGOUT (MANTÉM O LOGIN QUE PROTEGE A PÁGINA)
   ============================================================================ */
function preencherDadosUsuario(usuario) {
    if (!usuario) return;
    estadoRh.usuarioEmail = usuario.email || '';
    estadoRh.usuarioNome = usuario.nome || estadoRh.usuarioEmail.split('@')[0];
    // Rodapé da barra lateral (avatar, e-mail, selo do perfil e Sair): JavaScript/sidebar-padrao.js
    window.ajbSidebar?.iniciar(usuario);
}

let timerToast = null;
function exibirToast(mensagem, duracao = 3200) {
    const toast = document.getElementById('rh-toast');
    if (!toast) return;
    toast.textContent = mensagem;
    toast.classList.add('visivel');
    if (timerToast) clearTimeout(timerToast);
    timerToast = setTimeout(() => {
        toast.classList.remove('visivel');
    }, duracao);
}
window.exibirToast = exibirToast;

/* ============================================================================
   INICIALIZAÇÃO AUTENTICADA
   ============================================================================ */
function configurarAvisoErro() {
    document.getElementById('rh-aviso-erro-fechar')?.addEventListener('click', ocultarAvisoErro);
    document.getElementById('rh-aviso-erro-tentar')?.addEventListener('click', () => {
        ocultarAvisoErro();
        recarregarDados();
    });
}

ajbAoAutenticar(PAPEIS_RH, RH_LOGIN, (usuario) => {
    window.ajbAuth.vigiarSessao(RH_LOGIN);

    estadoRh.papel = usuario.role;
    document.body.classList.toggle('rh-papel-restrito', !podeEditar());

    preencherDadosUsuario(usuario);
    inicializarSidebarRecolhivelEMobile();
    registrarEventosRh();
    configurarAvisoErro();
    atualizarTudo();
    recarregarDados();
});

/**
 * ==========================================================================
 * AJBorges Transportes - Dashboard de Recursos Humanos (RH)
 * Controle de Autenticação (auth.js) e Interações da Interface
 * ==========================================================================
 */

const RH_LOGIN = '/HTML/Login.html#admin';
const HUB_URL = '/HTML/escolhaDashboard.html';

// Configurações e descrições dos módulos "Em breve"
const MODULOS_EM_BREVE = {
    colaboradores: {
        titulo: 'Gestão de Colaboradores',
        tag: 'Base de Pessoal',
        descricao: 'Cadastro unificado de funcionários, histórico funcional, cargos, controle de dependentes, registros de advertências e comprovantes de entrega de EPIs.'
    },
    admissoes: {
        titulo: 'Processo de Admissões',
        tag: 'Onboarding & Contratos',
        descricao: 'Fluxo digital de admissão: envio de links para pré-cadastro de candidatos, conferência de documentação obrigatória, contrato de trabalho e integração inicial.'
    },
    rescisoes: {
        titulo: 'Rescisões e Distratos',
        tag: 'Departamento Pessoal',
        descricao: 'Acompanhamento de avisos prévios, prazos legais de pagamento (Art. 477 da CLT), termo de homologação, baixa na CTPS digital e agendamento de exame demissional.'
    },
    agenda: {
        titulo: 'Agenda Completa do RH',
        tag: 'Calendário Integrado',
        descricao: 'Calendário de rotinas do setor: perícias médicas, audiências, vencimentos de acordos e convenções coletivas (CCT) e reuniões com a diretoria.'
    }
};

/**
 * Controle de Acesso Idêntico à Torre de Controle e Painel Administrativo.
 * Apenas usuários autenticados com papéis 'admin' ou 'diretoria' podem acessar.
 */
ajbAoAutenticar(['admin', 'diretoria'], RH_LOGIN, (usuario) => {
    // Monitoramento contínuo da sessão do Supabase (logout remoto redireciona para login)
    window.ajbAuth.vigiarSessao(RH_LOGIN);

    // Inicializa a interface e preenche dados do usuário autenticado
    preencherDadosUsuario(usuario);
    configurarEventosLogout();
    inicializarNavegacao();
    inicializarSidebarMobile();
});

/**
 * Preenche informações do usuário logado na sidebar e topbar
 */
function preencherDadosUsuario(usuario) {
    const emailEl = document.getElementById('sidebar-user-email');
    const roleEl = document.getElementById('sidebar-user-role');
    const avatarEl = document.getElementById('user-avatar-initials');

    if (usuario) {
        const email = usuario.email || '';
        const role = usuario.role === 'diretoria' ? 'Diretoria Executiva' : 'Administrador';
        const nome = usuario.nome || email.split('@')[0];

        if (emailEl && email) emailEl.textContent = email;
        if (roleEl) roleEl.textContent = role;
        if (avatarEl) {
            // Iniciais para o avatar circular
            const partes = nome.trim().split(/\s+/);
            let iniciais = 'RH';
            if (partes.length >= 2) {
                iniciais = (partes[0][0] + partes[1][0]).toUpperCase();
            } else if (partes.length === 1 && partes[0].length >= 2) {
                iniciais = partes[0].substring(0, 2).toUpperCase();
            }
            avatarEl.textContent = iniciais;
        }
    }
}

/**
 * Configura todos os botões de logout da página para usar o método padrão ajbAuth.sair()
 */
function configurarEventosLogout() {
    const botoesLogout = document.querySelectorAll('.btn-logout-acao');
    botoesLogout.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            window.ajbAuth.sair(RH_LOGIN);
        });
    });
}

/**
 * Gerencia a alternância de telas (Painel Inicial vs. Módulos "Em breve")
 */
function inicializarNavegacao() {
    const navLinks = document.querySelectorAll('.sidebar-nav .nav-link[data-view]');
    const viewPainelInicial = document.getElementById('view-painel-inicial');
    const viewEmBreve = document.getElementById('view-em-breve');
    const topbarTitulo = document.getElementById('topbar-titulo');

    const emBreveTitulo = document.getElementById('em-breve-titulo');
    const emBreveTag = document.getElementById('em-breve-tag');
    const emBreveDescricao = document.getElementById('em-breve-descricao');
    const btnRetornar = document.getElementById('btn-retornar-painel');

    function alternarVisualizacao(viewId) {
        // Atualiza a classe ativa nos links da sidebar
        navLinks.forEach(link => {
            if (link.getAttribute('data-view') === viewId) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });

        if (viewId === 'painel-inicial') {
            if (viewPainelInicial) viewPainelInicial.style.display = 'flex';
            if (viewEmBreve) viewEmBreve.style.display = 'none';
            if (topbarTitulo) topbarTitulo.textContent = 'Painel Inicial';
        } else {
            // Módulos "Em breve"
            const config = MODULOS_EM_BREVE[viewId] || {
                titulo: 'Módulo em Desenvolvimento',
                tag: 'Em breve',
                descricao: 'Esta funcionalidade faz parte do planejamento do RH e estará disponível em breve.'
            };

            if (viewPainelInicial) viewPainelInicial.style.display = 'none';
            if (viewEmBreve) viewEmBreve.style.display = 'flex';
            if (topbarTitulo) topbarTitulo.textContent = config.titulo;

            if (emBreveTitulo) emBreveTitulo.textContent = config.titulo;
            if (emBreveTag) emBreveTag.textContent = config.tag;
            if (emBreveDescricao) emBreveDescricao.textContent = config.descricao;
        }

        // Fecha a barra no mobile ao selecionar
        fecharSidebarMobile();

        // Rola suavemente ao topo
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const viewId = link.getAttribute('data-view');
            if (viewId) {
                e.preventDefault();
                alternarVisualizacao(viewId);
            }
        });
    });

    if (btnRetornar) {
        btnRetornar.addEventListener('click', (e) => {
            e.preventDefault();
            alternarVisualizacao('painel-inicial');
        });
    }
}

/**
 * Controle da gaveta da Sidebar em telas móveis (360px a 900px)
 */
function inicializarSidebarMobile() {
    const btnMobileMenu = document.getElementById('btn-mobile-menu');
    const btnFecharSidebar = document.getElementById('btn-fechar-sidebar');
    const backdrop = document.getElementById('rh-sidebar-backdrop');
    const sidebar = document.getElementById('rh-sidebar');

    function abrirSidebar() {
        if (sidebar) sidebar.classList.add('sidebar-aberta');
        if (backdrop) backdrop.classList.add('ativo');
        document.body.style.overflow = 'hidden';
    }

    function fecharSidebar() {
        if (sidebar) sidebar.classList.remove('sidebar-aberta');
        if (backdrop) backdrop.classList.remove('ativo');
        document.body.style.overflow = '';
    }

    if (btnMobileMenu) btnMobileMenu.addEventListener('click', abrirSidebar);
    if (btnFecharSidebar) btnFecharSidebar.addEventListener('click', fecharSidebar);
    if (backdrop) backdrop.addEventListener('click', fecharSidebar);

    window.fecharSidebarMobile = fecharSidebar;
}

/**
 * Exibe mensagens de feedback elegantes (toast flutuante)
 */
let timerToast = null;
function exibirToast(mensagem, duracao = 3500) {
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

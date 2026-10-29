// ==========================================
// AJBorges - Aviso de atualização do site (faixa nas páginas, ícone nos dashboards)
// ==========================================
// Mostra o aviso agendado pela gestão (tabela avisos_atualizacao, passos 16 e 21), lido pela RPC
// avisos_atualizacao_ativos(p_local) (só id, inicio, fim, descricao e locais). Cada página informa
// o seu local no <script>: data-aviso-local="ficha" (relatório de viagem e login), "site" (páginas do
// site), "frota" (dashboard da frota e escolha do painel) ou "cadastro" (dashboard do cadastro).
//   - ficha e site: faixa em cima do header (sem login; chave pública).
//   - frota e cadastro: nada de faixa; ícone com pontinho perto do sino, que abre um modal. Esses
//     avisos são internos: a RPC só devolve para a gestão, por isso a consulta vai com a sessão
//     (window.supabaseClient). O pontinho some depois de aberto, até chegar um aviso novo.
// Precisa do supabase-client.js antes (URL e chave pública). Se a consulta falhar, a página segue
// normal, sem aviso.
(function () {
    const FUSO = 'America/Sao_Paulo';
    const CONFERIR_AVISOS_MS = 5 * 60 * 1000; // busca de novo (aviso novo ou cancelado)
    const ATUALIZAR_TEXTO_MS = 30 * 1000;     // "programada" -> "em atualização" -> some
    const LOCAIS = ['ficha', 'site', 'frota', 'cadastro'];

    // Local desta página (sem o atributo: páginas do site)
    const SCRIPT = document.currentScript;
    const LOCAL = LOCAIS.includes(SCRIPT && SCRIPT.dataset.avisoLocal) ? SCRIPT.dataset.avisoLocal : 'site';
    const NO_DASHBOARD = LOCAL === 'frota' || LOCAL === 'cadastro';

    function escapeHtml(valor) {
        return String(valor ?? '').replace(/[&<>"'`]/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        }[c]));
    }

    const formatoHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
    const formatoDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' });
    const formatoDiaAno = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = (d) => formatoHora.format(d);
    const dia = (d) => formatoDia.format(d);

    // Descrição sem ponto duplicado ("Nova tela." + ". " vira "Nova tela.")
    const frase = (texto) => {
        const t = String(texto || '').trim();
        return /[.!?]$/.test(t) ? t : `${t}.`;
    };

    // Texto da faixa (já escapado). Fim em outro dia: "às 02:00 de 28/10"
    function textoDoAviso(aviso, agora) {
        const inicio = new Date(aviso.inicio);
        const fim = new Date(aviso.fim);
        const fimTexto = dia(fim) === dia(inicio) ? hora(fim) : `${hora(fim)} de ${dia(fim)}`;
        const descricao = escapeHtml(frase(aviso.descricao));
        if (agora < inicio) {
            return `<strong>Atualização programada:</strong> ${dia(inicio)} das ${hora(inicio)} às ${fimTexto}. ${descricao} ` +
                'Durante esse horário o site pode ficar instável; evite enviar fichas.';
        }
        const ateTexto = dia(fim) === dia(agora) ? hora(fim) : `${hora(fim)} de ${dia(fim)}`;
        return `<strong>O site está em atualização até ${ateTexto}.</strong> ${descricao}`;
    }

    async function buscarAvisos() {
        let lista;
        if (NO_DASHBOARD) {
            // Com a sessão da gestão (sem ela a RPC devolve vazio)
            const c = window.supabaseClient;
            if (!c || typeof c.rpc !== 'function') return [];
            const { data, error } = await c.rpc('avisos_atualizacao_ativos', { p_local: LOCAL });
            if (error) return [];
            lista = data;
        } else {
            if (typeof SUPABASE_CONFIG === 'undefined') return [];
            const resp = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/avisos_atualizacao_ativos`, {
                method: 'POST',
                headers: { apikey: SUPABASE_CONFIG.anonKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_local: LOCAL })
            });
            if (!resp.ok) return [];
            lista = await resp.json();
        }
        return Array.isArray(lista) ? lista : [];
    }

    const ESTILO_FAIXA = `
        .aviso-atualizacao-faixa { box-sizing: border-box; width: 100%; padding: 8px 16px; background: #fef3c7;
            border-bottom: 1px solid #f59e0b; color: #78350f; font: 500 13px/1.45 'Poppins', 'Inter', system-ui, sans-serif;
            text-align: center; overflow-wrap: anywhere; position: relative; z-index: 1001; }
        .aviso-atualizacao-faixa.aviso-em-andamento { background: #fee2e2; border-bottom-color: #ef4444; color: #7f1d1d; }
        .aviso-atualizacao-faixa.aviso-fixa { position: fixed; top: 0; left: 0; right: 0; }
        .aviso-atualizacao-faixa strong { font-weight: 700; }`;

    const ESTILO_DASHBOARD = `
        .aviso-local-fixo { position: fixed; top: 16px; right: 16px; z-index: 900; }
        .aviso-local-btn { position: relative; width: 38px; height: 38px; flex-shrink: 0; border-radius: 8px;
            background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; display: inline-flex; align-items: center;
            justify-content: center; cursor: pointer; padding: 0; transition: background-color 0.2s, border-color 0.2s; }
        .aviso-local-btn:hover { background: #fef3c7; border-color: #f59e0b; }
        .aviso-local-btn:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
        .aviso-local-btn[hidden] { display: none; }
        .aviso-local-btn.aviso-em-andamento { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }
        .aviso-local-ponto { position: absolute; top: -4px; right: -4px; width: 10px; height: 10px; border-radius: 50%;
            background: #ef4444; box-shadow: 0 0 0 2px #ffffff; }
        .aviso-local-ponto[hidden] { display: none; }
        .aviso-local-modal { position: fixed; inset: 0; z-index: 1200; background: rgba(15, 23, 42, 0.55);
            display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; }
        .aviso-local-modal[hidden] { display: none; }
        .aviso-local-caixa { box-sizing: border-box; width: min(460px, 100%); max-height: calc(100vh - 32px); overflow-y: auto;
            background: #ffffff; border-radius: 14px; box-shadow: 0 20px 50px rgba(15, 23, 42, 0.3);
            font: 400 14px/1.5 'Inter', 'Poppins', system-ui, sans-serif; color: #0f172a; }
        .aviso-local-topo { display: flex; align-items: center; justify-content: space-between; gap: 12px;
            padding: 16px 18px; border-bottom: 1px solid #e2e8f0; }
        .aviso-local-topo h3 { margin: 0; font-size: 1rem; font-weight: 700; }
        .aviso-local-fechar { width: 36px; height: 36px; flex-shrink: 0; border: none; border-radius: 8px; background: #f1f5f9;
            color: #475569; font-size: 1rem; cursor: pointer; }
        .aviso-local-fechar:hover { background: #e2e8f0; }
        .aviso-local-lista { list-style: none; margin: 0; padding: 14px 18px 18px; display: grid; gap: 12px; }
        .aviso-local-item { padding: 12px 14px; border: 1px solid #fcd34d; border-radius: 10px; background: #fffbeb; }
        .aviso-local-item.aviso-em-andamento { border-color: #fca5a5; background: #fef2f2; }
        .aviso-local-item h4 { margin: 0 0 8px; font-size: 0.92rem; color: #92400e; }
        .aviso-local-item.aviso-em-andamento h4 { color: #b91c1c; }
        .aviso-local-item dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 0.85rem; }
        .aviso-local-item dt { font-weight: 600; color: #475569; }
        .aviso-local-item dd { margin: 0; overflow-wrap: anywhere; }
        /* Celular: com o ícone a mais, o título encolhe (quebra linha) em vez de empurrar os botões */
        @media (max-width: 640px) {
            .admin-topbar:has(.aviso-local-btn:not([hidden])) { gap: 10px; }
            .admin-topbar:has(.aviso-local-btn:not([hidden])) .topbar-left { min-width: 0; gap: 10px; }
            .admin-topbar:has(.aviso-local-btn:not([hidden])) .topbar-title-block { min-width: 0; overflow-wrap: anywhere; }
            .admin-topbar:has(.aviso-local-btn:not([hidden])) .topbar-right { flex-shrink: 0; }
        }`;

    function incluirEstilo(id, css) {
        if (document.getElementById(id)) return;
        const estilo = document.createElement('style');
        estilo.id = id;
        estilo.textContent = css;
        document.head.appendChild(estilo);
    }

    let avisos = [];

    // ---------------- Faixa (ficha e site) ----------------

    let faixa = null;
    let header = null;
    let paddingOriginal = ''; // padding-top escrito no body (para devolver)
    let paddingBase = '0px';   // padding-top que o CSS já dá ao body

    // Header fixo (computador): a faixa fica fixa no topo e o header desce a altura dela.
    // Header no fluxo (celular): a faixa fica no fluxo, em cima do header. Nunca cobre o header.
    function encaixar() {
        if (!faixa) return;
        const fixo = !!header && getComputedStyle(header).position === 'fixed';
        faixa.classList.toggle('aviso-fixa', fixo);
        const altura = faixa.offsetHeight;
        if (header) header.style.top = fixo ? `${altura}px` : '';
        document.body.style.paddingTop = fixo ? `calc(${paddingBase} + ${altura}px)` : paddingOriginal;
    }

    function remover() {
        if (!faixa) return;
        faixa.remove();
        faixa = null;
        if (header) header.style.top = '';
        document.body.style.paddingTop = paddingOriginal;
    }

    function mostrarFaixa() {
        const agora = new Date();
        const aviso = avisos.find(a => new Date(a.fim) > agora);
        if (!aviso) return remover();
        if (!faixa) {
            incluirEstilo('aviso-atualizacao-estilo', ESTILO_FAIXA);
            faixa = document.createElement('div');
            faixa.className = 'aviso-atualizacao-faixa';
            faixa.setAttribute('role', 'status');
            faixa.setAttribute('aria-live', 'polite');
            document.body.prepend(faixa);
        }
        faixa.classList.toggle('aviso-em-andamento', agora >= new Date(aviso.inicio));
        faixa.innerHTML = textoDoAviso(aviso, agora);
        encaixar();
    }

    // ---------------- Ícone e modal (dashboards) ----------------

    const CHAVE_VISTOS = `ajborges_avisos_vistos_${LOCAL}`;
    let vistosEmMemoria = [];
    let botao = null;
    let ponto = null;
    let modal = null;
    let lista = null;

    function lerVistos() {
        try {
            const v = JSON.parse(localStorage.getItem(CHAVE_VISTOS) || '[]');
            return Array.isArray(v) ? v.map(String) : vistosEmMemoria;
        } catch (e) { return vistosEmMemoria; }
    }

    function gravarVistos(ids) {
        vistosEmMemoria = ids;
        try { localStorage.setItem(CHAVE_VISTOS, JSON.stringify(ids)); } catch (e) { /* fica só na memória */ }
    }

    const avisosAtivos = () => {
        const agora = new Date();
        return avisos.filter(a => new Date(a.fim) > agora);
    };

    // Um item do modal (já escapado). Término em outro dia: "02:00 de 28/10/2026"
    function itemDoModal(aviso, agora) {
        const inicio = new Date(aviso.inicio);
        const fim = new Date(aviso.fim);
        const emAndamento = agora >= inicio;
        const diaInicio = formatoDiaAno.format(inicio);
        const fimTexto = formatoDiaAno.format(fim) === diaInicio ? hora(fim) : `${hora(fim)} de ${formatoDiaAno.format(fim)}`;
        return `
            <li class="aviso-local-item${emAndamento ? ' aviso-em-andamento' : ''}">
                <h4>${emAndamento ? 'Em atualização agora' : 'Atualização programada'}</h4>
                <dl>
                    <dt>Dia</dt><dd>${escapeHtml(diaInicio)}</dd>
                    <dt>Início</dt><dd>${escapeHtml(hora(inicio))}</dd>
                    <dt>Término</dt><dd>${escapeHtml(fimTexto)}</dd>
                    <dt>Descrição</dt><dd>${escapeHtml(aviso.descricao)}</dd>
                </dl>
            </li>`;
    }

    function criarIcone() {
        incluirEstilo('aviso-local-estilo', ESTILO_DASHBOARD);
        botao = document.createElement('button');
        botao.type = 'button';
        botao.className = 'aviso-local-btn';
        botao.id = 'btn-aviso-local';
        botao.hidden = true;
        botao.setAttribute('aria-haspopup', 'dialog');
        botao.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span class="aviso-local-ponto" hidden></span>`;
        ponto = botao.querySelector('.aviso-local-ponto');
        // Perto do sino; sem sino (escolha do painel), no canto de cima
        const sino = document.querySelector('.notif-sino-wrap');
        if (sino) sino.before(botao);
        else {
            const canto = document.createElement('div');
            canto.className = 'aviso-local-fixo';
            canto.appendChild(botao);
            document.body.appendChild(canto);
        }

        modal = document.createElement('div');
        modal.className = 'aviso-local-modal';
        modal.id = 'modal-aviso-local';
        modal.hidden = true;
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'aviso-local-titulo');
        modal.innerHTML = `
            <div class="aviso-local-caixa">
                <div class="aviso-local-topo">
                    <h3 id="aviso-local-titulo">Atualização do site</h3>
                    <button type="button" class="aviso-local-fechar" aria-label="Fechar">✕</button>
                </div>
                <ul class="aviso-local-lista"></ul>
            </div>`;
        lista = modal.querySelector('.aviso-local-lista');
        document.body.appendChild(modal);

        botao.addEventListener('click', abrirModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('.aviso-local-fechar')) fecharModal();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !modal.hidden) fecharModal();
        });
    }

    function mostrarIcone() {
        const ativos = avisosAtivos();
        if (!botao) {
            if (!ativos.length) return;
            criarIcone();
        }
        const agora = new Date();
        botao.hidden = !ativos.length;
        if (!ativos.length) {
            if (!modal.hidden) fecharModal();
            return;
        }
        const emAndamento = ativos.some(a => agora >= new Date(a.inicio));
        const vistos = lerVistos();
        const novo = ativos.some(a => !vistos.includes(String(a.id)));
        botao.classList.toggle('aviso-em-andamento', emAndamento);
        ponto.hidden = !novo;
        const rotulo = (emAndamento ? 'Site em atualização agora' : 'Atualização do site programada') + (novo ? ' (aviso novo)' : '');
        botao.setAttribute('aria-label', rotulo);
        botao.title = rotulo;
        if (!modal.hidden) lista.innerHTML = ativos.map(a => itemDoModal(a, agora)).join('');
    }

    function abrirModal() {
        const ativos = avisosAtivos();
        if (!ativos.length) return;
        gravarVistos(ativos.map(a => String(a.id)));
        modal.hidden = false;
        mostrarIcone();
        modal.querySelector('.aviso-local-fechar').focus();
    }

    function fecharModal() {
        modal.hidden = true;
        if (botao && !botao.hidden) botao.focus();
    }

    // ---------------- Comum ----------------

    const mostrar = () => (NO_DASHBOARD ? mostrarIcone() : mostrarFaixa());

    async function atualizar() {
        try {
            // Ordem da RPC: o que começa antes primeiro (o em andamento vem antes do agendado)
            avisos = await buscarAvisos();
            mostrar();
        } catch (e) {
            console.warn('Aviso de atualização indisponível:', e);
        }
    }

    function iniciar() {
        if (!NO_DASHBOARD) {
            header = document.querySelector('body > header');
            paddingOriginal = document.body.style.paddingTop;
            paddingBase = getComputedStyle(document.body).paddingTop || '0px';
            window.addEventListener('resize', () => { try { encaixar(); } catch (e) { } });
        }
        atualizar();
        setInterval(atualizar, CONFERIR_AVISOS_MS);
        setInterval(() => { try { mostrar(); } catch (e) { } }, ATUALIZAR_TEXTO_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizar(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
})();

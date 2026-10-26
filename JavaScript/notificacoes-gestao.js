// ==========================================
// AJBorges - Sino de notificações dos dashboards da gestão
// ==========================================
// Cada dashboard tem o seu (frota: fichas de viagem novas; Agregue-se: cadastros novos), com a
// consulta e as ações dele. Conta o que chegou depois da "última vez que vi" (localStorage, uma
// chave por admin e por dashboard; na primeira vez começa de agora). Confere a cada 60 s com a aba
// visível (para com a aba escondida e confere na hora em que ela volta). Consulta leve: count +
// as últimas 10. Sem Realtime.
//
// ajbNotificacoesGestao.iniciar({
//   painel, usuarioId, botao, titulo, vazio,
//   buscar(desde) -> { total, itens: [{ id, data, texto }] } (null = falhou, fica como está),
//   textoToast(item, outros) -> texto ou null (null = sem toast), aoAbrir(id), aoChegar()
// })
// Toast e título da aba levam só o que vem em "texto" (nº da ficha e nome, nunca CPF/celular).
(function () {
    const INTERVALO_MS = 60 * 1000;
    const MAX_CONTADOR = 99;
    const formatoData = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    function escaparHtml(valor) {
        return String(valor ?? '').replace(/[&<>"'`]/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        }[c]));
    }

    const toast = (mensagem) => { if (typeof window.exibirToast === 'function') window.exibirToast(mensagem, 'info'); };

    function iniciar(cfg) {
        const botao = cfg && cfg.botao;
        if (!botao || botao.dataset.notificacoesProntas) return;
        botao.dataset.notificacoesProntas = '1';

        const chave = `ajborges_notificacoes_${cfg.painel}_${cfg.usuarioId || 'gestao'}`;
        const tituloOriginal = document.title;
        const contador = botao.querySelector('.notif-contador');
        let vistoEmMemoria = null;
        let total = 0;
        let itens = [];
        let jaAvisados = null; // ids já mostrados/avisados nesta aba (null = ainda não conferiu)
        let timer = null;

        const lerVistoEm = () => {
            try { return localStorage.getItem(chave) || vistoEmMemoria; } catch (e) { return vistoEmMemoria; }
        };
        const gravarVistoEm = (iso) => {
            vistoEmMemoria = iso;
            try { localStorage.setItem(chave, iso); } catch (e) { /* fica só na memória */ }
        };
        if (!lerVistoEm()) gravarVistoEm(new Date().toISOString());

        // Lista que abre embaixo do sino
        const caixa = document.createElement('div');
        caixa.className = 'notif-painel';
        caixa.hidden = true;
        caixa.setAttribute('role', 'dialog');
        caixa.setAttribute('aria-label', cfg.titulo);
        caixa.innerHTML = `<div class="notif-painel-topo">${escaparHtml(cfg.titulo)}</div><ul class="notif-lista"></ul>`;
        botao.insertAdjacentElement('afterend', caixa);
        const lista = caixa.querySelector('.notif-lista');

        function mostrarContador() {
            if (contador) {
                contador.textContent = total > MAX_CONTADOR ? `${MAX_CONTADOR}+` : String(total);
                contador.hidden = total === 0;
            }
            botao.setAttribute('aria-label', total > 0 ? `${cfg.titulo}: ${total}` : cfg.titulo);
            document.title = total > 0 ? `(${total > MAX_CONTADOR ? `${MAX_CONTADOR}+` : total}) ${tituloOriginal}` : tituloOriginal;
        }

        async function conferir() {
            let r = null;
            try { r = await cfg.buscar(lerVistoEm()); } catch (e) { console.warn('Notificações indisponíveis:', e); }
            if (!r) return;
            total = r.total || 0;
            itens = Array.isArray(r.itens) ? r.itens : [];
            // Na primeira conferência da aba só conta (a tabela acabou de carregar); depois avisa o que chegou
            const novos = jaAvisados ? itens.filter(i => !jaAvisados.has(i.id)) : [];
            if (!jaAvisados) jaAvisados = new Set();
            itens.forEach(i => jaAvisados.add(i.id));
            mostrarContador();
            if (novos.length) {
                const texto = cfg.textoToast(novos[0], novos.length - 1);
                if (texto) toast(texto);
                if (cfg.aoChegar) cfg.aoChegar();
            }
        }

        function desenharLista() {
            lista.innerHTML = itens.length
                ? itens.map(i => `<li><button type="button" class="notif-item" data-id="${escaparHtml(i.id)}">
                        <strong>${escaparHtml(i.texto)}</strong>
                        <span>${i.data ? escaparHtml(formatoData.format(new Date(i.data))) : ''}</span>
                    </button></li>`).join('')
                : `<li class="notif-vazio">${escaparHtml(cfg.vazio)}</li>`;
            if (total > itens.length) lista.insertAdjacentHTML('beforeend', `<li class="notif-vazio">Mostrando as ${itens.length} mais recentes de ${total}.</li>`);
        }

        function fecharLista() {
            caixa.hidden = true;
            botao.setAttribute('aria-expanded', 'false');
        }

        // Abrir a lista = "vi": o contador zera e a próxima contagem começa da mais recente da lista
        // (data do banco, sem depender do relógio do computador)
        async function abrirLista() {
            if (!caixa.hidden) return fecharLista();
            await conferir();
            desenharLista();
            // Celular (lista fixa na largura da tela): abre logo abaixo do sino, qualquer que seja a altura do topo
            caixa.style.top = getComputedStyle(caixa).position === 'fixed' ? `${Math.round(botao.getBoundingClientRect().bottom + 8)}px` : '';
            caixa.hidden = false;
            botao.setAttribute('aria-expanded', 'true');
            if (itens.length && itens[0].data) gravarVistoEm(new Date(itens[0].data).toISOString());
            total = 0;
            mostrarContador();
        }

        botao.addEventListener('click', abrirLista);
        lista.addEventListener('click', (e) => {
            const item = e.target.closest('.notif-item');
            if (!item) return;
            fecharLista();
            if (cfg.aoAbrir) cfg.aoAbrir(item.dataset.id);
        });
        document.addEventListener('click', (e) => {
            if (!caixa.hidden && !caixa.contains(e.target) && !botao.contains(e.target)) fecharLista();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !caixa.hidden) fecharLista();
        });

        // A cada 60 s com a aba visível; escondida, para; ao voltar, confere na hora
        const parar = () => { if (timer) clearInterval(timer); timer = null; };
        const ligar = () => { parar(); timer = setInterval(conferir, INTERVALO_MS); };
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) return parar();
            conferir();
            ligar();
        });
        conferir();
        if (!document.hidden) ligar();
    }

    window.ajbNotificacoesGestao = { iniciar };
})();

// ==========================================
// AJBorges - Faixa de aviso de atualização do site
// ==========================================
// Mostra no topo da página o aviso agendado pela gestão (tabela avisos_atualizacao, passo 16),
// lido pela RPC avisos_atualizacao_ativos (sem login; só id, inicio, fim e descricao).
// Incluída na ficha do motorista, no login e nas páginas públicas. Precisa do supabase-client.js
// antes (URL e chave pública). Se a consulta falhar, a página segue normal, sem faixa.
(function () {
    const FUSO = 'America/Sao_Paulo';
    const CONFERIR_AVISOS_MS = 5 * 60 * 1000; // busca de novo (aviso novo ou cancelado)
    const ATUALIZAR_TEXTO_MS = 30 * 1000;     // "programada" -> "em atualização" -> some

    function escapeHtml(valor) {
        return String(valor ?? '').replace(/[&<>"'`]/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        }[c]));
    }

    const formatoHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });
    const formatoDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' });
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
        if (typeof SUPABASE_CONFIG === 'undefined') return [];
        const resp = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/rpc/avisos_atualizacao_ativos`, {
            method: 'POST',
            headers: { apikey: SUPABASE_CONFIG.anonKey, 'Content-Type': 'application/json' },
            body: '{}'
        });
        if (!resp.ok) return [];
        const lista = await resp.json();
        return Array.isArray(lista) ? lista : [];
    }

    const ESTILO = `
        .aviso-atualizacao-faixa { box-sizing: border-box; width: 100%; padding: 8px 16px; background: #fef3c7;
            border-bottom: 1px solid #f59e0b; color: #78350f; font: 500 13px/1.45 'Poppins', 'Inter', system-ui, sans-serif;
            text-align: center; overflow-wrap: anywhere; position: relative; z-index: 1001; }
        .aviso-atualizacao-faixa.aviso-em-andamento { background: #fee2e2; border-bottom-color: #ef4444; color: #7f1d1d; }
        .aviso-atualizacao-faixa.aviso-fixa { position: fixed; top: 0; left: 0; right: 0; }
        .aviso-atualizacao-faixa strong { font-weight: 700; }`;

    let faixa = null;
    let avisos = [];
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

    function mostrar() {
        const agora = new Date();
        const aviso = avisos.find(a => new Date(a.fim) > agora);
        if (!aviso) return remover();
        if (!faixa) {
            if (!document.getElementById('aviso-atualizacao-estilo')) {
                const estilo = document.createElement('style');
                estilo.id = 'aviso-atualizacao-estilo';
                estilo.textContent = ESTILO;
                document.head.appendChild(estilo);
            }
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
        header = document.querySelector('body > header');
        paddingOriginal = document.body.style.paddingTop;
        paddingBase = getComputedStyle(document.body).paddingTop || '0px';
        atualizar();
        setInterval(atualizar, CONFERIR_AVISOS_MS);
        setInterval(() => { try { mostrar(); } catch (e) { } }, ATUALIZAR_TEXTO_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) atualizar(); });
        window.addEventListener('resize', () => { try { encaixar(); } catch (e) { } });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
    else iniciar();
})();

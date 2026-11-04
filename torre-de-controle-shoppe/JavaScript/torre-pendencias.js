/**
 * ============================================================================
 * TORRE DE CONTROLE - HISTÓRICO DE PENDÊNCIAS (aba #pendencias)
 * ============================================================================
 * Lista as pendências da passagem de turno (torre.passagem_pendencias,
 * supabase/sql/torre/T03_pendencias.sql) pela RPC torre.buscar_pendencias:
 * busca por texto (na pendência ou em "Como foi resolvido"), turno, data da
 * passagem e status (aberta, resolvida, continua). Até 200 por busca.
 * Também mantém o contador de pendências abertas ao lado de "Passagem de
 * turno" na barra lateral (window.torreAtualizarContadorPendencias).
 * Tudo que vem do banco entra na tela por escapeHtml.
 */
(function () {
    const LIMITE = 200;
    const ROTULO_STATUS = { aberta: 'Aberta', resolvida: 'Resolvida', continua: 'Continua' };

    const estado = { iniciado: false, ativo: false, lista: [], timer: null, pedido: 0 };

    const $ = (id) => document.getElementById(id);

    function esc(valor) {
        return String(valor ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function dataBr(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
    }

    function dataHoraBr(valor) {
        const d = new Date(valor);
        if (Number.isNaN(d.getTime())) return '';
        return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }

    function banco() {
        const c = window.supabaseClient;
        if (!c || typeof c.schema !== 'function') throw new Error('Cliente Supabase indisponível.');
        return c.schema('torre');
    }

    function mensagemErro(erro) {
        const texto = String((erro && (erro.message || erro.details)) || erro || '');
        const codigo = String((erro && erro.code) || '');
        if (codigo === '42501' || /permission denied|row-level security/i.test(texto)) return 'Sem permissão para ler as pendências com o seu usuário.';
        if (codigo === 'PGRST106') return 'Não foi possível ler as pendências: o schema "torre" não está liberado na API.';
        if (/fetch|network|failed|indisponível/i.test(texto)) return 'Sem conexão com o servidor: não foi possível ler as pendências.';
        return `Não foi possível ler as pendências: ${texto || 'erro desconhecido'}.`;
    }

    /* ------------------------------------------------------------------------
       Contador da barra lateral (pendências abertas = herdadas pelo próximo turno)
       ------------------------------------------------------------------------ */
    function atualizarContador(qtd) {
        const badge = $('nav-badge-pendencias');
        if (!badge) return;
        const n = Number(qtd) || 0;
        badge.hidden = n === 0;
        badge.textContent = n > 99 ? '99+' : String(n);
        const rotulo = n === 1 ? '1 pendência herdada aberta' : `${n} pendências herdadas abertas`;
        badge.setAttribute('aria-label', rotulo);
        badge.title = rotulo;
        const link = $('nav-link-passagem');
        if (link) link.title = n ? `Passagem de turno (${rotulo})` : 'Passagem de turno';
    }
    window.torreAtualizarContadorPendencias = atualizarContador;

    async function contarAbertas() {
        try {
            const { data, error } = await banco().from('passagem_pendencias').select('id').eq('status', 'aberta');
            if (error) throw error;
            atualizarContador(Array.isArray(data) ? data.length : 0);
        } catch (erro) {
            // Sem T03 no banco ou sem conexão: só não mostra o contador
            console.warn('[Torre] Não foi possível contar as pendências abertas:', erro);
            atualizarContador(0);
        }
    }

    /* ------------------------------------------------------------------------
       Busca e lista
       ------------------------------------------------------------------------ */
    async function carregar() {
        const pedido = ++estado.pedido;
        const resumo = $('pendencias-resumo');
        try {
            const { data, error } = await banco().rpc('buscar_pendencias', {
                p_texto: ($('pendencias-texto')?.value || '').trim() || null,
                p_turno: $('pendencias-turno')?.value || null,
                p_data: $('pendencias-data')?.value || null,
                p_status: $('pendencias-status')?.value || null
            });
            if (pedido !== estado.pedido) return; // chegou uma busca mais nova
            if (error) throw error;
            estado.lista = Array.isArray(data) ? data : [];
            renderizar();
        } catch (erro) {
            if (pedido !== estado.pedido) return;
            estado.lista = [];
            $('pendencias-lista').innerHTML = `<p class="passagem-vazio">${esc(mensagemErro(erro))}</p>`;
            if (resumo) resumo.textContent = '';
        }
    }

    function itemPendencia(p) {
        const status = ROTULO_STATUS[p.status] ? p.status : 'aberta';
        const fechada = status !== 'aberta';
        return `
            <article class="pendencia-item pendencia-${status}">
                <div class="pendencia-topo">
                    <span class="pendencia-status">${esc(ROTULO_STATUS[status])}</span>
                    <span class="passagem-selo">${esc(p.turno)}</span>
                    <span class="passagem-meta">Passagem de ${esc(dataBr(p.data))}</span>
                </div>
                <p class="pendencia-texto">${esc(p.texto)}</p>
                ${p.origem_id ? `<p class="passagem-meta">Continua de uma pendência do ${esc(p.origem_turno || '')} de ${esc(dataBr(p.origem_data))}</p>` : ''}
                ${fechada ? `
                <div class="pendencia-resolucao">
                    <span class="passagem-original-rotulo">Como foi resolvido</span>
                    <p class="pendencia-texto">${esc(p.resolucao)}</p>
                    <p class="passagem-meta">${status === 'continua' ? 'Passou para o turno seguinte' : 'Resolvida'} por ${esc(p.resolvido_email || 'usuário sem e-mail')} em ${esc(dataHoraBr(p.resolvido_em))}${p.fechada_turno ? ` · na passagem do ${esc(p.fechada_turno)} de ${esc(dataBr(p.fechada_data))}` : ''}</p>
                </div>` : '<p class="passagem-meta">Ainda aberta: o próximo turno fecha ao publicar a passagem.</p>'}
            </article>`;
    }

    function renderizar() {
        const el = $('pendencias-lista');
        const resumo = $('pendencias-resumo');
        if (!el) return;
        const n = estado.lista.length;
        if (resumo) {
            resumo.textContent = n === 0 ? '' : `${n} pendência(s)${n >= LIMITE ? ` (mostrando as ${LIMITE} mais recentes; refine a busca)` : ''}`;
        }
        el.innerHTML = n === 0
            ? '<p class="passagem-vazio">Nenhuma pendência com esses filtros.</p>'
            : estado.lista.map(itemPendencia).join('');
    }

    async function atualizar() {
        if (!estado.ativo) return;
        await Promise.all([carregar(), contarAbertas()]);
    }

    function iniciar() {
        if (estado.iniciado) return;
        estado.iniciado = true;
        $('pendencias-texto')?.addEventListener('input', () => {
            clearTimeout(estado.timer);
            estado.timer = setTimeout(carregar, 300);
        });
        ['pendencias-turno', 'pendencias-data', 'pendencias-status'].forEach((id) => {
            $(id)?.addEventListener('change', carregar);
        });
    }

    // Mostra/esconde a tela (as áreas de tabela da Torre somem enquanto ela está aberta)
    function ativar() {
        iniciar();
        if (!estado.ativo) {
            estado.ativo = true;
            atualizar();
        }
        $('torre-pendencias').hidden = false;
        ['torre-painel-contadores', 'torre-barra-subfiltros', 'torre-area-principal', 'torre-busca-wrapper']
            .forEach((id) => { const el = $(id); if (el) el.hidden = true; });
    }

    function desativar() {
        if (!estado.ativo) return;
        estado.ativo = false;
        $('torre-pendencias').hidden = true;
        ['torre-painel-contadores', 'torre-area-principal', 'torre-busca-wrapper']
            .forEach((id) => { const el = $(id); if (el) el.hidden = false; });
    }

    window.torrePendencias = { ativar, desativar, atualizar, contarAbertas };
})();

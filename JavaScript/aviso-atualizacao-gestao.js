// ==========================================
// AJBorges - "Avisar atualização do site" (dashboards da frota e do Agregue-se)
// ==========================================
// Modal para agendar e cancelar os avisos da tabela avisos_atualizacao (passo 16). Os dois
// dashboards gerenciam os mesmos avisos. Só a gestão grava (RLS com is_admin()); a lista vem da
// RPC avisos_atualizacao_ativos (não cancelados e que ainda não terminaram).
// Uso, depois do ajbAoAutenticar da gestão: ajbAvisoAtualizacaoGestao.iniciar(botao).
// O toast é o exibirToast(mensagem, tipo) da página.
(function () {
    const FUSO = 'America/Sao_Paulo';
    const MAX_DESCRICAO = 500;

    function escaparHtml(valor) {
        return String(valor ?? '').replace(/[&<>"'`]/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        }[c]));
    }

    const toast = (mensagem, tipo) => { if (typeof window.exibirToast === 'function') window.exibirToast(mensagem, tipo); };

    // ---------------- Datas no horário de Brasília ----------------

    // Partes da data em America/Sao_Paulo
    function partesSaoPaulo(data) {
        const partes = new Intl.DateTimeFormat('en-US', {
            timeZone: FUSO, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(data);
        return Object.fromEntries(partes.map(p => [p.type, p.value]));
    }

    // "AAAA-MM-DDTHH:MM" (campo datetime-local) lido como horário de Brasília, qualquer que seja
    // o fuso do computador
    function campoParaData(valor) {
        const m = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        if (!m) return null;
        const comoUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
        const p = partesSaoPaulo(new Date(comoUtc));
        const deslocamento = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - comoUtc;
        return new Date(comoUtc - deslocamento);
    }

    function dataParaCampo(data) {
        const p = partesSaoPaulo(data);
        return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    }

    const formatoDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' });
    const formatoHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' });

    function periodoTexto(inicio, fim) {
        const diaFim = formatoDia.format(fim);
        const fimTexto = diaFim === formatoDia.format(inicio) ? formatoHora.format(fim) : `${formatoHora.format(fim)} de ${diaFim}`;
        return `${formatoDia.format(inicio)} das ${formatoHora.format(inicio)} às ${fimTexto}`;
    }

    // ---------------- Modal ----------------

    const HTML_MODAL = `
    <div class="modal-overlay" id="modal-aviso-atualizacao" aria-hidden="true" role="dialog" aria-modal="true"
        aria-labelledby="aviso-atu-titulo">
        <div class="modal-container mot-modal">
            <div class="modal-header">
                <div class="modal-header-info">
                    <span class="badge-modal">Site</span>
                    <h3 class="modal-title" id="aviso-atu-titulo">Avisar atualização do site</h3>
                </div>
                <button type="button" class="modal-close-btn" data-aviso-fechar aria-label="Fechar">✕</button>
            </div>
            <div class="modal-body">
                <p class="aviso-atu-explica">A faixa aparece na ficha do motorista, no login e nas páginas públicas
                    até o término previsto. Horários de Brasília.</p>
                <div class="mot-alerta" id="aviso-atu-alerta" role="alert" hidden></div>
                <form id="aviso-atu-form" class="mot-form" novalidate>
                    <label class="mot-campo">
                        <span>Início <b class="mot-obrigatorio">*</b></span>
                        <input type="datetime-local" id="aviso-atu-inicio" required>
                    </label>
                    <label class="mot-campo">
                        <span>Término previsto <b class="mot-obrigatorio">*</b></span>
                        <input type="datetime-local" id="aviso-atu-fim" required>
                    </label>
                    <label class="mot-campo mot-campo-largo">
                        <span>Descrição do que vai mudar <b class="mot-obrigatorio">*</b></span>
                        <textarea id="aviso-atu-descricao" rows="3" maxlength="${MAX_DESCRICAO}" required></textarea>
                        <small id="aviso-atu-contador" aria-live="polite">0/${MAX_DESCRICAO} caracteres</small>
                    </label>
                </form>
                <div class="aviso-atu-botoes">
                    <button type="button" class="btn-modal-secundario" data-aviso-fechar>Cancelar</button>
                    <button type="button" class="btn-modal-sucesso" id="aviso-atu-salvar">Salvar aviso</button>
                </div>
                <h4 class="aviso-atu-lista-titulo">Avisos agendados ou em andamento</h4>
                <ul class="aviso-atu-lista" id="aviso-atu-lista"></ul>
            </div>
        </div>
    </div>`;

    let modal = null;
    const el = (id) => document.getElementById(id);

    function mostrarAlerta(texto) {
        const alerta = el('aviso-atu-alerta');
        if (!alerta) return;
        alerta.textContent = texto || '';
        alerta.hidden = !texto;
    }

    function atualizarContador() {
        const n = el('aviso-atu-descricao').value.length;
        el('aviso-atu-contador').textContent = `${n}/${MAX_DESCRICAO} caracteres`;
    }

    function limparFormulario() {
        el('aviso-atu-form').reset();
        mostrarAlerta('');
        atualizarContador();
    }

    function abrir() {
        limparFormulario();
        // Não deixa escolher início no passado (horário de Brasília)
        const agora = dataParaCampo(new Date());
        el('aviso-atu-inicio').min = agora;
        el('aviso-atu-fim').min = agora;
        modal.classList.add('active');
        modal.setAttribute('aria-hidden', 'false');
        el('aviso-atu-inicio').focus();
        carregarLista();
    }

    function fechar() {
        modal.classList.remove('active');
        modal.setAttribute('aria-hidden', 'true');
        limparFormulario();
    }

    async function carregarLista() {
        const lista = el('aviso-atu-lista');
        const c = window.supabaseClient;
        if (!c) {
            lista.innerHTML = '<li class="aviso-atu-vazio">Sem conexão com o banco.</li>';
            return;
        }
        lista.innerHTML = '<li class="aviso-atu-vazio">Carregando...</li>';
        const { data, error } = await c.rpc('avisos_atualizacao_ativos');
        if (error) {
            console.warn('Erro ao listar avisos de atualização:', error.message);
            lista.innerHTML = '<li class="aviso-atu-vazio">Não foi possível carregar os avisos. Confira se o passo 16 do banco foi aplicado.</li>';
            return;
        }
        const avisos = Array.isArray(data) ? data : [];
        if (avisos.length === 0) {
            lista.innerHTML = '<li class="aviso-atu-vazio">Nenhum aviso agendado.</li>';
            return;
        }
        const agora = new Date();
        lista.innerHTML = avisos.map(a => {
            const inicio = new Date(a.inicio);
            const emAndamento = inicio <= agora;
            return `
            <li class="aviso-atu-item">
                <div class="aviso-atu-item-texto">
                    <span class="aviso-atu-selo ${emAndamento ? 'aviso-atu-selo-andamento' : ''}">${emAndamento ? 'Em andamento' : 'Agendado'}</span>
                    <strong>${escaparHtml(periodoTexto(inicio, new Date(a.fim)))}</strong>
                    <p>${escaparHtml(a.descricao)}</p>
                </div>
                <button type="button" class="btn-modal-perigo aviso-atu-cancelar" data-aviso-id="${escaparHtml(a.id)}">Cancelar aviso</button>
            </li>`;
        }).join('');
    }

    async function salvar() {
        mostrarAlerta('');
        const inicio = campoParaData(el('aviso-atu-inicio').value);
        const fim = campoParaData(el('aviso-atu-fim').value);
        const descricao = el('aviso-atu-descricao').value.trim();
        // Vale o minuto atual (quem digita a hora de agora não leva erro pelos segundos)
        const minutoAtual = Math.floor(Date.now() / 60000) * 60000;
        if (!inicio) return mostrarAlerta('Informe a data e a hora do início.');
        if (inicio.getTime() < minutoAtual) return mostrarAlerta('O início não pode ser no passado.');
        if (!fim) return mostrarAlerta('Informe a data e a hora do término previsto.');
        if (fim <= inicio) return mostrarAlerta('O término previsto tem que ser depois do início.');
        if (!descricao) return mostrarAlerta('Descreva o que vai mudar.');
        if (descricao.length > MAX_DESCRICAO) return mostrarAlerta(`A descrição pode ter até ${MAX_DESCRICAO} caracteres.`);

        const c = window.supabaseClient;
        if (!c) return mostrarAlerta('Sem conexão com o banco. Atualize a página.');
        const botao = el('aviso-atu-salvar');
        botao.disabled = true;
        try {
            const { error } = await c.from('avisos_atualizacao')
                .insert({ inicio: inicio.toISOString(), fim: fim.toISOString(), descricao });
            if (error) {
                console.warn('Erro ao salvar aviso de atualização:', error.message);
                return mostrarAlerta('Não foi possível salvar o aviso. Confira se o passo 16 do banco foi aplicado e tente de novo.');
            }
            limparFormulario();
            toast('Aviso de atualização salvo. A faixa já aparece nas páginas.', 'sucesso');
            carregarLista();
        } finally {
            botao.disabled = false;
        }
    }

    async function cancelarAviso(botao) {
        const id = Number(botao.dataset.avisoId);
        if (!id || !confirm('Cancelar este aviso? A faixa some das páginas.')) return;
        const c = window.supabaseClient;
        if (!c) return;
        botao.disabled = true;
        const { error } = await c.from('avisos_atualizacao').update({ cancelado: true }).eq('id', id);
        if (error) {
            console.warn('Erro ao cancelar aviso de atualização:', error.message);
            botao.disabled = false;
            toast('Não foi possível cancelar o aviso. Tente de novo.', 'erro');
            return;
        }
        toast('Aviso cancelado.', 'info');
        carregarLista();
    }

    function iniciar(botaoAbrir) {
        if (!botaoAbrir || modal) return;
        document.body.insertAdjacentHTML('beforeend', HTML_MODAL);
        modal = el('modal-aviso-atualizacao');
        botaoAbrir.addEventListener('click', abrir);
        el('aviso-atu-salvar').addEventListener('click', salvar);
        el('aviso-atu-descricao').addEventListener('input', atualizarContador);
        el('aviso-atu-lista').addEventListener('click', (e) => {
            const botao = e.target.closest('.aviso-atu-cancelar');
            if (botao) cancelarAviso(botao);
        });
        // Fechar: botões, clique fora e Esc
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('[data-aviso-fechar]')) fechar();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('active')) fechar();
        });
    }

    window.ajbAvisoAtualizacaoGestao = { iniciar };
})();

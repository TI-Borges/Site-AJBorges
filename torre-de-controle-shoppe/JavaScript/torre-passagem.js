/**
 * ============================================================================
 * TORRE DE CONTROLE - PASSAGEM DE TURNO (aba #passagem)
 * ============================================================================
 * O operador escolhe o turno, escreve do jeito dele e clica "Gerar passagem":
 * a edge function torre-passagem-turno reorganiza o texto com a IA (o site
 * nunca fala com a IA nem tem chave). Ele revisa, edita e publica em
 * torre.passagens_turno (supabase/sql/torre/T02_passagem_turno.sql); autor e
 * hora vêm do servidor. No topo fica a última passagem publicada; abaixo, o
 * histórico com filtro por data e turno. Horários dos turnos em torre.turnos
 * (em branco até o operador preencher).
 * Pendências (T03_pendencias.sql): as pendências abertas herdadas aparecem no
 * topo do formulário; cada uma é fechada como "Resolvida" ou "Continua", com
 * "Como foi resolvido" obrigatório. A publicação vai pela RPC
 * torre.publicar_passagem, que fecha as herdadas, publica e cria as pendências
 * da passagem nova numa transação só (o banco recusa se faltar alguma).
 * Nome do operador (T04_nome_operador.sql): todos usam o mesmo login, então o
 * campo "Seu nome" (2 a 80 letras) é obrigatório para gerar e publicar; o
 * mesmo nome fica como quem fechou as herdadas. O navegador lembra o último
 * nome (localStorage). O nome NÃO vai para a IA.
 * Tudo que vem do banco ou da IA entra na tela por escapeHtml/textContent.
 */
(function () {
    const TURNOS = ['T1', 'T2', 'T3'];
    const LIMITE_HISTORICO = 30;
    const CHAVE_NOME = 'torre_operador_nome';
    const NOME_MIN = 2;
    const NOME_MAX = 80;

    const estado = {
        iniciado: false,
        ativo: false,
        turnos: [],
        ultima: null,
        historico: [],
        herdadas: [],
        fechamentos: {},   // id da pendência -> { status, resolucao } (o que o operador já preencheu)
        textoIa: null,
        gerando: false,
        publicando: false
    };

    const $ = (id) => document.getElementById(id);

    function esc(valor) {
        return String(valor ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function hojeIso() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

    function hora(valor) {
        return valor ? String(valor).slice(0, 5) : '';
    }

    // "04/11 15:30" (hora em que foi publicada)
    function diaHoraCurta(valor) {
        const d = new Date(valor);
        if (Number.isNaN(d.getTime())) return '';
        return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }

    // Passagens e pendências de antes do T04 não têm nome
    function nomeOuVazio(nome) {
        return String(nome || '').trim() || 'não informado';
    }

    /* "Seu nome": lembrado no navegador (sem localStorage, só não lembra) */
    function lerNomeSalvo() {
        try { return localStorage.getItem(CHAVE_NOME) || ''; } catch (e) { return ''; }
    }

    function salvarNome(nome) {
        try {
            if (nome) localStorage.setItem(CHAVE_NOME, nome);
            else localStorage.removeItem(CHAVE_NOME);
        } catch (e) { /* navegador sem localStorage */ }
    }

    // Nome válido (2 a 80 letras) ou null; sem nome marca o campo e põe o foco nele
    function conferirNome() {
        const el = $('passagem-operador-nome');
        const nome = el ? el.value.trim() : '';
        const valido = nome.length >= NOME_MIN && nome.length <= NOME_MAX;
        if (el) el.setAttribute('aria-invalid', String(!valido));
        if (valido) return nome;
        if (el) el.focus();
        status(`Preencha "Seu nome" (${NOME_MIN} a ${NOME_MAX} letras)`, 'erro');
        return null;
    }

    function banco() {
        const c = window.supabaseClient;
        if (!c || typeof c.schema !== 'function') throw new Error('Cliente Supabase indisponível.');
        return c.schema('torre');
    }

    function mensagemErro(erro, acao) {
        const texto = String((erro && (erro.message || erro.details)) || erro || '');
        const codigo = String((erro && erro.code) || '');
        if (codigo === '42501' || /permission denied|row-level security/i.test(texto)) {
            return `Sem permissão para ${acao} com o seu usuário. Nada foi alterado.`;
        }
        if (codigo === 'PGRST106') return `Não foi possível ${acao}: o schema "torre" não está liberado na API.`;
        if (/fetch|network|failed|indisponível/i.test(texto)) {
            return `Sem conexão com o servidor: não foi possível ${acao}. O que você digitou continua na tela.`;
        }
        return `Não foi possível ${acao}: ${texto || 'erro desconhecido'}. O que você digitou continua na tela.`;
    }

    function status(texto, tipo = '') {
        const el = $('passagem-status');
        if (!el) return;
        el.textContent = texto;
        el.className = `passagem-status${tipo ? ` passagem-status-${tipo}` : ''}`;
    }

    /* ------------------------------------------------------------------------
       Leitura
       ------------------------------------------------------------------------ */
    async function carregarTurnos() {
        const { data, error } = await banco().from('turnos').select('*').order('turno');
        if (error) throw error;
        estado.turnos = Array.isArray(data) ? data : [];
        renderizarTurnos();
    }

    async function carregarUltima() {
        const { data, error } = await banco().from('passagens_turno').select('*')
            .order('criado_em', { ascending: false }).limit(1);
        if (error) throw error;
        estado.ultima = Array.isArray(data) && data.length ? data[0] : null;
        renderizarUltima();
    }

    async function carregarHistorico() {
        let q = banco().from('passagens_turno').select('*');
        const data = $('historico-data')?.value || '';
        const turno = $('historico-turno')?.value || '';
        if (data) q = q.eq('data', data);
        if (turno) q = q.eq('turno', turno);
        const r = await q.order('criado_em', { ascending: false }).limit(LIMITE_HISTORICO);
        if (r.error) throw r.error;
        estado.historico = Array.isArray(r.data) ? r.data : [];
        renderizarHistorico();
    }

    // Pendências abertas = as herdadas pelo próximo turno (mais antigas primeiro)
    async function carregarHerdadas() {
        const { data, error } = await banco().from('passagem_pendencias').select('*')
            .eq('status', 'aberta').order('ordem', { ascending: true });
        if (error) throw error;
        estado.herdadas = Array.isArray(data) ? data : [];
        const ids = new Set(estado.herdadas.map((p) => p.id));
        Object.keys(estado.fechamentos).forEach((id) => { if (!ids.has(id)) delete estado.fechamentos[id]; });
        renderizarHerdadas();
        if (typeof window.torreAtualizarContadorPendencias === 'function') {
            window.torreAtualizarContadorPendencias(estado.herdadas.length);
        }
    }

    async function atualizar() {
        if (!estado.ativo) return;
        try {
            await Promise.all([carregarUltima(), carregarHistorico(), carregarHerdadas()]);
        } catch (erro) {
            console.warn('[Torre] Falha ao ler as passagens:', erro);
            const el = $('passagem-ultima');
            if (el && !estado.ultima) el.innerHTML = `<p class="passagem-vazio">${esc(mensagemErro(erro, 'ler as passagens'))}</p>`;
        }
    }

    /* ------------------------------------------------------------------------
       Desenho
       ------------------------------------------------------------------------ */
    function rotuloTurno(turno) {
        const t = estado.turnos.find((x) => x.turno === turno);
        return t && t.inicio && t.fim ? `${turno} (${hora(t.inicio)} às ${hora(t.fim)})` : `${turno} (horário não configurado)`;
    }

    function renderizarTurnos() {
        const sel = $('passagem-turno');
        if (sel) {
            const atual = sel.value;
            sel.innerHTML = '<option value="">Escolha o turno</option>'
                + TURNOS.map((t) => `<option value="${t}">${esc(rotuloTurno(t))}</option>`).join('');
            sel.value = atual;
        }
        const lista = $('passagem-horarios-lista');
        if (lista) {
            lista.innerHTML = TURNOS.map((t) => {
                const cfg = estado.turnos.find((x) => x.turno === t) || {};
                return `
                    <div class="passagem-horario-linha">
                        <strong>${t}</strong>
                        <label>Início <input type="time" data-horario-turno="${t}" data-horario-campo="inicio" value="${esc(hora(cfg.inicio))}"></label>
                        <label>Fim <input type="time" data-horario-turno="${t}" data-horario-campo="fim" value="${esc(hora(cfg.fim))}"></label>
                    </div>`;
            }).join('');
        }
    }

    function blocoPassagem(p, { idPrefixo }) {
        return `
            <pre class="passagem-texto">${esc(p.texto_final)}</pre>
            <button type="button" class="passagem-link" data-passagem-original="${esc(idPrefixo)}" aria-expanded="false">Ver texto original</button>
            <div class="passagem-original" id="${esc(idPrefixo)}" hidden>
                <span class="passagem-original-rotulo">Texto original do operador</span>
                <pre class="passagem-texto">${esc(p.texto_original)}</pre>
            </div>`;
    }

    function renderizarUltima() {
        const el = $('passagem-ultima');
        if (!el) return;
        const p = estado.ultima;
        if (!p) {
            el.innerHTML = '<h3 class="passagem-titulo">Última passagem</h3><p class="passagem-vazio">Nenhuma passagem publicada ainda.</p>';
            return;
        }
        el.innerHTML = `
            <div class="passagem-ultima-topo">
                <h3 class="passagem-titulo">Última passagem</h3>
                <span class="passagem-selo">${esc(p.turno)}</span>
            </div>
            <p class="passagem-meta" title="Login: ${esc(p.autor_email || 'usuário sem e-mail')}">${esc(p.turno)} · ${esc(diaHoraCurta(p.criado_em))} · por ${esc(nomeOuVazio(p.operador_nome))}${dataBr(p.data) === new Date(p.criado_em).toLocaleDateString('pt-BR') ? '' : ` · turno de ${esc(dataBr(p.data))}`}</p>
            ${blocoPassagem(p, { idPrefixo: 'passagem-ultima-original' })}`;
    }

    function renderizarHistorico() {
        const el = $('passagem-historico');
        if (!el) return;
        if (estado.historico.length === 0) {
            el.innerHTML = '<p class="passagem-vazio">Nenhuma passagem com esses filtros.</p>';
            return;
        }
        el.innerHTML = estado.historico.map((p, i) => `
            <details class="passagem-item" data-passagem-id="${esc(p.id)}">
                <summary>
                    <span class="passagem-selo">${esc(p.turno)}</span>
                    <span>${esc(dataBr(p.data))}</span>
                    <span class="passagem-meta" title="Login: ${esc(p.autor_email || 'usuário sem e-mail')}">por ${esc(nomeOuVazio(p.operador_nome))} · ${esc(dataHoraBr(p.criado_em))}</span>
                </summary>
                ${blocoPassagem(p, { idPrefixo: `passagem-hist-original-${i}` })}
            </details>`).join('');
    }

    function renderizarHerdadas() {
        const el = $('passagem-herdadas');
        if (!el) return;
        el.hidden = estado.herdadas.length === 0;
        if (!estado.herdadas.length) {
            el.innerHTML = '';
            return;
        }
        el.innerHTML = `
            <h4 class="passagem-subtitulo">Pendências herdadas (${estado.herdadas.length})</h4>
            <p class="passagem-ajuda">Feche cada uma antes de publicar: "Resolvida" ou "Continua" (passa para o próximo turno), sempre com "Como foi resolvido". Fica registrado como fechada pelo nome em "Seu nome".</p>
            ${estado.herdadas.map((p) => {
                const id = esc(p.id);
                const f = estado.fechamentos[p.id] || {};
                return `
                <fieldset class="pendencia-herdada" data-pendencia-id="${id}">
                    <legend class="pendencia-herdada-texto">${esc(p.texto)}</legend>
                    <p class="passagem-meta">Da passagem do ${esc(p.turno)} de ${esc(dataBr(p.data))}${p.origem_id ? ' · já veio de um turno anterior' : ''}</p>
                    <div class="pendencia-escolha">
                        <label><input type="radio" name="fechar-${id}" value="resolvida" data-fechar-status="${id}"${f.status === 'resolvida' ? ' checked' : ''}> Resolvida</label>
                        <label><input type="radio" name="fechar-${id}" value="continua" data-fechar-status="${id}"${f.status === 'continua' ? ' checked' : ''}> Continua</label>
                    </div>
                    <label class="passagem-campo">
                        <span>Como foi resolvido <span class="passagem-obrigatorio" aria-hidden="true">*</span></span>
                        <textarea rows="2" maxlength="1000" data-fechar-resolucao="${id}" aria-required="true"
                            placeholder="O que foi feito (ou por que continua)">${esc(f.resolucao || '')}</textarea>
                    </label>
                </fieldset>`;
            }).join('')}`;
    }

    // Falta fechar alguma? Marca os campos e devolve o primeiro a corrigir
    function conferirFechamentos() {
        let primeiro = null;
        estado.herdadas.forEach((p) => {
            const f = estado.fechamentos[p.id] || {};
            const caixa = document.querySelector(`[data-pendencia-id="${CSS.escape(p.id)}"]`);
            if (!caixa) return;
            const semStatus = !['resolvida', 'continua'].includes(f.status);
            const semResolucao = !String(f.resolucao || '').trim();
            caixa.classList.toggle('pendencia-incompleta', semStatus || semResolucao);
            const texto = caixa.querySelector('[data-fechar-resolucao]');
            if (texto) texto.setAttribute('aria-invalid', String(semResolucao));
            if (!primeiro && (semStatus || semResolucao)) primeiro = semStatus ? caixa.querySelector('input[type="radio"]') : texto;
        });
        return primeiro;
    }

    /* ------------------------------------------------------------------------
       Ações
       ------------------------------------------------------------------------ */
    async function chamarFuncaoPassagem(corpo) {
        const c = window.supabaseClient;
        const base = typeof SUPABASE_CONFIG !== 'undefined' ? SUPABASE_CONFIG : null;
        if (!c || !base) return { ok: false, status: 0, dados: { erro: 'Serviço indisponível no momento.' } };
        const { data } = await c.auth.getSession();
        const token = data && data.session && data.session.access_token;
        if (!token) return { ok: false, status: 401, dados: { erro: 'Sessão expirada. Entre novamente.' } };
        try {
            const resp = await fetch(`${base.url}/functions/v1/torre-passagem-turno`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'apikey': base.anonKey, 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(corpo)
            });
            let dados = {};
            try { dados = await resp.json(); } catch (e) { /* resposta sem JSON */ }
            return { ok: resp.ok, status: resp.status, dados };
        } catch (e) {
            return { ok: false, status: 0, dados: { erro: 'Falha de conexão. O seu texto continua na tela; tente de novo.' } };
        }
    }

    async function gerar() {
        if (estado.gerando) return;
        const turno = $('passagem-turno').value;
        const texto = $('passagem-original').value.trim();
        if (!conferirNome()) return;
        if (!turno) return status('Escolha o turno.', 'erro');
        if (!texto) return status('Escreva a passagem antes de gerar.', 'erro');

        const finalEl = $('passagem-final');
        const finalAtual = finalEl.value.trim();
        if (finalAtual && finalAtual !== (estado.textoIa || '').trim()
            && !confirm('Substituir o texto da passagem formal (com as suas edições) pelo novo texto da IA?')) return;

        estado.gerando = true;
        const btn = $('btn-gerar-passagem');
        btn.disabled = true;
        btn.textContent = 'Gerando...';
        status('Gerando a passagem com a IA...');
        try {
            const r = await chamarFuncaoPassagem({ turno, texto });
            if (!r.ok || typeof r.dados.texto_ia !== 'string') {
                status(r.dados.erro || 'Não foi possível gerar a passagem. O seu texto continua na tela.', 'erro');
                return;
            }
            estado.textoIa = r.dados.texto_ia;
            finalEl.value = r.dados.texto_ia;
            const rem = r.dados.removidos || {};
            const removidos = [rem.cpf ? `${rem.cpf} CPF` : '', rem.telefone ? `${rem.telefone} telefone(s)` : ''].filter(Boolean).join(' e ');
            const qtdSugestoes = Array.isArray(r.dados.sugestoes) ? r.dados.sugestoes.length : 0;
            const sugestoes = qtdSugestoes
                ? ` Inclui ${qtdSugestoes} sugestão(ões) de tratativa tirada(s) de passagens anteriores: confira antes de publicar.`
                : '';
            status(`Passagem gerada. Revise e edite antes de publicar.${sugestoes}${removidos ? ` Retirado antes de ir para a IA: ${removidos}.` : ''}`, 'ok');
        } finally {
            estado.gerando = false;
            btn.disabled = false;
            btn.textContent = 'Gerar passagem';
        }
    }

    async function publicar(e) {
        e.preventDefault();
        if (estado.publicando) return;
        const turno = $('passagem-turno').value;
        const data = $('passagem-data').value;
        const original = $('passagem-original').value.trim();
        const final = $('passagem-final').value.trim();
        const nome = conferirNome();
        if (!nome) return;
        if (!turno) return status('Escolha o turno.', 'erro');
        if (!data) return status('Informe a data do turno.', 'erro');
        if (!original) return status('O texto original está vazio.', 'erro');
        if (!final) return status('A passagem formal está vazia: gere ou escreva antes de publicar.', 'erro');
        const faltando = conferirFechamentos();
        if (faltando) {
            faltando.focus();
            return status('Feche cada pendência herdada: escolha "Resolvida" ou "Continua" e preencha "Como foi resolvido".', 'erro');
        }

        estado.publicando = true;
        const btn = $('btn-publicar-passagem');
        btn.disabled = true;
        try {
            const { data: r, error } = await banco().rpc('publicar_passagem', {
                p_turno: turno,
                p_data: data,
                p_texto_original: original,
                p_texto_ia: estado.textoIa,
                p_texto_final: final,
                p_fechamentos: estado.herdadas.map((p) => ({
                    id: p.id,
                    status: estado.fechamentos[p.id].status,
                    resolucao: estado.fechamentos[p.id].resolucao.trim()
                })),
                p_operador_nome: nome
            });
            if (error) {
                status(mensagemErro(error, 'publicar a passagem'), 'erro');
                return;
            }
            $('passagem-original').value = '';
            $('passagem-final').value = '';
            $('passagem-contador').textContent = '0';
            estado.textoIa = null;
            estado.fechamentos = {};
            const partes = [
                r && r.fechadas ? `${r.fechadas} pendência(s) herdada(s) fechada(s)` : '',
                r && r.continuam ? `${r.continuam} continua(m) no próximo turno` : '',
                r && r.novas ? `${r.novas} nova(s) pendência(s) para o próximo turno` : ''
            ].filter(Boolean);
            status(`Passagem publicada.${partes.length ? ` ${partes.join(', ')}.` : ''}`, 'ok');
            await atualizar();
        } catch (erro) {
            status(mensagemErro(erro, 'publicar a passagem'), 'erro');
        } finally {
            estado.publicando = false;
            btn.disabled = false;
        }
    }

    async function salvarHorarios() {
        const valores = {};
        document.querySelectorAll('[data-horario-turno]').forEach((inp) => {
            const t = inp.getAttribute('data-horario-turno');
            (valores[t] = valores[t] || {})[inp.getAttribute('data-horario-campo')] = inp.value || null;
        });
        try {
            for (const t of TURNOS) {
                const v = valores[t] || {};
                const { data, error } = await banco().from('turnos').update({ inicio: v.inicio || null, fim: v.fim || null })
                    .eq('turno', t).select();
                if (error) throw error;
                if (!Array.isArray(data) || data.length === 0) throw Object.assign(new Error('Nenhuma linha alterada.'), { code: '42501' });
            }
            await carregarTurnos();
            status('Horários dos turnos salvos.', 'ok');
        } catch (erro) {
            status(mensagemErro(erro, 'salvar os horários'), 'erro');
        }
    }

    function iniciar() {
        if (estado.iniciado) return;
        estado.iniciado = true;
        const dataEl = $('passagem-data');
        if (dataEl && !dataEl.value) dataEl.value = hojeIso();
        const nomeEl = $('passagem-operador-nome');
        if (nomeEl) {
            if (!nomeEl.value) nomeEl.value = lerNomeSalvo();
            nomeEl.addEventListener('input', () => {
                salvarNome(nomeEl.value.trim());
                if (nomeEl.getAttribute('aria-invalid') === 'true') {
                    const n = nomeEl.value.trim().length;
                    nomeEl.setAttribute('aria-invalid', String(n < NOME_MIN || n > NOME_MAX));
                }
            });
        }

        $('passagem-original')?.addEventListener('input', (e) => {
            $('passagem-contador').textContent = String(e.target.value.length);
        });
        $('btn-gerar-passagem')?.addEventListener('click', gerar);
        $('form-passagem')?.addEventListener('submit', publicar);
        $('btn-salvar-horarios')?.addEventListener('click', salvarHorarios);
        // Fechamento das herdadas: guarda o que o operador marca/escreve (sobrevive a trocar de aba)
        const herdadas = $('passagem-herdadas');
        const guardarFechamento = (e) => {
            const alvo = e.target;
            const id = alvo.getAttribute('data-fechar-status') || alvo.getAttribute('data-fechar-resolucao');
            if (!id) return;
            const f = estado.fechamentos[id] = estado.fechamentos[id] || {};
            if (alvo.hasAttribute('data-fechar-status')) f.status = alvo.value;
            else f.resolucao = alvo.value;
            const caixa = alvo.closest('.pendencia-herdada');
            if (caixa && caixa.classList.contains('pendencia-incompleta')) conferirFechamentos();
        };
        herdadas?.addEventListener('input', guardarFechamento);
        herdadas?.addEventListener('change', guardarFechamento);
        ['historico-data', 'historico-turno'].forEach((id) => {
            $(id)?.addEventListener('change', () => carregarHistorico().catch((erro) => {
                $('passagem-historico').innerHTML = `<p class="passagem-vazio">${esc(mensagemErro(erro, 'ler o histórico'))}</p>`;
            }));
        });
        // "Ver texto original" (na última e no histórico)
        $('torre-passagem')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-passagem-original]');
            if (!btn) return;
            const alvo = document.getElementById(btn.getAttribute('data-passagem-original'));
            if (!alvo) return;
            alvo.hidden = !alvo.hidden;
            btn.setAttribute('aria-expanded', String(!alvo.hidden));
            btn.textContent = alvo.hidden ? 'Ver texto original' : 'Esconder texto original';
        });
        carregarTurnos().catch((erro) => status(mensagemErro(erro, 'ler os horários dos turnos'), 'erro'));
    }

    // Mostra/esconde a tela (as áreas de tabela da Torre somem enquanto ela está aberta)
    function ativar() {
        iniciar();
        if (!estado.ativo) {
            estado.ativo = true;
            atualizar();
        }
        $('torre-passagem').hidden = false;
        ['torre-painel-contadores', 'torre-barra-subfiltros', 'torre-area-principal', 'torre-busca-wrapper']
            .forEach((id) => { const el = $(id); if (el) el.hidden = true; });
    }

    function desativar() {
        if (!estado.ativo) return;
        estado.ativo = false;
        $('torre-passagem').hidden = true;
        ['torre-painel-contadores', 'torre-area-principal', 'torre-busca-wrapper']
            .forEach((id) => { const el = $(id); if (el) el.hidden = false; });
    }

    window.torrePassagem = { ativar, desativar, atualizar, carregarHerdadas };
})();

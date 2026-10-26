// Sino de notificações dos dois dashboards: o da frota só conta fichas de viagem enviadas por motorista
// (não conta rascunho, ficha da gestão nem cadastro) e o do Agregue-se só conta cadastros (não conta
// ficha); toast e título da aba sem CPF/celular; abrir a lista zera o contador; a "última vez que vi"
// fica no localStorage por admin e por dashboard; para com a aba escondida e confere ao voltar.
// O Supabase é falso: aplica os filtros da consulta (select, gt, neq, not is null, order, limit, count)
// sobre os dados abaixo e registra cada consulta.
const { abrir } = require('./harness');

const ADMIN = { role: 'admin', nome: 'Gestão Teste', id: '99999999-9999-9999-9999-999999999999', email: 'gestao@exemplo.invalid' };
const MOTORISTA_ID = '11111111-1111-1111-1111-111111111111';

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: Number(process.argv[2] || 1280) });
  // Registra os setInterval de 60 s (e quando são parados) para conferir a pausa com a aba escondida
  await page.evaluateOnNewDocument(() => {
    window.__intervalos = [];
    const setI = window.setInterval.bind(window);
    const clearI = window.clearInterval.bind(window);
    window.setInterval = (fn, ms, ...a) => { const id = setI(fn, ms, ...a); if (ms === 60000) window.__intervalos.push({ id, ativo: true }); return id; };
    window.clearInterval = (id) => { const i = window.__intervalos.find(x => x.id === id); if (i) i.ativo = false; return clearI(id); };
  });
  await page.goto(`${base}/HTML/index.html`, { waitUntil: 'load' });

  const instalarSupabaseFalso = () => page.evaluate((motoristaId, adminId) => {
    const agora = Date.now();
    const iso = (ms) => new Date(agora + ms).toISOString();
    window.__consultas = [];
    window.__dados = {
      // Uma ficha antiga (antes da "última vez") que não pode contar
      fichas_viagem: [{ id: 'AJB-2026-100', motorista: 'Fulano Antigo', motorista_cpf: '11122233344', status: 'pendente', motorista_id: motoristaId, data_envio: iso(-3600e3), placas: 'ABC1D23', dados_completos: {} }],
      cadastros_agregados: [{ id: 'aaaaaaaa-0000-0000-0000-000000000001', nome: 'Cadastro Antigo', cpf: '55566677788', celular: '11988887777', status: 'pendente', criado_em: iso(-3600e3), dados: {}, documentos: [] }]
    };
    const consulta = (tabela) => {
      const q = { tabela, colunas: '*', filtros: [], ordem: null, limite: null, contar: false };
      const executar = () => {
        let linhas = window.__dados[tabela].slice();
        for (const [op, col, v] of q.filtros) {
          if (op === 'gt') linhas = linhas.filter(l => l[col] > v);
          if (op === 'neq') linhas = linhas.filter(l => l[col] !== null && l[col] !== undefined && l[col] !== v);
          if (op === 'notnull') linhas = linhas.filter(l => l[col] !== null && l[col] !== undefined);
        }
        if (q.ordem) linhas.sort((a, b) => (a[q.ordem.col] < b[q.ordem.col] ? -1 : 1) * (q.ordem.asc ? 1 : -1));
        const total = linhas.length;
        if (q.limite) linhas = linhas.slice(0, q.limite);
        const cols = q.colunas === '*' ? null : q.colunas.split(',').map(c => c.trim());
        const data = linhas.map(l => cols ? Object.fromEntries(cols.map(c => [c, l[c]])) : { ...l });
        window.__consultas.push(`${tabela}: select ${q.colunas} ${q.filtros.map(f => f.join(' ')).join(', ')}${q.limite ? ` limit ${q.limite}` : ''}${q.contar ? ' (count)' : ''}`);
        return { data, count: q.contar ? total : null, error: null };
      };
      const b = {
        select: (c, o) => { q.colunas = c; q.contar = !!(o && o.count); return b; },
        gt: (c, v) => { q.filtros.push(['gt', c, v]); return b; },
        neq: (c, v) => { q.filtros.push(['neq', c, v]); return b; },
        not: (c, op, v) => { if (op === 'is' && v === null) q.filtros.push(['notnull', c]); return b; },
        eq: () => b,
        order: (c, o) => { q.ordem = { col: c, asc: !(o && o.ascending === false) }; return b; },
        limit: (n) => { q.limite = n; return b; },
        then: (res, rej) => Promise.resolve(executar()).then(res, rej)
      };
      return b;
    };
    window.supabaseClient = {
      from: consulta,
      rpc: async () => ({ data: [], error: null }),
      storage: { from: () => ({ list: async () => ({ data: [], error: null }), createSignedUrls: async () => ({ data: [], error: null }), createSignedUrl: async () => ({ data: null, error: null }) }) }
    };
    // A tabela da frota recarrega pelas fichas "do banco"
    window.buscarFichasSupabase = async () => window.__dados.fichas_viagem.map(window.mapearFichaDoSupabase);
  }, MOTORISTA_ID, ADMIN.id);
  const conferirAgora = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))).then(() => new Promise(r => setTimeout(r, 400)));
  const estado = () => page.evaluate(() => {
    const c = document.querySelector('.notif-contador');
    return {
      contador: c.hidden ? '(escondido)' : c.textContent,
      tituloAba: document.title,
      toast: document.getElementById('admin-toast').classList.contains('show') ? document.getElementById('toast-message').textContent : '(sem toast)'
    };
  });
  const semDadoPessoal = (txt) => !/111\.?222\.?333-?44|11122233344|99988877766|55566677788|9\s?8888-?7777|11988887777|22977776666/.test(txt);

  const r = {};
  for (const [nome, url, chave] of [['frota', 'dashboard-admin.html', 'ajborges_notificacoes_frota_'], ['agregue-se', 'Dashboard-cadastro-motorista.html', 'ajborges_notificacoes_agregue-se_']]) {
    await page.evaluate((u) => { localStorage.clear(); localStorage.setItem('teste_usuario', JSON.stringify(u)); }, ADMIN);
    await page.goto(`${base}/HTML/${url}`, { waitUntil: 'load' });
    await new Promise(res => setTimeout(res, 500));
    const m = {};
    // Primeira vez: começa de agora (nada antigo aparece como novo)
    m.chaveLocalStorage = await page.evaluate((k) => Object.keys(localStorage).filter(x => x.startsWith(k)), chave);
    await instalarSupabaseFalso();
    await conferirAgora();
    m.primeiraVez = await estado();

    // Chegam: 1 ficha de motorista, 1 rascunho, 1 ficha criada pela gestão (sem motorista_id),
    // 1 ficha com o id do próprio admin e 1 cadastro de terceiro
    await page.evaluate((motoristaId, adminId) => {
      const iso = new Date(Date.now() + 1000).toISOString();
      window.__dados.fichas_viagem.push(
        { id: 'AJB-2026-500', motorista: 'Fulano Teste', motorista_cpf: '99988877766', status: 'pendente', motorista_id: motoristaId, data_envio: iso, placas: 'ABC1D23', dados_completos: {} },
        { id: 'AJB-2026-501', motorista: 'Rascunho', status: 'rascunho', motorista_id: motoristaId, data_envio: iso, dados_completos: {} },
        { id: 'AJB-2026-502', motorista: 'Criada pela Gestão', status: 'pendente', motorista_id: null, data_envio: iso, dados_completos: {} },
        { id: 'AJB-2026-503', motorista: 'Do Próprio Admin', status: 'pendente', motorista_id: adminId, data_envio: iso, dados_completos: {} });
      window.__dados.cadastros_agregados.push(
        { id: 'aaaaaaaa-0000-0000-0000-000000000002', nome: 'Beltrano Terceiro', cpf: '22233344455', celular: '22977776666', status: 'pendente', criado_em: iso, dados: {}, documentos: [] });
    }, MOTORISTA_ID, ADMIN.id);
    await conferirAgora();
    m.chegou = await estado();
    m.semCpfNoToastNemNoTitulo = semDadoPessoal(m.chegou.toast + m.chegou.tituloAba);
    m.tabelasConsultadas = [...new Set(await page.evaluate(() => window.__consultas.map(c => c.split(':')[0])))];
    m.consulta = await page.evaluate(() => window.__consultas.filter(c => c.includes('(count)')).pop());
    // Tabela recarregada: a frota baixa as fichas de novo (appState) e o Agregue-se roda carregarCadastros
    m.tabelaAtualizou = await page.evaluate((nome) => nome === 'frota'
      // eslint-disable-next-line no-undef
      ? appState.fichas.some(f => f.id === 'AJB-2026-500')
      : window.__consultas.some(c => c.startsWith('cadastros_agregados: select *')), nome);

    // Abrir a lista: mostra as novas e zera o contador e o título; grava a "última vez que vi"
    const vistoAntes = await page.evaluate((k) => { const x = Object.keys(localStorage).find(c => c.startsWith(k)); return localStorage.getItem(x); }, chave);
    await page.click('#btn-notif-sino');
    await new Promise(res => setTimeout(res, 400));
    m.lista = await page.$$eval('.notif-lista li', lis => lis.map(li => li.innerText.replace(/\s+/g, ' ').trim()));
    m.aposAbrir = await estado();
    m.ultimaVezQueVi = await page.evaluate((k, antes) => { const x = Object.keys(localStorage).find(c => c.startsWith(k)); return localStorage.getItem(x) !== antes ? `mudou (${x})` : 'NÃO mudou'; }, chave, vistoAntes);
    // Clicar no item abre a ficha / o cadastro
    await page.click('.notif-item');
    await new Promise(res => setTimeout(res, 600));
    m.abriuItem = await page.evaluate((nome) => nome === 'frota'
      ? (document.getElementById('modal-resumo-ficha')?.classList.contains('active') ? 'modal da ficha aberto' : 'NÃO abriu')
      : (document.getElementById('driver-modal')?.classList.contains('active') ? `modal do cadastro aberto (${document.getElementById('modal-title')?.textContent})` : 'NÃO abriu'), nome);
    // Depois de visto: conferir de novo não conta nada
    await conferirAgora();
    m.depoisDeVisto = await estado();

    // Aba escondida: para o intervalo de 60 s; ao voltar, confere na hora e liga de novo
    m.abaEscondida = await page.evaluate(async () => {
      const ativosAntes = window.__intervalos.filter(i => i.ativo).length;
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const ativosEscondida = window.__intervalos.filter(i => i.ativo).length;
      const consultasAntes = window.__consultas.length;
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise(r => setTimeout(r, 300));
      return `intervalos ativos: ${ativosAntes} -> escondida ${ativosEscondida} -> visível ${window.__intervalos.filter(i => i.ativo).length}; consultou ao voltar: ${window.__consultas.length > consultasAntes ? 'sim' : 'NÃO'}`;
    });
    r[nome] = m;
  }

  // localStorage com erro: o sino funciona (só na memória) e a página não quebra
  await page.evaluateOnNewDocument(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) { if (String(k).startsWith('ajborges_notificacoes')) throw new Error('bloqueado'); return get.call(this, k); };
    Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('ajborges_notificacoes')) throw new Error('bloqueado'); return set.call(this, k, v); };
  });
  const errosAntes = erros.length;
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await new Promise(res => setTimeout(res, 500));
  await instalarSupabaseFalso();
  await conferirAgora();
  await page.evaluate((motoristaId) => window.__dados.fichas_viagem.push({ id: 'AJB-2026-600', motorista: 'Ciclano', status: 'pendente', motorista_id: motoristaId, data_envio: new Date(Date.now() + 1000).toISOString(), dados_completos: {} }), MOTORISTA_ID);
  await conferirAgora();
  r.localStorageComErro = { ...(await estado()), errosNovos: erros.slice(errosAntes).filter(e => !/Chart is not defined/.test(e)) };

  r.erros = erros.filter(e => !/Chart is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

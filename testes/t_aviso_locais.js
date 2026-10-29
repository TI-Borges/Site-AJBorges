// Onde o aviso de atualização aparece (passo 21):
//  1. cada página pede a RPC com o seu local e cada combinação de locais aparece só nos lugares certos
//     (faixa no relatório de viagem/login e nas páginas do site; ícone nos dashboards e no escolhaDashboard,
//     nunca faixa nos dashboards);
//  2. ícone dos dashboards: perto do sino, pontinho até abrir, modal com programada/em atualização, dia,
//     início, término e descrição escapada; ids vistos no localStorage (e sem localStorage não quebra);
//     360 px sem rolagem lateral;
//  3. modal da gestão: "Todos" e as 4 caixas, não salva sem nenhuma, grava locais, lista mostra onde.
// A RPC é simulada no navegador (fetch e supabaseClient falsos) e filtra por p_local como o banco;
// aviso novo ou removido é conferido recarregando a página (no painel o visibilitychange também recarrega os dados).
const { abrir } = require('./harness');

const HORA = 3600 * 1000;
const ADMIN = { role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' };
const MOTORISTA = { role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '00000000000' };
const PAGINAS = [
  ['relatorio-viagem', MOTORISTA], ['Login', null], ['index', null], ['FichaMultiCadastro', null], ['Nossosfretes', null],
  ['Sobrenos', null], ['Contato', null], ['dashboard-admin', ADMIN], ['escolhaDashboard', ADMIN], ['Dashboard-cadastro-motorista', ADMIN]
];

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  await page.evaluateOnNewDocument(() => {
    // Mesmo filtro da RPC: o aviso tem p_local nos locais; frota e cadastro só para a gestão
    const filtrar = (local) => {
      const v = localStorage.getItem('teste_avisos') || '[]';
      const lista = JSON.parse(v);
      const usuario = JSON.parse(localStorage.getItem('teste_usuario') || 'null');
      const gestao = !!usuario && usuario.role === 'admin' && window.__comSessao;
      if (!['ficha', 'site', 'frota', 'cadastro'].includes(local)) return [];
      if ((local === 'frota' || local === 'cadastro') && !gestao) return [];
      return lista.filter(a => (a.locais || ['frota', 'cadastro', 'ficha', 'site']).includes(local));
    };
    window.__locaisPedidos = [];
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (url, opcoes) => {
      if (String(url).includes('/rest/v1/rpc/avisos_atualizacao_ativos')) {
        const corpo = JSON.parse((opcoes && opcoes.body) || '{}');
        window.__locaisPedidos.push(`fetch ${corpo.p_local}`);
        // fetch vai só com a chave pública (sem sessão)
        window.__comSessao = false;
        return Promise.resolve(new Response(JSON.stringify(filtrar(corpo.p_local)), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return fetchOriginal(url, opcoes);
    };
    // Cliente com sessão (dashboards). O resto do painel recebe listas vazias.
    const vazio = () => new Proxy(function () { }, {
      get: (t, p) => (p === 'then' ? (res) => res({ data: [], error: null, count: 0 }) : vazio()),
      apply: () => vazio()
    });
    window.__insercoes = [];
    window.supabaseClient = {
      rpc: async (nome, args) => {
        if (nome !== 'avisos_atualizacao_ativos') return { data: [], error: null };
        window.__locaisPedidos.push(`rpc ${args && args.p_local}`);
        window.__comSessao = true;
        return { data: filtrar(args && args.p_local), error: null };
      },
      from: (tabela) => tabela === 'avisos_atualizacao'
        ? { insert: async (obj) => { window.__insercoes.push(obj); return { error: null }; }, update: () => ({ eq: async () => ({ error: null }) }) }
        : vazio(),
      auth: vazio(), storage: vazio(), channel: vazio, removeChannel: () => { }
    };
    window.Chart = class { constructor() { } destroy() { } update() { } static getChart() { return null; } };
    // No site a sessão é conferida no servidor (assíncrono); o auth falso chama na hora e esbarra nos
    // let do fim do dashboard-admin.js. Aqui o retorno vem depois, como no site.
    let aoAutenticar;
    Object.defineProperty(window, 'ajbAoAutenticar', {
      configurable: true,
      get: () => aoAutenticar,
      set: (fn) => { aoAutenticar = (...args) => setTimeout(() => fn(...args), 0); }
    });
  });
  await page.goto(`${base}/HTML/index.html`, { waitUntil: 'load' });
  const espera = (ms) => new Promise(res => setTimeout(res, ms));
  const aviso = (id, inicioRel, fimRel, descricao, locais) => ({ id, inicio: new Date(Date.now() + inicioRel).toISOString(), fim: new Date(Date.now() + fimRel).toISOString(), descricao, locais });
  const preparar = (avisos, usuario, extra = {}) => page.evaluate((avisos, usuario, extra) => {
    localStorage.clear();
    localStorage.setItem('teste_avisos', JSON.stringify(avisos));
    if (usuario) localStorage.setItem('teste_usuario', JSON.stringify(usuario));
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
  }, avisos, usuario, extra);
  const abrirPagina = async (pag) => {
    await page.goto(`${base}/HTML/${pag}.html${pag === 'relatorio-viagem' ? '?novo=true' : ''}`, { waitUntil: 'load' });
    await espera(500);
  };
  const oQueAparece = () => page.evaluate(() => {
    const f = document.querySelector('.aviso-atualizacao-faixa');
    const b = document.getElementById('btn-aviso-local');
    if (f) return `faixa "${f.textContent.match(/Teste \w+/)?.[0] || f.textContent.slice(0, 40)}"`;
    if (b && !b.hidden) return `ícone${b.querySelector('.aviso-local-ponto').hidden ? '' : ' com pontinho'}`;
    return '—';
  });
  const r = {};

  // 1. Local pedido por página e matriz combinação x lugar
  r.localPedido = {};
  for (const [pag, usuario] of PAGINAS) {
    await preparar([], usuario);
    await abrirPagina(pag);
    r.localPedido[pag] = await page.evaluate(() => window.__locaisPedidos.join(', '));
  }
  const COMBINACOES = [['site'], ['ficha'], ['frota'], ['cadastro'], ['frota', 'ficha'], ['cadastro', 'site'], ['frota', 'cadastro'], ['frota', 'cadastro', 'ficha', 'site']];
  r.matriz = [];
  for (const locais of COMBINACOES) {
    const linha = [];
    for (const [pag, usuario] of PAGINAS) {
      await preparar([aviso(1, 2 * HORA, 4 * HORA, `Teste ${locais.join('_')}`, locais)], usuario);
      await abrirPagina(pag);
      linha.push(`${pag}: ${await oQueAparece()}`);
    }
    r.matriz.push(`[${locais.join(', ')}] → ${linha.filter(l => !l.endsWith('—')).join(' | ') || 'nenhum lugar'}`);
  }
  // Nos dashboards nunca há faixa, mesmo com aviso de todos os lugares
  r.faixaNosDashboards = [];
  for (const pag of ['dashboard-admin', 'Dashboard-cadastro-motorista', 'escolhaDashboard']) {
    await preparar([aviso(1, -1 * HORA, 1 * HORA, 'Teste todos', ['frota', 'cadastro', 'ficha', 'site'])], ADMIN);
    await abrirPagina(pag);
    r.faixaNosDashboards.push(`${pag}: ${await page.evaluate(() => document.querySelectorAll('.aviso-atualizacao-faixa').length)} faixa(s)`);
  }

  // 2. Ícone e modal nos dashboards
  r.icone = {};
  const DESC = 'Nova tela <img src=x onerror="window.__xss=1"> & "fichas"';
  for (const [nome, pag, local] of [['frota', 'dashboard-admin', 'frota'], ['cadastro', 'Dashboard-cadastro-motorista', 'cadastro'], ['escolha', 'escolhaDashboard', 'frota']]) {
    const t = {};
    await page.setViewport({ width: 1366, height: 800 });
    await preparar([aviso(21, -1 * HORA, 2 * HORA, 'Troca do servidor', [local]), aviso(22, 26 * HORA, 27 * HORA, DESC, [local])], ADMIN);
    await abrirPagina(pag);
    t.posicao = await page.evaluate(() => {
      const b = document.getElementById('btn-aviso-local');
      const sino = document.querySelector('.notif-sino-wrap');
      if (sino) return b.nextElementSibling === sino ? 'logo antes do sino' : 'LONGE do sino';
      const rr = b.getBoundingClientRect();
      return `${getComputedStyle(b.parentElement).position} no canto (${Math.round(window.innerWidth - rr.right)}px da direita, ${Math.round(rr.top)}px do topo)`;
    });
    t.antes = await oQueAparece();
    t.rotulo = await page.$eval('#btn-aviso-local', b => b.getAttribute('aria-label'));
    await page.click('#btn-aviso-local');
    await espera(200);
    t.modal = await page.evaluate(() => {
      const m = document.getElementById('modal-aviso-local');
      return { aberto: !m.hidden, foco: document.activeElement.className, itens: Array.from(m.querySelectorAll('.aviso-local-item')).map(li => li.innerText.replace(/\s+/g, ' ').trim()) };
    });
    t.descricaoEscapada = await page.evaluate(() => !document.querySelector('#modal-aviso-local img') && !window.__xss);
    t.depoisDeAbrir = await oQueAparece();
    t.vistos = await page.evaluate((k) => localStorage.getItem(k), `ajborges_avisos_vistos_${local}`);
    await page.keyboard.press('Escape');
    await espera(100);
    t.escFecha = await page.evaluate(() => document.getElementById('modal-aviso-local').hidden && document.activeElement.id === 'btn-aviso-local');
    await page.reload({ waitUntil: 'load' });
    await espera(500);
    t.depoisDeRecarregar = await oQueAparece();
    // Chega um aviso novo
    await page.evaluate((novo) => { const l = JSON.parse(localStorage.getItem('teste_avisos')); l.push(novo); localStorage.setItem('teste_avisos', JSON.stringify(l)); }, aviso(23, 48 * HORA, 49 * HORA, 'Outro', [local]));
    await page.reload({ waitUntil: 'load' });
    await espera(500);
    t.avisoNovo = await oQueAparece();
    // Sem aviso para este local: some
    await page.evaluate(() => localStorage.setItem('teste_avisos', JSON.stringify([{ id: 30, inicio: new Date(Date.now() + 3600e3).toISOString(), fim: new Date(Date.now() + 7200e3).toISOString(), descricao: 'Só site', locais: ['site'] }])));
    await page.reload({ waitUntil: 'load' });
    await espera(500);
    t.semAvisoDoLocal = await oQueAparece();
    // 360 px: com o ícone, sem rolagem lateral e ícone dentro da tela
    await preparar([aviso(21, -1 * HORA, 2 * HORA, 'Troca do servidor', [local])], ADMIN);
    await page.setViewport({ width: 360, height: 780 });
    await abrirPagina(pag);
    t.em360 = await page.evaluate(() => {
      const b = document.getElementById('btn-aviso-local').getBoundingClientRect();
      return `ícone ${b.left >= 0 && b.right <= window.innerWidth ? 'dentro da tela' : 'FORA da tela'}, rolagemH=${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'}`;
    });
    await page.click('#btn-aviso-local');
    await espera(200);
    t.modalEm360 = await page.evaluate(() => {
      const c = document.querySelector('.aviso-local-caixa').getBoundingClientRect();
      return `${Math.round(c.width)}px, ${c.left >= 0 && c.right <= window.innerWidth ? 'cabe' : 'NÃO cabe'}`;
    });
    r.icone[nome] = t;
  }
  // Sem localStorage (bloqueado): não quebra, o pontinho some ao abrir (fica na memória)
  await page.setViewport({ width: 1366, height: 800 });
  await preparar([aviso(41, 2 * HORA, 3 * HORA, 'Sem storage', ['frota'])], ADMIN);
  const errosAntes = erros.length;
  await page.evaluateOnNewDocument(() => {
    if (location.pathname.endsWith('dashboard-admin.html')) {
      const g = Storage.prototype.getItem;
      const s = Storage.prototype.setItem;
      Storage.prototype.getItem = function (k) { if (String(k).startsWith('ajborges_avisos_vistos')) throw new Error('bloqueado'); return g.call(this, k); };
      Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('ajborges_avisos_vistos')) throw new Error('bloqueado'); return s.call(this, k, v); };
    }
  });
  await abrirPagina('dashboard-admin');
  const semStorage = { antes: await oQueAparece() };
  await page.click('#btn-aviso-local');
  await espera(200);
  await page.keyboard.press('Escape');
  semStorage.depois = await oQueAparece();
  semStorage.erros = erros.slice(errosAntes).filter(e => /aviso/i.test(e));
  r.semLocalStorage = semStorage;

  // 3. Modal da gestão: caixas, bloqueio, gravação e lista
  r.gestao = {};
  for (const [nome, pag] of [['frota', 'dashboard-admin'], ['cadastro', 'Dashboard-cadastro-motorista']]) {
    const g = {};
    await preparar([aviso(51, -1 * HORA, 1 * HORA, 'Em andamento', ['frota', 'ficha']), aviso(52, 24 * HORA, 26 * HORA, 'De todos', ['frota', 'cadastro', 'ficha', 'site']), aviso(53, 30 * HORA, 31 * HORA, 'Só <b>site</b>', ['site'])], ADMIN);
    await abrirPagina(pag);
    await page.click('#btn-aviso-atualizacao');
    await espera(300);
    const caixas = () => page.evaluate(() => {
      const todos = document.getElementById('aviso-atu-local-todos').checked ? '☑' : '☐';
      const quatro = Array.from(document.querySelectorAll('input[name="aviso-atu-local"]')).map(c => `${c.checked ? '☑' : '☐'}${c.value}`).join(' ');
      const msg = document.getElementById('aviso-atu-locais-msg');
      return `Todos ${todos} | ${quatro} | salvar ${document.getElementById('aviso-atu-salvar').disabled ? 'BLOQUEADO' : 'liberado'}${msg.hidden ? '' : ` ("${msg.textContent}")`}`;
    });
    const clicar = async (sel) => { await page.click(sel); await espera(50); };
    g.ordem = await page.evaluate(() => Array.from(document.querySelectorAll('#aviso-atu-form > *')).map(e => e.id || e.querySelector('input,textarea')?.id).join(' → '));
    g.legenda = await page.$eval('#aviso-atu-locais legend', e => e.textContent.trim());
    g.rotulos = await page.$$eval('#aviso-atu-locais label', ls => ls.map(l => l.textContent.trim()));
    g.explica = await page.$eval('.aviso-atu-explica', e => e.textContent.replace(/\s+/g, ' ').trim());
    g.padrao = await caixas();
    await clicar('input[value="site"]');
    g.desmarcaUma = await caixas();
    await clicar('input[value="site"]');
    g.marcaDeNovo = await caixas();
    await clicar('#aviso-atu-local-todos');
    g.desmarcaTodos = await caixas();
    // Tenta salvar com tudo preenchido e nenhuma caixa (o botão está bloqueado; o clique não grava)
    const campo = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
    await campo('#aviso-atu-inicio', '2030-01-15T14:00');
    await campo('#aviso-atu-fim', '2030-01-15T16:00');
    await campo('#aviso-atu-descricao', 'Troca do servidor');
    await page.$eval('#aviso-atu-salvar', b => b.click());
    await espera(200);
    g.semNenhumaNaoGrava = await page.evaluate(() => `${window.__insercoes.length} gravação(ões)`);
    await clicar('#aviso-atu-local-todos');
    g.marcaTodos = await caixas();
    for (const v of ['cadastro', 'site']) await clicar(`input[value="${v}"]`);
    g.frotaEFicha = await caixas();
    await page.click('#aviso-atu-salvar');
    await espera(300);
    g.gravou = await page.evaluate(() => JSON.stringify(window.__insercoes.map(i => i.locais)));
    g.depoisDeSalvar = await caixas();
    g.lista = await page.$$eval('#aviso-atu-lista li', lis => lis.map(li => li.innerText.replace(/\s+/g, ' ').replace(' Cancelar aviso', '').trim()));
    g.listaEscapada = await page.$eval('#aviso-atu-lista', el => !el.querySelector('.aviso-atu-item-texto p b'));
    g.consultasDaLista = await page.evaluate(() => window.__locaisPedidos.filter(x => x.startsWith('rpc')).join(', '));
    await page.setViewport({ width: 360, height: 780 });
    await espera(1000); // termina a transição do layout ao redimensionar
    g.em360 = await page.evaluate(() => {
      const f = document.getElementById('aviso-atu-locais').getBoundingClientRect();
      return `caixas ${f.left >= 0 && f.right <= window.innerWidth ? 'cabem' : 'NÃO cabem'}, rolagemH=${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'}`;
    });
    await page.setViewport({ width: 1366, height: 800 });
    r.gestao[nome] = g;
  }

  r.erros = erros.filter(e => !/Swiper is not defined|limparDadosLocais/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

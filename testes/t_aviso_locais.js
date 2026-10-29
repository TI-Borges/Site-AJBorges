// Onde o aviso de atualização aparece (passo 21):
//  1. cada página pede a RPC com o seu local e cada combinação de locais aparece só nos lugares certos
//     (faixa em todos: relatório de viagem/login, páginas do site, dashboards e escolhaDashboard);
//  2. dashboards: a faixa fica em cima do conteúdo, sem cobrir a barra lateral (aberta, recolhida e a gaveta
//     do celular), descrição escapada, e não sobra ícone, modal nem ids vistos no localStorage;
//  3. modal da gestão: "Todos" e as 4 caixas, não salva sem nenhuma, grava locais, lista mostra onde.
// A RPC é simulada no navegador (fetch e supabaseClient falsos) e filtra por p_local como o banco.
const { abrir } = require('./harness');

const HORA = 3600 * 1000;
const ADMIN = { role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' };
const MOTORISTA = { role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '00000000000' };
const PAGINAS = [
  ['relatorio-viagem', MOTORISTA], ['Login', null], ['index', null], ['FichaMultiCadastro', null], ['Nossosfretes', null],
  ['Sobrenos', null], ['Contato', null], ['politica-privacidade', null], ['dashboard-admin', ADMIN], ['escolhaDashboard', ADMIN], ['Dashboard-cadastro-motorista', ADMIN]
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
    if (f) return `faixa "${f.textContent.match(/Teste \w+/)?.[0] || f.textContent.slice(0, 40)}"`;
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
  // 2. Faixa nos dashboards: em cima do conteúdo, sem cobrir a barra lateral (aberta, recolhida e a
  //    gaveta do celular); descrição escapada; sem ícone, modal ou ids vistos
  r.painel = {};
  const DESC = 'Nova tela <img src=x onerror="window.__xss=1"> & "fichas"';
  const medirFaixa = () => page.evaluate(() => {
    const f = document.querySelector('.aviso-atualizacao-faixa');
    if (!f) return 'SEM faixa';
    const rf = f.getBoundingClientRect();
    const sb = document.getElementById('admin-sidebar');
    const rs = sb ? sb.getBoundingClientRect() : null;
    const topo = document.querySelector('.admin-topbar');
    const rt = topo ? topo.getBoundingClientRect() : null;
    const sobreposta = rs && rs.right > 0 && rf.left < rs.right - 0.5 && rf.right > rs.left;
    return [
      `faixa x ${Math.round(rf.left)}–${Math.round(rf.right)} y ${Math.round(rf.top)}–${Math.round(rf.bottom)}`,
      rs ? `barra ${Math.round(rs.left)}–${Math.round(rs.right)}` : 'sem barra',
      `dentro de ${f.parentElement.className || f.parentElement.tagName.toLowerCase()}`,
      rt ? `topbar começa em ${Math.round(rt.top)} (${rt.top >= rf.bottom - 0.5 ? 'abaixo da faixa' : 'EM CIMA da faixa'})` : '',
      sobreposta ? `sobrepõe a barra: ${sb.contains(document.elementFromPoint(Math.round((Math.max(rf.left, rs.left) + Math.min(rf.right, rs.right)) / 2), Math.round(rf.top + rf.height / 2))) ? 'barra por cima' : 'FAIXA COBRE A BARRA'}` : 'não sobrepõe a barra',
      `rolagemH=${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'}`
    ].filter(Boolean).join(' | ');
  });
  const restosDoIcone = () => page.evaluate(() => [
    document.getElementById('btn-aviso-local') ? 'ícone' : '', document.getElementById('modal-aviso-local') ? 'modal' : '',
    ...Object.keys(localStorage).filter(k => k.startsWith('ajborges_avisos_vistos'))].filter(Boolean).join(', ') || 'nenhum');
  for (const [nome, pag, local] of [['frota', 'dashboard-admin', 'frota'], ['cadastro', 'Dashboard-cadastro-motorista', 'cadastro'], ['escolha', 'escolhaDashboard', 'frota']]) {
    const t = {};
    for (const w of [1366, 1920]) {
      await page.setViewport({ width: w, height: 800 });
      await preparar([aviso(21, 26 * HORA, 27 * HORA, DESC, [local])], ADMIN);
      await abrirPagina(pag);
      t[`${w} aberta`] = await medirFaixa();
      if (nome !== 'escolha') {
        await page.click('#sidebar-brand');
        await espera(400);
        t[`${w} recolhida`] = await medirFaixa();
        await page.reload({ waitUntil: 'load' });
        await espera(600);
        t[`${w} recolhida, recarregada`] = await medirFaixa();
      }
    }
    t.texto = await page.$eval('.aviso-atualizacao-faixa', f => f.textContent.replace(/\s+/g, ' ').trim());
    t.descricaoEscapada = await page.evaluate(() => !document.querySelector('.aviso-atualizacao-faixa img') && !window.__xss);
    await preparar([aviso(22, -1 * HORA, 1 * HORA, 'Troca do servidor', [local])], ADMIN);
    await abrirPagina(pag);
    t.emAndamento = await page.$eval('.aviso-atualizacao-faixa', f => `${f.classList.contains('aviso-em-andamento') ? 'vermelha' : 'amarela'}: ${f.textContent.replace(/\s+/g, ' ').trim()}`);
    // Celular: faixa no topo; na frota, a gaveta aberta fica por cima da faixa
    await page.setViewport({ width: 390, height: 780 });
    await abrirPagina(pag);
    t['390'] = await medirFaixa();
    if (nome === 'frota') {
      await page.click('#btn-mobile-menu');
      await espera(500);
      t['390 gaveta aberta'] = await medirFaixa();
    }
    t.restosDoIcone = await restosDoIcone();
    r.painel[nome] = t;
  }

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

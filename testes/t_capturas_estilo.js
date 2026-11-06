// Prints de estilo (setas dos carrosséis, ícones de Nossos Fretes, abas do Login e fonte única) em 1366 e 390 px,
// com o Google Fonts e o Swiper carregando de verdade (REDE_FONTES=1 no harness). Dados INVENTADOS: nada vai
// para o Supabase. Também mede a rolagem lateral de cada tela (scrollWidth > largura).
// Uso: node testes/t_capturas_estilo.js <antes|depois>  -> testes/capturas/estilo_<sufixo>_<tela>_<largura>.png
process.env.REDE_FONTES = '1';
const fs = require('fs');
const path = require('path');
const { abrir } = require('./harness');
const SUF = process.argv[2] || 'atual';
const CAP = path.join(__dirname, 'capturas');
fs.mkdirSync(CAP, { recursive: true });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const nome = (tela, largura) => path.join(CAP, `estilo_${SUF}_${tela}_${largura}.png`);

// Views da Torre: a mesma massa simulada do t_torre_interface.js (função copiada do próprio arquivo)
const fonteTorre = fs.readFileSync(path.join(__dirname, 'torre', 't_torre_interface.js'), 'utf8');
const ini = fonteTorre.indexOf('function criarViewsSimuladas');
const criarViewsSimuladas = new Function(`${fonteTorre.slice(ini, fonteTorre.indexOf('\n}\n', ini) + 2)}; return criarViewsSimuladas;`)();

function dadosRh() {
  const t = '2026-10-01T12:00:00Z';
  const colab = (id, nome, cargo, setor, vinculo, situacao, adm, exame) => ({ id, nome, cargo, setor, vinculo, situacao, data_admissao: adm, data_proximo_exame: exame, ativo: true, criado_em: t });
  return {
    colaboradores: [
      colab('c1', 'Fulano de Teste', 'Motorista', 'Operação', 'CLT', 'Ativo', '2024-03-11', '2026-11-20'),
      colab('c2', 'Beltrana de Teste', 'Analista de RH', 'Administrativo', 'CLT', 'Ativo', '2023-07-01', '2027-02-10'),
      colab('c3', 'Ciclano de Teste', 'Consultor', 'Comercial', 'PJ', 'Ativo', '2025-01-15', ''),
      colab('c4', 'Sicrana de Teste', 'Estagiária', 'Financeiro', 'Estagiário', 'Em admissão', '2026-10-20', ''),
      colab('c5', 'Deltrano de Teste', 'Mecânico', 'Manutenção', 'CLT', 'Em desligamento', '2022-05-02', '2026-09-30')
    ],
    modelos: [{ id: 'm1', chave: 'rescisao_clt', nome: 'Rescisão CLT', ativo: true }, { id: 'm2', chave: 'exame_periodico', nome: 'Exame periódico', ativo: true }],
    modelo_etapas: [{ id: 'me1', modelo_id: 'm1', nome: 'Comunicação', ordem: 1, ativo: true }, { id: 'me2', modelo_id: 'm1', nome: 'Exame demissional', ordem: 2, ativo: true }],
    processos: [{ id: 'p1', colaborador_id: 'c5', modelo_id: 'm1', modelo_nome: 'Rescisão CLT', cancelado: false, criado_em: t }],
    etapas: [{ id: 'e1', processo_id: 'p1', ordem: 1, nome: 'Comunicação', concluida: true, ativo: true }, { id: 'e2', processo_id: 'p1', ordem: 2, nome: 'Exame demissional', concluida: false, prazo: '2026-11-15', ativo: true }],
    observacoes: [], anexos: [],
    contratos_pj: [{ id: 'ct1', colaborador_id: 'c3', inicio: '2025-01-15', fim: '2026-12-31', valor: 8500, aviso_dias: 30, ativo: true }],
    exames: [{ id: 'x1', colaborador_id: 'c1', tipo: 'periodico', data_realizacao: '2025-11-20', vencimento: '2026-11-20', ativo: true, criado_em: t }],
    ferias: [{ id: 'f1', colaborador_id: 'c2', aquisitivo_inicio: '2025-07-01', saldo_dias: 30, ativo: true }]
  };
}

// Cliente Supabase falso: schema(x).from(tabela) devolve as linhas de window.__mockTabelas
function instalarMock(tabelas) {
  localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Admin Teste', id: 'a1', email: 'admin@teste.local' }));
  window.__mockTabelas = tabelas;
  const ler = (nome) => Promise.resolve({ data: (window.__mockTabelas || {})[nome] || [], error: null });
  const consulta = (nome) => {
    const q = {
      select: () => q, order: () => q, eq: () => q, in: () => q, limit: () => q,
      single: () => ler(nome).then((r) => ({ data: r.data[0] || null, error: null })),
      maybeSingle: () => ler(nome).then((r) => ({ data: r.data[0] || null, error: null })),
      then: (a, b) => ler(nome).then(a, b)
    };
    return q;
  };
  const cliente = {
    auth: { getUser: async () => ({ data: { user: { id: 'a1', email: 'admin@teste.local' } }, error: null }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) },
    from: consulta, rpc: async () => ({ data: [], error: null }),
    schema: () => ({ from: consulta, rpc: async () => ({ data: [], error: null }) }),
    storage: { from: () => ({ list: async () => ({ data: [] }) }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {}
  };
  window.supabase = { createClient: () => cliente };
  window.supabaseClient = cliente;
}

async function rolagemLateral(page, largura, tela, problemas) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  if (sw > largura) problemas.push(`${tela} ${largura}px: scrollWidth ${sw}`);
}

async function revelar(page) {
  await page.evaluate(() => document.querySelectorAll('.reveal-up,.reveal-left,.reveal-right,.reveal-scale,.reveal-fade').forEach((e) => e.classList.add('revealed')));
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await espera(900);
}

async function clipDe(page, seletores) {
  return page.evaluate((sels) => {
    const rs = sels.map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect());
    const top = Math.min(...rs.map((r) => r.top)) + scrollY, bottom = Math.max(...rs.map((r) => r.bottom)) + scrollY;
    return { x: 0, y: Math.max(0, top - 16), width: document.documentElement.clientWidth, height: bottom - top + 32 };
  }, seletores);
}

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  const problemas = [];
  // Página nova com o Supabase falso (o mock fica preso a ela, sem afetar a ficha nem o site)
  const novaPagina = async (largura, altura, tabelas) => {
    const p = await browser.newPage();
    await p.setRequestInterception(true);
    p.on('pageerror', (e) => erros.push(String(e)));
    p.on('request', (r) => {
      const u = r.url();
      if (/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)/.test(u)) return r.continue();
      if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/javascript', body: '' });
      r.continue();
    });
    await p.setViewport({ width: largura, height: altura });
    await p.evaluateOnNewDocument(instalarMock, tabelas);
    return p;
  };
  const fontes = {};
  for (const largura of [1366, 390]) {
    const altura = largura === 1366 ? 768 : 844;
    await page.setViewport({ width: largura, height: altura });

    // 1. Página inicial: carrossel do topo e carrossel da frota (+ lightbox)
    await page.goto(`${base}/HTML/index.html`, { waitUntil: 'networkidle2' });
    await page.evaluate(() => { const s = document.querySelector('.swiper'); if (s && s.swiper) s.swiper.autoplay && s.swiper.autoplay.stop(); });
    await revelar(page);
    await rolagemLateral(page, largura, 'index', problemas);
    fontes[`index_${largura}`] = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    await (await page.$('.hero-carousel-container')).screenshot({ path: nome('carrossel_topo', largura) });
    await page.evaluate(() => document.querySelector('.frota-slider-wrapper').scrollIntoView({ block: 'center' }));
    await espera(500);
    await (await page.$('.frota-slider-wrapper')).screenshot({ path: nome('carrossel_frota', largura) });
    await page.evaluate(() => document.getElementById('btnAbrirGaleria').click());
    await espera(700);
    await page.screenshot({ path: nome('lightbox_frota', largura) });

    // 2. Nossos Fretes: ícones do mural e das vantagens
    await page.goto(`${base}/HTML/Nossosfretes.html`, { waitUntil: 'networkidle2' });
    await revelar(page);
    await rolagemLateral(page, largura, 'Nossosfretes', problemas);
    await page.screenshot({ path: nome('nossosfretes_icones', largura), clip: await clipDe(page, ['.fretebras-info-grid', '.vantagens-section']) });

    // 3. Login: as duas abas (o auth.js de teste não tem limparDadosLocais; sem ele o login.js para antes das abas)
    const pL = await browser.newPage();
    await pL.setRequestInterception(true);
    pL.on('pageerror', (e) => erros.push(String(e)));
    pL.on('request', (r) => {
      const u = r.url();
      if (/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)/.test(u)) return r.continue();
      if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/javascript', body: '' });
      r.continue();
    });
    await pL.setViewport({ width: largura, height: altura });
    await pL.evaluateOnNewDocument(() => {
      let a;
      Object.defineProperty(window, 'ajbAuth', { configurable: true, get: () => a, set: (v) => { a = v; if (v && !v.limparDadosLocais) v.limparDadosLocais = () => {}; } });
    });
    await pL.goto(`${base}/HTML/Login.html`, { waitUntil: 'networkidle2' });
    await revelar(pL);
    await rolagemLateral(pL, largura, 'Login', problemas);
    const alturas = {};
    for (const aba of ['motorista', 'admin', 'motorista']) {
      await pL.click(`#tab-${aba}`);
      await espera(700);
      const h = await pL.$eval('.login-card', (c) => Math.round(c.getBoundingClientRect().height));
      alturas[aba] = alturas[aba] ? `${alturas[aba]}/${h}` : h;
      await (await pL.$('.login-card')).screenshot({ path: nome(`login_${aba}`, largura) });
    }
    // Durante a troca: maior variação de altura do cartão
    const variacao = await pL.evaluate(async () => {
      const c = document.querySelector('.login-card'); const hs = [];
      document.getElementById('tab-admin').click();
      for (let i = 0; i < 40; i++) { hs.push(c.getBoundingClientRect().height); await new Promise((r) => requestAnimationFrame(r)); }
      return Math.round(Math.max(...hs) - Math.min(...hs));
    });
    console.log(`${largura}px Login: altura do cartão ${JSON.stringify(alturas)}; variação durante a troca=${variacao}px`);
    await pL.close();

    // 4. Ficha de viagem (motorista)
    await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '12345678900' })));
    await page.goto(`${base}/HTML/relatorio-viagem.html`, { waitUntil: 'networkidle2' });
    await revelar(page);
    await rolagemLateral(page, largura, 'ficha', problemas);
    await page.screenshot({ path: nome('ficha', largura), fullPage: true });

    // 5. Painel de cadastros (lista com dados inventados)
    const pC = await novaPagina(largura, altura, {});
    await pC.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'networkidle2' });
    await pC.evaluate(() => {
      const b = { criado_em: '2026-10-27T12:00:00Z', etapas: {}, documentos: [], dados: {}, tipo: 'pf' };
      cadastros = [ // eslint-disable-line no-undef
        { ...b, id: 'k1', status: 'pendente', nome: 'Fulano de Teste da Silva', cpf: '52316915930', celular: '11900000000', anotacoes: 'Ligar depois das 18h.', anotado_em: '2026-11-01T10:00:00Z' },
        { ...b, id: 'k2', status: 'aprovado', nome: 'Beltrano de Teste', cpf: '11144477735', celular: '(14) 99858-0000' },
        { ...b, id: 'k3', status: 'analise', nome: 'Ciclano de Teste Oliveira', cpf: '22255588846', celular: '11912345678', tipo: 'pj' },
        { ...b, id: 'k4', status: 'recusado', nome: 'Sicrano de Teste', cpf: '33366699957', celular: '11988887777' }
      ];
      renderTabela(); // eslint-disable-line no-undef
    });
    await revelar(pC);
    await rolagemLateral(pC, largura, 'cadastros', problemas);
    await pC.screenshot({ path: nome('painel_cadastros', largura) });
    await pC.close();

    // 6. Dashboard do RH
    const pRh = await novaPagina(largura, altura, dadosRh());
    await pRh.goto(`${base}/dashboard-rh/HTML/index.html`, { waitUntil: 'networkidle2' });
    await revelar(pRh);
    await rolagemLateral(pRh, largura, 'rh', problemas);
    await pRh.screenshot({ path: nome('rh', largura) });
    await pRh.close();

    // 7. Torre: MATRIZ
    const pT = await novaPagina(largura, altura, criarViewsSimuladas({ minutosDesde: 4 }));
    await pT.goto(`${base}/torre-de-controle-shoppe/HTML/index.html`, { waitUntil: 'networkidle2' });
    await pT.waitForSelector('#torre-tabela-dados tbody tr', { timeout: 8000 }).catch(() => problemas.push(`torre ${largura}px: tabela vazia`));
    await revelar(pT);
    await rolagemLateral(pT, largura, 'torre', problemas);
    fontes[`torre_${largura}`] = await pT.evaluate(() => getComputedStyle(document.querySelector('#torre-tabela-dados td') || document.body).fontFamily);
    await pT.screenshot({ path: nome('torre_matriz', largura) });
    await pT.close();
  }
  console.log('Fontes:', JSON.stringify(fontes));
  console.log(problemas.length ? `Rolagem lateral / problemas: ${problemas.join(' | ')}` : 'Sem rolagem lateral nas telas capturadas');
  if (erros.length) console.log('Erros da página:', erros.slice(0, 5).join(' | '));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });

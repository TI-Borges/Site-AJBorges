// Escape com <img onerror>: popover do resumo de frete (origem/destino digitados) na ficha e filtro de
// motoristas da Conferência de Combustível no dashboard. Confere também os textos de "Limpar" sem número.
// Uso: node testes/t_escape_resumos.js
const { abrir } = require('./harness');
const espera = (ms) => new Promise(res => setTimeout(res, ms));
const XSS = '<img src=x onerror="window.__xss=1">';

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: 1280 });
  // Chart.js (CDN) não carrega no teste; o ajbAoAutenticar de verdade espera o DOM
  await page.evaluateOnNewDocument(() => {
    const g = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : g), apply: () => g, construct: () => g, set: () => true });
    window.Chart = g;
    let a = null;
    Object.defineProperty(window, 'ajbAoAutenticar', { configurable: true, get: () => a, set: (fn) => { a = (...x) => setTimeout(() => fn(...x), 0); } });
  });
  const r = {};

  // Ficha: frete com origem e destino com <img onerror>; popover "Limpar" da Relação de Fretes
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(500);
  await page.evaluate((xss) => {
    const definir = (n, v) => { const el = document.querySelector(`[name="${n}"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    definir('data_frete_ml_1', '01/10/2026');
    definir('cliente_frete_ml_1', 'shopee');
    definir('origem_frete_ml_1', `Origem ${xss}`);
    definir('destino_frete_ml_1', `Destino ${xss}`);
  }, XSS);
  await page.click('#btn-lixeira-fretes-ml');
  await espera(200);
  r.popoverFrete = await page.evaluate(() => {
    const d = document.querySelector('#popover-lista-linhas-preenchidas .detalhe-linha');
    return { texto: d?.textContent, title: d?.title, imgCriado: !!document.querySelector('#popover-lista-linhas-preenchidas img'), xss: !!window.__xss };
  });
  r.textosLimpar = await page.evaluate(() => Array.from(document.querySelectorAll('#btn-limpar-fretes-ml-todas strong, #btn-limpar-abast-ml-todas strong')).map(s => s.textContent.trim()));
  await page.click('#btn-limpar-fretes-ml-todas');
  await espera(200);
  r.toastLimparFretes = await page.evaluate(() => Array.from(document.querySelectorAll('.toast-custom, .toast, #toast-container')).map(t => t.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / '));

  // Dashboard: motorista com <img onerror> no nome; filtro da Conferência de Combustível
  const ficha = { id: 'AJB-2026-700', motorista: `Fulano ${XSS}`, status: 'pendente', dataEnvio: '05/10/2026', fretes: [],
    abastecimentos: [{ posto: 'Marília - Posto Esmeralda', valor: '50,00', litros: '10', combustivel: 'diesel_s10' }] };
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((f) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
  }, ficha);
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1200);
  await page.evaluate(() => renderizarTabelaCombustivel()); // eslint-disable-line no-undef
  await espera(200);
  r.filtroCombustivel = await page.evaluate(() => {
    const sel = document.getElementById('filtro-combustivel-motorista');
    return {
      opcoes: Array.from(sel.options).map(o => `${o.textContent} [value=${o.value}]`),
      imgCriado: !!sel.querySelector('img')
    };
  });
  // Filtrar pelo motorista continua funcionando
  await page.evaluate(() => { const s = document.getElementById('filtro-combustivel-motorista'); s.selectedIndex = 1; s.dispatchEvent(new Event('change')); });
  await espera(200);
  r.filtrando = await page.$eval('#info-registros-combustivel', el => el.textContent);
  await espera(500);
  // Fora do escopo deste teste: onde mais o nome do motorista vira HTML sem escape no dashboard
  r.semEscapeEmOutrasPartes = await page.evaluate(() => Array.from(document.querySelectorAll('img[src="x"]')).map(i => (i.closest('[id]') || i).id));
  r.erros = erros.filter(e => !/limparDadosLocais/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

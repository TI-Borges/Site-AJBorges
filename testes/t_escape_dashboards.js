// Escape com <img onerror> nos dois dashboards: todo texto que vem do banco (nome, placa, cidade, datas e
// valores como texto, observações, id da ficha) entra como texto. dashboard-admin: lista de fichas, alerta
// de consumo, resumo da ficha, Viagens, Pedágios, Planejamento, tabelas diárias, Conferência de Combustível
// (filtro e "nenhum abastecimento"), Acertos, Frota e Análises. Dashboard-cadastro-motorista: lista,
// detalhes do cadastro e ficha para impressão. No fim procura qualquer <img src="x"> na página.
// Uso: node testes/t_escape_dashboards.js [largura]
const { abrir } = require('./harness');
const LARGURA = Number(process.argv[2] || 1280);
const espera = (ms) => new Promise(res => setTimeout(res, ms));
const X = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';

function falsos() {
  // Chart.js (CDN) não carrega no teste; o ajbAoAutenticar de verdade espera o DOM
  const g = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : g), apply: () => g, construct: () => g, set: () => true });
  window.Chart = g;
  let a = null;
  Object.defineProperty(window, 'ajbAoAutenticar', { configurable: true, get: () => a, set: (fn) => { a = (...x) => setTimeout(() => fn(...x), 0); } });
  // Supabase falso só para os cadastros (Dashboard de Cadastros); o resto falha (sem banco)
  let cadastros = null;
  try { cadastros = JSON.parse(localStorage.getItem('__cadastros') || 'null'); } catch (e) { return; }
  if (!cadastros) return;
  const falha = { data: null, error: { message: 'sem banco' } };
  const consulta = (t) => {
    const q = new Proxy({}, { get: (o, k) => (k === 'then' ? (ok) => Promise.resolve(t === 'cadastros_agregados' ? { data: cadastros, error: null } : falha).then(ok) : () => q) });
    return q;
  };
  const cliente = {
    from: consulta, rpc: async () => falha, channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), createSignedUrl: async () => falha, createSignedUrls: async () => ({ data: [], error: null }), download: async () => falha }) },
    auth: { getUser: async () => ({ data: { user: { id: 'a1', email: 'g@x' } }, error: null }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) }
  };
  window.supabase = { createClient: () => cliente };
}

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: LARGURA });
  await page.evaluateOnNewDocument(falsos);
  const r = {};
  const imgsSemEscape = () => page.evaluate(() => ({
    img: Array.from(document.querySelectorAll('img[src="x"]')).map(i => { const c = i.closest('[id]'); return c ? c.id : i.parentElement.tagName; }),
    xss: window.__xss || 0
  }));

  // ---------------- dashboard-admin ----------------
  const fichas = [
    {
      id: `AJB-2026-801`, motorista: `Fulano ${X}`, status: 'pendente', dataEnvio: `05/10/2026 ${X}`, dataSaida: `01/10/2026`,
      placas: `ABC1D23 ${X}`, destinoInicial: `Marília ${X}`, destinoFinal: `Santos ${X}`,
      totalFrete: `1.000,00 ${X}`, vrComissao: '110,00', saldoComissao: `110,00 ${X}`, valorAdiantamento: '0,00',
      totalPedagio: `50,00 ${X}`, observacoesMotorista: `Obs ${X}`,
      kmTotal: '1000', mediaKmL: '1,00',
      fretes: [{ data: '01/10/2026', cliente: 'shopee', origem: `Origem ${X}`, destino: `Destino ${X}`, valor: '1.000,00', comissao: '110,00' }],
      abastecimentos: [{ posto: `Posto ${X}`, nf: `1 ${X}`, km: '100', valor: '500,00', litros: '1000', combustivel: 'diesel_s10' },
                       { posto: 'Outro', posto_outro: `Beira ${X}`, valor: '10,00', litros: '5', combustivel: 'arla' }]
    },
    // Motorista sem abastecimento: o filtro dele mostra "Nenhum abastecimento encontrado para o motorista ..."
    { id: 'AJB-2026-802', motorista: `Beltrano ${X}`, status: 'pendente', dataEnvio: '06/10/2026', dataSaida: '02/10/2026', fretes: [], abastecimentos: [] },
    // Id fora do padrão AJB-... (só a gestão grava assim)
    { id: `AJB-${X}`, motorista: 'Ciclano', status: 'pendente', dataEnvio: '07/10/2026', fretes: [], abastecimentos: [] }
  ];
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((f) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify(f));
  }, fichas);
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1500);
  r.adminDepoisDeAbrir = await imgsSemEscape();
  await page.evaluate(() => {
    /* eslint-disable no-undef */
    preencherSecoesSecundarias();
    renderizarTabelasDiarias();
    renderizarTabelaCombustivel();
    const sel = document.getElementById('filtro-combustivel-motorista');
    sel.value = Array.from(sel.options).find(o => o.value.startsWith('Beltrano')).value;
    renderizarTabelaCombustivel();
    if (typeof renderizarAnalises === 'function') renderizarAnalises();
    abrirModalResumoFicha('AJB-2026-801');
    /* eslint-enable no-undef */
  });
  await espera(500);
  r.adminDepoisDeTudo = await imgsSemEscape();
  r.adminAmostras = await page.evaluate(() => ({
    lista: document.querySelector('#row-ficha-AJB-2026-801 .driver-name')?.textContent,
    alerta: document.getElementById('alerta-consumo-texto')?.textContent?.trim() || '(sem alerta)',
    viagens: document.querySelector('#container-viagens-resumo td:nth-child(3)')?.textContent,
    planejamento: document.querySelector('#container-planejamento-resumo td:nth-child(3)')?.textContent,
    pedagios: document.querySelector('#tabela-pedagios-body td:nth-child(4)')?.textContent,
    combustivelVazio: document.querySelector('#tabela-combustivel-body td')?.textContent.trim(),
    resumoObs: Array.from(document.querySelectorAll('#modal-ficha-conteudo p')).map(p => p.textContent).find(t => t.startsWith('Obs')),
    idForaDoPadrao: Array.from(document.querySelectorAll('#tabela-fichas-body .td-ficha-id')).map(e => e.textContent).find(t => t.includes('img'))
  }));

  // ---------------- Dashboard-cadastro-motorista ----------------
  const cad = {
    id: '11111111-aaaa-bbbb-cccc-000000000001', nome: `Terceiro ${X}`, cpf: '12345678900', celular: `11999 ${X}`, email: `t@x ${X}`,
    tipo: 'pj', status: 'recusado', motivo_recusa: `Motivo ${X}`, analisado_por: `gestor ${X}`, analisado_em: '2026-10-10T10:00:00Z',
    criado_em: '2026-10-01T10:00:00Z', sem_carreta: false,
    etapas: { gr: { feito: true, por: `fulano ${X}`, em: '2026-10-02T10:00:00Z' } },
    dados: { 'nome-empresa': `Empresa ${X}`, _tipologia: `Truck ${X}`, 'crlv1-placa': `ABC ${X}`, 'cnh-registro': `123 ${X}`, 'cnh-categoria': `E ${X}`,
             _aceite_lgpd: { em: '2026-10-01T10:00:00Z', versao: `v1 ${X}` } },
    documentos: [{ campo: 'extra', nome: `arq ${X}.pdf`, descricao: `Desc ${X}`, path: 'p/x.pdf', enviado_por: `quem ${X}`, enviado_em: '2026-10-03T10:00:00Z' }]
  };
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((c) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
    localStorage.setItem('__cadastros', JSON.stringify([c]));
  }, cad);
  await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
  await espera(1500);
  r.cadastroLista = { ...(await imgsSemEscape()), nome: await page.evaluate(() => document.querySelector('#driver-table-body td div div')?.textContent) };
  await page.evaluate(() => document.querySelector('[data-acao="abrir"]')?.click());
  await espera(800);
  r.cadastroDetalhes = { ...(await imgsSemEscape()), motivo: await page.evaluate(() => Array.from(document.querySelectorAll('div')).map(d => d.textContent).find(t => t.startsWith('Motivo da recusa'))) };
  // Ficha para impressão (abre em outra janela)
  const nova = new Promise(res => browser.once('targetcreated', t => res(t.page())));
  await page.evaluate(() => document.querySelector('[data-acao="baixar-ficha"]')?.click());
  const janela = await Promise.race([nova, espera(4000).then(() => null)]);
  if (janela) {
    await espera(1500);
    r.cadastroImpressao = await janela.evaluate(() => ({ img: document.querySelectorAll('img[src="x"]').length, xss: window.__xss || 0, temNome: document.body.textContent.includes('Terceiro <img') }));
    await janela.close();
  } else r.cadastroImpressao = '(a janela não abriu)';

  r.erros = erros.filter(e => !/limparDadosLocais/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

// Pedágio só da gestão: para o motorista a palavra "pedágio" não aparece no HTML da ficha nem na
// revisão, e a Despesa total / Resultado não somam pedágio; a gestão vê, edita e soma como antes
const { abrir } = require('./harness');

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: Number(process.argv[2] || 1280), altura: Number(process.argv[3] || 0) || undefined });
  const PEDAGIO = /ped[aá]gio/i;
  const ocorrencias = () => page.evaluate(() => (document.documentElement.outerHTML.match(/[^<>]{0,40}ped[aá]gio[^<>]{0,40}/gi) || []).slice(0, 5));
  const cards = () => page.evaluate(() => ({
    despesaTotal: document.getElementById('ml-indicador-despesa-total').textContent.trim(),
    resultado: document.getElementById('ml-indicador-resultado-viagem').textContent.trim(),
    legenda: document.getElementById('ml-indicador-despesa-total').nextElementSibling.textContent.trim().replace(/\s+/g, ' ')
  }));
  const usar = (usuario, fichas) => page.evaluate((u, f) => {
    try { localStorage.clear(); } catch (e) { }
    localStorage.setItem('teste_usuario', JSON.stringify(u));
    if (f) localStorage.setItem('ajborges_fichas_viagem', JSON.stringify(f));
  }, usuario, fichas);
  const MOTORISTA = { role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '00000000000' };
  const GESTAO = { role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' };
  // Ficha em que a gestão já lançou pedágio (R$ 987,65): frete 10.000,00, diesel 1.800,00
  const FICHA = {
    id: 'AJB-2026-992', motorista: 'Motorista Ficticio', placas: 'ABC1D23', status: 'aprovado',
    kmSaida: '100000', kmEntrada: '101500', dataSaida: '01/10/2026', dataChegada: '05/10/2026',
    destinoInicial: 'Marília - SP', valorAdiantamento: '0,00',
    fretes: [{ data: '01/10/2026', cliente: 'shopee', origem: 'Marília - SP', destino: 'Cravinhos - SP', valor: '10.000,00', comissao: '1.100,00' }],
    abastecimentos: [{ posto: 'Posto Ficticio', valor: '1.800,00', litros: '312,92', combustivel: 'diesel_s10', placa: 'principal' }],
    pedagios: ['987,65', '', ''], totalPedagio: '987,65', outrasDespesas: []
  };
  const r = {};

  // 1. Motorista, ficha nova: nada de pedágio no HTML nem na revisão
  await page.goto(`${base}/HTML/relatorio-viagem.html`, { waitUntil: 'load' });
  await usar(MOTORISTA);
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await page.evaluate(() => { window.reservarNumeroFichaSupabase = async () => 'AJB-2026-993'; window.salvarFichaSupabase = async () => ({ success: true }); });
  r.motoristaNova = { html: await ocorrencias(), cards: await cards() };
  r.motoristaNova.campos = await page.evaluate(() => ['ml-pedagio-1', 'ml-total-pedagio', 'card-bloco-pedagio', 'btn-limpar-apenas-pedagios-ml'].map(id => `${id}: ${document.getElementById(id) ? 'EXISTE' : 'não existe'}`));
  r.motoristaNova.tituloLixeira = await page.$eval('#btn-lixeira-despesas-ml', el => el.title);
  r.motoristaNova.outrasDespesasLarguraToda = await page.evaluate(() => {
    const grade = document.querySelector('.grid-despesas-dupla').getBoundingClientRect();
    const card = document.querySelector('.card-outras-despesas').getBoundingClientRect();
    return `${Math.round(card.width)} de ${Math.round(grade.width)} px`;
  });
  // Revisão antes de enviar
  const digitar = async (sel, txt) => { await page.focus(sel); await page.keyboard.type(txt); };
  await digitar('#placas', 'ABC1D23');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '101500');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await digitar('#valor-adiantamento', '0');
  await page.select('[name="posto_ml_1"]', 'Marília - Posto Esmeralda');
  await page.select('[name="combustivel_ml_1"]', 'diesel_s10');
  await digitar('[name="valor_ml_1"]', '180000');
  await page.$eval('[name="litros_ml_1"]', el => { el.value = ''; });
  await digitar('[name="litros_ml_1"]', '312920');
  await page.click('#btn-finalizar-relatorio-ml');
  await new Promise(res => setTimeout(res, 300));
  r.motoristaRevisao = await page.evaluate((re) => {
    const modal = document.getElementById('modal-revisar-envio');
    return { aberta: modal.classList.contains('ativo'), temPedagio: new RegExp(re, 'i').test(modal.innerHTML) };
  }, PEDAGIO.source);
  r.motoristaRevisao.htmlDaPagina = await ocorrencias();

  // 2. Motorista vendo a ficha concluída (mode=view) em que a gestão lançou pedágio
  await usar(MOTORISTA, [FICHA]);
  await page.goto(`${base}/HTML/relatorio-viagem.html?ficha=${FICHA.id}&mode=view`, { waitUntil: 'load' });
  await new Promise(res => setTimeout(res, 600));
  r.motoristaFichaComPedagio = { html: await ocorrencias(), tem98765: await page.evaluate(() => document.documentElement.outerHTML.includes('987,65')), cards: await cards() };

  // 3. Gestão: vê e edita o pedágio, e a Despesa total soma
  await usar(GESTAO, [FICHA]);
  await page.goto(`${base}/HTML/relatorio-viagem.html?ficha=${FICHA.id}&mode=admin`, { waitUntil: 'load' });
  await new Promise(res => setTimeout(res, 600));
  r.gestao = {
    aparece: (await ocorrencias()).length > 0,
    campos: await page.evaluate(() => ['ml-pedagio-1', 'ml-pedagio-2', 'ml-total-pedagio'].map(id => {
      const el = document.getElementById(id);
      return el ? `${id}=${el.value || '(vazio)'} ${el.readOnly ? 'só leitura' : 'editável'}` : `${id}: NÃO EXISTE`;
    })),
    cards: await cards()
  };
  await page.$eval('#ml-pedagio-2', el => { el.value = ''; el.focus(); });
  await page.keyboard.type('1000');
  await page.$eval('#ml-pedagio-2', el => el.blur());
  r.gestao.depoisDeEditar = { total: await page.$eval('#ml-total-pedagio', el => el.value), cards: await cards() };

  r.dialogos = page._dialogos || [];
  r.erros = erros.filter(e => !/Chart is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

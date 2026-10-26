// Máscara dos litros (diesel e ARLA) no estilo caixa eletrônico: começa em 0,00, os números entram
// pela direita, ponto/letra ignorados, Backspace, colar, 0,00 = vazio, valor gravado e ficha reaberta
const { abrir } = require('./harness');

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: Number(process.argv[2] || 1280), altura: Number(process.argv[3] || 0) || undefined });
  const novaFicha = async () => {
    await page.evaluate(() => { try { localStorage.removeItem('ajborges_relatorio_viagem_ml_draft'); } catch (e) { } });
    await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
    await page.evaluate(() => {
      window.reservarNumeroFichaSupabase = async () => 'AJB-2026-990';
      window.salvarFichaSupabase = async (f) => { window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
    });
  };
  const campo = (i) => `[name="litros_ml_${i}"]`;
  const valor = (i) => page.$eval(campo(i), el => el.value);
  const mostrar = (i) => page.evaluate((i) => { const tr = document.querySelector(`[name="posto_ml_${i}"]`).closest('tr'); tr.classList.remove('linha-oculta-celular'); tr.hidden = false; }, i);
  const digitarUmAUm = async (i, texto) => {
    const passos = [];
    await page.focus(campo(i));
    for (const ch of texto) { await page.keyboard.type(ch); passos.push(`${ch} → ${await valor(i)}`); }
    return passos;
  };
  const colar = (i, texto) => page.$eval(campo(i), (el, texto) => {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', texto);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return el.value;
  }, texto);
  const tentarEnviar = async () => {
    await page.click('#btn-finalizar-relatorio-ml');
    await new Promise(res => setTimeout(res, 300));
    return page.evaluate(() => ({
      revisaoAberta: document.querySelector('#modal-revisar-envio').classList.contains('ativo'),
      toast: document.querySelector('.toast-mensagem')?.textContent || '',
      erros: Array.from(document.querySelectorAll('.erro-campo-celular')).map(e => e.textContent)
    }));
  };
  const cabecalho = async () => {
    const digitar = async (sel, txt) => { await page.focus(sel); await page.keyboard.type(txt); };
    await digitar('#placas', 'ABC1D23');
    await digitar('#data-saida', '01102026');
    await digitar('#data-chegada', '05102026');
    await digitar('#km-saida', '100000');
    await digitar('#km-chegada', '101500');
    await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await digitar('#valor-adiantamento', '0');
  };
  const r = {};

  await novaFicha();
  // Todas as 10 linhas (inclusive as escondidas, que aparecem com "+ Adicionar") começam em 0,00
  r.inicio = await page.evaluate(() => Array.from(document.querySelectorAll('.input-litros-abast-ml'))
    .map(el => `${el.name}=${el.value} (${el.getAttribute('inputmode')})`));

  // Digitar 3, 1, 2, 9, 2
  r.digitar31292 = await digitarUmAUm(1, '31292');
  // Ponto e letra ignorados
  await page.$eval(campo(2), el => { el.value = ''; });
  await mostrar(2);
  r.pontoELetra = (await digitarUmAUm(2, '3a1.2,x9')).join(' | ');
  // Backspace: tira o último número; tudo apagado volta para 0,00
  await page.focus(campo(1));
  await page.keyboard.press('Backspace');
  r.backspace1 = await valor(1);
  for (let k = 0; k < 6; k++) await page.keyboard.press('Backspace');
  r.backspaceTudo = await valor(1);
  // Milhar sem ponto
  await page.$eval(campo(1), el => { el.value = ''; });
  await digitarUmAUm(1, '125050');
  r.milhar = await valor(1);
  // Colar (substitui o que estava no campo)
  r.colar = {};
  for (const t of ['312,92', '312.92', '31292', '1.250,50', '312,924', 'abc', '']) r.colar[JSON.stringify(t)] = await colar(1, t);

  // 0,00 conta como vazio: só a linha 1 com litros apagados (0,00) não envia
  await novaFicha();
  await cabecalho();
  await page.focus(campo(1));
  await page.keyboard.type('5');
  await page.keyboard.press('Backspace');
  await page.$eval(campo(1), el => el.blur());
  r.zeroBloqueia = { campo: await valor(1), revisao: await tentarEnviar() };
  r.zeroBloqueia.qtdAbastecimentosNaRevisao = await page.$eval('#revisar-qtd-abastecimentos', el => el.textContent);
  await page.click('#btn-revisar-confirmar');
  await new Promise(res => setTimeout(res, 500));
  r.zeroBloqueia.aoConfirmar = await page.evaluate(() => (window.__payload ? 'ENVIOU' : 'não enviou') + ' | ' + (document.querySelector('.toast-mensagem')?.textContent || ''));

  // Valor gravado, média e aviso de limite: 1.500 km, diesel 200,00 + 100,00 e ARLA 50,00 -> 5,00 km/l (como antes)
  await novaFicha();
  await cabecalho();
  const linha = async (i, comb, litros, valorRs) => {
    await mostrar(i);
    await page.select(`[name="posto_ml_${i}"]`, 'Marília - Posto Esmeralda');
    await page.select(`[name="combustivel_ml_${i}"]`, comb);
    await page.$eval(`[name="valor_ml_${i}"]`, el => { el.value = ''; });
    await page.focus(`[name="valor_ml_${i}"]`); await page.keyboard.type(valorRs);
    await page.$eval(campo(i), el => { el.value = ''; });
    await page.focus(campo(i)); await page.keyboard.type(litros);
    await page.$eval(campo(i), el => el.blur());
  };
  await linha(1, 'diesel_s10', '150001', '120000');
  r.limiteDiesel150001 = await page.$eval(campo(1), el => `${el.value} | ${el.getAttribute('aria-invalid') === 'true' ? 'AVISO' : 'normal'}`);
  await linha(1, 'diesel_s10', '20000', '120000');
  await linha(2, 'diesel_s500', '10000', '60000');
  await linha(3, 'arla', '5000', '25000');
  r.limiteDiesel200 = await page.$eval(campo(1), el => `${el.value} | ${el.getAttribute('aria-invalid') === 'true' ? 'AVISO' : 'normal'}`);
  r.media = await page.evaluate(() => [document.getElementById('ml-indicador-media-combustivel').textContent.trim().replace(/\s+/g, ' '),
    document.getElementById('ml-media-base-geral').textContent.trim().replace(/\s+/g, ' '),
    document.querySelector('#ml-media-arla .media-arla-linha')?.textContent.trim().replace(/\s+/g, ' ')]);
  // Linha 4 com 31292 (= 312,92) para conferir o valor gravado; média enviada = 1.500 ÷ 612,92 = 2,45
  await linha(4, 'diesel_s10', '31292', '150000');
  r.envio = await tentarEnviar();
  r.revisaoAbast = await page.$eval('#revisar-detalhes-viagem', el => (el.innerText.match(/#\d[^\n]*\n[^\n]*/g) || []).map(t => t.replace(/\n/g, ': ')));
  await page.click('#btn-revisar-confirmar');
  await new Promise(res => setTimeout(res, 800));
  r.gravado = await page.evaluate(() => {
    const p = window.__payload;
    if (!p) return null;
    return {
      litrosTexto: p.abastecimentos.map(a => a.litros),
      // Como o dashboard lê (parseLitrosAbast: vírgula = decimal)
      litrosNumero: p.abastecimentos.map(a => parseFloat(String(a.litros).replace(/\./g, '').replace(',', '.'))),
      linhas: p.abastecimentos.length,
      media_km_l: p.media_km_l
    };
  });

  // Ficha salva reabre como 312,92 (gestão editando e motorista vendo a ficha concluída, mode=view);
  // gravadas antes da máscara (1.250,5 / 15) também
  const FICHA = {
    id: 'AJB-2026-991', motorista: 'Motorista Ficticio', placas: 'ABC1D23', status: 'pendente',
    kmSaida: '100000', kmEntrada: '101500', dataSaida: '01/10/2026', dataChegada: '05/10/2026',
    destinoInicial: 'Marília - SP', valorAdiantamento: '0,00', fretes: [],
    abastecimentos: [
      { posto: 'Posto Ficticio', valor: '1.800,00', litros: '312,92', combustivel: 'diesel_s10', placa: 'principal' },
      { posto: 'Posto Ficticio', valor: '1.000,00', litros: '1.250,5', combustivel: 'diesel_s10', placa: 'principal' },
      { posto: 'Posto Ficticio', valor: '100,00', litros: '15', combustivel: 'arla', placa: 'principal' }],
    outrasDespesas: []
  };
  for (const [papel, usuario, url] of [
    ['gestao', { role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' }, `ficha=${FICHA.id}&mode=admin`],
    ['motorista_view', { role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '00000000000' }, `ficha=${FICHA.id}&mode=view`]]) {
    await page.evaluate((f, u) => {
      localStorage.clear();
      localStorage.setItem('teste_usuario', JSON.stringify(u));
      localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
    }, FICHA, usuario);
    await page.goto(`${base}/HTML/relatorio-viagem.html?${url}`, { waitUntil: 'load' });
    await new Promise(res => setTimeout(res, 600));
    r[`reabrir_${papel}`] = await page.evaluate(() => [1, 2, 3, 4].map(i => document.querySelector(`[name="litros_ml_${i}"]`).value));
  }

  r.dialogos = page._dialogos || [];
  r.erros = erros.filter(e => !/Chart is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

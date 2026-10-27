// Litros com 3 casas, como a bomba (128,501 L): máscara, colar, sem aviso de preço por litro (só o de limite),
// totais de diesel e ARLA com 3 casas,
// média do diesel e da ARLA igual à conta feita à mão, o que vai para o banco, ficha antiga com 2 casas
// reaberta na conferência da gestão e o dashboard (resumo da ficha e média da frota).
// Uso: node testes/t_litros_3casas.js [largura]
const { abrir } = require('./harness');
const espera = (ms) => new Promise(res => setTimeout(res, ms));

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: Number(process.argv[2] || 1280) });
  const r = {};
  const campo = (i) => `[name="litros_ml_${i}"]`;
  const valorDe = (sel) => page.$eval(sel, el => el.value);
  const novaFicha = async () => {
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
    await page.evaluate(() => {
      document.getElementById('secao-formulario-ml').classList.remove('oculto');
      document.querySelectorAll('table.tabela-abastecimento tr.linha-oculta-celular').forEach(tr => tr.classList.remove('linha-oculta-celular'));
      window.reservarNumeroFichaSupabase = async () => 'AJB-2026-997';
      window.salvarFichaSupabase = async (f) => { window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
    });
  };
  const digitar = async (sel, txt) => { await page.focus(sel); await page.keyboard.type(txt); };
  const colar = (i, texto) => page.$eval(campo(i), (el, texto) => {
    el.focus();
    el.select();
    const dt = new DataTransfer();
    dt.setData('text/plain', texto);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return el.value;
  }, texto);
  const abastecimento = async (i, comb, valor, litros) => {
    await page.select(`[name="posto_ml_${i}"]`, 'Marília - Posto Esmeralda');
    await page.select(`[name="combustivel_ml_${i}"]`, comb);
    await page.$eval(`[name="valor_ml_${i}"]`, el => { el.value = ''; });
    await digitar(`[name="valor_ml_${i}"]`, valor);
    await page.$eval(campo(i), el => { el.value = '0,000'; });
    await digitar(campo(i), litros);
    await page.$eval(campo(i), el => el.blur());
    await espera(100);
  };
  const avisoDe = (i) => page.$eval(campo(i), el => {
    const ancora = el.closest('.tabela-litros-wrap') || el;
    const a = ancora.nextElementSibling;
    return a && a.classList.contains('erro-campo-celular') ? a.textContent : '(sem aviso)';
  });

  // 1. Máscara: começa em 0,000 e 1 2 8 5 0 1 vira 128,501
  await novaFicha();
  r.inicio = Array.from(new Set(await page.$$eval('.input-litros-abast-ml', els => els.map(el => `${el.value} / placeholder ${el.placeholder}`))));
  await page.$eval(campo(1), el => el.focus());
  const passos = [];
  for (const ch of '128501') { await page.keyboard.type(ch); passos.push(`${ch} → ${await valorDe(campo(1))}`); }
  r.digitar128501 = passos;
  await page.keyboard.press('Backspace');
  r.backspace = await valorDe(campo(1));
  r.dinheiroContinua2Casas = await (async () => { await digitar('[name="valor_ml_1"]', '87252'); return valorDe('[name="valor_ml_1"]'); })();

  // 2. Colar
  r.colar = {};
  for (const t of ['128,501', '128.501', '128501', '128,50', '1.250,50', 'R$ 312,92 L']) r.colar[t] = await colar(2, t);

  // 3. Sem aviso de preço por litro (foi tirado): R$ 872,52 com 128,501 L ou com 1285,01 L, nenhum aviso;
  //    o aviso de limite (1.500 L de diesel / 150 L de ARLA) continua. Totais com 3 casas, como as linhas.
  await novaFicha();
  r.totaisAoAbrir = await page.evaluate(() => `diesel ${document.getElementById('ml-total-litros-diesel').value} L | ARLA ${document.getElementById('ml-total-litros-arla').value} L`);
  await digitar('#placas', 'ABC1D23');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '101500');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await digitar('#valor-adiantamento', '0');
  await abastecimento(1, 'diesel_s10', '87252', '128501');
  r.semAvisoDePreco = { r128_501: `${await valorDe(campo(1))} L → ${await avisoDe(1)}` };
  await abastecimento(2, 'diesel_s500', '87252', '1285010');
  r.semAvisoDePreco.r1285_01 = `${await valorDe(campo(2))} L → ${await avisoDe(2)}`;
  await abastecimento(3, 'arla', '100', '20125');   // R$ 1,00 por 20,125 L de ARLA
  await page.$eval('[name="valor_ml_3"]', el => el.blur());
  await espera(100);
  r.semAvisoDePreco.arla_r1 = `${await valorDe(campo(3))} L → ${await avisoDe(3)}`;
  await page.$eval('[name="valor_ml_3"]', el => { el.value = ''; });
  await digitar('[name="valor_ml_3"]', '8050');      // R$ 80,50
  await page.$eval('[name="valor_ml_3"]', el => el.blur());
  await espera(100);
  r.semAvisoDePreco.textoNaPagina = await page.evaluate(() => /por litro/i.test(document.getElementById('form-relatorio').innerText) ? 'APARECE' : 'não aparece');
  r.limite1500Continua = await (async () => { await abastecimento(4, 'diesel_s10', '1200000', '1600000'); return avisoDe(4); })();
  r.limite150ArlaContinua = await (async () => { await abastecimento(5, 'arla', '50000', '150010'); return avisoDe(5); })();
  await page.$eval(campo(5), el => { el.value = '0,000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('[name="valor_ml_5"]', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('[name="posto_ml_5"]', '');
  await page.select('[name="combustivel_ml_5"]', '');
  await page.$eval(campo(4), el => { el.value = '0,000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.$eval('[name="valor_ml_4"]', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('[name="posto_ml_4"]', '');
  await page.select('[name="combustivel_ml_4"]', '');

  // 4. Média: diesel 128,501 + 1285,010 L; ARLA 20,125 L; KM 1.500
  const kmViagem = 1500;
  const dieselL = 128.501 + 1285.010;
  const arlaL = 20.125;
  const fmt2 = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  r.media = await page.evaluate(() => ({
    totalLitrosDiesel: document.getElementById('ml-total-litros-diesel').value,
    totalLitrosArla: document.getElementById('ml-total-litros-arla').value,
    mediaDiesel: document.getElementById('ml-indicador-media-combustivel').textContent.trim().replace(/\s+/g, ' '),
    mediaArla: document.getElementById('ml-media-arla').textContent.trim()
  }));
  r.media.aMao = `diesel ${fmt2(kmViagem / dieselL)} km/l (1.500 ÷ ${dieselL.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}) | ARLA ${fmt2(kmViagem / arlaL)} km/l (1.500 ÷ 20,125)`;
  r.media.bate = r.media.mediaDiesel.startsWith(fmt2(kmViagem / dieselL)) && r.media.mediaArla.includes(fmt2(kmViagem / arlaL));

  // 5. Envio: vai 128,501 (3 casas) para o banco
  await page.$eval('#btn-finalizar-relatorio-ml', el => el.scrollIntoView({ block: 'center' }));
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(400);
  r.envio = { revisaoAbriu: await page.evaluate(() => document.querySelector('#modal-revisar-envio').classList.contains('ativo')) };
  r.envio.revisao = await page.$$eval('#revisar-detalhes-viagem .revisar-linha', ls => ls.map(l => l.textContent.replace(/\s+/g, ' ').trim()).filter(t => /^#|Total diesel|Total ARLA|Média/.test(t)));
  await page.click('#btn-revisar-confirmar');
  await espera(1200);
  r.envio.payload = await page.evaluate(() => window.__payload && {
    litros: window.__payload.abastecimentos.map(a => `${a.combustivel}:${a.litros}`),
    totalLitros: window.__payload.dados_completos.totalLitros,
    media_km_l: window.__payload.media_km_l
  });

  // 6. Ficha antiga (2 casas) reaberta na conferência da gestão
  const ANTIGA = {
    id: 'AJB-2026-940', motorista: 'Motorista Antigo', motoristaId: 'mot-a', placas: 'ABC1D23', status: 'pendente',
    kmSaida: '100000', kmEntrada: '101500', destinoInicial: 'Marília - SP', valorAdiantamento: '0,00',
    fretes: [], outrasDespesas: [],
    abastecimentos: [
      { posto: 'Marília - Posto Esmeralda', valor: '1.900,00', litros: '312,92', combustivel: 'diesel_s10' },
      { posto: 'Marília - Posto Esmeralda', valor: '600,00', litros: '1.250,5', combustivel: 'diesel_s500' },
      { posto: 'Marília - Posto Esmeralda', valor: '90,00', litros: '20,5', combustivel: 'arla' }
    ]
  };
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((f) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'admin-1', email: 'g@x' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
  }, ANTIGA);
  await page.goto(`${base}/HTML/relatorio-viagem.html?ficha=${ANTIGA.id}&mode=admin`, { waitUntil: 'load' });
  await espera(700);
  r.fichaAntiga = await page.evaluate(() => ({
    campos: [1, 2, 3].map(i => document.querySelector(`[name="litros_ml_${i}"]`).value),
    totalDiesel: document.getElementById('ml-total-litros-diesel').value,
    mediaDiesel: document.getElementById('ml-indicador-media-combustivel').textContent.trim().replace(/\s+/g, ' ')
  }));
  r.fichaAntiga.mediaAMao = `${fmt2(1500 / (312.92 + 1250.5))} km/l`;

  // 7. Dashboard: resumo da ficha e média da frota com 3 casas
  await page.evaluateOnNewDocument(() => {
    const grafico = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : grafico), apply: () => grafico, construct: () => grafico, set: () => true });
    window.Chart = grafico;
    let aoAutenticar;
    Object.defineProperty(window, 'ajbAoAutenticar', { configurable: true, get: () => aoAutenticar, set: (fn) => { aoAutenticar = (...a) => setTimeout(() => fn(...a), 0); } });
  });
  const NOVA = { ...ANTIGA, id: 'AJB-2026-941', motorista: 'Motorista Bomba', dataEnvio: '05/10/2026', totalFrete: '0,00', kmTotal: '1500',
    abastecimentos: [{ posto: 'P', valor: '872,52', litros: '128,501', combustivel: 'diesel_s10' }, { posto: 'P', valor: '80,50', litros: '20,125', combustivel: 'arla' }] };
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((f) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
  }, NOVA);
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1200);
  await page.click('#row-ficha-AJB-2026-941 .btn-acao-resumo');
  await espera(300);
  r.dashboard = await page.evaluate(() => ({
    lista: document.querySelector('#row-ficha-AJB-2026-941 .diesel-badge').textContent.trim(),
    resumo: Array.from(document.querySelectorAll('#modal-ficha-conteudo .modal-info-linha')).map(l => l.textContent.replace(/\s+/g, ' ').trim()).filter(t => /Diesel|ARLA/.test(t)),
    mediaFrota: document.getElementById('kpi-media-consumo-geral').textContent
  }));
  r.dashboard.aMao = `diesel ${(1500 / 128.501).toFixed(2)} km/l | ARLA ${fmt2(1500 / 20.125)} km/l`;

  r.erros = erros.filter(e => !/limparDadosLocais|Chart is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

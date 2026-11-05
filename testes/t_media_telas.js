// Passo 24 nas telas, com dados INVENTADOS (nada vai para o Supabase):
//  - Ficha do motorista: coluna "Momento" (obrigatória no diesel, opcional no ARLA), card "Em aberto" sem a
//    Chegada, 4,17 com Saída + Durante + Chegada (a Saída fica fora), o Momento vai no envio e a revisão mostra.
//  - Dashboard da frota: selo por placa ("Em aberto", média, antiga com aviso), filtro "Só média em aberto",
//    modal com o Momento e a média por placa, KPI / gráfico por motorista / Análises com Σ KM ÷ Σ litros.
// Prints em testes/capturas (1366 e 390). Uso: node testes/t_media_telas.js
const fs = require('fs');
const path = require('path');
const { abrir } = require('./harness');

const CAP = path.join(__dirname, 'capturas');
fs.mkdirSync(CAP, { recursive: true });
const falhas = [];
const conferir = (nome, ok, valor) => { console.log(`${ok ? 'ok ' : 'ERRO'} ${nome}: ${JSON.stringify(valor)}`); if (!ok) falhas.push(nome); };

// Dashboard: fichas inventadas
const fx = (id, extra) => ({
  id, motorista: 'Motorista Ficticio A', placas: 'ABC1D23', status: 'aprovado', dataSaida: '2026-10-01', dataChegada: '2026-10-05',
  totalFrete: '5.000,00', vrComissao: '550,00', outrasDespesas: [], ...extra
});
const FECHADA = fx('AJB-2026-971', { kmSaida: '100000', kmEntrada: '101250', kmTotal: '1250', abastecimentos: [
  { posto: 'Posto A', valor: '600,00', litros: '100', combustivel: 'diesel_s10', momento: 'saida' },
  { posto: 'Posto B', valor: '1.200,00', litros: '200', combustivel: 'diesel_s10', momento: 'durante' },
  { posto: 'Posto C', valor: '600,00', litros: '100', combustivel: 'diesel_s500', momento: 'chegada' },
  { posto: 'Posto C', valor: '100,00', litros: '20', combustivel: 'arla', momento: 'chegada' }] });
const ABERTA = fx('AJB-2026-972', { status: 'pendente', kmSaida: '200000', kmEntrada: '200800', kmTotal: '800', abastecimentos: [
  { posto: 'Posto A', valor: '600,00', litros: '100', combustivel: 'diesel_s10', momento: 'saida' },
  { posto: 'Posto B', valor: '1.200,00', litros: '200', combustivel: 'diesel_s10', momento: 'durante' }] });
const DUAS = fx('AJB-2026-973', { motorista: 'Motorista Ficticio B', placaSecundaria: 'XYZ9A87', kmSaida: '300000', kmEntrada: '301000',
  kmSaida2: '400000', kmEntrada2: '400900', kmTotal1: '1000', kmTotal2: '900', kmTotal: '1900', abastecimentos: [
    { posto: 'Posto A', valor: '1.000,00', litros: '300', combustivel: 'diesel_s10', placa: 'principal', momento: 'saida' },
    { posto: 'Posto A', valor: '1.000,00', litros: '400', combustivel: 'diesel_s10', placa: 'principal', momento: 'chegada' },
    { posto: 'Posto D', valor: '1.000,00', litros: '500', combustivel: 'diesel_s10', placa: 'secundaria', momento: 'saida' },
    { posto: 'Posto D', valor: '1.000,00', litros: '300', combustivel: 'diesel_s10', placa: 'secundaria', momento: 'durante' }] });
// Antiga (sem Momento): 3.000 km ÷ 1.000 L = 3,00 (conta de antes)
const ANTIGA = fx('AJB-2026-050', { motorista: 'Motorista Ficticio B', placas: 'DEF5678', kmTotal: '3000', abastecimentos: [
  { posto: 'Posto C', valor: '5.000,00', litros: '1.000', combustivel: 'diesel_s10' }] });
// Outra fechada do motorista A: 3.000 km ÷ 1.000 L = 3,00. Com a FECHADA (4,17): Σ = 4.250 ÷ 1.300 = 3,27; média das médias = 3,58
const FECHADA2 = fx('AJB-2026-974', { kmSaida: '500000', kmEntrada: '503000', kmTotal: '3000', abastecimentos: [
  { posto: 'Posto A', valor: '5.000,00', litros: '1.000', combustivel: 'diesel_s10', momento: 'chegada' }] });

(async () => {
  for (const largura of [1366, 390]) {
    console.log(`\n=== ${largura}px ===`);
    const { srv, base, browser, page, erros } = await abrir({ largura, altura: 900 });
    // O stub de login do harness não tem limparDadosLocais: sem ele o dashboard para antes de ligar os filtros
    await page.evaluateOnNewDocument(() => {
      let auth;
      Object.defineProperty(window, 'ajbAuth', { configurable: true, get: () => auth, set: (v) => { auth = v; if (auth && !auth.limparDadosLocais) auth.limparDadosLocais = () => {}; } });
    });

    // ---------------- Ficha do motorista ----------------
    await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
    await page.evaluate(() => {
      window.reservarNumeroFichaSupabase = async () => 'AJB-2026-999';
      window.salvarFichaSupabase = async (f) => { window.__enviado = f; window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
    });
    const digitar = async (sel, txt) => { await page.focus(sel); await page.keyboard.type(txt); };
    const limparEDigitar = async (sel, txt) => { await page.$eval(sel, el => { el.value = ''; }); await digitar(sel, txt); await page.$eval(sel, el => el.blur()); };
    const linha = async (i, comb, momento, litros) => {
      await page.evaluate((i) => { const tr = document.querySelector(`[name="posto_ml_${i}"]`).closest('tr'); tr.classList.remove('linha-oculta-celular'); tr.hidden = false; }, i);
      await page.select(`[name="posto_ml_${i}"]`, 'Marília - Posto Esmeralda');
      await page.select(`[name="combustivel_ml_${i}"]`, comb);
      if (momento !== null) await page.select(`[name="momento_ml_${i}"]`, momento);
      await limparEDigitar(`[name="valor_ml_${i}"]`, '50000');
      await limparEDigitar(`[name="litros_ml_${i}"]`, `${litros}000`);
    };
    const card = () => page.evaluate(() => {
      const v = document.getElementById('ml-indicador-media-combustivel');
      const a = document.getElementById('ml-media-aviso');
      return { valor: v.textContent.trim().replace(/\s+/g, ' '), aviso: a.hidden ? '' : a.textContent.trim(),
        base: document.getElementById('ml-media-base-geral').textContent.trim().replace(/\s+/g, ' ') };
    });
    const tentarEnviar = async () => {
      await page.click('#btn-finalizar-relatorio-ml');
      await new Promise(res => setTimeout(res, 250));
      return page.evaluate(() => ({ revisao: document.querySelector('#modal-revisar-envio').classList.contains('ativo'),
        erros: Array.from(document.querySelectorAll('.erro-campo-celular')).map(e => e.textContent) }));
    };

    const coluna = await page.evaluate(() => {
      const th = Array.from(document.querySelectorAll('table.tabela-abastecimento:not(.tabela-fretes-ml) thead th')).map(t => t.textContent.trim());
      const sel = document.querySelector('[name="momento_ml_1"]');
      return { th, opcoes: Array.from(sel.options).map(o => o.textContent), ajuda: sel.title,
        texto: document.querySelector('.ajuda-momento-abast').textContent.replace(/\s+/g, ' ').trim(),
        rotuloCelular: sel.closest('td').dataset.rotulo || '' };
    });
    conferir('coluna MOMENTO depois do combustível', coluna.th.join(',').includes('COMBUSTÍVEL,MOMENTO'), coluna.th);
    conferir('opções do Momento', JSON.stringify(coluna.opcoes) === JSON.stringify(['Selecione...', 'Saída', 'Durante a viagem', 'Chegada']), coluna.opcoes);
    conferir('ajuda do Momento', coluna.ajuda === 'Saída = completar o tanque antes de sair; não entra na média desta viagem.' && coluna.texto.startsWith('Momento: Saída = completar o tanque antes de sair; não entra na média desta viagem.'), coluna.texto);

    await digitar('#placas', 'abc1d23');
    await digitar('#km-saida', '100000');
    await digitar('#km-chegada', '101250');
    await linha(1, 'diesel_s10', 'saida', '100');
    await linha(2, 'diesel_s10', 'durante', '200');
    const emAberto = await card();
    conferir('sem Chegada: card "Em aberto"', emAberto.valor === 'Em aberto' && emAberto.aviso === 'Em aberto, falta o abastecimento de chegada', emAberto);
    // print do card "Em aberto"
    const elCard = await page.$('.card-indicador.indicador-media');
    await elCard.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await elCard.screenshot({ path: path.join(CAP, `media_card_em_aberto_${largura}.png`) });

    // Dados da viagem (para a validação chegar nos abastecimentos)
    await digitar('#data-saida', '01102026');
    await digitar('#data-chegada', '05102026');
    await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await limparEDigitar('#valor-adiantamento', '0');
    // Linha de diesel sem Momento: não envia
    await linha(3, 'diesel_s500', null, '100');
    const semMomento = await tentarEnviar();
    conferir('diesel sem Momento não envia', !semMomento.revisao && semMomento.erros.some(e => /Escolha o Momento/.test(e)), semMomento.erros);
    // ARLA sem Momento pode
    await page.select('[name="momento_ml_3"]', 'chegada');
    await linha(4, 'arla', null, '20');
    const fechada = await card();
    conferir('Saída + Durante + Chegada: 1.250 ÷ 300 = 4,17 (Saída e ARLA fora)', fechada.valor === '4,17 km/l' && fechada.aviso === '' && /(300)/.test(fechada.base), fechada);
    // print da tabela com o Momento
    const elTabela = await page.$('[name="momento_ml_1"]');
    const tabela = await elTabela.evaluateHandle(el => el.closest('.tabela-abastecimento-wrapper'));
    await tabela.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => document.querySelectorAll('.toast, #toast-notificacao').forEach(t => { t.style.display = 'none'; }));
    await new Promise(res => setTimeout(res, 200));
    await tabela.screenshot({ path: path.join(CAP, `media_ficha_momento_${largura}.png`) });

    // Envio: o Momento vai em cada abastecimento; media_km_l = 4.17; a revisão mostra
    const rev = await tentarEnviar();
    const revisao = await page.evaluate(() => Array.from(document.querySelectorAll('#revisar-detalhes-viagem .revisar-linha')).map(l => l.textContent.replace(/\s+/g, ' ').trim()).filter(t => /Média de combustível|^#/.test(t)));
    conferir('revisão mostra a média e o Momento', rev.revisao && revisao.some(t => /Média de combustível \(só diesel\)4,17 km\/l/.test(t)) && revisao.some(t => /Saída/.test(t)), revisao);
    await page.click('#btn-revisar-confirmar');
    await new Promise(res => setTimeout(res, 800));
    const enviado = await page.evaluate(() => window.__payload && { momentos: window.__payload.abastecimentos.map(a => `${a.combustivel}:${a.momento}`), media: window.__payload.media_km_l, dc: window.__payload.dados_completos.mediaPrincipal });
    conferir('envio leva o Momento e a média 4.17', !!enviado && enviado.momentos.join(',') === 'diesel_s10:saida,diesel_s10:durante,diesel_s500:chegada,arla:' && enviado.media === 4.17, enviado);

    // ---------------- Dashboard da frota ----------------
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1' })));
    await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 500));
    const dash = await page.evaluate((fichas) => {
      appState.fichas = fichas;
      appState.filtroStatus = 'todos';
      calcularMetricasDashboard();
      renderizarTabelaFichas();
      const selos = () => Object.fromEntries(Array.from(document.querySelectorAll('#tabela-fichas-gestao tbody tr')).map(tr =>
        [tr.querySelector('.td-ficha-id')?.textContent, Array.from(tr.querySelectorAll('.medias-ficha .diesel-badge')).map(b => b.textContent.trim() + (b.title ? ` [${b.title}]` : ''))]));
      const todos = selos();
      const chk = document.getElementById('filtro-media-em-aberto');
      chk.checked = true; chk.dispatchEvent(new Event('change', { bubbles: true }));
      const soAbertas = Object.keys(selos());
      chk.checked = false; chk.dispatchEvent(new Event('change', { bubbles: true }));
      const consumo = obterDadosGraficosReais().consumo;
      const modal = (id) => { abrirModalResumoFicha(id); const c = document.getElementById('modal-ficha-conteudo');
        return { linhas: Array.from(c.querySelectorAll('.modal-info-linha')).map(l => l.textContent.trim().replace(/\s+/g, ' ')).filter(t => /Média Consumo|média antiga/.test(t)),
          momento: Array.from(c.querySelectorAll('.modal-tabela-resumo')).pop().innerText.split('\n').filter(Boolean).slice(0, 3) }; };
      document.getElementById('analises-filtro-status').value = 'todas';
      renderizarAnalises();
      const tabela = (id) => Array.from(document.querySelectorAll(`#${id} tbody tr`)).map(tr => Array.from(tr.children).map(c => c.textContent.trim().replace(/\s+/g, ' ')).join(' | '));
      return {
        todos, soAbertas, kpi: document.getElementById('kpi-media-consumo-geral').textContent.trim(),
        kpiAbertas: document.getElementById('kpi-media-em-aberto').textContent.trim(),
        consumo: consumo.labels.map((l, i) => `${l}: ${consumo.data[i]}`),
        modalFechada: modal('AJB-2026-971'), modalAberta: modal('AJB-2026-972'), modalDuas: modal('AJB-2026-973'), modalAntiga: modal('AJB-2026-050'),
        motoristas: tabela('analises-tabela-motoristas'),
        resumoMedia: Array.from(document.querySelectorAll('#analises-resumo .kpi-card')).map(c => c.textContent.replace(/\s+/g, ' ').trim()).find(t => /Média km\/l/.test(t))
      };
    }, [FECHADA, ABERTA, DUAS, ANTIGA, FECHADA2]);
    conferir('lista: selo da fechada', JSON.stringify(dash.todos['AJB-2026-971']) === '["4.17 km/l"]', dash.todos['AJB-2026-971']);
    conferir('lista: selo "Em aberto"', /^Em aberto \[Em aberto, falta o abastecimento de chegada\]$/.test(dash.todos['AJB-2026-972'][0]), dash.todos['AJB-2026-972']);
    conferir('lista: 2 placas separadas', JSON.stringify(dash.todos['AJB-2026-973']) === '["ABC-1D23: 2.50 km/l","XYZ-9A87: Em aberto [Em aberto, falta o abastecimento de chegada]"]', dash.todos['AJB-2026-973']);
    conferir('lista: antiga com aviso', JSON.stringify(dash.todos['AJB-2026-050']) === '["3.00 km/l* [média antiga (inclui o acerto da saída)]"]', dash.todos['AJB-2026-050']);
    conferir('filtro "Só média em aberto"', JSON.stringify(dash.soAbertas.sort()) === '["AJB-2026-972","AJB-2026-973"]', dash.soAbertas);
    // KPI: Σ das fechadas e antigas = (1250 + 1000 + 3000 + 3000) ÷ (300 + 400 + 1000 + 1000) = 8250 ÷ 2700 = 3,06; 2 em aberto fora
    conferir('KPI da frota = Σ KM ÷ Σ litros (em aberto fora)', dash.kpi === '3.06 km/l' && /2 média\(s\) em aberto/.test(dash.kpiAbertas), [dash.kpi, dash.kpiAbertas]);
    // Motorista A: (1250 + 3000) ÷ (300 + 1000) = 3,27 (média das médias seria (4,17 + 3,00) ÷ 2 = 3,58)
    // Motorista B: (1000 + 3000) ÷ (400 + 1000) = 2,86
    conferir('gráfico por motorista = Σ KM ÷ Σ litros (≠ média das médias)', JSON.stringify(dash.consumo) === '["Motorista Ficticio A: 3.27","Motorista Ficticio B: 2.86"]', dash.consumo);
    conferir('Análises por motorista = Σ KM ÷ Σ litros + em aberto à parte', dash.motoristas.some(l => /^Motorista Ficticio A \|.*3,27 km\/l1 em aberto/.test(l)), dash.motoristas);
    conferir('modal fechada', /Média Consumo Diesel: 4\.17 km\/l \(1\.250 km ÷ 300 L\)/.test(dash.modalFechada.linhas[0]) && /MOMENTO/i.test(dash.modalFechada.momento[0]) && /Saída/.test(dash.modalFechada.momento[1]), dash.modalFechada);
    conferir('modal em aberto', dash.modalAberta.linhas[0] === 'Média Consumo Diesel: Em aberto, falta o abastecimento de chegada', dash.modalAberta.linhas);
    conferir('modal 2 placas', dash.modalDuas.linhas.length === 2 && /ABC-1D23.*2\.50/.test(dash.modalDuas.linhas[0]) && /XYZ-9A87.*Em aberto/.test(dash.modalDuas.linhas[1]), dash.modalDuas.linhas);
    conferir('modal antiga com aviso', /3\.00 km\/l/.test(dash.modalAntiga.linhas[0]) && dash.modalAntiga.linhas[1] === 'média antiga (inclui o acerto da saída)', dash.modalAntiga.linhas);

    // prints do dashboard: lista de fichas, modal da ficha de 2 placas e Análises
    await page.evaluate(() => { fecharModalResumo(); document.querySelector('#nav-link-fichas')?.click(); });
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => { appState.filtroStatus = 'todos'; renderizarTabelaFichas(); document.querySelector('#tabela-fichas-gestao').scrollIntoView({ block: 'start' }); });
    await page.screenshot({ path: path.join(CAP, `media_dashboard_lista_${largura}.png`) });
    await page.evaluate(() => { abrirModalResumoFicha('AJB-2026-973'); const l = Array.from(document.querySelectorAll('#modal-ficha-conteudo .modal-info-linha')).find(x => /Média Consumo/.test(x.textContent)); l && l.scrollIntoView({ block: 'center' }); });
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(CAP, `media_dashboard_modal_${largura}.png`) });
    await page.evaluate(() => { fecharModalResumo(); document.querySelector('#nav-link-analises')?.click(); });
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => { renderizarAnalises(); document.getElementById('analises-resumo')?.scrollIntoView({ block: 'start' }); });
    await page.screenshot({ path: path.join(CAP, `media_dashboard_analises_${largura}.png`) });

    const errosJs = erros.filter(e => !/Chart is not defined|limparDadosLocais/.test(e));
    conferir('sem erro de JavaScript', errosJs.length === 0, errosJs);
    await browser.close(); srv.close();
  }
  console.log(falhas.length ? `\nFALHOU (${falhas.length})` : '\nOK');
  process.exit(falhas.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

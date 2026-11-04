// Vários adiantamentos na ficha (passo 23): começa com 1 linha; "+ Adicionar adiantamento" até 100 (o 101º não
// entra); remover sobe as de baixo; "Total de adiantamentos" e o saldo de comissão somam todas as linhas; a revisão
// lista cada um; o envio leva a lista e a soma em valorAdiantamento; a cópia do rascunho volta com tudo (3 e 100);
// ficha antiga (só valorAdiantamento) abre com 1 linha; o dashboard mostra a lista e o total, e o acerto usa a soma.
// Uso: node testes/t_adiantamentos.js [largura]   (padrão 1280; rode também com 390)
const { abrir } = require('./harness');
const LARGURA = Number(process.argv[2] || 1280);
const espera = (ms) => new Promise(res => setTimeout(res, ms));
const TAB = 'table.tabela-adiantamentos';
let falhas = 0;
const conferir = (cond, msg, obtido) => { console.log(`${cond ? 'OK   ' : 'FALHA'} ${msg} -> ${JSON.stringify(obtido)}`); if (!cond) falhas++; };

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: LARGURA });
  // Banco "sem sinal" (cópia do rascunho no celular), como no t_fretes_100
  await page.evaluateOnNewDocument(() => {
    let semSinal = false;
    try { semSinal = localStorage.getItem('__banco_sem_sinal') === '1'; } catch (e) { /* about:blank */ }
    if (!semSinal) return;
    const falha = { data: null, error: { message: 'TypeError: Failed to fetch' } };
    const consulta = new Proxy({}, { get: (t, k) => (k === 'then' ? (ok) => Promise.resolve(falha).then(ok) : () => consulta) });
    const cliente = {
      from: () => consulta, rpc: async () => falha, channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      storage: { from: () => ({ upload: async () => falha, remove: async () => falha, list: async () => falha, createSignedUrl: async () => falha }) },
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }), getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) }
    };
    window.supabase = { createClient: () => cliente };
  });
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });

  const estado = () => page.evaluate((T) => {
    const t = document.querySelector(T);
    const linhas = Array.from(t.tBodies[0].rows).filter(tr => !tr.classList.contains('linha-adicionar-celular'));
    const visiveis = linhas.filter(tr => getComputedStyle(tr).display !== 'none');
    const btn = t.querySelector('.btn-adicionar-linha-celular');
    const lim = t.querySelector('.texto-limite-linhas');
    return {
      visiveis: visiveis.length,
      valores: visiveis.map(tr => tr.querySelector('input').value),
      botao: !!btn && getComputedStyle(btn).display !== 'none' && btn.offsetParent !== null,
      textoBotao: btn ? btn.textContent.replace(/\s+/g, ' ').trim() : '',
      limite: lim && getComputedStyle(lim).display !== 'none' && lim.offsetParent !== null ? lim.textContent : '',
      total: document.getElementById('total-adiantamentos').value,
      saldo: document.getElementById('ml-indicador-saldo-comissao').textContent.trim(),
      rolagemH: document.documentElement.scrollWidth > window.innerWidth,
      idsRepetidos: document.querySelectorAll('#valor-adiantamento').length,
      namesRepetidos: (() => { const n = Array.from(document.querySelectorAll('#form-relatorio [name]')).map(e => e.name); return n.length - new Set(n).size; })()
    };
  }, TAB);

  // Mostra n linhas pelo "+ Adicionar" e digita os valores (só dígitos; a máscara formata)
  const preencher = async (digitos) => {
    let vis = await page.$eval(TAB, t => Number(t.dataset.mostrar || 1));
    while (vis < digitos.length) { await page.$eval(`${TAB} .btn-adicionar-linha-celular`, b => b.click()); vis++; }
    await page.evaluate((ds) => {
      ds.forEach((d, k) => {
        const el = document.querySelector(`[name="valor_adiantamento_${k + 1}"]`);
        el.value = d; el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }, digitos);
    return estado();
  };
  // Frete Shopee de R$ 10.000,00 (comissão R$ 1.100,00)
  const freteShopee = () => page.evaluate(() => {
    const d = (c, v) => { const el = document.querySelector(`[name="${c}_frete_ml_1"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    d('data', '01/10/2026'); d('cliente', 'shopee'); d('origem', 'Marília - SP'); d('destino', 'Santos - SP'); d('valor', '1000000');
  });

  const inicio = await estado();
  conferir(inicio.visiveis === 1 && inicio.botao && inicio.total === '0,00', 'começa com 1 linha, botão e total 0,00', inicio);
  conferir(inicio.textoBotao === '+ Adicionar adiantamento', 'texto do botão', inicio.textoBotao);
  await freteShopee();

  const um = await preencher(['50000']);
  conferir(um.total === '500,00' && /600,00/.test(um.saldo), '1 adiantamento: total 500,00, saldo 600,00', um);

  const tres = await preencher(['50000', '20000', '50']);
  conferir(tres.visiveis === 3 && tres.total === '700,50' && /399,50/.test(tres.saldo), '3 adiantamentos: total 700,50, saldo 399,50', tres);

  // Remover o 2: o 3 sobe
  await page.$eval('button.btn-limpar-linha-inline[data-linha-adiant="2"]', b => b.click());
  await espera(100);
  const removido = await estado();
  conferir(removido.visiveis === 2 && removido.valores.join(' | ') === '500,00 | 0,50' && removido.total === '500,50', 'remover o 2 sobe o 3 e refaz o total', removido);

  // 100 linhas de 1,00 e o 101º
  const t0 = Date.now();
  const cem = await preencher(Array.from({ length: 100 }, () => '100'));
  conferir(cem.visiveis === 100 && cem.total === '100,00' && /1\.000,00/.test(cem.saldo), `100 adiantamentos: total 100,00, saldo 1.000,00 (${Date.now() - t0} ms)`, { visiveis: cem.visiveis, total: cem.total, saldo: cem.saldo });
  conferir(!cem.botao && cem.limite === 'Limite de 100 adiantamentos atingido', 'no 100 o botão some e aparece o limite', { botao: cem.botao, limite: cem.limite });
  await page.$eval(`${TAB} .btn-adicionar-linha-celular`, b => b.click());
  await espera(100);
  const linha101 = await page.evaluate(() => !!document.querySelector('[name="valor_adiantamento_101"]'));
  conferir(!linha101 && (await estado()).visiveis === 100, 'o 101º não entra', { linha101 });
  conferir(cem.idsRepetidos === 1 && cem.namesRepetidos === 0, 'sem id nem name repetido', { ids: cem.idsRepetidos, names: cem.namesRepetidos });
  conferir(!cem.rolagemH, `sem rolagem lateral em ${LARGURA}px`, cem.rolagemH);

  // Envio com 3 adiantamentos (volta para 3: 100,00 + 250,00 + 0,00)
  await page.evaluate(() => {
    const t = document.querySelector('table.tabela-adiantamentos');
    for (let i = 1; i <= 100; i++) document.querySelector(`[name="valor_adiantamento_${i}"]`).value = '';
    t.dataset.mostrar = '1';
  });
  await preencher(['10000', '25000', '000']);
  await page.evaluate(() => {
    window.reservarNumeroFichaSupabase = async () => 'AJB-2026-230';
    window.salvarFichaSupabase = async (f) => { window.__payload = window.mapearFichaParaSupabase(f); return { success: true }; };
  });
  const digitar = async (sel, txt) => { await page.$eval(sel, el => { el.value = ''; }); await page.focus(sel); await page.keyboard.type(txt); };
  await digitar('#placas', 'ABC1D23');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '105000');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(300);
  const revisao = await page.evaluate(() => Array.from(document.querySelectorAll('#revisar-detalhes-viagem .revisar-linha'))
    .map(l => Array.from(l.children).map(c => c.textContent.trim()).join(' ')).filter(t => /diantamento/.test(t)));
  conferir(revisao.join(' / ') === 'Adiantamento 1 R$ 100,00 / Adiantamento 2 R$ 250,00 / Adiantamento 3 R$ 0,00 / Total de adiantamentos R$ 350,00', 'revisão lista cada um e o total', revisao);
  await page.click('#btn-revisar-confirmar');
  await espera(800);
  const envio = await page.evaluate(() => {
    const p = window.__payload;
    return p ? { valor_adiantamento: p.valor_adiantamento, valorAdiantamento: p.dados_completos.valorAdiantamento, adiantamentos: p.dados_completos.adiantamentos } : null;
  });
  conferir(envio && envio.valor_adiantamento === 350 && envio.valorAdiantamento === '350,00' &&
    JSON.stringify(envio.adiantamentos) === '[{"valor":"100,00"},{"valor":"250,00"},{"valor":"0,00"}]', 'envio leva a lista e a soma', envio);
  const fichaEnviada = await page.evaluate(() => {
    const p = window.__payload;
    return p && { ...p.dados_completos, id: 'AJB-2026-230', status: 'pendente', motorista: 'Motorista Teste', abastecimentos: p.abastecimentos, fretes: p.dados_completos.fretes, dataEnvio: '05/10/2026', vrComissao: '1.100,00', totalFrete: '10.000,00' };
  });

  // Sem adiantamento nenhum: o envio é recusado com a mensagem de sempre
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await freteShopee();
  await digitar('#placas', 'ABC1D23');
  await digitar('#km-saida', '100000');
  await digitar('#km-chegada', '105000');
  await digitar('#data-saida', '01102026');
  await digitar('#data-chegada', '05102026');
  await page.$eval('#destino-inicial', el => { el.value = 'Marília - SP'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('#btn-finalizar-relatorio-ml');
  await espera(300);
  const semAdiant = await page.evaluate(() => ({
    revisaoAberta: document.querySelector('#modal-revisar-envio').classList.contains('ativo'),
    erro: Array.from(document.querySelectorAll('.erro-campo-celular')).map(e => e.textContent).join(' | ') || document.getElementById('toast-notificacao')?.textContent?.trim(),
    foco: document.activeElement?.id
  }));
  conferir(!semAdiant.revisaoAberta && /adiantamento/.test(semAdiant.erro || ''), 'sem adiantamento o envio é recusado', semAdiant);

  // Rascunho (cópia do celular): 3 e depois 100 voltam com tudo
  const recarregar = async () => { await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' }); await espera(1500); return estado(); };
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('__banco_sem_sinal', '1'); });
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await espera(800);
  await freteShopee();
  const r3 = await preencher(['10000', '25000', '000']);
  await espera(3500);
  const v3 = await recarregar();
  conferir(v3.visiveis === 3 && v3.valores.join(' | ') === r3.valores.join(' | ') && v3.total === '350,00' && /750,00/.test(v3.saldo), 'rascunho com 3 volta com tudo', { antes: r3.valores, depois: v3.valores, total: v3.total, saldo: v3.saldo });
  await preencher(Array.from({ length: 100 }, (_, k) => String(100 + k)));
  await espera(3500);
  const v100 = await recarregar();
  const copia = await page.evaluate(() => { const k = Object.keys(localStorage).find(k => k.startsWith('ajborges_rascunho_viagem_')); const c = k && JSON.parse(localStorage.getItem(k)); return c ? c.dados.cabecalho : null; });
  conferir(v100.visiveis === 100 && v100.valores[99] === '1,99' && v100.total === '149,50' && copia && copia.adiantamentos.length === 100 && copia.valorAdiantamento === '149,50',
    'rascunho com 100 volta com tudo', { visiveis: v100.visiveis, ultimo: v100.valores[99], total: v100.total, copia: copia && `${copia.adiantamentos.length} linhas, ${copia.valorAdiantamento}` });

  // Ficha antiga (só valorAdiantamento): abre com 1 linha preenchida
  const ANTIGA = {
    id: 'AJB-2026-231', motorista: 'Motorista Antigo', placas: 'ABC1D23', status: 'pendente',
    kmSaida: '100000', kmEntrada: '101500', dataSaida: '01/10/2026', dataChegada: '05/10/2026',
    destinoInicial: 'Marília - SP', valorAdiantamento: '750,00', fretes: [], abastecimentos: [], outrasDespesas: [],
    totalFrete: '10.000,00', vrComissao: '1.100,00', saldoComissao: '350,00', dataEnvio: '05/10/2026'
  };
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((f) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify([f]));
  }, ANTIGA);
  await page.goto(`${base}/HTML/relatorio-viagem.html?ficha=${ANTIGA.id}&mode=admin`, { waitUntil: 'load' });
  await espera(800);
  const antiga = await estado();
  conferir(antiga.visiveis === 1 && antiga.valores[0] === '750,00' && antiga.total === '750,00', 'ficha antiga abre com 1 linha', { visiveis: antiga.visiveis, valores: antiga.valores, total: antiga.total });

  // Dashboard: resumo com a lista e o total; acerto usa a soma; ficha antiga com o valor único
  await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((fs) => {
    localStorage.clear();
    localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1', email: 'g@x' }));
    localStorage.setItem('ajborges_fichas_viagem', JSON.stringify(fs));
  }, [{ ...fichaEnviada, adiantamentos: [...fichaEnviada.adiantamentos, { valor: '<img src=x onerror=alert(1)>' }] }, ANTIGA]);
  await page.goto(`${base}/HTML/dashboard-admin.html`, { waitUntil: 'load' });
  await espera(1200);
  const resumo = async (id) => {
    await page.evaluate((i) => abrirModalResumoFicha(i), id); // eslint-disable-line no-undef
    await espera(300);
    return page.evaluate(() => {
      const c = document.getElementById('modal-ficha-conteudo');
      return {
        linhas: Array.from(c.querySelectorAll('.modal-info-linha')).map(l => l.textContent.replace(/\s+/g, ' ').trim()).filter(t => /diantamento/.test(t)),
        itens: Array.from(c.querySelectorAll('.modal-lista-adiantamentos li')).map(li => li.textContent.trim()),
        imgInjetada: !!c.querySelector('.modal-lista-adiantamentos img'),
        rolagemH: document.documentElement.scrollWidth > window.innerWidth
      };
    });
  };
  const dNova = await resumo('AJB-2026-230');
  conferir(dNova.itens.slice(0, 3).join(' / ') === 'R$ 100,00 / R$ 250,00 / R$ 0,00' && dNova.linhas.some(t => t === 'Total de adiantamentos: R$ 350,00') && !dNova.imgInjetada && !dNova.rolagemH,
    'dashboard mostra a lista e o total (texto escapado)', dNova);
  await page.evaluate(() => document.querySelector('#modal-ficha-resumo .btn-fechar-modal, .modal-fechar, [data-fechar-modal]')?.click());
  const dAntiga = await resumo('AJB-2026-231');
  conferir(dAntiga.itens.length === 0 && dAntiga.linhas.join() === 'Adiantamento Concedido: R$ 750,00', 'dashboard: ficha antiga com o valor único', dAntiga);
  const acerto = await page.evaluate(() => {
    renderizarTabelaAcertos(); // eslint-disable-line no-undef
    return Array.from(document.querySelectorAll('#tabela-acertos-body tr')).map(tr => Array.from(tr.cells).slice(0, 7).map(td => td.textContent.replace(/\s+/g, ' ').trim()).join(' | '));
  });
  conferir(acerto.some(l => /AJB-2026-230 .*R\$ 1\.100,00 \| R\$ 350,00 \| R\$ 750,00/.test(l)) && acerto.some(l => /AJB-2026-231 .*R\$ 750,00 \| R\$ 350,00/.test(l)), 'acerto: comissão - total de adiantamentos', acerto);

  const errosReais = erros.filter(e => !/Chart is not defined|limparDadosLocais/.test(e));
  conferir(errosReais.length === 0, 'sem erro de JavaScript', errosReais);
  console.log(falhas ? `${falhas} FALHA(S)` : 'tudo ok');
  await browser.close(); srv.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

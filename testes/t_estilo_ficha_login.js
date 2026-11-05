// Estilo (só CSS/HTML): aviso do login abaixo do header; "+ Adicionar frete" e "+ Adicionar abastecimento"
// do mesmo tamanho; títulos e campos da Relação de Fretes alinhados; bloco de adiantamentos centralizado.
// Dados simulados. Prints em testes/capturas/estilo_<sufixo>_<parte>_<largura>.png
// Uso: node testes/t_estilo_ficha_login.js [sufixo]   (sufixo "antes" só mede e tira os prints, sem conferir)
const path = require('path');
const { abrir } = require('./harness');

const SUF = process.argv[2] || 'depois';
const CONFERIR = SUF !== 'antes';
const CAP = path.join(__dirname, 'capturas');
let falhas = 0;
const ok = (cond, msg, extra) => {
  if (!CONFERIR) { console.log(`MEDIDA ${msg}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`); return; }
  console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`); if (!cond) falhas++;
};
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const rolagemLateral = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

// Mostra o aviso do mesmo jeito que o showToast do login.js (classe "show" + tipo)
const mostrarAviso = (page, msg, tipo) => page.evaluate((msg, tipo) => {
  const t = document.getElementById('login-toast');
  t.querySelector('.toast-message').textContent = msg;
  t.querySelector('.toast-icon').textContent = tipo === 'error' ? '✕' : '✓';
  t.className = 'login-toast show';
  t.classList.add(`toast-${tipo}`);
  t.setAttribute('aria-hidden', 'false');
}, msg, tipo);

const medirAviso = (page) => page.evaluate(() => {
  const h = document.querySelector('header').getBoundingClientRect();
  const t = document.getElementById('login-toast').getBoundingClientRect();
  return { fimHeader: Math.round(h.bottom), topoAviso: Math.round(t.top), respiro: Math.round(t.top - Math.max(h.bottom, 0)), dentro: t.left >= 0 && t.right <= window.innerWidth + 0.5 };
});

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});

  // ---------- 2.1 Aviso do login ----------
  for (const largura of [1366, 390]) {
    console.log(`\n--- Aviso do login ${largura}px ---`);
    await page.setViewport({ width: largura, height: largura === 390 ? 844 : 800 });
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'load' });
    for (const [nome, msg] of [['admin', 'Acesso de administrador aprovado! Acessando painel...'], ['motorista', 'Login aprovado! Acessando sua ficha...'], ['erro', 'Por favor, informe um CPF válido no formato 000.000.000-00.']]) {
      await mostrarAviso(page, msg, nome === 'erro' ? 'error' : 'success');
      await esperar(450);
      const m = await medirAviso(page);
      ok(m.respiro >= 10 && m.respiro <= 14 && m.dentro, `aviso (${nome}) abaixo do header com ~12px de respiro`, m);
      if (nome === 'admin') await page.screenshot({ path: path.join(CAP, `estilo_${SUF}_aviso_login_${largura}.png`), clip: { x: 0, y: 0, width: largura, height: Math.min(420, m.topoAviso + 160) } });
    }
    // Página rolada (no celular o header sai da tela): o aviso continua visível, no topo
    await page.evaluate(() => window.scrollTo(0, 600));
    await esperar(200);
    const rolado = await medirAviso(page);
    ok(rolado.topoAviso >= 10 && rolado.topoAviso < 900 && rolado.respiro >= 10, 'página rolada: aviso continua visível e fora do header', rolado);
    ok(!(await rolagemLateral(page)), 'login sem rolagem lateral');
  }

  // ---------- 2.2 a 2.4 Ficha de viagem ----------
  const tabFretes = 'table.tabela-fretes-ml';
  const tabAbast = 'table.tabela-abastecimento:not(.tabela-fretes-ml)';
  for (const largura of [1366, 390]) {
    console.log(`\n--- Ficha de viagem ${largura}px ---`);
    await page.setViewport({ width: largura, height: 900 });
    await page.evaluate(() => localStorage.clear()).catch(() => { });
    await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
    await esperar(400);

    // 2.2 Botões "+ Adicionar"
    const botoes = await page.evaluate((tabFretes, tabAbast) => {
      const med = (sel) => {
        const b = document.querySelector(sel);
        const r = b.getBoundingClientRect(), cs = getComputedStyle(b), sp = b.querySelector('span');
        return { w: Math.round(r.width), h: Math.round(r.height), fonte: cs.fontSize + ' ' + cs.fontWeight, pad: cs.padding, gap: cs.gap, borda: cs.border, raio: cs.borderRadius, icone: sp && getComputedStyle(sp).fontSize, classe: b.className };
      };
      return { frete: med(`${tabFretes} .btn-adicionar-linha-celular`), abast: med(`${tabAbast} .btn-adicionar-linha-celular`) };
    }, tabFretes, tabAbast);
    const igual = ['w', 'h', 'fonte', 'pad', 'gap', 'borda', 'raio', 'icone', 'classe'].every(k => botoes.frete[k] === botoes.abast[k]);
    ok(igual, '"+ Adicionar frete" e "+ Adicionar abastecimento" do mesmo tamanho (mesma classe)', botoes);
    await page.evaluate((tabFretes) => document.querySelector(`${tabFretes} .btn-adicionar-linha-celular`).scrollIntoView({ block: 'center' }), tabFretes);
    await esperar(200);
    await page.screenshot({ path: path.join(CAP, `estilo_${SUF}_botao_frete_${largura}.png`) });
    await page.evaluate((tabAbast) => document.querySelector(`${tabAbast} .btn-adicionar-linha-celular`).scrollIntoView({ block: 'center' }), tabAbast);
    await esperar(200);
    await page.screenshot({ path: path.join(CAP, `estilo_${SUF}_botao_abastecimento_${largura}.png`) });

    // 2.3 Relação de Fretes (no computador é tabela; no celular vira cartões)
    const fretes = await page.evaluate((tabFretes) => {
      const t = document.querySelector(tabFretes);
      const ths = Array.from(t.querySelectorAll('thead th')).filter(th => th.offsetParent !== null);
      const topoTitulo = (th) => {
        const rg = document.createRange();
        const no = Array.from(th.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
        rg.selectNodeContents(no); return Math.round(rg.getClientRects()[0].top);
      };
      const titulos = ths.map(th => ({ t: th.firstChild.textContent.trim() || th.textContent.trim(), top: ths.length ? topoTitulo(th) : 0 }));
      const selos = ths.map(th => { const s = th.querySelector('.tag-motorista, .th-tag-gestao'); return s ? { t: s.textContent.trim(), top: Math.round(s.getBoundingClientRect().top), tituloBottom: (() => { const rg = document.createRange(); rg.selectNodeContents(Array.from(th.childNodes).find(n => n.nodeType === 3 && n.textContent.trim())); return Math.round(rg.getBoundingClientRect().bottom); })() } : null; }).filter(Boolean);
      const linha = t.querySelector('tbody tr');
      const campos = Array.from(linha.querySelectorAll('input.input-tabela, select')).filter(e => e.offsetParent !== null && e.type !== 'hidden').map(e => ({ n: e.name, top: Math.round(e.getBoundingClientRect().top), h: Math.round(e.getBoundingClientRect().height) }));
      const dica = linha.querySelector('.dica-valor-frete');
      const valor = linha.querySelector('.input-valor-frete-ml');
      // Totais: cada valor do rodapé dentro da sua coluna do cabeçalho
      const cols = ths.map(th => th.getBoundingClientRect());
      const totais = Array.from(t.querySelectorAll('tfoot tr:first-child td')).map(td => ({ l: Math.round(td.getBoundingClientRect().left), r: Math.round(td.getBoundingClientRect().right) }));
      const tdsLinha = Array.from(linha.children).filter(td => td.offsetParent !== null).map(td => ({ l: Math.round(td.getBoundingClientRect().left), r: Math.round(td.getBoundingClientRect().right) }));
      return {
        eTabela: getComputedStyle(t).display === 'table',
        titulos, selos, campos,
        dicaAbaixo: dica && valor ? Math.round(dica.getBoundingClientRect().top - valor.getBoundingClientRect().bottom) : null,
        colunas: cols.map(c => ({ l: Math.round(c.left), r: Math.round(c.right) })), totais, tdsLinha
      };
    }, tabFretes);
    if (fretes.eTabela) {
        const tops = new Set(fretes.titulos.map(x => x.top));
        ok(tops.size === 1, 'todos os títulos da Relação de Fretes na mesma linha', fretes.titulos);
        ok(fretes.selos.length === 3 && fretes.selos.every(s => s.top >= s.tituloBottom), 'selos "Motorista" / "Gestão" embaixo do título', fretes.selos);
        const ctops = new Set(fretes.campos.map(c => c.top));
        ok(ctops.size === 1, 'campos da linha na mesma altura', fretes.campos);
        ok(fretes.dicaAbaixo !== null && fretes.dicaAbaixo >= 0, '"Não sabe o valor?..." embaixo do campo do valor', fretes.dicaAbaixo);
        // Linha de totais: as bordas dos tds do rodapé caem nas bordas das colunas
        const bordas = new Set(fretes.colunas.flatMap(c => [c.l, c.r]));
        ok(fretes.totais.every(td => bordas.has(td.l) && bordas.has(td.r)), 'linha de TOTAIS alinhada com as colunas', fretes.totais);
      } else {
        ok(fretes.dicaAbaixo !== null && fretes.dicaAbaixo >= 0, 'celular (cartão): "Não sabe o valor?..." embaixo do campo do valor', fretes.dicaAbaixo);
    }
    await page.evaluate((tabFretes) => { document.querySelector(tabFretes).scrollIntoView({ block: 'start' }); window.scrollBy(0, -130); }, tabFretes);
    await esperar(200);
    await page.screenshot({ path: path.join(CAP, `estilo_${SUF}_relacao_fretes_${largura}.png`) });

    // Abastecimento: mesmos critérios de alinhamento (se tiver selo)
    const abast = await page.evaluate((tabAbast) => {
      const t = document.querySelector(tabAbast);
      const selos = t.querySelectorAll('thead .tag-motorista, thead .th-tag-gestao').length;
      const linha = t.querySelector('tbody tr');
      const campos = Array.from(linha.querySelectorAll('input.input-tabela, select')).filter(e => e.offsetParent !== null).map(e => Math.round(e.getBoundingClientRect().top));
      return { eTabela: getComputedStyle(t).display === 'table', selos, alturas: [...new Set(campos)] };
    }, tabAbast);
    if (abast.eTabela) ok(abast.alturas.length === 1, `abastecimento: campos da linha na mesma altura (selos no cabeçalho: ${abast.selos})`, abast);

    // 2.4 Adiantamentos centralizado
    const adiant = await page.evaluate(() => {
      const w = document.querySelector('.tabela-adiantamentos-wrapper').getBoundingClientRect();
      const area = document.querySelector('.bloco-adiantamentos').getBoundingClientRect();
      return { w: Math.round(w.width), esq: Math.round(w.left - area.left), dir: Math.round(area.right - w.right), area: Math.round(area.width) };
    });
    if (largura >= 900) ok(adiant.w === 520 && Math.abs(adiant.esq - adiant.dir) <= 1, 'adiantamentos: bloco centralizado, largura mantida (520px)', adiant);
    else ok(adiant.esq <= 1 && adiant.dir <= 1, 'adiantamentos no celular: largura toda', adiant);
    await page.evaluate(() => { document.querySelector('.bloco-adiantamentos').scrollIntoView({ block: 'start' }); window.scrollBy(0, -130); });
    await esperar(200);
    await page.screenshot({ path: path.join(CAP, `estilo_${SUF}_adiantamentos_${largura}.png`) });

    // Número da linha (e a lixeira, da 2ª linha em diante) no meio da altura dos campos (depois dos prints:
    // o "Remover" mostra um aviso da ficha)
    if (fretes.eTabela) {
      await page.evaluate((tabFretes) => document.querySelector(`${tabFretes} .btn-adicionar-linha-celular`).click(), tabFretes);
      await esperar(200);
      const visiveis = `${tabFretes} tbody tr:not(.linha-oculta-celular):not(.linha-adicionar-celular)`;
      const centros = await page.evaluate((visiveis) => Array.from(document.querySelectorAll(visiveis)).slice(0, 2).map((tr) => {
        const meio = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
        const lixeira = tr.querySelector('.btn-limpar-linha-inline');
        return { numero: meio(tr.querySelector('.num-rotulo')), lixeira: lixeira && lixeira.offsetParent ? meio(lixeira) : null, campo: meio(tr.querySelector('.input-data-frete')) };
      }), visiveis);
      ok(centros.length === 2 && centros.every(c => Math.abs(c.numero - c.campo) <= 2 && (c.lixeira === null || Math.abs(c.lixeira - c.campo) <= 2)), 'número e lixeira no meio da altura dos campos (1ª e 2ª linha)', centros);
      await page.evaluate((visiveis) => document.querySelectorAll(visiveis)[1].querySelector('.btn-limpar-linha-inline').click(), visiveis);
      await esperar(200);
    }
    ok(!(await rolagemLateral(page)), 'ficha sem rolagem lateral na página');
  }

  // 320 px: os dois "+ Adicionar" cabem no cartão (no celular não há largura mínima)
  console.log('\n--- Ficha de viagem 320px ---');
  await page.setViewport({ width: 320, height: 800 });
  await page.goto(`${base}/HTML/relatorio-viagem.html?novo=true`, { waitUntil: 'load' });
  await esperar(400);
  const b320 = await page.evaluate((tabFretes, tabAbast) => [tabFretes, tabAbast].map((t) => {
    const b = document.querySelector(`${t} .btn-adicionar-linha-celular`);
    return { w: Math.round(b.getBoundingClientRect().width), td: Math.round(b.parentElement.getBoundingClientRect().width) };
  }), tabFretes, tabAbast);
  ok(b320.every(x => x.w <= x.td && x.w === b320[0].w), '320px: os dois botões do mesmo tamanho e dentro do cartão', b320);
  ok(!(await rolagemLateral(page)), '320px: ficha sem rolagem lateral');

  const errosJs = erros.filter(e => !/Failed to fetch|Swiper|limparDadosLocais/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(CONFERIR ? (falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK') : '\nMEDIDAS SALVAS');
  await browser.close(); srv.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

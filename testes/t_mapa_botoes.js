// Botões do mapa (Google Maps, Waze, Copiar Endereço) da página inicial iguais aos do Contato,
// parados e com o mouse em cima (cor do fundo, do texto, do ícone, borda, padding e fonte),
// e nenhuma página com "Quereta" (o certo é Granja Xereta).
const fs = require('fs');
const path = require('path');
const { abrir } = require('./harness');

const BOTOES = [
  ['Google Maps', '.btn-mapa-primario'],
  ['Waze', '#btn-abrir-waze'],
  ['Copiar Endereço', '#btn-copiar-endereco']
];

async function estilos(page, sel) {
  return page.$eval(sel, el => {
    const cs = getComputedStyle(el);
    const svg = el.querySelector('svg');
    return {
      fundo: cs.backgroundColor, texto: cs.color, icone: svg ? getComputedStyle(svg).color : '(sem ícone)',
      borda: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`, padding: cs.padding,
      fonte: `${cs.fontSize} ${cs.fontWeight} ${cs.fontFamily.split(',')[0]}`, sombra: cs.boxShadow, transform: cs.transform
    };
  });
}

(async () => {
  const { srv, base, browser, page, erros } = await abrir({ largura: 1280 });
  const r = {};
  for (const [pagina, url] of [['inicio', 'index.html'], ['contato', 'Contato.html']]) {
    await page.goto(`${base}/HTML/${url}`, { waitUntil: 'load' });
    r[pagina] = {};
    for (const [nome, sel] of BOTOES) {
      await page.$eval(sel, el => el.scrollIntoView({ block: 'center' }));
      await page.mouse.move(0, 0);
      await new Promise(res => setTimeout(res, 400));
      const parado = await estilos(page, sel);
      await page.hover(sel);
      await new Promise(res => setTimeout(res, 400)); // transição de 0,2 s
      const hover = await estilos(page, sel);
      r[pagina][nome] = { parado, hover };
    }
  }

  // Comparação pedida: hover da página inicial
  const ESPERADO_PRIMARIO = 'rgb(43, 43, 109)';   // #2b2b6d
  const ESPERADO_SECUNDARIO = 'rgb(61, 61, 144)'; // #3d3d90
  r.conferencia = BOTOES.map(([nome]) => {
    const i = r.inicio[nome];
    const c = r.contato[nome];
    const fundoEsperado = nome === 'Google Maps' ? ESPERADO_PRIMARIO : ESPERADO_SECUNDARIO;
    const igualContato = ['parado', 'hover'].every(e => JSON.stringify(i[e]) === JSON.stringify(c[e]));
    return `${nome}: hover fundo ${i.hover.fundo} (${i.hover.fundo === fundoEsperado ? 'ok' : 'ERRADO, esperado ' + fundoEsperado}) | ` +
      `texto ${i.hover.texto} (${i.hover.texto === 'rgb(255, 255, 255)' ? 'branco' : 'NÃO branco'}, ${i.hover.texto !== i.hover.fundo ? 'visível' : 'INVISÍVEL'}) | ` +
      `ícone ${i.hover.icone === i.hover.texto ? 'acompanha o texto' : 'DIFERENTE do texto'} | igual ao Contato: ${igualContato ? 'sim' : 'NÃO'}`;
  });

  // "Quereta" em alguma página (arquivo e texto da página aberta)
  const pastaHtml = path.resolve(__dirname, '..', 'HTML');
  r.queretaNosArquivos = fs.readdirSync(pastaHtml).filter(f => /quereta/i.test(fs.readFileSync(path.join(pastaHtml, f), 'utf8')));
  r.queretaNasPaginas = [];
  for (const f of ['index.html', 'Contato.html', 'Login.html', 'politica-privacidade.html', 'Sobrenos.html', 'Nossosfretes.html', 'FichaMultiCadastro.html']) {
    await page.goto(`${base}/HTML/${f}`, { waitUntil: 'load' });
    if (await page.evaluate(() => /quereta/i.test(document.documentElement.outerHTML))) r.queretaNasPaginas.push(f);
  }

  // (o harness deixa os CDNs vazios: o carrossel Swiper do início não carrega; o auth.js de teste não tem limparDadosLocais)
  r.erros = erros.filter(e => !/limparDadosLocais|Swiper is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

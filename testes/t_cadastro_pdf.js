// Cadastro de terceiros com documentos só em PDF, selfie e rastreador; envio dos arquivos com falha
// e "Tentar enviar de novo"; dashboard abrindo o cadastro novo e os do formato de antes.
// Nada vai para o Supabase: a edge function e o Storage são simulados no navegador.
// Só dados inventados (CPF de teste 523.169.159-30, nomes "de Teste").
// Uso: node testes/t_cadastro_pdf.js
const { abrir } = require('./harness');
const espera = (ms) => new Promise((res) => setTimeout(res, ms));

// Arquivos e simulação da edge function / Storage, dentro da página
const NA_PAGINA = () => {
  window.__arq = {
    pdf: (nome, kb = 2, tipo = 'application/pdf') => new File([new Uint8Array(kb * 1024).fill(37)], nome, { type: tipo }),
    async foto(nome, lado = 400, tipo = 'image/png') {
      const c = document.createElement('canvas');
      c.width = lado; c.height = Math.round(lado * 0.75);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#3d3d90'; ctx.fillRect(0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, tipo));
      return new File([blob], nome, { type: tipo });
    },
    escolher(sel, arquivos) {
      const input = document.querySelector(sel);
      const dt = new DataTransfer();
      arquivos.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    previa: (sel) => Array.from(document.querySelector(sel).closest('.upload-dropzone').querySelectorAll('.file-preview-nome')).map((e) => e.textContent),
    async pronto(sel) {
      const zona = document.querySelector(sel).closest('.upload-dropzone');
      for (let i = 0; i < 100 && zona.dataset.processando; i++) await new Promise((r) => setTimeout(r, 50));
    }
  };
  // Edge function: devolve um upload por arquivo, na ordem do corpo (como a de verdade)
  window.__bucket = {};
  window.__chamadasUpload = [];
  window.__falharUpload = new Set(); // caminhos que falham (as 3 tentativas)
  window.solicitarCadastroAgregado = async (corpo) => {
    window.__corpo = corpo;
    const uploads = [];
    let i = 0;
    for (const [campo, lista] of Object.entries(corpo.documentos)) {
      for (const d of lista) {
        uploads.push({ indice: i, campo, path: `terceiros/cad-teste/${campo}_${i + 1}_${d.nome}`, token: `token-${i}` });
        i++;
      }
    }
    return { sucesso: true, cadastroId: 'cad-teste', uploads };
  };
  window.supabaseClient = {
    storage: {
      from: () => ({
        uploadToSignedUrl: async (caminho, token, arquivo, opcoes) => {
          window.__chamadasUpload.push({ caminho, tipoDoArquivo: arquivo.type, contentType: opcoes && opcoes.contentType });
          await new Promise((r) => setTimeout(r, 30));
          if (window.__falharUpload.has(caminho)) return { error: { statusCode: '500', message: 'falha simulada' } };
          window.__bucket[caminho] = arquivo.type;
          return { error: null };
        }
      })
    }
  };
};

async function preencherValido(page, { tipologia = 'Toco (4×2)', selfie = true, rastreador = true, residencia = false } = {}) {
  await page.select('#pf-tipologia', tipologia);
  await page.evaluate(async (o) => {
    const v = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
    v('pf-motorista-nome', 'Fulano'); v('pf-motorista-sobrenome', 'de Teste');
    v('pf-cpf', '523.169.159-30'); v('pf-celular', '(11) 90000-0000');
    if (o.rastreador) { v('pf-rastreador-marca', 'Sascar'); v('pf-rastreador-id', 'TESTE-000123'); }
    __arq.escolher('#pf-anexo-cnh', [__arq.pdf('cnh.pdf')]);
    document.querySelectorAll('#pf-crlvs input[type=file]').forEach((i, n) => __arq.escolher(`#${i.id}`, [__arq.pdf(`crlv-${n + 1}.pdf`)]));
    __arq.escolher('#pf-anexo-rntrc', [__arq.pdf('rntrc.pdf')]);
    if (o.residencia) __arq.escolher('#pf-anexo-residencia', [__arq.pdf('conta.pdf')]);
    if (o.selfie) __arq.escolher('#pf-anexo-selfie', [await __arq.foto('selfie.png')]);
    document.getElementById('pf-aceite-lgpd').checked = true;
  }, { selfie, rastreador, residencia });
  await page.evaluate(() => __arq.pronto('#pf-anexo-selfie'));
}

async function enviar(page) {
  page._dialogos = [];
  await page.evaluate(() => document.querySelector('#form-pf button[type="submit"]').click());
  await espera(250);
  return page.evaluate(() => ({
    revisao: document.getElementById('modal-revisar-cadastro').classList.contains('ativo'),
    aviso: Array.from(document.querySelectorAll('#form-pf .aviso-bloco')).map((a) => a.textContent).join(' / '),
    invalido: Array.from(document.querySelectorAll('#form-pf :invalid')).map((el) => el.id).join(', ')
  }));
}

async function novaPagina(page, base) {
  await page.goto(`${base}/HTML/FichaMultiCadastro.html`, { waitUntil: 'load' });
  await page.evaluate(NA_PAGINA);
  await page.click('#card-pf');
}

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  const r = {};

  // 1. CRLVs por tipo de veículo
  await novaPagina(page, base);
  r.crlvs = {};
  for (const t of ['Cavalo 6×2', 'Toco (4×2)']) {
    await page.select('#pf-tipologia', t);
    r.crlvs[t] = await page.$$eval('#pf-crlvs .cartao-doc-titulo', (hs) => hs.map((h) => h.textContent));
  }
  r.dicaTipologia = await page.$eval('#pf-dica-tipologia', (e) => e.textContent);
  await page.select('#pf-tipologia', 'Cavalo 6×2');
  await preencherValido(page, { tipologia: 'Cavalo 6×2' });
  await page.evaluate(() => { const i = document.getElementById('pf-anexo-crlv-2'); i.closest('.upload-dropzone').querySelector('.file-preview-remover').click(); });
  r.cavaloSemCrlvCarreta = await enviar(page);

  // 2. Foto recusada nos documentos; PDF aceito; a selfie é a única que aceita imagem
  await novaPagina(page, base);
  await page.select('#pf-tipologia', 'Toco (4×2)');
  r.tipos = {};
  for (const [nome, sel] of [['CNH', '#pf-anexo-cnh'], ['CRLV', '#pf-anexo-crlv-1'], ['RNTRC', '#pf-anexo-rntrc'], ['Comprovante', '#pf-anexo-residencia'], ['Selfie', '#pf-anexo-selfie']]) {
    page._dialogos = [];
    await page.evaluate(async (sel) => __arq.escolher(sel, [await __arq.foto('foto.jpg', 300, 'image/jpeg')]), sel);
    await page.evaluate((sel) => __arq.pronto(sel), sel);
    const foto = { aviso: (page._dialogos || []).join(' / ') || '(sem aviso)', previa: await page.evaluate((sel) => __arq.previa(sel), sel) };
    page._dialogos = [];
    await page.evaluate((sel) => __arq.escolher(sel, [__arq.pdf('doc.pdf')]), sel);
    const pdf = { aviso: (page._dialogos || []).join(' / ') || '(sem aviso)', previa: await page.evaluate((sel) => __arq.previa(sel), sel) };
    r.tipos[nome] = { foto, pdf };
  }
  r.accept = await page.$$eval('#form-pf input[type=file]', (is) => is.map((i) => `${i.id}: ${i.accept}${i.getAttribute('capture') ? ` capture=${i.getAttribute('capture')}` : ''}`));
  r.textoZonaDocs = await page.$eval('#pf-anexo-cnh', (i) => i.closest('.upload-dropzone').querySelector('.upload-subtext').textContent);
  r.etiquetaComprovante = await page.$eval('#form-pf .cartao-doc[data-doc="residencia"] .etiqueta-doc', (e) => e.textContent);
  // Arquivo de 0 byte é recusado na hora
  page._dialogos = [];
  await page.evaluate(() => __arq.escolher('#pf-anexo-rntrc', [new File([], 'vazio.pdf', { type: 'application/pdf' })]));
  r.arquivoVazio = (page._dialogos || []).join(' / ');

  // 3. A caixa "não tenho" não existe mais (a do aceite da LGPD continua)
  r.caixaNaoTenho = await page.evaluate(() => ({
    caixas: document.querySelectorAll('.cartao-doc .caixa-sem-pdf, [id*="-sem-pdf-"]').length,
    camposDigitados: document.querySelectorAll('#pf-cnh-registro, #pf-mot-cep, #pf-rntrc, [id^="pf-crlv1-"]').length,
    texto: /não tenho o pdf/i.test(document.body.innerText),
    aceiteLgpd: !!document.getElementById('pf-aceite-lgpd')
  }));

  // 4. Sem comprovante o envio passa; sem selfie ou sem rastreador é bloqueado
  await novaPagina(page, base);
  await preencherValido(page, { selfie: false });
  r.semSelfie = await enviar(page);
  await novaPagina(page, base);
  await preencherValido(page, { rastreador: false });
  r.semRastreador = await enviar(page);
  await novaPagina(page, base);
  await preencherValido(page);
  r.semComprovante = await enviar(page);
  r.semComprovante.resumo = await page.$$eval('#resumo-cadastro div', (ds) => ds.map((d) => d.textContent).filter((t) => /Comprovante|Rastreador|Selfie/.test(t)));

  // 5. PDF com file.type vazio (Android/WhatsApp) é aceito e sobe com application/pdf
  await novaPagina(page, base);
  await preencherValido(page);
  page._dialogos = [];
  await page.evaluate(() => {
    __arq.escolher('#pf-anexo-cnh', [__arq.pdf('cnh-whatsapp.pdf', 3, '')]);
    __arq.escolher('#pf-anexo-rntrc', [__arq.pdf('rntrc-drive.PDF', 3, 'application/octet-stream')]);
  });
  r.tipoVazio = { aviso: (page._dialogos || []).join(' / ') || '(sem aviso)', previaCnh: await page.evaluate(() => __arq.previa('#pf-anexo-cnh')) };
  await enviar(page);
  await page.click('#btn-confirmar-envio');
  await espera(800);
  r.tipoVazio.corpo = await page.evaluate(() => Object.fromEntries(Object.entries(window.__corpo.documentos).map(([k, l]) => [k, l.map((d) => `${d.nome}:${d.tipo}`)])));
  r.tipoVazio.uploads = await page.evaluate(() => window.__chamadasUpload.filter((c) => /whatsapp|drive/.test(c.caminho)).map((c) => `${c.caminho.split('/').pop()} arquivo=${c.tipoDoArquivo} contentType=${c.contentType}`));
  r.tipoVazio.sucesso = await page.evaluate(() => document.getElementById('modal-sucesso-cadastro').classList.contains('ativo'));

  // 6. Falha no 3º arquivo -> sem tela de sucesso -> "Tentar enviar de novo" -> tudo no bucket
  await novaPagina(page, base);
  await preencherValido(page, { residencia: true });
  await enviar(page);
  // 3º arquivo do envio (ordem: CNH, selfie, CRLV, RNTRC, comprovante)
  await page.evaluate(() => {
    const original = window.solicitarCadastroAgregado;
    window.solicitarCadastroAgregado = async (corpo) => {
      const res = await original(corpo);
      window.__falharUpload.add(res.uploads[2].path);
      return res;
    };
  });
  // Tela de progresso e aviso ao sair durante o envio
  const progresso = [];
  await page.click('#btn-confirmar-envio');
  for (let i = 0; i < 12; i++) {
    await espera(40);
    progresso.push(await page.evaluate(() => {
      const m = document.getElementById('modal-enviando-cadastro');
      if (!m.classList.contains('ativo')) return null;
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return `${m.querySelector('h3').textContent} ${document.getElementById('envio-progresso-contagem').textContent} ${m.querySelector('.envio-progresso-aviso').textContent} | sair pede confirmação: ${ev.defaultPrevented ? 'sim' : 'NÃO'}`;
    }));
  }
  await espera(800);
  r.falha = {
    progresso: [...new Set(progresso.filter(Boolean))],
    telaDeSucesso: await page.evaluate(() => document.getElementById('modal-sucesso-cadastro').classList.contains('ativo')),
    telaDeFalha: await page.evaluate(() => document.getElementById('modal-falha-envio').classList.contains('ativo')),
    lista: await page.$$eval('#lista-falhas-envio li', (ls) => ls.map((l) => l.textContent)),
    whatsappNaPrimeira: await page.evaluate(() => !document.getElementById('btn-whatsapp-rh').hidden),
    noBucket: await page.evaluate(() => Object.keys(window.__bucket).length),
    formularioMantido: await page.evaluate(() => __arq.previa('#pf-anexo-cnh').length)
  };
  // Tentar de novo ainda falhando -> aparece o WhatsApp do RH com a lista
  await page.click('#btn-tentar-de-novo');
  await espera(800);
  r.falha.segundaTentativa = await page.evaluate(() => ({
    whatsapp: !document.getElementById('btn-whatsapp-rh').hidden,
    link: decodeURIComponent(document.getElementById('btn-whatsapp-rh').href).replace(/\n/g, ' | '),
    uploadsSoDoQueFalhou: window.__chamadasUpload.slice(-3).map((c) => c.caminho.split('/').pop())
  }));
  // A rede volta: tentar de novo sobe só o que faltou e mostra o sucesso
  await page.evaluate(() => window.__falharUpload.clear());
  const antes = await page.evaluate(() => window.__chamadasUpload.length);
  await page.click('#btn-tentar-de-novo');
  await espera(800);
  r.falha.terceira = await page.evaluate((antes) => ({
    reenviados: window.__chamadasUpload.slice(antes).map((c) => c.caminho.split('/').pop()),
    noBucket: Object.keys(window.__bucket).length,
    esperados: window.__corpo && Object.values(window.__corpo.documentos).flat().length,
    telaDeSucesso: document.getElementById('modal-sucesso-cadastro').classList.contains('ativo')
  }), antes);
  const noBucket = await page.evaluate(() => Object.keys(window.__bucket));
  const corpoEnviado = await page.evaluate(() => window.__corpo);

  // 7. 360 px sem quebrar
  r.celular = {};
  for (const w of [360, 390]) {
    await page.setViewport({ width: w, height: 780 });
    await novaPagina(page, base);
    await preencherValido(page, { tipologia: 'Bitrem' });
    r.celular[w] = await page.evaluate(() => {
      const fora = Array.from(document.querySelectorAll('#form-pf *')).filter((el) => el.offsetParent !== null)
        .filter((el) => { const b = el.getBoundingClientRect(); return b.width && (b.right > window.innerWidth + 1 || b.left < -1); }).map((el) => el.id || el.className);
      return `rolagem lateral ${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'}, fora da tela: ${fora.length ? fora.join(', ') : 'nenhum'}`;
    });
  }
  await page.setViewport({ width: 1280, height: 900 });

  // 8. Dashboard: o cadastro enviado acima (sem "não chegou") e os do formato de antes
  await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão', id: 'a1' })));
  await page.goto(`${base}/HTML/Dashboard-cadastro-motorista.html`, { waitUntil: 'load' });
  r.dashboard = await page.evaluate(async (noBucket, corpo) => {
    const doc = (id, campo, n, nome, tipo) => ({ campo, nome, tipo, tamanho: 1000, path: `terceiros/${id}/${campo}_${n}_${nome}` });
    const base = { cpf: '52316915930', celular: '11900000000', tipo: 'pf', status: 'pendente', criado_em: '2026-10-27T12:00:00Z', etapas: {} };
    // Novo: como a edge function grava (dados do corpo + _tipologia, _papeis e _so_pdf; documentos com os caminhos)
    let n = 0;
    const docsNovo = Object.entries(corpo.documentos).flatMap(([campo, l]) => l.map((d) => ({ campo, nome: d.nome, tipo: d.tipo, tamanho: d.tamanho, path: `terceiros/cad-teste/${campo}_${++n}_${d.nome}` })));
    const novo = { ...base, id: 'cad-teste', nome: 'Fulano de Teste', dados: { ...corpo.dados, _tipologia: corpo.tipologia, _papeis: ['Caminhão'], _so_pdf: true }, documentos: docsNovo };
    // Formato de antes (com _sem_pdf e campos digitados, sem selfie nem rastreador)
    const antigo = { ...base, id: 'c-antigo', nome: 'Beltrano de Teste', status: 'analise',
      etapas: { gr: { feito: true, por: 'Gestão de Teste', em: '2026-10-21T10:00:00Z' } },
      dados: { _tipologia: 'Cavalo 6×2', _sem_pdf: { cnh: true, crlv_1: false, rntrc: false, residencia: false }, 'cnh-registro': '12345678900', 'cnh-categoria': 'E', celular: '(11) 90000-0001' },
      documentos: [doc('c-antigo', 'cnh_foto', 1, 'foto-cnh.jpg', 'image/jpeg'), doc('c-antigo', 'crlv_1', 2, 'crlv.pdf', 'application/pdf'),
        doc('c-antigo', 'rntrc', 3, 'rntrc.pdf', 'application/pdf'), doc('c-antigo', 'residencia', 4, 'conta.pdf', 'application/pdf')] };
    // Formato mais antigo (sem _tipologia)
    const maisAntigo = { ...base, id: 'c-mais-antigo', nome: 'Ciclano de Teste', status: 'aprovado', sem_carreta: true,
      dados: { 'veic-placa': 'ABC1D23', 'rastreador-pri': 'Sascar' }, documentos: [doc('c-mais-antigo', 'cnh', 1, 'cnh.pdf', 'application/pdf')] };
    const noBucketTodos = new Set([...noBucket, ...antigo.documentos.map((d) => d.path), ...maisAntigo.documentos.map((d) => d.path)]);
    window.supabaseClient = {
      storage: { from: () => ({
        list: async (pasta) => ({ data: [...noBucketTodos].filter((p) => p.startsWith(pasta + '/')).map((p) => ({ name: p.slice(pasta.length + 1) })) }),
        createSignedUrls: async (cs) => ({ data: cs.map((p) => ({ path: p, signedUrl: `https://link.teste/${p}` })) }),
        createSignedUrl: async (p) => ({ data: { signedUrl: `https://link.teste/${p}` } })
      }) }
    };
    cadastros = [novo, antigo, maisAntigo]; // eslint-disable-line no-undef
    const ver = async (c) => {
      await abrirModal(c.id); // eslint-disable-line no-undef
      await new Promise((res) => setTimeout(res, 50));
      const corpoModal = document.getElementById('modal-body-content');
      const secoes = Array.from(corpoModal.querySelectorAll('fieldset.cad-secao')).map((f) => {
        const legenda = f.querySelector('legend').textContent.trim().replace(/\s+/g, ' ');
        const inputs = Array.from(f.querySelectorAll('input[data-campo]')).map((i) => `${i.getAttribute('data-campo')}=${i.value || `(${i.placeholder})`}`);
        return `${legenda}: ${f.querySelectorAll('.cad-foto-miniatura').length} miniatura(s), ${f.querySelectorAll('[data-acao="abrir-doc"]').length} PDF(s)${inputs.length ? ` | ${inputs.join(', ')}` : ''}`;
      }).filter((t) => !/Etapas|Extras/.test(t));
      const ficha = fichaHtml(c, { enviados: noBucketTodos, nomes: nomesLegiveis(c), srcFoto: (x) => `https://link.teste/${x.path}`, imprimir: true }); // eslint-disable-line no-undef
      const fichaDoc = new DOMParser().parseFromString(ficha, 'text/html');
      return {
        status: corpoModal.querySelector('.cad-topo').textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
        etapaGr: !!corpoModal.querySelector('input[data-etapa="gr"]')?.checked,
        naoChegou: (corpoModal.innerText.match(/não chegou/gi) || []).length,
        secoes,
        ficha: Array.from(fichaDoc.querySelectorAll('h2')).map((h) => h.textContent.trim().replace(/\s+/g, ' ')).filter((t) => /Selfie|Rastreador|Comprovante|CRLV|CNH/.test(t)),
        fichaRastreador: Array.from(fichaDoc.querySelectorAll('section')).filter((s) => /Rastreador/.test(s.querySelector('h2').textContent)).map((s) => s.querySelector('table').textContent.replace(/\s+/g, ' ').trim()),
        fichaMiniaturas: fichaDoc.querySelectorAll('figure img').length,
        zip: Object.values(nomesLegiveis(c)) // eslint-disable-line no-undef
      };
    };
    return { novo: await ver(novo), antigo: await ver(antigo), maisAntigo: await ver(maisAntigo) };
  }, noBucket, corpoEnviado);

  r.erros = erros.filter((e) => !/limparDadosLocais/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });

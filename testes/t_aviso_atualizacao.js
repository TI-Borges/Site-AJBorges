// Aviso de atualização do site: faixa nas páginas (antes / durante / depois do fim / cancelado / consulta
// com erro; não cobre o header nem cria rolagem em 360 e 1440 px; descrição escapada) e o modal
// "Avisar atualização do site" nos dois dashboards (validação, salvar, lista e cancelar).
// A RPC avisos_atualizacao_ativos é simulada no navegador (fetch e supabaseClient falsos).
const { abrir } = require('./harness');

const PAGINAS = (process.argv[3] || 'index,Login,FichaMultiCadastro,Nossosfretes,Sobrenos,Contato,relatorio-viagem').split(',');
const LARGURAS = (process.argv[2] || '360,1440').split(',').map(Number);
const HORA = 3600 * 1000;

(async () => {
  const { srv, base, browser, page, erros } = await abrir({});
  // fetch da RPC: devolve o que estiver em localStorage.teste_avisos ("erro" = consulta falha)
  await page.evaluateOnNewDocument(() => {
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = (url, opcoes) => {
      if (String(url).includes('/rest/v1/rpc/avisos_atualizacao_ativos')) {
        window.__consultasAviso = (window.__consultasAviso || 0) + 1;
        const v = localStorage.getItem('teste_avisos') || '[]';
        if (v === 'erro') return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve(new Response(v, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return fetchOriginal(url, opcoes);
    };
  });
  await page.goto(`${base}/HTML/index.html`, { waitUntil: 'load' });
  const definirAvisos = (lista) => page.evaluate((v) => localStorage.setItem('teste_avisos', v), typeof lista === 'string' ? lista : JSON.stringify(lista));
  const aviso = (id, inicioRel, fimRel, descricao) => ({ id, inicio: new Date(Date.now() + inicioRel).toISOString(), fim: new Date(Date.now() + fimRel).toISOString(), descricao });
  const faixa = () => page.evaluate(() => {
    const f = document.querySelector('.aviso-atualizacao-faixa');
    return f ? { texto: f.textContent.replace(/\s+/g, ' ').trim(), tags: Array.from(f.querySelectorAll('*')).map(e => e.tagName.toLowerCase()).join(',') } : null;
  });
  const abrirPagina = async (pag) => {
    await page.goto(`${base}/HTML/${pag}.html${pag === 'relatorio-viagem' ? '?novo=true' : ''}`, { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 400));
  };
  const r = {};

  // 1. Textos: antes, durante, terminado, cancelado (RPC sem o aviso), consulta com erro
  await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'motorista', nome: 'Motorista Teste', id: 'u1', cpf: '00000000000' })));
  const DESCRICAO = 'Nova tela de abastecimento <img src=x onerror="window.__xss=1"> & "fichas"';
  await definirAvisos([aviso(1, 2 * HORA, 4 * HORA, DESCRICAO)]);
  await abrirPagina('relatorio-viagem');
  r.antes = await faixa();
  r.descricaoEscapada = await page.evaluate(() => !document.querySelector('.aviso-atualizacao-faixa img') && !window.__xss);
  await definirAvisos([aviso(2, -1 * HORA, 1 * HORA, 'Troca do servidor.')]);
  await abrirPagina('relatorio-viagem');
  r.durante = await faixa();
  await definirAvisos([aviso(3, -3 * HORA, -1 * HORA, 'Já terminou')]);
  await abrirPagina('relatorio-viagem');
  r.depoisDoFim = await faixa();
  // Com a página aberta: o aviso é cancelado (a RPC para de devolver) e a faixa some na próxima consulta
  await definirAvisos([aviso(4, 2 * HORA, 4 * HORA, 'Vai ser cancelado')]);
  await abrirPagina('relatorio-viagem');
  r.cancelado = { antes: await faixa() };
  await definirAvisos([]);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await new Promise(res => setTimeout(res, 300));
  r.cancelado.depois = await faixa();
  await definirAvisos('erro');
  const errosAntes = erros.length;
  await abrirPagina('relatorio-viagem');
  r.consultaComErro = { faixa: await faixa(), errosNovosNaPagina: erros.slice(errosAntes), formularioNaTela: await page.$eval('#form-relatorio', el => el.offsetParent !== null) };
  r.consultas = await page.evaluate(() => window.__consultasAviso || 0);

  // 2. Layout em cada página: faixa acima do header (sem cobrir), sem rolagem lateral; com o header
  //    fixo (computador), rolando a página a faixa continua no topo e o header logo abaixo
  await definirAvisos([aviso(5, 2 * HORA, 4 * HORA, 'Atualização do portal da frota com melhorias na ficha de viagem e no login dos motoristas.')]);
  r.layout = [];
  for (const pag of PAGINAS) {
    for (const w of LARGURAS) {
      await page.setViewport({ width: w, height: 800 });
      await abrirPagina(pag);
      const medir = () => page.evaluate(() => {
        const f = document.querySelector('.aviso-atualizacao-faixa');
        const h = document.querySelector('body > header');
        if (!f || !h) return null;
        const rf = f.getBoundingClientRect();
        const rh = h.getBoundingClientRect();
        const main = document.querySelector('main') || h.nextElementSibling;
        const primeiro = main && (main.firstElementChild || main);
        return {
          faixa: `${Math.round(rf.top)}–${Math.round(rf.bottom)}`, header: `${Math.round(rh.top)}–${Math.round(rh.bottom)} ${getComputedStyle(h).position}`,
          cobreHeader: rf.bottom > rh.top + 0.5 && rf.top < rh.bottom, rolagemH: document.documentElement.scrollWidth > window.innerWidth,
          conteudoAtrasDoHeader: getComputedStyle(h).position === 'fixed' && primeiro && primeiro.getBoundingClientRect().top < rh.bottom - 1
        };
      });
      const topo = await medir();
      await page.evaluate(() => window.scrollTo(0, 600));
      await new Promise(res => setTimeout(res, 100));
      const rolado = await medir();
      r.layout.push(`${pag.padEnd(19)} ${String(w).padStart(4)}px | topo: faixa ${topo?.faixa} header ${topo?.header} cobre=${topo?.cobreHeader ? 'SIM' : 'não'} conteúdo atrás do header=${topo?.conteudoAtrasDoHeader ? 'SIM' : 'não'} rolagemH=${topo?.rolagemH ? 'SIM' : 'não'} | rolado: faixa ${rolado?.faixa} header ${rolado?.header} cobre=${rolado?.cobreHeader ? 'SIM' : 'não'}`);
    }
  }

  // 3. Modal "Avisar atualização do site" nos dois dashboards
  r.modal = {};
  for (const [nome, url] of [['frota', 'dashboard-admin.html'], ['agregue-se', 'Dashboard-cadastro-motorista.html']]) {
    for (const w of [1280, 360]) {
      await page.setViewport({ width: w, height: 800 });
      await page.evaluate(() => localStorage.setItem('teste_usuario', JSON.stringify({ role: 'admin', nome: 'Gestão Teste', id: 'admin-1', email: 'gestao@exemplo.invalid' })));
      await definirAvisos([aviso(10, -1 * HORA, 1 * HORA, 'Em andamento <b>agora</b>'), aviso(11, 24 * HORA, 26 * HORA, 'Amanhã')]);
      await page.goto(`${base}/HTML/${url}`, { waitUntil: 'load' });
      await new Promise(res => setTimeout(res, 500));
      // Supabase falso: a lista vem de teste_avisos; insert e update ficam registrados
      await page.evaluate(() => {
        window.__chamadas = [];
        window.supabaseClient = {
          rpc: async (nome) => { window.__chamadas.push(`rpc ${nome}`); return { data: JSON.parse(localStorage.getItem('teste_avisos')), error: null }; },
          from: (tabela) => ({
            insert: async (obj) => { window.__chamadas.push(`insert ${tabela} ${JSON.stringify(obj)}`); return { error: null }; },
            update: (obj) => ({ eq: async (col, v) => { window.__chamadas.push(`update ${tabela} ${JSON.stringify(obj)} ${col}=${v}`); return { error: null }; } })
          })
        };
      });
      const m = {};
      m.botao = await page.$eval('#btn-aviso-atualizacao', b => { const r = b.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}, ${r.right <= window.innerWidth && r.left >= 0 ? 'dentro da tela' : 'FORA da tela'}, "${b.getAttribute('aria-label')}"`; });
      await page.click('#btn-aviso-atualizacao');
      await new Promise(res => setTimeout(res, 400));
      m.aberto = await page.$eval('#modal-aviso-atualizacao', el => el.classList.contains('active'));
      m.lista = await page.$$eval('#aviso-atu-lista li', lis => lis.map(li => li.innerText.replace(/\s+/g, ' ').trim()));
      m.listaEscapada = await page.$eval('#aviso-atu-lista', el => !el.querySelector('.aviso-atu-item-texto p b'));
      const salvar = async () => { await page.click('#aviso-atu-salvar'); await new Promise(res => setTimeout(res, 200)); return page.$eval('#aviso-atu-alerta', el => el.hidden ? '(sem alerta)' : el.textContent); };
      const campo = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
      m.vazio = await salvar();
      await campo('#aviso-atu-inicio', '2020-01-10T10:00');
      await campo('#aviso-atu-fim', '2020-01-10T12:00');
      m.inicioNoPassado = await salvar();
      await campo('#aviso-atu-inicio', '2030-01-15T14:00');
      await campo('#aviso-atu-fim', '2030-01-15T13:00');
      m.fimAntes = await salvar();
      await campo('#aviso-atu-fim', '2030-01-15T16:30');
      m.semDescricao = await salvar();
      await page.focus('#aviso-atu-descricao');
      await page.keyboard.type('Troca do servidor');
      m.contador = await page.$eval('#aviso-atu-contador', el => el.textContent);
      m.maxlength = await page.$eval('#aviso-atu-descricao', el => el.maxLength);
      m.salvou = await salvar();
      m.toast = await page.$eval('#toast-message', el => el.textContent);
      m.formLimpo = await page.$eval('#aviso-atu-descricao', el => el.value === '');
      // Cancelar aviso (com confirmação)
      page._dialogos = [];
      await page.click('.aviso-atu-cancelar[data-aviso-id="11"]');
      await new Promise(res => setTimeout(res, 300));
      m.confirmacao = page._dialogos[0] || '(sem confirmação)';
      m.chamadas = await page.evaluate(() => window.__chamadas);
      // 360: modal cabe na tela, sem rolagem lateral
      m.cabe = await page.evaluate(() => {
        const c = document.querySelector('#modal-aviso-atualizacao .modal-container').getBoundingClientRect();
        return `${Math.round(c.width)}px, ${c.left >= 0 && c.right <= window.innerWidth ? 'cabe' : 'NÃO cabe'}, rolagemH=${document.documentElement.scrollWidth > window.innerWidth ? 'SIM' : 'não'}`;
      });
      await page.click('#modal-aviso-atualizacao .aviso-atu-botoes [data-aviso-fechar]');
      await new Promise(res => setTimeout(res, 300));
      m.fechouNoCancelar = await page.$eval('#modal-aviso-atualizacao', el => !el.classList.contains('active'));
      r.modal[`${nome} ${w}px`] = m;
    }
  }

  r.erros = erros.filter(e => !/Chart is not defined/.test(e));
  console.log(JSON.stringify(r, null, 2));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });

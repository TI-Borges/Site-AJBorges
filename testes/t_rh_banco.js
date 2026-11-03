// Dashboard RH lendo e gravando no schema rh, com o Supabase simulado por um Postgres de verdade:
// o supabase-js do CDN é trocado por um cliente falso cujo .schema('rh') manda cada consulta para
// um PGlite (no Node) com R01 + R01b aplicados, como o papel authenticated e o JWT do usuário
// (app_metadata.role). Ou seja: quem barra o rh_restrito é a RLS, não a tela.
// auth.js e supabase-client.js são os reais.
// Confere: diretoria/motorista/sem sessão vão para o login; admin grava tudo e relê depois de
// recarregar; observação sem autor/hora no pedido; erro de rede e de permissão sem perder o que
// foi digitado; rh_restrito só com observação e concluir/reabrir; escapeHtml.
// Uso: node testes/t_rh_banco.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = path.resolve(__dirname, '..');
const RH = '/dashboard-rh/HTML/index.html';
const LOGIN = '/HTML/Login.html#admin';
const SUBS = {
  admin: '00000000-0000-0000-0000-0000000000c3',
  rh: '00000000-0000-0000-0000-0000000000a1',
  rh_restrito: '00000000-0000-0000-0000-0000000000b2',
  diretoria: '00000000-0000-0000-0000-0000000000d4',
  motorista: '00000000-0000-0000-0000-0000000000e5'
};
let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}`); if (!cond) falhas++; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const SUPABASE_FALSO = `
window.supabase = { createClient: () => {
  const SUBS = ${JSON.stringify(SUBS)};
  const papel = () => localStorage.getItem('teste_papel');
  async function executar(pedido) {
    if (localStorage.getItem('teste_rede_off') === '1') {
      return { data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' } };
    }
    return window.__rhBanco(papel(), pedido);
  }
  function consulta(tabela) {
    const pedido = { tabela, op: 'select', valores: null, id: null };
    const q = {
      select() { return q; },
      insert(v) { pedido.op = 'insert'; pedido.valores = v; return q; },
      update(v) { pedido.op = 'update'; pedido.valores = v; return q; },
      eq(coluna, valor) { pedido.id = valor; return q; },
      then(ok, erro) { return executar(pedido).then(ok, erro); }
    };
    return q;
  }
  return {
    auth: {
      getUser: async () => {
        const p = papel();
        return p ? { data: { user: { id: SUBS[p], email: p + '@teste.local', app_metadata: { role: p }, user_metadata: {} } }, error: null }
                 : { data: { user: null }, error: { message: 'sem sessão' } };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({})
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    schema: (nome) => ({ from: (tabela) => (nome === 'rh' ? consulta(tabela) : null) })
  };
} };`;

async function criarBanco() {
  const db = new PGlite();
  await db.exec(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create role authenticated;
    create role anon;
    create role service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
  `);
  for (const arq of ['R01_estrutura.sql', 'R01b_admin.sql']) {
    const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh', arq), 'utf8');
    const ini = sql.indexOf('\nbegin;\n');
    await db.exec(sql.slice(ini, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length));
  }
  return db;
}

// Tradução mínima do que o rh.js usa do PostgREST: select('*'), insert(...).select(), update(...).eq('id').select()
function montarSql(pedido) {
  const nome = /^[a-z_]+$/;
  if (!nome.test(pedido.tabela)) throw new Error('tabela inválida');
  const t = `rh.${pedido.tabela}`;
  if (pedido.op === 'select') return [`select coalesce(json_agg(x), '[]'::json) as j from ${t} x`, []];
  const linhas = Array.isArray(pedido.valores) ? pedido.valores : [pedido.valores];
  const cols = [...new Set(linhas.flatMap(Object.keys))];
  if (!cols.every(c => nome.test(c))) throw new Error('coluna inválida');
  if (pedido.op === 'insert') {
    return [`with r as (insert into ${t} (${cols}) select ${cols} from json_populate_recordset(null::${t}, $1::json) returning *)
             select coalesce(json_agg(r), '[]'::json) as j from r`, [JSON.stringify(linhas)]];
  }
  return [`with r as (update ${t} as alvo set ${cols.map(c => `${c} = s.${c}`)} from json_populate_record(null::${t}, $1::json) s
           where alvo.id = $2 returning alvo.*) select coalesce(json_agg(r), '[]'::json) as j from r`, [JSON.stringify(linhas[0]), pedido.id]];
}

function servidor() {
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  return new Promise(res => {
    const srv = http.createServer((req, resp) => {
      const arq = path.join(RAIZ, decodeURIComponent(req.url.split('?')[0]));
      fs.readFile(arq, (err, dados) => {
        if (err) { resp.writeHead(404); return resp.end(); }
        resp.writeHead(200, { 'Content-Type': tipos[path.extname(arq).toLowerCase()] || 'application/octet-stream' });
        resp.end(dados);
      });
    });
    srv.listen(0, () => res(srv));
  });
}

(async () => {
  const db = await criarBanco();
  const srv = await servidor();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const erros = [];
  page.on('pageerror', e => erros.push(String(e)));
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (!u.startsWith(base)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });

  const pedidos = [];
  let pendentes = 0;
  await page.exposeFunction('__rhBanco', async (papel, pedido) => {
    pendentes++;
    pedidos.push({ papel, ...pedido });
    try {
      const claims = JSON.stringify({ sub: SUBS[papel], role: 'authenticated', email: `${papel}@teste.local`, app_metadata: { role: papel } });
      const data = await db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
        await tx.query('set local role authenticated');
        const [sql, params] = montarSql(pedido);
        return (await tx.query(sql, params)).rows[0].j;
      });
      return { data, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code || '', details: e.detail || '' } };
    } finally {
      pendentes--;
    }
  });
  // Espera o banco ficar parado (gravação + releitura)
  const ocioso = async () => {
    for (let i = 0; i < 200; i++) {
      await esperar(60);
      if (pendentes === 0) { await esperar(120); if (pendentes === 0) return; }
    }
  };
  const valor = async (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const aviso = () => page.evaluate(() => {
    const a = document.getElementById('rh-aviso-erro');
    return a.hidden ? '' : document.getElementById('rh-aviso-erro-texto').textContent;
  });
  const entrar = async (papel) => {
    await page.goto(`${base}/HTML/Login.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(p => { localStorage.clear(); if (p) localStorage.setItem('teste_papel', p); }, papel);
    await page.goto(`${base}${RH}`, { waitUntil: 'load' });
    await esperar(300);
    await ocioso();
    return page.url().replace(base, '');
  };
  const irTela = async (view) => { await page.click(`#rh-nav-list .nav-link[data-view="${view}"]`); await esperar(100); };
  const linhasDoBanco = async (sql) => (await db.query(sql)).rows;

  // 1. Acesso da página
  console.log('\n--- Acesso ---');
  for (const papel of [null, 'motorista', 'diretoria']) {
    const url = await entrar(papel);
    ok(url === LOGIN, `${papel || 'sem sessão'}: vai para o login (${url})`);
  }
  for (const papel of ['admin', 'rh', 'rh_restrito']) {
    const url = await entrar(papel);
    const r = await page.evaluate(() => ({
      visivel: document.documentElement.style.visibility === '',
      papel: document.getElementById('sidebar-user-role').textContent,
      modelos: Object.keys(estadoRh.modelos).sort().join(),
      faixa: Boolean(document.getElementById('rh-prototipo-faixa')) || /Protótipo/.test(document.body.innerText),
      aviso: document.getElementById('rh-aviso-erro').hidden ? '' : document.getElementById('rh-aviso-erro-texto').textContent
    }));
    ok(url === RH && r.visivel, `${papel}: entra no Dashboard RH (${r.papel})`);
    ok(r.modelos === 'admissao_clt,distrato_pj,exame_periodico,rescisao_clt' && !r.aviso, `${papel}: leu os 4 modelos do schema rh ${r.aviso}`);
    ok(!r.faixa, `${papel}: sem faixa "Protótipo"`);
  }

  // 2. Admin grava tudo
  console.log('\n--- Admin grava ---');
  await entrar('admin');
  const NOME_XSS = '<img src=x onerror="window.__xss=1">Ana Souza';
  await page.click('#topbar-btn-novo-colab');
  await valor('#colab-nome', NOME_XSS);
  await valor('#colab-cargo', 'Analista');
  await valor('#colab-setor', 'RH');
  await page.select('#colab-vinculo', 'CLT');
  await valor('#colab-data-admissao', '2025-01-10');
  await page.click('#form-novo-colaborador button[type="submit"]');
  await ocioso();
  await page.click('#topbar-btn-novo-colab');
  await valor('#colab-nome', 'Bruno PJ');
  await valor('#colab-cargo', 'Consultor');
  await valor('#colab-setor', 'TI');
  await page.select('#colab-vinculo', 'PJ');
  await valor('#colab-data-admissao', '2025-03-01');
  await page.click('#form-novo-colaborador button[type="submit"]');
  await ocioso();
  const idAna = (await linhasDoBanco(`select id from rh.colaboradores where nome like '%Ana Souza'`))[0].id;
  const idBruno = (await linhasDoBanco(`select id from rh.colaboradores where nome = 'Bruno PJ'`))[0].id;

  // Processo de rescisão (7 etapas copiadas do modelo)
  await page.click('#topbar-btn-novo-proc');
  await page.select('#proc-colaborador', idAna);
  await page.select('#proc-modelo', 'rescisao_clt');
  await page.click('#form-novo-processo button[type="submit"]');
  await ocioso();
  ok((await page.$$('.etapa-card')).length === 7, 'processo criado com as 7 etapas do modelo');

  // Concluir a 1ª etapa, observação, responsável da 2ª, anexo, mover a 3ª para baixo, remover a última
  await page.click('.etapa-card:nth-child(1) [data-acao="alternar-conclusao-etapa"]');
  await ocioso();
  await page.type('.etapa-card:nth-child(1) .input-nova-obs', 'Comunicado entregue ao colaborador');
  await page.click('.etapa-card:nth-child(1) form[data-form="adicionar-observacao-etapa"] button[type="submit"]');
  await ocioso();
  await valor('.etapa-card:nth-child(2) .input-etapa-responsavel', 'DP');
  await ocioso();
  const arqAnexo = path.join(os.tmpdir(), 'contrato-ana.pdf');
  fs.writeFileSync(arqAnexo, 'teste');
  const inputAnexo = await page.$('.etapa-card:nth-child(1) .input-anexo-etapa');
  await inputAnexo.uploadFile(arqAnexo);
  await page.$eval('.etapa-card:nth-child(1) .input-anexo-etapa', el => el.dispatchEvent(new Event('change', { bubbles: true })));
  await ocioso();
  await page.click('.etapa-card:nth-child(3) [data-acao="mover-etapa-proc"][data-direcao="1"]');
  await ocioso();
  await page.click('.etapa-card:nth-child(7) [data-acao="remover-etapa-proc"]');
  await ocioso();

  const pedidoObs = pedidos.filter(p => p.tabela === 'observacoes' && p.op === 'insert').pop();
  ok(pedidoObs && Object.keys(pedidoObs.valores).sort().join() === 'etapa_id,texto',
    `observação: o navegador manda só ${pedidoObs && Object.keys(pedidoObs.valores).sort().join()} (sem autor/hora)`);
  ok(!pedidos.some(p => p.op === 'delete'), 'nenhum delete pedido ao banco');

  // Exame, férias, contrato PJ, etapa nova no modelo de admissão
  await irTela('exames');
  await page.click('#btn-registrar-exame');
  await page.select('#exame-colaborador', idAna);
  await page.select('#exame-tipo', 'periodico');
  await valor('#exame-data-realizacao', '2026-01-15');
  await valor('#exame-vencimento', '2027-01-15');
  await page.click('#form-exame button[type="submit"]');
  await ocioso();
  await irTela('ferias');
  await page.click('#btn-informar-ferias');
  await page.select('#ferias-colaborador', idAna);
  await valor('#ferias-aquisitivo-inicio', '2025-01-10');
  await valor('#ferias-saldo', '30');
  await page.click('#form-ferias button[type="submit"]');
  await ocioso();
  await irTela('prestadores');
  await page.click('#btn-cadastrar-contrato-pj');
  await page.select('#pj-colaborador', idBruno);
  await valor('#pj-inicio', '2025-03-01');
  await valor('#pj-fim', '2026-12-31');
  await valor('#pj-valor', '12500.50');
  await valor('#pj-aviso', '30');
  await page.click('#form-contrato-pj button[type="submit"]');
  await ocioso();
  await irTela('modelos');
  await page.click('[data-modelo-id="admissao_clt"]');
  await page.type('#input-nova-etapa-modelo', 'Exame admissional');
  await page.click('#form-adicionar-etapa-modelo button[type="submit"]');
  await ocioso();
  ok(!(await aviso()), `admin: nenhuma gravação deu erro ${await aviso()}`);

  // 3. Recarrega a página e relê do banco
  console.log('\n--- Admin recarrega ---');
  await page.reload({ waitUntil: 'load' });
  await esperar(300);
  await ocioso();
  const relido = await page.evaluate(() => {
    const ana = estadoRh.colaboradores.find(c => c.nome.endsWith('Ana Souza'));
    const bruno = estadoRh.colaboradores.find(c => c.nome === 'Bruno PJ');
    const proc = estadoRh.processos[0];
    const comObs = proc && proc.etapas.find(e => e.observacoes.length);
    return {
      colaboradores: estadoRh.colaboradores.length,
      processos: estadoRh.processos.length,
      etapas: proc ? proc.etapas.map(e => `${e.nome}${e.concluida ? '✓' : ''}${e.responsavel ? '(' + e.responsavel + ')' : ''}`).join(', ') : '',
      obs: comObs ? `${comObs.observacoes[0].autor} • ${comObs.observacoes[0].dataHora} • ${comObs.observacoes[0].texto}` : '',
      anexos: comObs ? comObs.anexos.join() : '',
      exames: estadoRh.exames.length,
      ferias: ana && ana.ferias ? `${ana.ferias.aquisitivoInicio} saldo ${ana.ferias.saldoDias}` : '',
      contrato: bruno && bruno.contratoPj ? `${bruno.contratoPj.fim} R$ ${bruno.contratoPj.valor} aviso ${bruno.contratoPj.avisoDias}` : '',
      admissao: estadoRh.modelos.admissao_clt.etapas.map(e => e.nome).join()
    };
  });
  console.log(JSON.stringify(relido, null, 2));
  ok(relido.colaboradores === 2 && relido.processos === 1, 'relê 2 colaboradores e 1 processo');
  ok(relido.etapas === 'Comunicação✓, Aviso(DP), Conferência, Cálculo, Pagamento, Assinaturas',
    'relê as etapas: 1ª concluída, responsável na 2ª, 3ª movida para baixo, última removida');
  ok(/^admin@teste\.local • \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} • Comunicado entregue ao colaborador$/.test(relido.obs),
    'relê a observação com e-mail e hora do servidor');
  ok(relido.anexos === 'contrato-ana.pdf', 'relê o anexo (só o nome)');
  ok(relido.exames === 1 && relido.ferias === '2025-01-10 saldo 30' && relido.contrato === '2026-12-31 R$ 12500.5 aviso 30',
    'relê exame, férias e contrato PJ');
  ok(relido.admissao === 'Exame admissional', 'relê a etapa nova do modelo de Admissão CLT');
  const obsBanco = (await linhasDoBanco(`select autor, autor_email, criado_por from rh.observacoes`))[0];
  ok(obsBanco.autor === SUBS.admin && obsBanco.criado_por === SUBS.admin, 'no banco: autor/criado_por = id do admin (servidor)');
  const etapaRemovida = await linhasDoBanco(`select count(*)::int n from rh.etapas where not ativo`);
  ok(etapaRemovida[0].n === 1, 'no banco: etapa removida ficou com ativo = false (sem delete)');

  // escapeHtml: o nome com HTML aparece como texto
  await irTela('colaboradores');
  const xss = await page.evaluate(() => ({
    rodou: Boolean(window.__xss),
    imgs: document.querySelectorAll('#colaboradores-lista-container img, #colaborador-ficha-container img').length,
    texto: document.querySelector('#colaboradores-lista-container .item-titulo').textContent
  }));
  ok(!xss.rodou && xss.imgs === 0 && xss.texto.includes('<img'), 'nome com HTML aparece como texto (escapeHtml)');

  // 4. Erro de rede: não perde o que foi digitado
  console.log('\n--- Erro de rede ---');
  await irTela('processos');
  await page.evaluate(() => localStorage.setItem('teste_rede_off', '1'));
  await page.type('.etapa-card:nth-child(2) .input-nova-obs', 'Texto que não pode sumir');
  await page.click('.etapa-card:nth-child(2) form[data-form="adicionar-observacao-etapa"] button[type="submit"]');
  await ocioso();
  const rede = { aviso: await aviso(), digitado: await page.$eval('.etapa-card:nth-child(2) .input-nova-obs', el => el.value) };
  ok(/Sem conexão com o servidor/.test(rede.aviso), `aviso de rede: "${rede.aviso}"`);
  ok(rede.digitado === 'Texto que não pode sumir', 'o texto digitado continua no campo');
  await page.evaluate(() => localStorage.removeItem('teste_rede_off'));
  await page.click('.etapa-card:nth-child(2) form[data-form="adicionar-observacao-etapa"] button[type="submit"]');
  await ocioso();
  const obsDepois = (await linhasDoBanco(`select count(*)::int n from rh.observacoes where texto = 'Texto que não pode sumir'`))[0].n;
  ok(obsDepois === 1 && !(await aviso()), 'tentando de novo com a rede de volta, grava e o aviso some');

  // Rede caída ao abrir a página: aviso com "Tentar de novo"
  await page.evaluate(() => localStorage.setItem('teste_rede_off', '1'));
  await page.reload({ waitUntil: 'load' });
  await esperar(300);
  const carga = await page.evaluate(() => ({ texto: document.getElementById('rh-aviso-erro-texto').textContent, tentar: !document.getElementById('rh-aviso-erro-tentar').hidden }));
  ok(/Sem conexão/.test(carga.texto) && carga.tentar, `rede caída ao abrir: "${carga.texto}" com "Tentar de novo"`);
  await page.evaluate(() => localStorage.removeItem('teste_rede_off'));
  await page.click('#rh-aviso-erro-tentar');
  await ocioso();
  ok(!(await aviso()) && (await page.evaluate(() => estadoRh.colaboradores.length)) === 2, '"Tentar de novo" carrega os dados');

  // 5. rh_restrito
  console.log('\n--- rh_restrito ---');
  await entrar('rh_restrito');
  const visiveis = async () => page.evaluate(() => Array.from(document.querySelectorAll('[data-so-edicao]'))
    .filter(el => getComputedStyle(el).display !== 'none').map(el => el.id || el.getAttribute('data-acao') || el.className));
  const vistos = [];
  for (const view of ['painel', 'colaboradores', 'processos', 'prestadores', 'exames', 'ferias', 'modelos', 'agenda']) {
    await irTela(view);
    vistos.push(...await visiveis());
  }
  ok(vistos.length === 0, `nenhum botão de edição visível em nenhuma tela ${JSON.stringify(vistos)}`);
  await irTela('processos');
  const restrito = await page.evaluate(() => {
    const card = document.querySelector('.etapa-card');
    const vis = (sel) => Array.from(card.querySelectorAll(sel)).filter(el => getComputedStyle(el).display !== 'none').length;
    return {
      concluir: vis('[data-acao="alternar-conclusao-etapa"]'),
      obs: vis('form[data-form="adicionar-observacao-etapa"]'),
      imprimir: document.querySelectorAll('[data-acao="imprimir-processo"]').length,
      outrosBotoes: vis('button:not([data-acao="alternar-conclusao-etapa"]):not([type="submit"])'),
      anexo: vis('.label-upload-anexo'),
      camposTravados: Array.from(card.querySelectorAll('.input-etapa-responsavel, .input-etapa-prazo')).every(i => i.disabled)
    };
  });
  ok(restrito.concluir === 1 && restrito.obs === 1 && restrito.imprimir === 1, 'restrito vê Concluir/Reabrir, observação e Imprimir');
  ok(restrito.outrosBotoes === 0 && restrito.anexo === 0 && restrito.camposTravados, `restrito: sem renomear/mover/remover/anexo e responsável/prazo travados ${JSON.stringify(restrito)}`);

  await page.type('.etapa-card:nth-child(3) .input-nova-obs', 'Registro do restrito');
  await page.click('.etapa-card:nth-child(3) form[data-form="adicionar-observacao-etapa"] button[type="submit"]');
  await ocioso();
  await page.click('.etapa-card:nth-child(3) [data-acao="alternar-conclusao-etapa"]');
  await ocioso();
  const doRestrito = (await linhasDoBanco(`select (select count(*)::int from rh.observacoes where autor = '${SUBS.rh_restrito}') obs,
      (select count(*)::int from rh.etapas where concluida_por = '${SUBS.rh_restrito}') concluidas`))[0];
  ok(doRestrito.obs === 1 && doRestrito.concluidas === 1 && !(await aviso()), 'restrito grava observação e conclui etapa');
  await page.click('.etapa-card:nth-child(3) [data-acao="alternar-conclusao-etapa"]');
  await ocioso();
  const reaberta = (await linhasDoBanco(`select count(*)::int n from rh.etapas where concluida_por = '${SUBS.rh_restrito}'`))[0].n;
  ok(reaberta === 0 && !(await aviso()), 'restrito reabre a etapa');

  // Forçando a tela (botão escondido reaparece): o banco barra e o que foi digitado fica
  await page.evaluate(() => document.body.classList.remove('rh-papel-restrito'));
  await page.click('#topbar-btn-novo-colab');
  await valor('#colab-nome', 'Colaborador do restrito');
  await valor('#colab-cargo', 'X');
  await valor('#colab-setor', 'Y');
  await valor('#colab-data-admissao', '2025-01-01');
  await page.click('#form-novo-colaborador button[type="submit"]');
  await ocioso();
  const forcado = await page.evaluate(() => ({
    aberto: !document.getElementById('modal-colaborador').hidden,
    nome: document.getElementById('colab-nome').value,
    aviso: document.getElementById('rh-aviso-erro').hidden ? '' : document.getElementById('rh-aviso-erro-texto').textContent
  }));
  ok(/Sem permissão/.test(forcado.aviso), `restrito forçando "Novo colaborador": "${forcado.aviso}"`);
  ok(forcado.aberto && forcado.nome === 'Colaborador do restrito', 'o formulário continua aberto com o que foi digitado');
  await page.click('[data-fechar-modal="modal-colaborador"]');
  await page.evaluate(() => { document.querySelectorAll('.input-etapa-responsavel').forEach(i => { i.disabled = false; }); });
  await valor('.etapa-card:nth-child(1) .input-etapa-responsavel', 'Invasor');
  await ocioso();
  const resp = { aviso: await aviso(), campo: await page.$eval('.etapa-card:nth-child(1) .input-etapa-responsavel', el => el.value) };
  ok(/Sem permissão/.test(resp.aviso) && resp.campo === 'Invasor', `restrito forçando responsável: barrado pelo banco, campo mantém o texto`);
  const nadaMudou = (await linhasDoBanco(`select (select count(*)::int from rh.colaboradores) c,
      (select count(*)::int from rh.etapas where responsavel = 'Invasor') r`))[0];
  ok(nadaMudou.c === 2 && nadaMudou.r === 0, 'no banco: nada do restrito além de observação/conclusão');

  // 6. Sem rolagem lateral e topo colado (sem a faixa)
  console.log('\n--- Layout ---');
  await entrar('admin');
  for (const w of [360, 768, 1440]) {
    await page.setViewport({ width: w, height: 800 });
    await esperar(150);
    const l = await page.evaluate(() => ({
      rolagem: document.documentElement.scrollWidth > window.innerWidth,
      topo: Math.round(document.querySelector('.rh-topbar').getBoundingClientRect().top),
      padding: getComputedStyle(document.body).paddingTop
    }));
    ok(!l.rolagem && l.topo === 0 && l.padding === '0px', `${w}px: sem rolagem lateral, topbar no topo (${JSON.stringify(l)})`);
  }

  ok(erros.length === 0, `sem erros de JS ${erros.length ? JSON.stringify(erros) : ''}`);
  await browser.close(); srv.close();
  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

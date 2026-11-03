// Lixeira do Dashboard RH com o banco simulado por um Postgres de verdade (PGlite com R01 + R01b +
// R03 + R05): cada consulta e cada RPC do rh.js roda como authenticated com o JWT do usuário, então
// quem esconde o excluído e quem barra o rh_restrito é o banco, não a tela.
// Confere: "Excluir colaborador" na ficha abre a confirmação com o nome (como texto); depois de
// excluir ele some de todas as telas, contadores, alertas e agenda, com processos, etapas, anexos,
// exames, férias e contrato; nada é apagado no banco (contagens iguais, nenhum delete pedido);
// a Lixeira lista nome, quando e quem excluiu; "Restaurar" traz tudo de volta; rh também exclui;
// rh_restrito não vê o botão nem a Lixeira e o banco barra a RPC se ele forçar.
// Uso: node testes/t_rh_lixeira.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PGlite } = require('@electric-sql/pglite');
const { AUTH_SIMULADO, storageSimulado } = require('./rh_storage_simulado');

const RAIZ = path.resolve(__dirname, '..');
const RH = '/dashboard-rh/HTML/index.html';
const SUBS = {
  admin: '00000000-0000-0000-0000-0000000000c3',
  rh: '00000000-0000-0000-0000-0000000000a1',
  rh_restrito: '00000000-0000-0000-0000-0000000000b2'
};
const NOME = '<img src=x onerror="window.__xss=1">Ana Lixeira';
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`); if (!cond) falhas++; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

const SUPABASE_FALSO = `
window.supabase = { createClient: () => {
  const SUBS = ${JSON.stringify(SUBS)};
  const papel = () => localStorage.getItem('teste_papel');
  function consulta(tabela) {
    const pedido = { tabela, op: 'select', valores: null, id: null };
    const q = {
      select() { return q; },
      insert(v) { pedido.op = 'insert'; pedido.valores = v; return q; },
      update(v) { pedido.op = 'update'; pedido.valores = v; return q; },
      delete() { pedido.op = 'delete'; return q; },
      eq(coluna, valor) { pedido.id = valor; return q; },
      then(ok, erro) { return window.__rhBanco(papel(), pedido).then(ok, erro); }
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
    schema: (nome) => nome !== 'rh' ? null : ({
      from: consulta,
      rpc: (funcao, args) => window.__rhBanco(papel(), { op: 'rpc', funcao, args })
    })
  };
} };`;

async function criarBanco() {
  const db = new PGlite();
  await db.exec(AUTH_SIMULADO + storageSimulado());
  for (const arq of ['R01_estrutura.sql', 'R01b_admin.sql', 'R03_anexos.sql', 'R05_lixeira.sql']) {
    const sql = fs.readFileSync(path.join(RAIZ, 'supabase/sql/rh', arq), 'utf8');
    await db.exec(sql.slice(sql.indexOf('\nbegin;\n'), sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length));
  }
  // Dados: Ana (PJ) com tudo e Carlos (CLT), que não sai
  await db.exec(`
    select set_config('request.jwt.claims', '{"sub":"${SUBS.rh}","email":"rh@teste.local","app_metadata":{"role":"rh"}}', false);
    do $$
    declare c uuid; p uuid; e uuid; cam text; o uuid;
    begin
      insert into rh.colaboradores (nome, cargo, setor, vinculo, data_admissao, data_proximo_exame)
        values ('${NOME.replace(/'/g, "''")}', 'Analista', 'RH', 'PJ', current_date - 300, current_date + 5) returning id into c;
      insert into rh.processos (colaborador_id, modelo_id, modelo_nome)
        select c, id, nome from rh.modelos where chave = 'distrato_pj' returning id into p;
      insert into rh.etapas (processo_id, ordem, nome, prazo) values (p, 1, 'Comunicação Ana', current_date + 3) returning id into e;
      insert into rh.etapas (processo_id, ordem, nome) values (p, 2, 'Distrato Ana');
      insert into rh.observacoes (etapa_id, texto) values (e, 'Observação da Ana');
      cam := p || '/' || e || '/' || gen_random_uuid() || '.pdf';
      insert into storage.objects (bucket_id, name, metadata) values ('rh-anexos', cam, '{"size":10,"mimetype":"application/pdf"}');
      insert into rh.anexos (etapa_id, caminho, nome_original, tipo, tamanho) values (e, cam, 'distrato-ana.pdf', 'application/pdf', 10);
      insert into rh.exames (colaborador_id, tipo, data_realizacao, vencimento) values (c, 'periodico', current_date - 360, current_date + 5);
      insert into rh.contratos_pj (colaborador_id, inicio, fim, valor, aviso_dias) values (c, current_date - 300, current_date + 20, 1000, 30);
      insert into rh.colaboradores (nome, cargo, setor, vinculo, data_admissao) values ('Carlos Fica', 'Motorista', 'Frota', 'CLT', current_date - 500)
        returning id into o;
      insert into rh.ferias (colaborador_id, aquisitivo_inicio, saldo_dias) values (o, current_date - 400, 30);
      insert into rh.ferias (colaborador_id, aquisitivo_inicio, saldo_dias) values (c, current_date - 400, 30);
    end $$;
    select set_config('request.jwt.claims', '', false);
  `);
  return db;
}

// PostgREST mínimo: select('*'), insert/update(...).select(), rpc(funcao, args)
function montarSql(pedido) {
  const nome = /^[a-z_]+$/;
  if (pedido.op === 'rpc') {
    if (!nome.test(pedido.funcao)) throw new Error('função inválida');
    if (pedido.funcao === 'lixeira') return [`select coalesce(json_agg(x), '[]'::json) as j from rh.lixeira() x`, []];
    return [`select rh.${pedido.funcao}($1::uuid)::text as j`, [pedido.args.p_id]];
  }
  if (!nome.test(pedido.tabela)) throw new Error('tabela inválida');
  const t = `rh.${pedido.tabela}`;
  if (pedido.op === 'select') return [`select coalesce(json_agg(x), '[]'::json) as j from ${t} x`, []];
  if (pedido.op === 'delete') return [`with r as (delete from ${t} where id = $1 returning *) select coalesce(json_agg(r), '[]'::json) as j from r`, [pedido.id]];
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

  const ocioso = async () => {
    for (let i = 0; i < 200; i++) {
      await esperar(60);
      if (pendentes === 0) { await esperar(150); if (pendentes === 0) return; }
    }
  };
  const entrar = async (papel) => {
    await page.goto(`${base}/HTML/Login.html`).catch(() => { });
    await page.evaluate(p => { localStorage.clear(); localStorage.setItem('teste_papel', p); }, papel);
    await page.goto(`${base}${RH}`, { waitUntil: 'load' });
    await ocioso();
  };
  const irTela = async (view) => { await page.$eval(`#rh-nav-list .nav-link[data-view="${view}"]`, a => a.click()); await ocioso(); };
  const contadores = () => page.evaluate(() => Object.fromEntries(['colaboradores', 'processos', 'prestadores', 'exames', 'ferias', 'agenda']
    .map(k => [k, document.getElementById(`nav-count-${k}`).textContent])));
  // Texto de todas as telas (painel, alertas, listas, agenda...) procurando a Ana e o que é dela
  const rastrosDaAna = async () => {
    const achados = [];
    for (const v of ['painel', 'colaboradores', 'processos', 'prestadores', 'exames', 'ferias', 'agenda']) {
      await irTela(v);
      const t = await page.$eval('main', m => m.innerText);
      if (/Ana Lixeira|Comunicação Ana|Distrato Ana|distrato-ana|Observação da Ana/.test(t)) achados.push(v);
    }
    return achados;
  };
  const linhasNoBanco = async () => JSON.stringify((await db.query(`select
      (select count(*)::int from rh.colaboradores) c, (select count(*)::int from rh.processos) p, (select count(*)::int from rh.etapas) e,
      (select count(*)::int from rh.observacoes) o, (select count(*)::int from rh.anexos) a, (select count(*)::int from rh.exames) x,
      (select count(*)::int from rh.ferias) f, (select count(*)::int from rh.contratos_pj) ct,
      (select count(*)::int from storage.objects) so`)).rows[0]);
  const selecionarAna = async () => {
    await irTela('colaboradores');
    await page.evaluate(() => {
      const item = Array.from(document.querySelectorAll('[data-acao="selecionar-colaborador"]')).find(el => /Ana Lixeira/.test(el.textContent));
      if (item) item.click();
    });
    await esperar(100);
  };

  // 1. Admin: antes
  console.log('\n--- Admin exclui ---');
  await entrar('admin');
  const antes = await contadores();
  ok(antes.colaboradores === '2' && antes.processos === '1' && antes.exames === '1' && Number(antes.agenda) > 0, 'antes: Ana aparece nos contadores', antes);
  ok((await rastrosDaAna()).length >= 5, 'antes: Ana aparece nas telas');
  const bancoAntes = await linhasNoBanco();

  // 2. Botão na ficha e confirmação com o nome (texto, não HTML)
  await selecionarAna();
  ok(await page.$eval('#btn-excluir-colaborador', b => getComputedStyle(b).display !== 'none' && b.textContent.trim()), 'ficha tem "Excluir colaborador"');
  await page.click('#btn-excluir-colaborador');
  await esperar(100);
  const modal = await page.evaluate(() => ({
    aberto: !document.getElementById('modal-excluir-colaborador').hidden,
    nome: document.getElementById('excluir-colab-nome').textContent,
    img: document.querySelectorAll('#modal-excluir-colaborador img').length
  }));
  ok(modal.aberto && modal.nome === NOME && modal.img === 0, 'confirmação mostra o nome como texto', modal);
  // Cancelar não exclui
  await page.click('#modal-excluir-colaborador [data-fechar-modal]');
  await esperar(100);
  ok((await contadores()).colaboradores === '2', 'Cancelar não exclui');

  await page.click('#btn-excluir-colaborador');
  await esperar(100);
  await page.click('#btn-confirmar-exclusao');
  await ocioso();
  const toast = await page.$eval('#rh-toast', t => t.textContent);
  ok(/foi para a Lixeira/.test(toast), 'toast de exclusão', toast);
  const depois = await contadores();
  ok(depois.colaboradores === '1' && depois.processos === '0' && depois.exames === '0' && depois.prestadores === '0' && depois.agenda === '0',
    'excluído some de todos os contadores (com processo, exame, contrato e agenda)', depois);
  const rastros = await rastrosDaAna();
  ok(rastros.length === 0, 'excluído some de todas as telas, alertas e agenda', rastros.join(', '));
  ok(await page.$eval('main', m => /Carlos Fica/.test(m.innerText)) || (await (async () => { await irTela('colaboradores'); return page.$eval('main', m => /Carlos Fica/.test(m.innerText)); })()),
    'o outro colaborador continua');
  ok(await linhasNoBanco() === bancoAntes, 'nada foi apagado no banco (mesmas contagens, arquivo continua no Storage)', await linhasNoBanco());
  ok(!pedidos.some(p => p.op === 'delete'), 'nenhum delete pedido ao banco');
  const marcado = (await db.query(`select excluido_por = '${SUBS.admin}' and excluido_por_email = 'admin@teste.local' and excluido_em is not null as ok
    from rh.colaboradores where nome like '%Ana Lixeira'`)).rows[0].ok;
  ok(marcado, 'servidor gravou quando e quem excluiu');

  // 3. Lixeira lista; Restaurar volta tudo
  console.log('\n--- Lixeira ---');
  await irTela('lixeira');
  const lix = await page.evaluate(() => ({
    titulo: document.getElementById('topbar-titulo').textContent,
    itens: Array.from(document.querySelectorAll('#lixeira-lista-container [data-lixeira-id]')).map(el => el.innerText.replace(/\s+/g, ' ').trim()),
    img: document.querySelectorAll('#lixeira-lista-container img').length,
    total: document.getElementById('lixeira-total-badge').textContent
  }));
  ok(lix.titulo === 'Lixeira' && lix.itens.length === 1 && lix.itens[0].includes(NOME) && /Excluído em \d{2}\/\d{2}\/\d{4}/.test(lix.itens[0])
    && lix.itens[0].includes('por admin@teste.local') && lix.img === 0 && lix.total === '1', 'Lixeira mostra nome, quando e quem excluiu', lix);
  await page.click('#lixeira-lista-container [data-acao="restaurar-colaborador"]');
  await ocioso();
  const lix2 = await page.$$eval('#lixeira-lista-container [data-lixeira-id]', l => l.length);
  const volta = await contadores();
  ok(lix2 === 0 && JSON.stringify(volta) === JSON.stringify(antes), 'Restaurar tira da lixeira e tudo volta', volta);
  ok((await rastrosDaAna()).length >= 5, 'restaurado aparece de novo nas telas');
  ok(await linhasNoBanco() === bancoAntes, 'continua sem apagar nada');
  const audit = (await db.query(`select count(*)::int n from rh.auditoria a join rh.colaboradores c on c.id = a.registro_id
    where a.tabela = 'colaboradores' and c.nome like '%Ana Lixeira'`)).rows[0].n;
  ok(audit === 2, 'exclusão e restauração auditadas', audit);

  // 4. rh também exclui; Lixeira mostra quem
  console.log('\n--- rh ---');
  await entrar('rh');
  await selecionarAna();
  await page.click('#btn-excluir-colaborador');
  await esperar(100);
  await page.click('#btn-confirmar-exclusao');
  await ocioso();
  ok((await contadores()).colaboradores === '1', 'rh exclui');
  await irTela('lixeira');
  ok(await page.$eval('#lixeira-lista-container', el => el.innerText.includes('por rh@teste.local')), 'Lixeira mostra que foi o rh');

  // 5. rh_restrito: sem botão, sem Lixeira, banco barra
  console.log('\n--- rh_restrito ---');
  await entrar('rh_restrito');
  const restrito = await page.evaluate(() => {
    const visivel = (el) => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    return {
      menuLixeira: visivel(document.getElementById('nav-link-lixeira')),
      colaboradores: document.getElementById('nav-count-colaboradores').textContent
    };
  });
  ok(!restrito.menuLixeira, 'rh_restrito não vê "Lixeira" na barra lateral');
  ok(restrito.colaboradores === '1', 'rh_restrito também não vê o excluído', restrito.colaboradores);
  await irTela('colaboradores');
  ok(await page.$eval('#btn-excluir-colaborador', b => getComputedStyle(b).display === 'none'), 'rh_restrito sem o botão "Excluir colaborador"');
  await page.evaluate(() => alternarTelaRh('lixeira'));
  await ocioso();
  ok(await page.$eval('#topbar-titulo', t => t.textContent) === 'Painel', 'rh_restrito forçando a Lixeira volta ao Painel');
  const forcado = await page.evaluate(async () => {
    const id = estadoRh.colaboradores[0].id;
    const r = await window.supabaseClient.schema('rh').rpc('excluir_colaborador', { p_id: id });
    const l = await window.supabaseClient.schema('rh').rpc('lixeira', {});
    return { excluir: r.error && r.error.code, lixeira: l.error && l.error.code };
  });
  ok(forcado.excluir === '42501' && forcado.lixeira === '42501', 'rh_restrito forçando a RPC: barrado pelo banco', forcado);
  ok((await db.query(`select count(*)::int n from rh.colaboradores where excluido_em is null`)).rows[0].n === 1, 'nada mudou com o rh_restrito');

  // 6. Celular: Lixeira cabe na tela
  await entrar('admin');
  await page.setViewport({ width: 390, height: 800 });
  await irTela('lixeira');
  const cel = await page.evaluate(() => ({ rolagem: document.documentElement.scrollWidth > window.innerWidth, itens: document.querySelectorAll('#lixeira-lista-container [data-lixeira-id]').length }));
  ok(!cel.rolagem && cel.itens === 1, '390px: Lixeira sem rolagem lateral', cel);

  ok(!(await page.evaluate(() => window.__xss)), 'escapeHtml: nenhum <img onerror> executou');
  ok(erros.length === 0, 'sem erros de JS', erros.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close(); await db.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

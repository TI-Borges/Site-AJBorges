// Barra lateral da Torre: "Passagem de turno" e "Histórico de pendências" numa seção própria
// ("COMUNICAÇÃO ENTRE TURNOS", logo abaixo das abas da planilha) com destaque índigo AJBorges no ícone,
// no item ativo e na faixa (as abas da planilha continuam laranja); contador de pendências herdadas
// abertas ao lado de "Passagem de turno" (some quando zera; vale em qualquer aba); as duas telas com o
// mesmo índigo em botões, títulos e cards; barra recolhida (só ícones, tooltip pelo title, contador no
// canto do ícone) e gaveta do celular (390 px). Banco PGlite T01+T02+T03 e auth/Supabase simulados
// como no t_torre_passagem_tela.js. Prints em testes/capturas/torre_sidebar_turnos*.png.
// Uso: node testes/torre/t_torre_sidebar_turnos.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PGlite } = require('@electric-sql/pglite');

const RAIZ = path.resolve(__dirname, '..', '..');
const TORRE = '/torre-de-controle-shoppe/HTML/index.html';
const SUBS = {
  admin: '00000000-0000-0000-0000-0000000000c3',
  diretoria: '00000000-0000-0000-0000-0000000000d4',
  motorista: '11111111-1111-1111-1111-111111111111'
};
const XSS = '<img src=x onerror="window.__xss=1">';
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`); if (!cond) falhas++; };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
const ateCommit = (sql) => sql.slice(0, sql.indexOf('\ncommit;\n') + '\ncommit;\n'.length);

const SUPABASE_FALSO = `
window.supabase = { createClient: () => {
  const SUBS = ${JSON.stringify(SUBS)};
  const papel = () => localStorage.getItem('teste_papel');
  function consulta(tabela) {
    const pedido = { tabela, op: 'select', valores: null, filtros: [], ordem: null, limite: null };
    const q = {
      select() { return q; },
      insert(v) { pedido.op = 'insert'; pedido.valores = v; return q; },
      update(v) { pedido.op = 'update'; pedido.valores = v; return q; },
      eq(coluna, valor) { pedido.filtros.push([coluna, valor]); return q; },
      order(coluna, opcoes) { pedido.ordem = [coluna, !(opcoes && opcoes.ascending === false)]; return q; },
      limit(n) { pedido.limite = n; return q; },
      then(ok, erro) { return window.__torreBanco(papel(), pedido).then(ok, erro); }
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
      getSession: async () => ({ data: { session: papel() ? { access_token: 'token-' + papel() } : null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({})
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    schema: (nome) => nome === 'torre' ? {
      from: consulta,
      rpc: (funcao, args) => ({ then(ok, erro) { return window.__torreBanco(papel(), { op: 'rpc', funcao, args }).then(ok, erro); } })
    } : null
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
    create role authenticated; create role anon; create role service_role;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    create function public.is_admin() returns boolean language sql stable security definer as $$
      select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'diretoria') $$;
  `);
  for (const arq of ['T01_copia_planilha.sql', 'T02_passagem_turno.sql', 'T03_pendencias.sql', 'T04_nome_operador.sql']) {
    const sql = ateCommit(fs.readFileSync(path.join(RAIZ, 'supabase/sql/torre', arq), 'utf8'));
    await db.exec(sql.slice(sql.indexOf('\nbegin;\n')));
  }
  return db;
}

// PostgREST mínimo: select/eq/order/limit, insert(...).select(), update(...).eq().select()
function montarSql(pedido) {
  const nome = /^[a-z_]+$/;
  // RPCs do T03 (PostgREST: argumentos por nome)
  if (pedido.op === 'rpc') {
    const a = pedido.args || {};
    if (pedido.funcao === 'publicar_passagem') {
      return ['select torre.publicar_passagem($1, $2::date, $3, $4, $5, $6::jsonb, $7)::json as j',
        [a.p_turno, a.p_data, a.p_texto_original, a.p_texto_ia, a.p_texto_final, JSON.stringify(a.p_fechamentos ?? []), a.p_operador_nome]];
    }
    if (pedido.funcao === 'buscar_pendencias') {
      return [`select coalesce(json_agg(x), '[]'::json) as j from torre.buscar_pendencias($1, $2, $3::date, $4) x`,
        [a.p_texto, a.p_turno, a.p_data, a.p_status]];
    }
    throw new Error('rpc desconhecida');
  }
  if (!nome.test(pedido.tabela)) throw new Error('tabela inválida');
  const t = `torre.${pedido.tabela}`;
  const params = [];
  const onde = pedido.filtros.map(([c, v]) => {
    if (!nome.test(c)) throw new Error('coluna inválida');
    params.push(v);
    return `${c}::text = $${params.length}`;
  });
  const where = onde.length ? `where ${onde.join(' and ')}` : '';
  if (pedido.op === 'select') {
    const ordem = pedido.ordem && nome.test(pedido.ordem[0]) ? `order by ${pedido.ordem[0]} ${pedido.ordem[1] ? 'asc' : 'desc'}` : '';
    const limite = Number.isInteger(pedido.limite) ? `limit ${pedido.limite}` : '';
    return [`select coalesce(json_agg(x), '[]'::json) as j from (select * from ${t} ${where} ${ordem} ${limite}) x`, params];
  }
  const linhas = Array.isArray(pedido.valores) ? pedido.valores : [pedido.valores];
  const cols = [...new Set(linhas.flatMap(Object.keys))];
  if (!cols.every(c => nome.test(c))) throw new Error('coluna inválida');
  if (pedido.op === 'insert') {
    return [`with r as (insert into ${t} (${cols}) select ${cols} from json_populate_recordset(null::${t}, $1::json) returning *)
             select coalesce(json_agg(r), '[]'::json) as j from r`, [JSON.stringify(linhas)]];
  }
  const p2 = [JSON.stringify(linhas[0]), ...params];
  const where2 = pedido.filtros.map(([c], i) => `alvo.${c}::text = $${i + 2}`).join(' and ');
  return [`with r as (update ${t} as alvo set ${cols.map(c => `${c} = s.${c}`)} from json_populate_record(null::${t}, $1::json) s
           ${where2 ? `where ${where2}` : ''} returning alvo.*) select coalesce(json_agg(r), '[]'::json) as j from r`, p2];
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
  page.on('dialog', d => d.accept());

  // IA simulada: o teste escolhe a resposta da edge function
  const ia = { pedidos: [], externos: [], resposta: { status: 200, corpo: {} } };
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = r.url();
    if (u.includes('@supabase/supabase-js')) return r.respond({ status: 200, contentType: 'text/javascript', body: SUPABASE_FALSO });
    if (u.endsWith('/functions/v1/torre-passagem-turno')) {
      if (r.method() === 'OPTIONS') return r.respond({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }, body: 'ok' });
      ia.pedidos.push({ headers: r.headers(), corpo: JSON.parse(r.postData() || '{}') });
      return r.respond({ status: ia.resposta.status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(ia.resposta.corpo) });
    }
    if (!u.startsWith(base)) { ia.externos.push(u); return r.respond({ status: 200, contentType: 'text/css', body: '' }); }
    r.continue();
  });

  let pendentes = 0;
  await page.exposeFunction('__torreBanco', async (papel, pedido) => {
    pendentes++;
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
      return { data: null, error: { message: e.message, code: e.code || '' } };
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
  const entrar = async (papel, hash = '#passagem') => {
    await page.goto(`${base}/HTML/Login.html`).catch(() => { });
    await page.evaluate(p => { localStorage.clear(); localStorage.setItem('teste_papel', p); localStorage.setItem('torre_operador_nome', { admin: 'Ana Operadora', diretoria: 'Bruno Diretoria' }[p] || ''); }, papel);
    await page.goto(`${base}${TORRE}${hash}`, { waitUntil: 'load' });
    await ocioso();
  };
  const valor = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  const tela = () => page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; };
    return {
      passagem: vis('torre-passagem'), tabela: vis('torre-area-principal'), busca: vis('torre-busca-wrapper'), contadores: vis('torre-painel-contadores'),
      titulo: document.getElementById('torre-aba-titulo').textContent,
      ativo: document.querySelector('.sidebar-nav .nav-link.active')?.getAttribute('data-aba'),
      status: document.getElementById('passagem-status').textContent,
      rolagem: document.documentElement.scrollWidth > window.innerWidth
    };
  });

  const CAP = (nome) => path.join(RAIZ, 'testes/capturas', nome);
  const publicarNoBanco = (turno, final, fechamentos = "'[]'") => db.exec(`begin;
    select set_config('request.jwt.claims', '{"sub":"${SUBS.admin}","role":"authenticated","email":"admin@teste.local","app_metadata":{"role":"admin"}}', true);
    set local role authenticated;
    select torre.publicar_passagem('${turno}', current_date, 'x', null, E'${final}', ${fechamentos}, 'Ana Operadora');
    commit;`);
  const barra = () => page.evaluate(() => {
    const sb = document.getElementById('torre-sidebar');
    const nav = sb.querySelector('.sidebar-nav');
    const grupos = Array.from(nav.children).map(el => el.classList.contains('nav-group-label')
      ? `[${el.textContent.trim()}]` : Array.from(el.querySelectorAll('.nav-text')).map(t => t.textContent.trim()).join(', '));
    const cor = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; };
    const badge = document.getElementById('nav-badge-pendencias');
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    return {
      grupos,
      iconeTurnos: cor('#nav-link-passagem .nav-icon', 'color'), iconeHistorico: cor('#nav-link-pendencias .nav-icon', 'color'),
      iconePlanilha: cor('#nav-link-validacoes .nav-icon', 'color'),
      rotuloTurnos: cor('.nav-group-turnos', 'color'),
      ativo: document.querySelector('.sidebar-nav .nav-link.active')?.id,
      faixaAtivo: cor('.sidebar-nav .nav-link.active', 'borderLeftColor'), fundoAtivo: cor('.sidebar-nav .nav-link.active', 'backgroundColor'),
      badge: vis(badge) ? badge.textContent : '(escondido)', badgeAria: badge?.getAttribute('aria-label') || '',
      badgeFundo: vis(badge) ? getComputedStyle(badge).backgroundColor : '',
      badgeDentro: vis(badge) ? (() => { const b = badge.getBoundingClientRect(); const s = sb.getBoundingClientRect(); return b.left >= s.left && b.right <= s.right; })() : null,
      tituloPassagem: document.getElementById('nav-link-passagem').title,
      tituloHistorico: document.getElementById('nav-link-pendencias').title,
      rotulosVisiveis: Array.from(nav.querySelectorAll('.nav-group-label')).filter(vis).length,
      textosVisiveis: Array.from(nav.querySelectorAll('.nav-text')).filter(t => t.getBoundingClientRect().width > 2).length,
      largura: Math.round(sb.getBoundingClientRect().width),
      rolagem: document.documentElement.scrollWidth > window.innerWidth
    };
  });
  const LARANJA = 'rgb(238, 77, 45)';
  const INDIGO_FAIXA = 'rgb(107, 107, 214)';
  const INDIGO_CLARO = 'rgb(169, 169, 242)';
  const INDIGO_AJB = 'rgb(61, 61, 144)';

  // Duas pendências abertas no banco (publicadas pelo T1)
  await publicarNoBanco('T1', 'PENDÊNCIAS PARA O PRÓXIMO TURNO\\n- Conferir os canhotos\\n- Ligar para a transportadora');

  // 1. Seções e cores (1366, MATRIZ ativa)
  console.log('\n--- Barra lateral ---');
  await entrar('admin', '#matriz');
  let b = await barra();
  ok(b.grupos.join(' / ') === '[OPERAÇÃO EM TEMPO REAL] / MATRIZ, Validações, Origem, Carregamentos, Trânsito, Descargas, Faturamento, Links, Endereços / [COMUNICAÇÃO ENTRE TURNOS] / Passagem de turno, Histórico de pendências / [SISTEMAS & PAINÉIS] / Hub de Dashboard',
    'seção própria "COMUNICAÇÃO ENTRE TURNOS" logo abaixo das abas da planilha', b.grupos.join(' / '));
  ok(b.iconeTurnos === INDIGO_CLARO && b.iconeHistorico === INDIGO_CLARO && b.iconePlanilha !== INDIGO_CLARO && b.rotuloTurnos !== 'rgb(100, 116, 139)',
    'ícones da seção em índigo claro; abas da planilha não', `${b.iconeTurnos} / ${b.iconePlanilha}`);
  ok(b.ativo === 'nav-link-matriz' && b.faixaAtivo === LARANJA, 'aba da planilha ativa continua laranja', b.faixaAtivo);
  ok(b.badge === '2' && b.badgeAria === '2 pendências herdadas abertas' && b.tituloPassagem === 'Passagem de turno (2 pendências herdadas abertas)',
    'contador "2" ao lado de "Passagem de turno" já na MATRIZ (com aria-label e tooltip)', `${b.badge} | ${b.tituloPassagem}`);
  ok(!b.rolagem, '1366px sem rolagem lateral');
  ok(await page.evaluate(() => !document.body.classList.contains('torre-area-turnos') && getComputedStyle(document.getElementById('torre-aba-titulo')).color) !== 'rgb(61, 61, 144)',
    'na MATRIZ o título do topo não fica índigo');

  // 2. Passagem de turno ativa: faixa/fundo índigo; telas com destaque índigo
  await page.click('#nav-link-passagem');
  await ocioso();
  b = await barra();
  ok(b.ativo === 'nav-link-passagem' && b.faixaAtivo === INDIGO_FAIXA && b.fundoAtivo === 'rgba(107, 107, 214, 0.2)',
    'item ativo e faixa em índigo (não laranja)', `${b.faixaAtivo} / ${b.fundoAtivo}`);
  const telaCores = () => page.evaluate(() => {
    const c = (sel, prop) => { const el = document.querySelector(sel); return el && el.offsetParent !== null ? getComputedStyle(el)[prop] : null; };
    return {
      publicar: c('#btn-publicar-passagem', 'backgroundColor'), gerar: c('#btn-gerar-passagem', 'backgroundColor'),
      cardTopo: c('#form-passagem', 'borderTopColor'), ultima: c('#passagem-ultima', 'borderLeftColor'),
      tituloCard: c('#form-passagem .passagem-titulo', 'color'), selo: c('#passagem-ultima .passagem-selo', 'color'),
      tituloTopo: getComputedStyle(document.getElementById('torre-aba-titulo')).color,
      cardHistorico: c('#torre-pendencias .passagem-card', 'borderTopColor'), tituloHistorico: c('#torre-pendencias .passagem-titulo', 'color')
    };
  });
  let tc = await telaCores();
  ok(tc.publicar === INDIGO_AJB && tc.gerar === INDIGO_AJB && tc.cardTopo === INDIGO_AJB && tc.ultima === INDIGO_AJB && tc.tituloCard === INDIGO_AJB && tc.selo === INDIGO_AJB && tc.tituloTopo === INDIGO_AJB,
    'Passagem de turno: botões, cards, títulos e selo em índigo #3d3d90', tc);
  await page.screenshot({ path: CAP('torre_sidebar_turnos.png') });

  await page.click('#nav-link-pendencias');
  await ocioso();
  b = await barra();
  tc = await telaCores();
  ok(b.ativo === 'nav-link-pendencias' && b.faixaAtivo === INDIGO_FAIXA && tc.cardHistorico === INDIGO_AJB && tc.tituloHistorico === INDIGO_AJB && tc.tituloTopo === INDIGO_AJB,
    'Histórico de pendências: item ativo índigo e tela com o mesmo destaque', `${b.faixaAtivo} / ${tc.cardHistorico}`);
  await page.click('#nav-link-transito');
  await ocioso();
  b = await barra();
  ok(b.ativo === 'nav-link-transito' && b.faixaAtivo === LARANJA && !(await page.evaluate(() => document.body.classList.contains('torre-area-turnos'))),
    'voltando para uma aba da planilha: laranja de novo', b.faixaAtivo);

  // 3. Contador some quando o turno fecha tudo; volta quando surge pendência nova
  await page.click('#nav-link-passagem');
  await ocioso();
  for (const [i, s] of [[0, 'resolvida'], [1, 'resolvida']]) {
    await page.evaluate((i, s) => {
      const f = document.querySelectorAll('#passagem-herdadas .pendencia-herdada')[i];
      f.querySelector(`input[value="${s}"]`).click();
      const t = f.querySelector('textarea'); t.value = 'Feito.'; t.dispatchEvent(new Event('input', { bubbles: true }));
    }, i, s);
  }
  await page.select('#passagem-turno', 'T2');
  await valor('#passagem-original', 'turno 2');
  await valor('#passagem-final', 'AVISOS\n- ok');
  await page.click('#btn-publicar-passagem');
  await ocioso();
  b = await barra();
  ok(b.badge === '(escondido)' && b.tituloPassagem === 'Passagem de turno', 'sem pendência aberta: contador some e o tooltip volta ao nome', b.badge);
  await publicarNoBanco('T3', 'PENDÊNCIAS PARA O PRÓXIMO TURNO\\n- Pedir a foto do lacre');
  await entrar('admin', '#matriz');
  b = await barra();
  ok(b.badge === '1' && b.badgeAria === '1 pendência herdada aberta', 'outra pendência: contador "1" (singular)', b.badge);

  // 4. Barra recolhida (clique no logo): só ícones, tooltip pelo title, contador no canto do ícone
  console.log('\n--- Barra recolhida e celular ---');
  await page.click('#sidebar-brand');
  await esperar(400);
  b = await barra();
  ok(b.largura <= 80 && b.rotulosVisiveis === 0 && b.textosVisiveis === 0, 'recolhida: sem rótulos nem textos (só ícones)', `${b.largura}px`);
  ok(b.tituloPassagem === 'Passagem de turno (1 pendência herdada aberta)' && b.tituloHistorico === 'Histórico de pendências', 'tooltip (title) com o nome e o contador', b.tituloPassagem);
  ok(b.badge === '1' && b.badgeDentro && b.iconeTurnos === INDIGO_CLARO, 'recolhida: contador no ícone, dentro da barra; ícone índigo', b.badgeDentro);
  const separador = await page.evaluate(() => getComputedStyle(document.getElementById('torre-nav-turnos')).borderTopStyle);
  ok(separador === 'solid', 'recolhida: separador entre as seções', separador);
  await page.click('#nav-link-pendencias');
  await ocioso();
  ok((await barra()).ativo === 'nav-link-pendencias' && await page.$eval('#torre-aba-titulo', el => el.textContent) === 'Histórico de pendências', 'recolhida: o ícone abre a tela');
  await page.screenshot({ path: CAP('torre_sidebar_turnos_recolhida.png') });
  await page.click('#sidebar-brand');
  await esperar(300);

  // 5. Celular (390): gaveta com a seção; tocar no item fecha a gaveta e abre a tela
  await page.setViewport({ width: 390, height: 844 });
  await entrar('admin', '#matriz');
  await page.click('#btn-mobile-menu');
  await esperar(400);
  b = await barra();
  const aberta = await page.evaluate(() => document.getElementById('torre-sidebar').classList.contains('sidebar-aberta'));
  ok(aberta && b.grupos.includes('[COMUNICAÇÃO ENTRE TURNOS]') && b.badge === '1' && b.badgeDentro && !b.rolagem, '390px: gaveta aberta com a seção e o contador', b.badge);
  await page.screenshot({ path: CAP('torre_sidebar_turnos_390.png') });
  await page.click('#nav-link-passagem');
  await ocioso();
  const depois = await page.evaluate(() => ({
    aberta: document.getElementById('torre-sidebar').classList.contains('sidebar-aberta'),
    titulo: document.getElementById('torre-aba-titulo').textContent,
    rolagem: document.documentElement.scrollWidth > window.innerWidth
  }));
  ok(!depois.aberta && depois.titulo === 'Passagem de turno' && !depois.rolagem, '390px: tocar em "Passagem de turno" fecha a gaveta e abre a tela', depois);
  await page.setViewport({ width: 1366, height: 900 });

  const errosJs = erros.filter(e => !/Failed to fetch|Swiper/.test(e));
  ok(errosJs.length === 0, 'sem erros de JS', errosJs.join(' | '));
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTUDO OK');
  await browser.close(); srv.close(); await db.close();
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

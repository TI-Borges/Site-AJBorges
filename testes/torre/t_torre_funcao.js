// Edge function torre-receber-planilha no Node, gravando num PGlite com o T01 (nada vai para o Supabase).
// Confere: 405, 401 (sem secret, errado, o CRON_SECRET do site), 413 (corpo > 5 MB, com e sem
// Content-Length), 400 (JSON/formato), 200 gravando pela RPC com os cabeçalhos do schema torre,
// 422 (aba proibida), 503 (RPC fora), que ela nunca lê o CRON_SECRET e que os logs não têm dados pessoais.
// Uso: node testes/torre/t_torre_funcao.js
const { bancoComTorre, carregarFuncao } = require('./apoio');

let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ' -> ' + extra : ''}`); if (!cond) falhas++; };

const URL_FUNCAO = 'https://teste.invalid/functions/v1/torre-receber-planilha';
const pedir = (corpo, headers = {}, metodo = 'POST') => new Request(URL_FUNCAO, {
  method: metodo, headers: { 'Content-Type': 'application/json', ...headers },
  ...(metodo === 'POST' ? { body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo) } : {})
});
const comSegredo = { 'x-torre-secret': 'segredo-da-torre-teste' };
const payload = {
  abas: [{
    aba: 'TRÂNSITO', cabecalho: [{ c: 'LH' }, { c: 'MOTORISTA' }, { c: 'CONTATO DO MOTORISTA' }, { c: 'CAVALO' }, { c: 'STATUS' }], extras: {},
    linhas: [2, 3, 4].map(n => ({ linha: n, celulas: [{ c: 'LH', v: `LT0TESTE${n}` }, { c: 'MOTORISTA', v: `Motorista Exemplo 0${n}` },
      { c: 'CONTATO DO MOTORISTA', v: '(00) 00000-0000' }, { c: 'CAVALO', v: `EXE${n}A00` }, { c: 'STATUS', v: 'ATRASADO', bg: '#f4cccc' }] }))
  }]
};

(async () => {
  const db = await bancoComTorre();
  const f = await carregarFuncao(db);
  const chamar = async (req) => { const r = await f.handler(req); return { status: r.status, corpo: await r.json() }; };

  let r = await chamar(pedir(null, comSegredo, 'GET'));
  ok(r.status === 405, 'GET -> 405', r.status);

  r = await chamar(pedir(payload));
  ok(r.status === 401, 'sem x-torre-secret -> 401', r.status);
  r = await chamar(pedir(payload, { 'x-torre-secret': 'segredo-da-torre-testX' }));
  ok(r.status === 401, 'secret errado (mesmo tamanho) -> 401', r.status);
  r = await chamar(pedir(payload, { 'x-torre-secret': 'curto' }));
  ok(r.status === 401, 'secret errado (outro tamanho) -> 401', r.status);
  r = await chamar(pedir(payload, { 'x-torre-secret': 'segredo-do-cron-do-site' }));
  ok(r.status === 401, 'CRON_SECRET do site não abre a Torre -> 401', r.status);
  r = await chamar(pedir(payload, { 'x-cron-secret': 'segredo-do-cron-do-site' }));
  ok(r.status === 401, 'cabeçalho x-cron-secret não abre a Torre -> 401', r.status);
  ok(f.chamadas.length === 0, 'nada chegou ao banco antes de autorizar');

  const grande = JSON.stringify({ abas: [{ aba: 'ORIGEM', linhas: [{ linha: 2, celulas: [{ c: 'X', v: 'x'.repeat(5 * 1024 * 1024) }] }] }] });
  r = await chamar(pedir(grande, comSegredo));
  ok(r.status === 413, 'corpo > 5 MB (com Content-Length) -> 413', r.status);
  const fluxo = new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(32)); c.close(); } });
  r = await chamar(new Request(URL_FUNCAO, { method: 'POST', headers: comSegredo, body: fluxo, duplex: 'half' }));
  ok(r.status === 413, 'corpo > 5 MB (sem Content-Length, em pedaços) -> 413', r.status);

  r = await chamar(pedir('{nao e json', comSegredo));
  ok(r.status === 400, 'JSON inválido -> 400', r.status);
  r = await chamar(pedir({ abas: 'TRÂNSITO' }, comSegredo));
  ok(r.status === 400, 'formato inválido -> 400', r.status);
  r = await chamar(pedir({ abas: [{ aba: 'ORIGEM', linhas: Array.from({ length: 3001 }, (_, i) => ({ linha: i + 2, celulas: [] })) }] }, comSegredo));
  ok(r.status === 400, '3.001 linhas -> 400', r.status);
  ok(f.chamadas.length === 0, 'nada chegou ao banco nas recusas da função');

  r = await chamar(pedir(payload, comSegredo));
  ok(r.status === 200 && r.corpo.ok && r.corpo.abas === 1 && r.corpo.linhas === 3, 'payload válido -> 200, gravado pela RPC', JSON.stringify(r.corpo));
  const ch = f.chamadas[f.chamadas.length - 1];
  ok(ch.url.endsWith('/rest/v1/rpc/aplicar_planilha') && ch.headers['Content-Profile'] === 'torre' && ch.headers['Accept-Profile'] === 'torre',
    'chamou a RPC pela REST com Content-Profile/Accept-Profile: torre');
  await db.exec(`begin; select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"role":"admin"}}', true); set local role authenticated;`);
  const vista = (await db.query(`select ordem, lh, status, status_situacao from torre.v_transito order by ordem`)).rows;
  await db.exec('rollback');
  ok(vista.length === 3 && vista[0].lh === 'LT0TESTE2' && vista[0].status_situacao === 'critico', 'admin lê pela v_transito', JSON.stringify(vista[0]));

  r = await chamar(pedir({ abas: [{ aba: 'CONFIGURAÇÕES', cabecalho: [], extras: {}, linhas: [] }] }, comSegredo));
  ok(r.status === 422 && /não permitida/.test(r.corpo.erro), 'aba CONFIGURAÇÕES -> 422 (recusada pela RPC)', JSON.stringify(r.corpo));
  r = await chamar(pedir({ abas: [{ aba: 'TRÂNSITO', cabecalho: [], extras: {}, linhas: [] }] }, comSegredo));
  ok(r.status === 200 && r.corpo.ok === false && r.corpo.bloqueadas[0] === 'TRÂNSITO', 'TRÂNSITO vazia -> trava dos 50% (mantém a anterior)', JSON.stringify(r.corpo));

  f.chamadas.falharHttp = true;
  r = await chamar(pedir(payload, comSegredo));
  ok(r.status === 503, 'RPC fora do ar -> 503', r.status);
  f.chamadas.falharHttp = false;

  ok(!f.envLidas.includes('CRON_SECRET'), 'nunca lê o CRON_SECRET', [...new Set(f.envLidas)].join(','));
  const logs = f.logs.join('\n');
  ok(f.logs.length > 0 && !/Motorista|Exemplo|00000|EXE\dA|LT0TESTE|segredo/.test(logs), 'logs só com contagens (sem nome, telefone, placa, LH ou secret)');
  console.log('      logs:\n      ' + f.logs.join('\n      '));

  f.restaurarFetch();
  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// Apps Script supabase/apps-script/torre-sincronizar.gs no Node (vm), com uma planilha simulada só de
// leitura: qualquer método que não seja de leitura dá erro e fica registrado. Dados INVENTADOS.
// Confere: linhas vazias (inclusive as de fórmula), cores (fundo, texto, cor do bloco), links (rich text,
// em parte do texto e =HYPERLINK), blocos mesclados da MATRIZ, contadores e "Última atualização",
// aba oculta, CONFIGURAÇÕES e BASE ATLAS nunca abertas (mesmo se postas na lista), trava, propriedades,
// gatilho e logs sem dados pessoais. Depois manda o payload gerado pela edge function até o PGlite e
// lê pelas views, como o site vai ler (ponta a ponta).
// Uso: node testes/torre/t_torre_script.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { RAIZ, bancoComTorre, carregarFuncao } = require('./apoio');

let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? 'OK  ' : 'FALHA'} ${msg}${extra !== undefined ? ' -> ' + extra : ''}`); if (!cond) falhas++; };
const FONTE = fs.readFileSync(path.join(RAIZ, 'supabase/apps-script/torre-sincronizar.gs'), 'utf8');

// ---------- Planilha simulada ----------
const col = (letra) => letra.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
function aba(nome, celulas, extra = {}) {
  // celulas: { 'A1': 'texto' | { v, bg, fg, url, runs, f } }
  const mapa = {};
  for (const [ref, x] of Object.entries(celulas)) {
    const [, l, r] = ref.match(/^([A-Z]+)(\d+)$/);
    mapa[`${r},${col(l)}`] = typeof x === 'string' ? { v: x } : x;
  }
  const chaves = Object.keys(mapa).map(k => k.split(',').map(Number));
  return { nome, mapa, oculta: !!extra.oculta, mesclas: extra.mesclas || [],
    ultimaLinha: Math.max(0, ...chaves.filter(([r, c]) => { const x = mapa[`${r},${c}`]; return x.v || x.f; }).map(([r]) => r)),
    ultimaColuna: Math.max(0, ...chaves.filter(([r, c]) => { const x = mapa[`${r},${c}`]; return x.v || x.f; }).map(([, c]) => c)) };
}
const registro = { proibidos: [], abasPedidas: [], abasLidas: new Set(), idAberto: null };
const LEITURA = {
  planilha: ['getSheetByName'],
  aba: ['getLastRow', 'getLastColumn', 'isSheetHidden', 'getRange', 'getName'],
  faixa: ['getDisplayValues', 'getBackgrounds', 'getFontColors', 'getRichTextValues', 'getFormulas', 'getMergedRanges']
};
function soLeitura(tipo, obj) {
  return new Proxy(obj, { get(alvo, prop) {
    if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return alvo[prop];
    if (!LEITURA[tipo].includes(prop)) { registro.proibidos.push(`${tipo}.${prop}`); throw new Error(`proibido: ${tipo}.${prop}`); }
    return alvo[prop];
  } });
}
function planilhaFalsa(abas) {
  return soLeitura('planilha', {
    getSheetByName(nome) {
      registro.abasPedidas.push(nome);
      const a = abas.find(x => x.nome === nome);
      if (!a) return null;
      return soLeitura('aba', {
        getName: () => a.nome, isSheetHidden: () => a.oculta, getLastRow: () => a.ultimaLinha, getLastColumn: () => a.ultimaColuna,
        getRange(r0, c0, nr = 1, nc = 1) {
          registro.abasLidas.add(a.nome);
          const grade = (f) => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => f(a.mapa[`${r0 + i},${c0 + j}`] || {})));
          return soLeitura('faixa', {
            getDisplayValues: () => grade(x => x.v || ''),
            getBackgrounds: () => grade(x => x.bg || '#ffffff'),
            getFontColors: () => grade(x => x.fg || '#000000'),
            getFormulas: () => grade(x => x.f || ''),
            getRichTextValues: () => grade(x => ({ getLinkUrl: () => x.url || null,
              getRuns: () => (x.runs || []).map(u => ({ getLinkUrl: () => u })) })),
            getMergedRanges: () => a.mesclas.filter(m => m.linha >= r0 && m.linha < r0 + nr)
              .map(m => ({ getColumn: () => m.ini, getNumColumns: () => m.n }))
          });
        }
      });
    }
  });
}

// MATRIZ: contadores nas linhas 1-2, "Última atualização" em A5, blocos mesclados na linha 5, títulos na 6
const corBloco = { ORIGEM: '#d9d2e9', CARREGAMENTO: '#c9daf8', TRÂNSITO: '#fff2cc', DESCARGAS: '#d0e0e3' };
const titulosMatriz = { A: 'LH', B: 'MOTORISTA', C: 'CAVALO', D: 'CARRETA', E: 'ETA', F: 'LOCALIZAÇÃO', G: 'KM', H: 'TIMER',
  I: 'CPT', J: 'TIMER', K: 'STATUS', L: 'PREVISÃO DE CHEGADA', M: 'CPT', N: 'ETA DESTINO', O: 'STATUS', P: 'PARADA', Q: 'KM/H',
  R: 'TT RESTANTE', S: 'CHEGADA', T: 'TIMER', U: 'STATUS' };
const blocoDe = (l) => l >= 'E' && l <= 'H' ? 'ORIGEM' : l >= 'I' && l <= 'K' ? 'CARREGAMENTO' : l >= 'L' && l <= 'R' ? 'TRÂNSITO' : l >= 'S' && l <= 'U' ? 'DESCARGAS' : null;
const matrizCel = {
  A1: 'ROTAS ATIVAS', B1: 'Pendentes Chegada', C1: 'Carregamentos', D1: 'Trânsito', E1: 'Atrasos', F1: 'Descarga',
  A2: '3', B2: '0', C2: '0', D2: '2', E2: '1', F2: '1',
  A5: 'Última atualização: 29/10/2026 10:35:00', E5: { v: 'ORIGEM', bg: corBloco.ORIGEM }, I5: { v: 'CARREGAMENTO', bg: corBloco.CARREGAMENTO },
  L5: { v: 'TRÂNSITO', bg: corBloco['TRÂNSITO'] }, S5: { v: 'DESCARGAS', bg: corBloco.DESCARGAS },
  // linha 7: em trânsito; 8: vazia mas pintada; 9: descarga; 10: trânsito com a cor do bloco; 11-60: só fórmula vazia
  A7: 'LT0TESTE001', B7: 'Motorista Exemplo 01', C7: 'EXE1A01', O7: { v: 'Em trânsito', bg: '#ff9900' }, P7: { v: '02:10', bg: '#f4cccc' }, Q7: '62',
  A8: { v: '', bg: '#f4cccc' }, O8: { v: '', bg: '#ff9900' },
  A9: 'LT0TESTE002', B9: 'Motorista Exemplo 02', U9: { v: 'Descarregando', bg: '#cfe2f3' }, S9: '29/10 09:00',
  A10: 'LT0TESTE003', B10: 'Motorista Exemplo 03', O10: { v: 'NO PRAZO', bg: corBloco['TRÂNSITO'] }, N10: { v: '29/10 18:00', fg: '#cc0000' }
};
for (const [l, t] of Object.entries(titulosMatriz)) matrizCel[`${l}6`] = { v: t, bg: blocoDe(l) ? corBloco[blocoDe(l)] : '#000000' };
for (let r = 11; r <= 60; r++) matrizCel[`A${r}`] = { v: '', f: '=IFERROR(VLOOKUP(1;X:X;1;0);"")' };

const titulosTransito = ['LH', 'MOTORISTA', 'CARGA', 'CONTATO DO MOTORISTA', 'CAVALO', 'CARRETA', 'VÍNCULO', 'ORIGEM', 'DESTINO', 'POSIÇÃO ATUAL',
  'CPT ORIGEM', 'CPT REALIZADO', 'PCT', 'KM/H', 'T PARADA', 'TOTAL PARADA', 'Macro', 'ATUALIZAÇÃO', 'PREVISÃO DE CHEGADA', 'ETA DESTINO',
  'T CHEGADA', 'STATUS', 'PROGRESSÃO VIAGEM', 'FATURAMENTO', 'CIOT / VPO', 'SM'];
const letra = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const transitoCel = {};
titulosTransito.forEach((t, i) => { transitoCel[`${letra(i + 1)}1`] = { v: t, bg: '#1c4587', fg: '#ffffff' }; });
for (const [r, n] of [[2, 1], [4, 2]]) {
  titulosTransito.forEach((t, i) => { transitoCel[`${letra(i + 1)}${r}`] = `${t} ${n}`; });
  transitoCel[`B${r}`] = `Motorista Exemplo 0${n}`;
  transitoCel[`D${r}`] = '(00) 00000-0000';
  transitoCel[`E${r}`] = `EXE${n}A0${n}`;
  transitoCel[`J${r}`] = { v: 'Ver no mapa', url: `https://exemplo.invalid/mapa/${n}` };
  transitoCel[`V${r}`] = { v: n === 1 ? 'ATRASADO' : 'CHEGOU', bg: n === 1 ? '#ea9999' : '#b6d7a8' };
  transitoCel[`L${r}`] = { v: '29/10 10:00', fg: n === 1 ? '#ff0000' : '#1155cc' };
}
transitoCel.AA2 = 'coluna sem título';

const abas = [
  aba('MATRIZ', matrizCel, { mesclas: [{ linha: 5, ini: col('E'), n: 4 }, { linha: 5, ini: col('I'), n: 3 }, { linha: 5, ini: col('L'), n: 7 }, { linha: 5, ini: col('S'), n: 3 }] }),
  aba('VALIDAÇÕES PRÉ CARREGAMENTO', { A1: 'VALIDAÇÕES', A3: 'LH', B3: 'MOTORISTA', C3: 'CHECKLIST', D3: 'GR', F3: 'Última atualização', G3: '29/10/2026 10:30',
    A4: 'LT0TESTE010', B4: 'Motorista Exemplo 10', C4: { v: 'NOK', bg: '#ff0000' }, D4: { v: 'OK', bg: '#00ff00' },
    A5: 'LT0TESTE011', B5: 'Motorista Exemplo 11', C5: { v: 'PENDENTE', bg: '#000000', fg: '#ffffff' } }),
  aba('ORIGEM', { A1: 'LH', B1: 'MOTORISTA', A2: 'LT0OCULTA', B2: 'Motorista Oculto' }, { oculta: true }),
  aba('CARREGAMENTOS', { A1: 'LH', B1: 'MOTORISTA', C1: 'STATUS' }),
  aba('TRÂNSITO', transitoCel),
  aba('DESCARGAS', { A1: 'LH', B1: 'STATUS', A2: 'LT0TESTE020', B2: { v: 'Descarregando', bg: '#cfe2f3' } }),
  aba('FATURAMENTO', { A1: 'LH', B1: 'VALOR', C1: 'STATUS', A2: 'LT0TESTE030', B2: 'R$ 1.234,56', C2: { v: 'FATURAR', bg: '#ffff00' } }),
  aba('LINKS / TREINAMENTOS', { B1: 'LINKS ÚTEIS', B2: 'Treinamento de Exemplo', C2: { v: 'Abrir', url: 'https://exemplo.invalid/treinamento' },
    B3: 'Manual de Exemplo', C3: { v: 'Manual', f: '=HYPERLINK("https://exemplo.invalid/manual";"Manual")' },
    D3: { v: 'veja aqui o vídeo', runs: [null, 'https://exemplo.invalid/video'] }, B5: 'Seção sem link' }),
  aba('ENDEREÇOS', { A1: 'NOME', B1: 'ENDEREÇO', C1: 'MAPA', A2: 'CD Exemplo', B2: 'Rua Exemplo, 100', C2: { v: 'mapa', url: 'https://exemplo.invalid/cd' } }),
  aba('CONFIGURAÇÕES', { A1: 'SENHA', B1: 'segredo-da-planilha' }),
  aba('BASE ATLAS', { A1: 'CPF', A2: '000.000.000-00' })
];

// ---------- Ambiente do Apps Script ----------
function ambiente(opcoes = {}) {
  const logs = [];
  const enviados = [];
  const gatilhos = opcoes.gatilhos || [];
  const props = opcoes.props || { TORRE_PLANILHA_ID: 'id-planilha-teste', TORRE_FUNCAO_URL: 'https://teste.invalid/functions/v1/torre-receber-planilha', TORRE_SYNC_SECRET: 'segredo-da-torre-teste' };
  const ctx = {
    console, JSON, Math, String, Array, Object, Number, RegExp, Error, Date,
    Logger: { log: (s) => logs.push(String(s)) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => opcoes.travado !== true, releaseLock: () => {} }) },
    SpreadsheetApp: { openById: (id) => { registro.idAberto = id; return planilhaFalsa(abas); } },
    Utilities: { newBlob: (s) => ({ getBytes: () => Buffer.from(s, 'utf8') }) },
    UrlFetchApp: { fetch: (url, o) => { enviados.push({ url, o }); const r = opcoes.resposta || { codigo: 200, corpo: { ok: true, abas: 8, linhas: 10, bloqueadas: [] } };
      return { getResponseCode: () => r.codigo, getContentText: () => JSON.stringify(r.corpo) }; } },
    ScriptApp: {
      getProjectTriggers: () => gatilhos.slice(),
      deleteTrigger: (g) => gatilhos.splice(gatilhos.indexOf(g), 1),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (m) => ({ create: () => gatilhos.push({ fn, m, getHandlerFunction: () => fn }) }) }) })
    }
  };
  vm.createContext(ctx);
  vm.runInContext(FONTE, ctx, { filename: 'torre-sincronizar.gs' });
  return { ctx, logs, enviados, gatilhos, rodar: (codigo) => vm.runInContext(codigo, ctx) };
}

(async () => {
  // Só leitura no código (grep)
  const escrita = FONTE.match(/\.(setValues?|setFormulas?|setBackgrounds?|setNote|clear\w*|sort|insert\w*|delete(Row|Rows|Column|Columns|Sheet)|appendRow|copyTo|moveTo|protect|hideSheet|activate)\(/g);
  ok(!escrita, 'script: nenhum método de escrita na planilha (grep)', escrita ? escrita.join(',') : 'nenhum');
  ok(!/https?:\/\/[^\s'"]*supabase\.co/.test(FONTE.replace(/\* .*<projeto>.*/g, '')) && !/TORRE_SYNC_SECRET\s*=\s*['"]/.test(FONTE),
    'script: sem URL nem secret escritos no código');

  // 1. testarUmaVez
  const a = ambiente();
  const res = a.rodar('testarUmaVez()');
  ok(registro.idAberto === 'id-planilha-teste', 'abre a planilha por openById com o ID das propriedades');
  ok(registro.proibidos.length === 0, 'só métodos de leitura foram usados', registro.proibidos.join(',') || 'nenhum proibido');
  ok(!registro.abasPedidas.includes('CONFIGURAÇÕES') && !registro.abasPedidas.includes('BASE ATLAS'), 'CONFIGURAÇÕES e BASE ATLAS nunca pedidas', registro.abasPedidas.join(' | '));
  ok(!registro.abasLidas.has('ORIGEM'), 'aba oculta (ORIGEM) não é lida');
  ok(a.enviados.length === 1 && a.enviados[0].o.headers['x-torre-secret'] === 'segredo-da-torre-teste' && a.enviados[0].url.endsWith('/torre-receber-planilha'),
    'envia 1 POST para a URL das propriedades com x-torre-secret');
  const payload = JSON.parse(a.enviados[0].o.payload);
  const porNome = Object.fromEntries(payload.abas.map(x => [x.aba, x]));
  ok(payload.abas.map(x => x.aba).join('|') === 'MATRIZ|VALIDAÇÕES PRÉ CARREGAMENTO|CARREGAMENTOS|TRÂNSITO|DESCARGAS|FATURAMENTO|LINKS / TREINAMENTOS|ENDEREÇOS',
    'payload com as 8 abas visíveis, na ordem', payload.abas.length);
  const mz = porNome.MATRIZ;
  ok(mz.linhas.map(l => l.linha).join() === '7,9,10', 'MATRIZ: linhas vazias (pintadas ou só com fórmula) ignoradas', mz.linhas.map(l => l.linha).join());
  const l7 = Object.fromEntries(mz.linhas[0].celulas.map(c => [(c.g || '') + '|' + c.c, c]));
  ok(l7['TRÂNSITO|STATUS'] && l7['TRÂNSITO|STATUS'].bg === '#ff9900' && !l7['TRÂNSITO|STATUS'].cb && l7['|LH'].v === 'LT0TESTE001' && !l7['|LH'].bg,
    'MATRIZ: bloco pela mescla da linha 5, cor guardada, fundo branco omitido', JSON.stringify(l7['TRÂNSITO|STATUS']));
  const l10 = Object.fromEntries(mz.linhas[2].celulas.map(c => [(c.g || '') + '|' + c.c, c]));
  ok(l10['TRÂNSITO|STATUS'].cb === true && l10['TRÂNSITO|ETA DESTINO'].fg === '#cc0000', 'MATRIZ: fundo igual ao do bloco marcado cb; cor do texto guardada');
  ok(mz.extras.ultima_atualizacao === '29/10/2026 10:35:00' && mz.extras.topo[1].join() === '3,0,0,2,1,1', 'MATRIZ: "Última atualização" e contadores (linhas 1-2)', JSON.stringify(mz.extras));
  ok(mz.cabecalho.length === 21 && mz.cabecalho[4].g === 'ORIGEM' && mz.cabecalho[0].g === undefined, 'MATRIZ: cabeçalho com títulos e blocos', mz.cabecalho.length);
  const va = porNome['VALIDAÇÕES PRÉ CARREGAMENTO'];
  ok(va.extras.ultima_atualizacao === '29/10/2026 10:30' && va.cabecalho.map(h => h.c).join() === 'LH,MOTORISTA,CHECKLIST,GR' && va.linhas.length === 2,
    'VALIDAÇÕES: títulos na linha 3; "Última atualização" e a data ao lado não viram coluna', JSON.stringify(va.cabecalho.map(h => h.c)));
  const tr = porNome['TRÂNSITO'];
  ok(tr.linhas.map(l => l.linha).join() === '2,4' && tr.cabecalho.length === 27 && tr.cabecalho[26].c === 'AA', 'TRÂNSITO: linha 3 vazia ignorada; coluna sem título vira a letra (AA)');
  const t2 = Object.fromEntries(tr.linhas[0].celulas.map(c => [c.c, c]));
  ok(t2['POSIÇÃO ATUAL'].url === 'https://exemplo.invalid/mapa/1' && t2.STATUS.bg === '#ea9999' && t2['CPT REALIZADO'].fg === '#ff0000' && !('cb' in t2.LH),
    'TRÂNSITO: link do rich text, fundo e cor do texto');
  ok(porNome.CARREGAMENTOS.linhas.length === 0, 'CARREGAMENTOS sem dados vai vazia (pode zerar)');
  const lk = porNome['LINKS / TREINAMENTOS'];
  const lkCel = lk.linhas.map(l => l.celulas.map(c => `${c.c}:${c.v}${c.url ? '@' + c.url : ''}`).join(' '));
  ok(lk.linhas[0].linha === 2 && lkCel[0] === 'B:Treinamento de Exemplo C:Abrir@https://exemplo.invalid/treinamento' &&
     lkCel[1] === 'B:Manual de Exemplo C:Manual@https://exemplo.invalid/manual D:veja aqui o vídeo@https://exemplo.invalid/video',
    'LINKS: colunas pela letra; link do rich text, do =HYPERLINK e de parte do texto', JSON.stringify(lkCel));
  ok(!JSON.stringify(payload).includes('segredo-da-planilha') && !JSON.stringify(payload).includes('000.000.000-00') && !JSON.stringify(payload).includes('Motorista Oculto'),
    'payload sem nada de CONFIGURAÇÕES, BASE ATLAS ou da aba oculta');
  ok(res && res.codigo === 200, 'testarUmaVez devolve http 200');
  const logs = a.logs.join('\n');
  ok(/^Torre: http 200 \| enviadas 8 abas, \d+ linhas, \d+ KB/m.test(logs) && /TRÂNSITO: 2 linhas, 27 colunas/.test(logs) && /ORIGEM: oculta/.test(logs),
    'log com contagens por aba');
  ok(!/Motorista|Exemplo|00000|EXE\dA|LT0TESTE|segredo|exemplo\.invalid/.test(logs), 'log sem nome, telefone, placa, LH, link ou secret');
  console.log('      ' + a.logs.join('\n      '));

  // 2. Lista adulterada: BASE ATLAS e CONFIGURAÇÕES postas na lista continuam sem ser abertas
  registro.abasPedidas = [];
  const b = ambiente();
  b.rodar(`TORRE_ABAS.push({ nome: 'BASE ATLAS', titulos: 1, dados: 2 }, { nome: 'CONFIGURAÇÕES', titulos: 1, dados: 2 }, { nome: 'configuracoes', titulos: 1, dados: 2 })`);
  b.rodar('sincronizarTorre()');
  ok(!registro.abasPedidas.some(n => /ATLAS|CONFIG/i.test(n)) && JSON.parse(b.enviados[0].o.payload).abas.length === 8,
    'BASE ATLAS/CONFIGURAÇÕES na lista: continuam sem ser abertas');

  // 3. Trava, propriedades e resposta de erro
  const c = ambiente({ travado: true });
  ok(c.rodar('sincronizarTorre()') === null && c.enviados.length === 0 && /pulada/.test(c.logs.join()), 'LockService: com outra cópia rodando, pula');
  let erro = '';
  try { ambiente({ props: {} }).rodar('sincronizarTorre()'); } catch (e) { erro = e.message; }
  ok(/faltam propriedades/.test(erro), 'sem as propriedades do script: erro claro', erro);
  erro = '';
  const d = ambiente({ resposta: { codigo: 401, corpo: { erro: 'Não autorizado.' } } });
  try { d.rodar('sincronizarTorre()'); } catch (e) { erro = e.message; }
  ok(/http 401/.test(erro), 'função responde 401: o gatilho falha (e o Google avisa a conta TI)', erro);

  // 4. Gatilho
  const e = ambiente({ gatilhos: [{ fn: 'sincronizarTorre', getHandlerFunction: () => 'sincronizarTorre' }, { fn: 'outra', getHandlerFunction: () => 'outra' }] });
  e.rodar('criarGatilho()');
  ok(e.gatilhos.filter(g => g.fn === 'sincronizarTorre').length === 1 && e.gatilhos.find(g => g.fn === 'sincronizarTorre').m === 5 && e.gatilhos.some(g => g.fn === 'outra'),
    'criarGatilho: um só, a cada 5 min (sem mexer em outros gatilhos)');
  e.rodar('removerGatilho()');
  ok(!e.gatilhos.some(g => g.fn === 'sincronizarTorre') && e.gatilhos.length === 1, 'removerGatilho: tira só o da Torre');

  // 5. Ponta a ponta: payload do script -> edge function -> RPC -> views (como admin)
  const db = await bancoComTorre();
  const f = await carregarFuncao(db);
  const r = await f.handler(new Request('https://teste.invalid/functions/v1/torre-receber-planilha', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-torre-secret': 'segredo-da-torre-teste' }, body: a.enviados[0].o.payload }));
  const corpo = await r.json();
  ok(r.status === 200 && corpo.ok && corpo.abas === 8, 'ponta a ponta: função grava as 8 abas', JSON.stringify(corpo));
  await db.exec(`begin; select set_config('request.jwt.claims', '{"role":"authenticated","app_metadata":{"role":"admin"}}', true); set local role authenticated;`);
  const q = async (s) => (await db.query(s)).rows;
  const matriz = await q(`select ordem, etapa, lh, motorista, transito_status, transito_status_situacao, transito_parada_situacao,
                                 transito_eta_destino_situacao, descarga_status_situacao from torre.v_matriz order by ordem`);
  const cont = (await q(`select * from torre.v_matriz_contadores`))[0];
  const transito = await q(`select lh, contato, posicao_atual_url, status, status_situacao, cpt_realizado_situacao from torre.v_transito order by ordem`);
  const valid = await q(`select lh, checklist, checklist_situacao, gr_situacao from torre.v_validacoes order by ordem`);
  const links = await q(`select titulo, link, link_url, link_2_url from torre.v_links order by ordem`);
  const ender = await q(`select nome, mapa_url from torre.v_enderecos`);
  const fat = await q(`select status, status_situacao, valor from torre.v_faturamento`);
  const st = (await q(`select abas, linhas, ultimo_erro, minutos_desde from torre.v_status`))[0];
  await db.exec('rollback');
  ok(matriz.map(m => `${m.ordem}:${m.etapa}:${m.transito_status_situacao ?? '-'}:${m.descarga_status_situacao ?? '-'}`).join(' ') === '7:transito:andamento:- 9:descarga:-:info 10:transito:-:-',
    'v_matriz: etapa e situação (cor do bloco = null)', JSON.stringify(matriz));
  ok(matriz[0].transito_parada_situacao === 'critico' && matriz[2].transito_eta_destino_situacao === 'critico', 'v_matriz: fundo vermelho e texto vermelho = critico');
  ok(cont.rotas_ativas === 3 && cont.transito === 2 && cont.atrasos === 1 && cont.descarga === 1 && new Date(cont.atualizado_em).toISOString() === '2026-10-29T13:35:00.000Z',
    'v_matriz_contadores: contadores e "Última atualização" (10:35 de Brasília)', JSON.stringify(cont));
  ok(transito.length === 2 && transito[0].posicao_atual_url === 'https://exemplo.invalid/mapa/1' && transito[0].status_situacao === 'critico' &&
     transito[1].status_situacao === 'ok' && transito[0].cpt_realizado_situacao === 'critico' && transito[1].cpt_realizado_situacao === null,
    'v_transito: link, situações; texto azul (de link) não vira situação', JSON.stringify(transito.map(t => [t.status_situacao, t.cpt_realizado_situacao])));
  ok(valid.map(v => `${v.checklist}:${v.checklist_situacao}:${v.gr_situacao ?? '-'}`).join(' ') === 'NOK:critico:ok PENDENTE:destaque:-', 'v_validacoes: checklist_situacao (vermelho, preto)');
  ok(links.length === 3 && links[0].link_url === 'https://exemplo.invalid/treinamento' && links[1].link_url === 'https://exemplo.invalid/manual' &&
     links[1].link_2_url === 'https://exemplo.invalid/video' && links[2].titulo === 'Seção sem link' && links[2].link_url === null, 'v_links: títulos e links', JSON.stringify(links.map(l => l.titulo)));
  ok(ender[0].mapa_url === 'https://exemplo.invalid/cd' && fat[0].status_situacao === 'atencao' && fat[0].valor === 'R$ 1.234,56', 'v_enderecos e v_faturamento');
  ok(st.abas === 8 && st.ultimo_erro === null && st.minutos_desde === 0, 'v_status: última sincronização boa', JSON.stringify(st));
  const semUso = (await db.query(fs.readFileSync(path.join(RAIZ, 'torre-de-controle-shoppe/CONTRATO_DADOS.md'), 'utf8').match(/```sql\n(with cab as[\s\S]*?)```/)[1])).rows;
  ok(semUso.some(x => x.tipo === 'título da planilha sem coluna' && x.aba === 'TRÂNSITO' && x.item === 'AA') &&
     semUso.some(x => x.tipo === 'coluna sem título na planilha' && x.aba === 'MATRIZ' && x.item === 'transito_cpt') === false,
    'consulta de conferência de títulos (CONTRATO_DADOS.md) acha o título sem coluna', semUso.filter(x => x.aba === 'TRÂNSITO').map(x => x.item).join(','));

  f.restaurarFetch();
  console.log(`\n${falhas ? falhas + ' FALHA(S)' : 'TUDO OK'}`);
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

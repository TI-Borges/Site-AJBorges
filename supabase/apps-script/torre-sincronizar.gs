/**
 * ==========================================================================
 * AJBorges - Torre de Controle - Shoppe: cópia da planilha para o site
 *
 * Lê as abas da planilha "TORRE DE CONTROLE SHOPEE" (só leitura) e envia
 * para a edge function torre-receber-planilha do Supabase do site, a cada
 * 5 minutos. Projeto NOVO e SEPARADO, da conta TI: NÃO é o projeto
 * "PLANILHA SHOPEE" que fica dentro da planilha.
 *
 * PASSO A PASSO (uma vez)
 *  1. Entre com a conta TI em https://script.google.com -> Novo projeto.
 *     Nome: "Torre - cópia para o site".
 *  2. Apague o conteúdo de Code.gs e cole este arquivo inteiro. Salve.
 *  3. Configurações do projeto (engrenagem) -> Propriedades do script ->
 *     adicione as três:
 *       TORRE_PLANILHA_ID  = o ID da planilha (o trecho entre /d/ e /edit
 *                            no endereço da planilha)
 *       TORRE_FUNCAO_URL   = https://<projeto>.supabase.co/functions/v1/torre-receber-planilha
 *       TORRE_SYNC_SECRET  = o mesmo valor cadastrado no secret
 *                            TORRE_SYNC_SECRET do Supabase
 *     Nada disso fica escrito no código.
 *  4. A conta TI precisa ter acesso (pelo menos leitura) à planilha.
 *  5. No editor, escolha a função testarUmaVez e clique em Executar. Na
 *     primeira vez o Google pede autorização (ver planilhas e conectar a
 *     serviço externo): autorize com a conta TI.
 *     O log mostra só contagens (abas, linhas, colunas, resposta da função).
 *  6. Deu "http 200"? Escolha criarGatilho e Executar: a cópia passa a
 *     rodar sozinha a cada 5 minutos. Para parar: removerGatilho.
 *
 * Se a cópia falhar, o Google manda e-mail de falha do gatilho para a conta TI.
 * Os nomes das abas e as linhas de título/dados ficam em TORRE_ABAS, logo
 * abaixo. CONFIGURAÇÕES, BASE ATLAS e abas ocultas nunca são lidas.
 * ==========================================================================
 */

// Abas copiadas. titulos = linha dos títulos (null = sem cabeçalho: a coluna
// vira a letra, ex.: "B"); blocos = linha com o nome do bloco (MATRIZ);
// dados = primeira linha de dados; topo = linhas dos contadores (MATRIZ);
// ultimaAtualizacaoAte = procura "Última atualização" da linha 1 até esta.
const TORRE_ABAS = [
  { nome: 'MATRIZ', titulos: 6, blocos: 5, dados: 7, topo: [1, 2], ultimaAtualizacaoAte: 5 },
  { nome: 'VALIDAÇÕES PRÉ CARREGAMENTO', titulos: 3, dados: 4, ultimaAtualizacaoAte: 3 },
  { nome: 'ORIGEM', titulos: 1, dados: 2 },
  { nome: 'CARREGAMENTOS', titulos: 1, dados: 2 },
  { nome: 'TRÂNSITO', titulos: 1, dados: 2 },
  { nome: 'DESCARGAS', titulos: 1, dados: 2 },
  { nome: 'FATURAMENTO', titulos: 1, dados: 2 },
  { nome: 'LINKS / TREINAMENTOS', titulos: null, dados: 2 },
  { nome: 'ENDEREÇOS', titulos: 1, dados: 2 }
];

// Nunca lidas, mesmo que alguém as coloque em TORRE_ABAS
const TORRE_NUNCA_LER = ['CONFIGURAÇÕES', 'BASE ATLAS'];

// Nomes dos blocos da linha 5 da MATRIZ
const TORRE_BLOCOS_MATRIZ = ['ORIGEM', 'CARREGAMENTO', 'TRÂNSITO', 'DESCARGAS'];

// Os mesmos limites da função/RPC
const TORRE_LIMITES = { linhas: 3000, colunas: 80, bytes: 5 * 1024 * 1024 };


// Chamada pelo gatilho de 5 em 5 minutos
function sincronizarTorre() {
  return torreExecutar_(false);
}

// Roda uma vez e mostra no log as contagens de cada aba
function testarUmaVez() {
  return torreExecutar_(true);
}

function criarGatilho() {
  removerGatilho();
  ScriptApp.newTrigger('sincronizarTorre').timeBased().everyMinutes(5).create();
  Logger.log('Torre: gatilho criado (sincronizarTorre a cada 5 minutos).');
}

function removerGatilho() {
  let removidos = 0;
  ScriptApp.getProjectTriggers().forEach(function (g) {
    if (g.getHandlerFunction() === 'sincronizarTorre') {
      ScriptApp.deleteTrigger(g);
      removidos++;
    }
  });
  Logger.log('Torre: ' + removidos + ' gatilho(s) removido(s).');
}


function torreExecutar_(detalhar) {
  const trava = LockService.getScriptLock();
  if (!trava.tryLock(1000)) {
    Logger.log('Torre: outra cópia ainda está rodando; esta foi pulada.');
    return null;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const idPlanilha = props.getProperty('TORRE_PLANILHA_ID');
    const urlFuncao = props.getProperty('TORRE_FUNCAO_URL');
    const segredo = props.getProperty('TORRE_SYNC_SECRET');
    if (!idPlanilha || !urlFuncao || !segredo) {
      throw new Error('Torre: faltam propriedades do script (TORRE_PLANILHA_ID, TORRE_FUNCAO_URL, TORRE_SYNC_SECRET).');
    }

    const planilha = SpreadsheetApp.openById(idPlanilha);
    const abas = [];
    const resumo = [];
    TORRE_ABAS.forEach(function (cfg) {
      if (torreNuncaLer_(cfg.nome)) {
        resumo.push(cfg.nome + ': proibida, não lida');
        return;
      }
      const aba = planilha.getSheetByName(cfg.nome);
      if (!aba) {
        resumo.push(cfg.nome + ': não encontrada');
        return;
      }
      if (aba.isSheetHidden()) {
        resumo.push(cfg.nome + ': oculta, não lida');
        return;
      }
      const lida = torreLerAba_(aba, cfg);
      abas.push(lida.aba);
      resumo.push(cfg.nome + ': ' + lida.aba.linhas.length + ' linhas, ' + lida.colunas + ' colunas' +
        (lida.avisos.length ? ' (' + lida.avisos.join('; ') + ')' : ''));
    });
    if (!abas.length) {
      throw new Error('Torre: nenhuma aba lida. ' + resumo.join(' | '));
    }

    const totalLinhas = abas.reduce(function (n, a) { return n + a.linhas.length; }, 0);
    const corpo = JSON.stringify({ abas: abas });
    const bytes = Utilities.newBlob(corpo).getBytes().length;
    if (bytes > TORRE_LIMITES.bytes) {
      throw new Error('Torre: cópia com ' + Math.round(bytes / 1024) + ' KB, acima do limite de 5 MB; não foi enviada.');
    }

    const resposta = UrlFetchApp.fetch(urlFuncao, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-torre-secret': segredo },
      payload: corpo,
      muteHttpExceptions: true
    });
    const codigo = resposta.getResponseCode();
    let resultado = {};
    try {
      resultado = JSON.parse(resposta.getContentText()) || {};
    } catch (e) {
      resultado = {};
    }

    // Só contagens e nomes de aba (a resposta da função não traz dados das linhas)
    Logger.log('Torre: http ' + codigo + ' | enviadas ' + abas.length + ' abas, ' + totalLinhas + ' linhas, ' +
      Math.round(bytes / 1024) + ' KB | aplicadas ' + (resultado.abas || 0) + ' abas, ' + (resultado.linhas || 0) +
      ' linhas' + ((resultado.bloqueadas || []).length ? ' | mantidas pela trava: ' + resultado.bloqueadas.join(', ') : '') +
      (resultado.erro ? ' | ' + resultado.erro : ''));
    if (detalhar) {
      resumo.forEach(function (l) { Logger.log('  ' + l); });
    }
    if (codigo !== 200) {
      throw new Error('Torre: a função respondeu http ' + codigo + (resultado.erro ? ' (' + resultado.erro + ')' : '') + '.');
    }
    return { codigo: codigo, resultado: resultado, abas: abas.length, linhas: totalLinhas, resumo: resumo };
  } finally {
    trava.releaseLock();
  }
}

function torreNuncaLer_(nome) {
  const chave = torreChave_(nome);
  return TORRE_NUNCA_LER.some(function (n) { return torreChave_(n) === chave; });
}

// Lê uma aba (só leitura): títulos, blocos, linhas não vazias com texto, cores e links
function torreLerAba_(aba, cfg) {
  const avisos = [];
  const ultimaLinha = aba.getLastRow();
  const largura = Math.max(aba.getLastColumn(), 1);

  let titulos = [];
  let fundosTitulo = [];
  if (cfg.titulos) {
    const r = aba.getRange(cfg.titulos, 1, 1, largura);
    titulos = r.getDisplayValues()[0];
    fundosTitulo = r.getBackgrounds()[0];
  }
  let blocos = [];
  let fundosBloco = [];
  if (cfg.blocos) {
    const r = aba.getRange(cfg.blocos, 1, 1, largura);
    blocos = torreBlocos_(r, largura);
    fundosBloco = r.getBackgrounds()[0];
  }

  // Dados: os 5 retratos da faixa inteira de uma vez (uma leitura cada)
  const qtd = ultimaLinha - cfg.dados + 1;
  let valores = [], fundos = [], cores = [], ricos = [], formulas = [];
  if (qtd > 0) {
    const r = aba.getRange(cfg.dados, 1, qtd, largura);
    valores = r.getDisplayValues();
    fundos = r.getBackgrounds();
    cores = r.getFontColors();
    ricos = r.getRichTextValues();
    formulas = r.getFormulas();
  }
  const naoVazias = [];
  for (let i = 0; i < valores.length; i++) {
    if (valores[i].some(function (v) { return String(v).trim() !== ''; })) naoVazias.push(i);
  }

  // Colunas usadas: com título ou com algum dado. "Última atualização" na linha dos
  // títulos (e a data logo à direita dele) não é título de coluna.
  const posRotulo = titulos.findIndex(function (t) { return torreChave_(t).indexOf('ULTIMAATUALIZACAO') === 0; });
  let colunas = [];
  for (let j = 0; j < largura; j++) {
    const titulo = String(titulos[j] || '').trim();
    const comTitulo = titulo !== '' && !(posRotulo >= 0 && (j === posRotulo || j === posRotulo + 1));
    const comDado = naoVazias.some(function (i) { return String(valores[i][j]).trim() !== ''; });
    if (comTitulo || comDado) colunas.push(j);
  }
  if (colunas.length > TORRE_LIMITES.colunas) {
    avisos.push(colunas.length + ' colunas, enviadas só as ' + TORRE_LIMITES.colunas + ' primeiras');
    colunas = colunas.slice(0, TORRE_LIMITES.colunas);
  }
  let linhasLidas = naoVazias;
  if (linhasLidas.length > TORRE_LIMITES.linhas) {
    avisos.push(linhasLidas.length + ' linhas, enviadas só as ' + TORRE_LIMITES.linhas + ' primeiras');
    linhasLidas = linhasLidas.slice(0, TORRE_LIMITES.linhas);
  }

  const nomeColuna = function (j) { return String(titulos[j] || '').trim() || torreLetra_(j + 1); };
  const cabecalho = colunas.map(function (j) {
    const h = { c: nomeColuna(j) };
    if (blocos[j]) h.g = blocos[j];
    return h;
  });

  const linhas = linhasLidas.map(function (i) {
    const celulas = [];
    colunas.forEach(function (j) {
      const v = String(valores[i][j]).trim();
      const url = torreLink_(ricos[i] && ricos[i][j], formulas[i] && formulas[i][j]);
      if (v === '' && !url) return; // célula vazia não vai (a view devolve null)
      const cel = { c: nomeColuna(j), v: v };
      if (blocos[j]) cel.g = blocos[j];
      const bg = String(fundos[i][j] || '').toLowerCase();
      if (bg && bg !== '#ffffff') {
        cel.bg = bg;
        // fundo igual ao do título ou do bloco = cor do bloco, sem significado
        if (bg === String(fundosTitulo[j] || '').toLowerCase() || bg === String(fundosBloco[j] || '').toLowerCase()) cel.cb = true;
      }
      const fg = String(cores[i][j] || '').toLowerCase();
      if (fg && fg !== '#000000') cel.fg = fg;
      if (url) cel.url = url;
      celulas.push(cel);
    });
    return { linha: cfg.dados + i, celulas: celulas };
  });

  const extras = {};
  if (cfg.ultimaAtualizacaoAte) {
    const grade = aba.getRange(1, 1, cfg.ultimaAtualizacaoAte, largura).getDisplayValues();
    const quando = torreUltimaAtualizacao_(grade);
    if (quando) extras.ultima_atualizacao = quando;
    if (cfg.topo) {
      extras.topo = cfg.topo.map(function (n) {
        const linha = (grade[n - 1] || []).map(function (v) { return String(v).trim(); });
        while (linha.length && linha[linha.length - 1] === '') linha.pop();
        return linha;
      });
    }
  }

  return {
    aba: { aba: cfg.nome, cabecalho: cabecalho, extras: extras, linhas: linhas },
    colunas: colunas.length,
    avisos: avisos
  };
}

// Bloco (ORIGEM, CARREGAMENTO, TRÂNSITO, DESCARGAS) de cada coluna, pelas células mescladas da linha
function torreBlocos_(faixa, largura) {
  const textos = faixa.getDisplayValues()[0];
  const conhecidos = TORRE_BLOCOS_MATRIZ.map(torreChave_);
  const ehBloco = function (t) { return conhecidos.indexOf(torreChave_(t)) >= 0; };
  const blocos = new Array(largura).fill(null);
  const mesclas = faixa.getMergedRanges();
  mesclas.forEach(function (m) {
    const ini = m.getColumn();
    const texto = String(textos[ini - 1] || '').trim();
    if (!ehBloco(texto)) return;
    for (let c = ini; c < ini + m.getNumColumns() && c <= largura; c++) blocos[c - 1] = texto;
  });
  if (!mesclas.length) {
    // sem mescla: o bloco vale da célula com o nome até a próxima célula preenchida
    let atual = null;
    for (let j = 0; j < largura; j++) {
      const t = String(textos[j] || '').trim();
      if (t) atual = ehBloco(t) ? t : null;
      blocos[j] = atual;
    }
  }
  for (let j = 0; j < largura; j++) {
    const t = String(textos[j] || '').trim();
    if (!blocos[j] && ehBloco(t)) blocos[j] = t;
  }
  return blocos;
}

// Link da célula: texto com link (inteiro ou em parte) ou fórmula =HYPERLINK("…")
function torreLink_(rico, formula) {
  if (rico) {
    const direto = rico.getLinkUrl();
    if (direto) return direto;
    const partes = rico.getRuns ? rico.getRuns() : [];
    for (let k = 0; k < partes.length; k++) {
      const u = partes[k].getLinkUrl();
      if (u) return u;
    }
  }
  const m = /^=\s*HYPERLINK\(\s*"([^"]+)"/i.exec(String(formula || ''));
  return m ? m[1] : null;
}

// "Última atualização: 29/10/2026 10:35" na própria célula, ou o valor à direita/abaixo
function torreUltimaAtualizacao_(grade) {
  for (let i = 0; i < grade.length; i++) {
    for (let j = 0; j < grade[i].length; j++) {
      const t = String(grade[i][j] || '').trim();
      if (torreChave_(t).indexOf('ULTIMAATUALIZACAO') !== 0) continue;
      const resto = t.replace(/^[^:]*?atualiza[çc][ãa]o\s*:?\s*/i, '').trim();
      if (/\d/.test(resto)) return resto;
      for (let k = j + 1; k < grade[i].length; k++) {
        const d = String(grade[i][k] || '').trim();
        if (d) return d;
      }
      if (grade[i + 1] && String(grade[i + 1][j] || '').trim()) return String(grade[i + 1][j]).trim();
    }
  }
  return null;
}

function torreChave_(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function torreLetra_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

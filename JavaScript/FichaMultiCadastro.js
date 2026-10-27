document.addEventListener('DOMContentLoaded', () => {
    const cardPJ = document.getElementById('card-pj');
    const cardPF = document.getElementById('card-pf');
    const formPJ = document.getElementById('form-pj');
    const formPF = document.getElementById('form-pf');

    function selectType(type) {
        if (type === 'pj') {
            cardPJ.classList.add('active');
            cardPF.classList.remove('active');
            formPJ.classList.remove('hidden');
            formPF.classList.add('hidden');
            formPJ.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (type === 'pf') {
            cardPF.classList.add('active');
            cardPJ.classList.remove('active');
            formPF.classList.remove('hidden');
            formPJ.classList.add('hidden');
            formPF.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    cardPJ.addEventListener('click', () => selectType('pj'));
    cardPF.addEventListener('click', () => selectType('pf'));

    cardPJ.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectType('pj');
        }
    });

    cardPF.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectType('pf');
        }
    });

    function applyMask(input, maskFn) {
        if (!input) return;
        input.addEventListener('input', (e) => {
            const cursorPosition = input.selectionStart;
            const prevLength = input.value.length;
            input.value = maskFn(input.value);
            const newLength = input.value.length;
            if (cursorPosition !== null && prevLength !== newLength) {
                const diff = newLength - prevLength;
                input.setSelectionRange(cursorPosition + diff, cursorPosition + diff);
            }
        });
    }

    function maskCNPJ(value) {
        return value
            .replace(/\D/g, '')
            .slice(0, 14)
            .replace(/^(\d{2})(\d)/, '$1.$2')
            .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
            .replace(/\.(\d{3})(\d)/, '.$1/$2')
            .replace(/(\d{4})(\d)/, '$1-$2');
    }

    function maskCPF(value) {
        return value
            .replace(/\D/g, '')
            .slice(0, 11)
            .replace(/^(\d{3})(\d)/, '$1.$2')
            .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
            .replace(/\.(\d{3})(\d)/, '.$1-$2');
    }

    function maskPhone(value) {
        const clean = value.replace(/\D/g, '').slice(0, 11);
        if (clean.length <= 10) {
            return clean
                .replace(/^(\d{2})(\d)/, '($1) $2')
                .replace(/(\d{4})(\d)/, '$1-$2');
        }
        return clean
            .replace(/^(\d{2})(\d)/, '($1) $2')
            .replace(/(\d{5})(\d)/, '$1-$2');
    }

    function bloquearNumeros(input) {
        if (!input) return;
        input.addEventListener('keydown', (e) => {
            if (e.key >= '0' && e.key <= '9') {
                e.preventDefault();
            }
        });
        input.addEventListener('input', () => {
            input.value = input.value.replace(/[0-9]/g, '');
        });
    }

    // (Os dados da CNH, do CRLV, do RNTRC e do endereço não são mais digitados: vêm no PDF anexado)
    // Celular do motorista: obrigatório, com DDD (10 ou 11 dígitos), a mesma regra da edge function
    function conferirCelular(input) {
        if (!input) return;
        const digitos = input.value.replace(/\D/g, '');
        input.setCustomValidity(digitos.length === 0 || (digitos.length >= 10 && digitos.length <= 11)
            ? '' : 'Informe o celular com DDD: 10 ou 11 números, ex.: (11) 96123-4567.');
    }

    ['pj', 'pf'].forEach((p) => {
        applyMask(document.getElementById(`${p}-cpf`), maskCPF);
        applyMask(document.getElementById(`${p}-celular`), maskPhone);
        document.getElementById(`${p}-celular`)?.addEventListener('input', (e) => conferirCelular(e.target));
        ['motorista-nome', 'motorista-sobrenome'].forEach((s) => bloquearNumeros(document.getElementById(`${p}-${s}`)));
    });
    // Rastreador: escolher "Outra" na lista limpa o campo para digitar o nome da marca
    ['pj', 'pf'].forEach((p) => {
        const marca = document.getElementById(`${p}-rastreador-marca`);
        marca?.addEventListener('input', () => {
            if (marca.value.trim().toLowerCase() !== 'outra') return;
            marca.value = '';
            marca.placeholder = 'Digite o nome da marca';
        });
    });
    applyMask(document.getElementById('pj-cnpj'), maskCNPJ);
    applyMask(document.getElementById('pj-telefone-empresa'), maskPhone);
    bloquearNumeros(document.getElementById('pj-responsavel'));

    // Arquivos de cada zona de anexo (input -> [{ arquivo, chave, preparando }]).
    // Cada escolha soma à lista; o input é zerado depois de cada escolha.
    const listasAnexo = new WeakMap();
    const itensDe = (input) => listasAnexo.get(input) || [];

    // Os documentos (CNH, CRLVs, RNTRC e comprovante) aceitam só PDF; só a zona marcada com
    // data-aceita="foto" aceita imagem
    const aceitaFoto = (input) => input?.dataset.aceita === 'foto';
    // Até 3 arquivos por documento; a zona pode pedir menos (data-max="1" na selfie)
    const maxDe = (input) => Number(input?.dataset.max) || MAX_ARQUIVOS;
    const docDaZona = (input) => input?.closest('.cartao-doc')?.dataset.doc || '';
    const MSG_SO_PDF = 'Envie o PDF do documento (baixe pelo app CNH Digital / CRLV Digital / ANTT). Foto não é aceita.';
    const MSG_SO_PDF_RESIDENCIA = 'Envie o comprovante em PDF (a conta em PDF baixada do app ou do site da empresa).';

    // Mesma checagem para "escolha os arquivos" e para arrastar e soltar (um arquivo por vez)
    function conferirArquivo(f, input) {
        if (aceitaFoto(input)) {
            if (!TIPOS_FOTO.includes(f.type)) return `O arquivo "${f.name}" não é uma foto JPG ou PNG.`;
            return null; // o tamanho da foto é conferido depois da redução
        }
        if (!TIPOS_PDF.includes(f.type)) return docDaZona(input) === 'residencia' ? MSG_SO_PDF_RESIDENCIA : MSG_SO_PDF;
        if (f.size > TAMANHO_MAX) return `O arquivo "${f.name}" passa de 10 MB.`;
        return null;
    }

    // Reduz a foto no navegador: lado maior com até 2000 px, JPEG 0,85.
    // O <img> já aplica a orientação da câmera (EXIF) antes de ir para o canvas.
    function reduzirFoto(arquivo) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(arquivo);
            const img = new Image();
            const fim = (erro, foto) => {
                URL.revokeObjectURL(url);
                if (erro) reject(erro);
                else resolve(foto);
            };
            img.onload = () => {
                try {
                    const escala = Math.min(1, LADO_MAX_FOTO / Math.max(img.naturalWidth, img.naturalHeight));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(img.naturalWidth * escala));
                    canvas.height = Math.max(1, Math.round(img.naturalHeight * escala));
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#fff'; // fundo branco para PNG com transparência
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    canvas.toBlob((blob) => {
                        if (!blob) return fim(new Error('canvas_vazio'));
                        const nome = `${arquivo.name.replace(/\.[^.]*$/, '') || 'foto'}.jpg`;
                        fim(null, new File([blob], nome, { type: 'image/jpeg', lastModified: Date.now() }));
                    }, 'image/jpeg', QUALIDADE_FOTO);
                } catch (err) {
                    fim(err);
                }
            };
            img.onerror = () => fim(new Error('imagem_ilegivel'));
            img.src = url;
        });
    }

    // "processando" na zona enquanto alguma foto da lista ainda está sendo reduzida
    function marcarProcessando(input) {
        const zone = input.closest('.upload-dropzone');
        if (!zone) return;
        if (itensDe(input).some((item) => item.preparando)) zone.dataset.processando = '1';
        else delete zone.dataset.processando;
    }

    // Troca as fotos novas pelas versões reduzidas. Se a redução falhar,
    // segue a original, desde que tenha até 10 MB.
    async function prepararFotos(input, itens) {
        const recusadas = [];
        for (const item of itens) {
            try {
                item.arquivo = await reduzirFoto(item.arquivo);
            } catch (err) {
                console.warn('Foto não reduzida; usando a original:', err && err.message);
                if (item.arquivo.size > TAMANHO_MAX) {
                    recusadas.push(item.arquivo.name);
                    listasAnexo.set(input, itensDe(input).filter((x) => x !== item));
                }
            }
            item.preparando = false;
            // A lista pode ter sido limpa ou mudado no meio: só redesenha a atual
            marcarProcessando(input);
            renderFileList(input, input.closest('.upload-dropzone')?.querySelector('.file-preview-list'));
        }
        if (recusadas.length) alert(`Não foi possível usar a foto "${recusadas.join('", "')}": passa de 10 MB. Tente outra foto.`);
    }

    // Soma os arquivos escolhidos (ou soltos) à lista da zona.
    // Repetido (mesmo nome e tamanho) é ignorado; tipo errado e o que passar de 3 são recusados.
    function adicionarArquivos(input, novos) {
        if (input.disabled) return;
        const itens = itensDe(input);
        const avisos = [];
        const fotos = [];
        let passou = false;
        for (const f of Array.from(novos || [])) {
            const chave = `${f.name}|${f.size}`;
            if (itens.some((item) => item.chave === chave)) continue;
            const problema = conferirArquivo(f, input);
            if (problema) {
                avisos.push(problema);
                continue;
            }
            const max = maxDe(input);
            // Zona de 1 arquivo (selfie): a foto nova troca a anterior
            if (max === 1 && itens.length) {
                itens.length = 0;
                fotos.length = 0;
            }
            if (itens.length >= max) {
                passou = true;
                continue;
            }
            const item = { arquivo: f, chave, preparando: TIPOS_FOTO.includes(f.type) };
            itens.push(item);
            if (item.preparando) fotos.push(item);
        }
        if (passou) avisos.push(`Este documento aceita no máximo ${MAX_ARQUIVOS} arquivos. Remova um para adicionar outro.`);
        listasAnexo.set(input, itens);
        input.value = '';
        marcarProcessando(input);
        renderFileList(input, input.closest('.upload-dropzone')?.querySelector('.file-preview-list'));
        if (avisos.length) alert([...new Set(avisos)].join('\n')); // a mesma mensagem aparece uma vez só
        if (fotos.length) prepararFotos(input, fotos);
    }

    // Busca o input e a prévia dentro da própria zona: funciona também com
    // cartões criados pelo JS que ainda não entraram na página (CRLVs).
    function ligarDropzone(zone) {
        if (!zone || zone.dataset.ligada === '1') return;
        const input = zone.querySelector('input[type="file"]');
        const previewList = zone.querySelector('.file-preview-list');

        if (!input) return;
        zone.dataset.ligada = '1';

        zone.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'LABEL') {
                input.click();
            }
        });

        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });

        zone.addEventListener('dragleave', () => {
            zone.classList.remove('dragover');
        });

        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            const arquivos = e.dataTransfer && e.dataTransfer.files;
            if (!arquivos || arquivos.length === 0 || input.disabled) return;
            adicionarArquivos(input, arquivos);
            // Avisa o cartão (o aviso de erro do bloco some quando ele muda)
            zone.dispatchEvent(new Event('change', { bubbles: true }));
        });

        input.addEventListener('change', () => {
            if (input.files && input.files.length > 0) adicionarArquivos(input, input.files);
        });
    }

    function limparArquivos(input) {
        if (!input) return;
        input.value = '';
        listasAnexo.set(input, []);
        delete input.closest('.upload-dropzone')?.dataset.processando;
        renderFileList(input, input.closest('.upload-dropzone')?.querySelector('.file-preview-list'));
    }

    document.querySelectorAll('.upload-dropzone').forEach((zone) => ligarDropzone(zone));

    // Selfie: o botão abre a câmera da frente (capture="user"); a zona continua aceitando
    // a foto da galeria. As duas vão para a mesma lista (1 foto).
    document.querySelectorAll('.btn-tirar-selfie').forEach((btn) => {
        const destino = document.getElementById(btn.dataset.selfieDe);
        const camera = btn.parentElement.querySelector('input[capture]');
        if (!destino || !camera) return;
        btn.addEventListener('click', () => camera.click());
        camera.addEventListener('change', () => {
            if (camera.files && camera.files.length) adicionarArquivos(destino, camera.files);
            camera.value = '';
        });
    });

    // Arquivo solto fora de uma zona não abre no navegador
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    function renderFileList(input, container) {
        if (!container) return;
        (container.miniaturas || []).forEach((url) => URL.revokeObjectURL(url));
        container.miniaturas = [];
        container.innerHTML = '';
        itensDe(input).forEach((registro) => {
            const file = registro.arquivo;
            const item = document.createElement('span');
            item.className = 'file-preview-item';
            const sizeKb = (file.size / 1024).toFixed(0);
            // Foto ainda sendo reduzida fica sem miniatura até ficar pronta
            if (file.type.startsWith('image/') && !registro.preparando) {
                const miniatura = document.createElement('img');
                miniatura.className = 'file-preview-miniatura';
                miniatura.alt = '';
                miniatura.src = URL.createObjectURL(file);
                container.miniaturas.push(miniatura.src);
                item.appendChild(miniatura);
            } else if (!file.type.startsWith('image/')) {
                const icone = document.createElement('span');
                icone.className = 'file-preview-icone';
                icone.setAttribute('aria-hidden', 'true');
                icone.textContent = 'PDF';
                item.appendChild(icone);
            }
            const nome = document.createElement('span');
            nome.className = 'file-preview-nome';
            nome.textContent = registro.preparando ? `${file.name}: Preparando a foto...` : `${file.name} (${sizeKb} KB)`;
            item.appendChild(nome);
            const remover = document.createElement('button');
            remover.type = 'button';
            remover.className = 'file-preview-remover';
            remover.setAttribute('aria-label', `Remover ${file.name}`);
            remover.textContent = '✕';
            remover.addEventListener('click', (e) => {
                e.stopPropagation(); // não abre o seletor de arquivos da zona
                listasAnexo.set(input, itensDe(input).filter((x) => x !== registro));
                marcarProcessando(input);
                renderFileList(input, container);
            });
            item.appendChild(remover);
            container.appendChild(item);
        });
    }

    // =========================================================================
    // CADASTRO NO SUPABASE (edge function "solicitar-cadastro")
    //
    // Cada documento (CNH, um CRLV por veículo da tipologia e RNTRC) vai em PDF, baixado
    // pelo app do documento; o comprovante de residência é opcional (também em PDF). Os
    // dados dos documentos não são digitados: o PDF já tem tudo. O cadastro nasce PENDENTE.
    // =========================================================================

    // Tipo de veículo -> veículos (um CRLV por veículo, na ordem; o mesmo da edge function)
    const TIPOLOGIAS = {
        'VUC/¾': ['Caminhão'],
        'Toco (4×2)': ['Caminhão'],
        'Truck (6×2)': ['Caminhão'],
        'Bitruck (8×2)': ['Caminhão'],
        'Cavalo 4×2': ['Cavalo', 'Carreta'],
        'Cavalo 6×2': ['Cavalo', 'Carreta'],
        'Cavalo 6×4': ['Cavalo', 'Carreta'],
        'Carreta simples (2e)': ['Cavalo', 'Carreta'],
        'Carreta LS 3e': ['Cavalo', 'Carreta'],
        'Romeu e Julieta': ['Caminhão', 'Reboque'],
        'Bitrem': ['Cavalo', '1ª carreta', '2ª carreta'],
        'Rodotrem': ['Cavalo', '1ª carreta', '2ª carreta'],
        'Treminhão/Tritrem': ['Caminhão', '1º reboque', '2º reboque', '3º reboque']
    };
    const CAMPOS_ACESSO = ['motorista-nome', 'motorista-sobrenome', 'cpf', 'celular'];
    const CAMPOS_EMPRESA = ['nome-empresa', 'cnpj', 'telefone-empresa', 'responsavel'];
    // Rastreador do veículo (PF e PJ), obrigatório
    const CAMPOS_RASTREADOR = ['rastreador-marca', 'rastreador-id'];
    const MAX_ARQUIVOS = 3;
    // Documentos: só PDF, até 3 por documento. Foto (JPG/PNG) só onde a zona aceita foto.
    const TIPOS_PDF = ['application/pdf'];
    const TIPOS_FOTO = ['image/png', 'image/jpeg'];
    const TAMANHO_MAX = 10 * 1024 * 1024;
    const LADO_MAX_FOTO = 2000;
    const QUALIDADE_FOTO = 0.85;
    // Data da "Última atualização" da Política de Privacidade (HTML/politica-privacidade.html)
    const VERSAO_POLITICA = '2026-10-19';

    // "CRLV do Cavalo", "CRLV da 1ª carreta"
    const nomeCrlv = (papel) => `CRLV ${/carreta$/i.test(papel) ? 'da' : 'do'} ${papel}`;

    function esc(v) {
        return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
        }[c]));
    }

    function campo(prefixo, sufixo) {
        return document.getElementById(`${prefixo}-${sufixo}`);
    }

    function papeisDe(prefixo) {
        return TIPOLOGIAS[campo(prefixo, 'tipologia')?.value] || [];
    }

    // Documentos do envio, na ordem da tela: [{ doc, titulo, obrigatorio }]
    function documentosDe(prefixo) {
        return [
            { doc: 'cnh', titulo: 'CNH', obrigatorio: true },
            { doc: 'selfie', titulo: 'Selfie segurando a CNH', obrigatorio: true },
            ...papeisDe(prefixo).map((papel, i) => ({ doc: `crlv_${i + 1}`, titulo: nomeCrlv(papel), obrigatorio: true })),
            { doc: 'rntrc', titulo: 'RNTRC', obrigatorio: true },
            { doc: 'residencia', titulo: 'Comprovante de residência', obrigatorio: false }
        ];
    }

    const cartaoDe = (prefixo, doc) => campo(prefixo, 'docs')?.querySelector(`.cartao-doc[data-doc="${doc}"]`);
    const anexoDe = (prefixo, doc) => campo(prefixo, `anexo-${doc.replace('_', '-')}`);
    // Lista da zona (não o input.files, que é zerado a cada escolha)
    const listaDe = (el) => (el ? itensDe(el).map((item) => item.arquivo) : []);
    const arquivosDe = (prefixo, doc) => listaDe(anexoDe(prefixo, doc));

    // ---------- Cartões de CRLV (um por veículo da tipologia) ----------
    function criarCartaoCrlv(prefixo, n, papel) {
        const anexo = `${prefixo}-anexo-crlv-${n}`;
        const cartao = document.createElement('div');
        cartao.className = 'cartao-doc';
        cartao.dataset.doc = `crlv_${n}`;
        cartao.dataset.papel = papel;
        cartao.innerHTML = `
            <div class="cartao-doc-topo">
                <h4 class="cartao-doc-titulo">${esc(nomeCrlv(papel))}</h4>
                <span class="etiqueta-doc etiqueta-obrigatorio">Obrigatório</span>
            </div>
            <div class="cartao-doc-anexo">
                <div class="upload-dropzone" data-target="${anexo}">
                    <div class="upload-inner-card">
                        <svg class="upload-icon" viewBox="0 0 24 24" width="28" height="28" fill="none"
                            stroke="#64748b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <span class="upload-text"><span class="upload-texto-mouse">Arraste aqui ou <label for="${anexo}"
                                class="upload-action-link">escolha os arquivos</label></span><span class="upload-texto-toque">Toque para escolher o PDF</span></span>
                        <span class="upload-subtext">Somente PDF. Baixe pelo app do documento.</span>
                        <input type="file" id="${anexo}" class="file-input-hidden" multiple accept="application/pdf,.pdf">
                    </div>
                    <div class="file-preview-list" id="preview-${anexo}"></div>
                </div>
            </div>`;
        ligarDropzone(cartao.querySelector('.upload-dropzone'));
        return cartao;
    }

    function cartaoPreenchido(cartao) {
        return !!cartao && listaDe(cartao.querySelector('input[type="file"]')).length > 0;
    }

    // Recria os cartões de CRLV para a tipologia escolhida. Os cartões que
    // continuam iguais (mesma posição e mesmo veículo) são mantidos.
    // Devolve false se o motorista desistir da troca.
    function montarCrlvs(prefixo) {
        const lista = campo(prefixo, 'crlvs');
        if (!lista) return true;
        const papeis = papeisDe(prefixo);
        const atuais = Array.from(lista.querySelectorAll('.cartao-doc'));
        const sairao = atuais.filter((c, i) => c.dataset.papel !== papeis[i]);
        if (sairao.some(cartaoPreenchido)) {
            const nomes = sairao.filter(cartaoPreenchido).map((c) => nomeCrlv(c.dataset.papel)).join(', ');
            if (!confirm(`Trocar o tipo de veículo apaga o que você já informou em: ${nomes}. Deseja continuar?`)) return false;
        }
        sairao.forEach((c) => c.remove());
        papeis.forEach((papel, i) => {
            const existente = lista.querySelector(`.cartao-doc[data-doc="crlv_${i + 1}"]`);
            if (existente) return;
            const novo = criarCartaoCrlv(prefixo, i + 1, papel);
            const proximo = Array.from(lista.children).find((c) => Number(c.dataset.doc.slice(5)) > i + 1);
            lista.insertBefore(novo, proximo || null);
        });
        return true;
    }

    // ---------- Lista de documentos: aparece depois de escolher o tipo de veículo ----------
    function atualizarDocs(prefixo) {
        const temTipologia = papeisDe(prefixo).length > 0;
        const aviso = campo(prefixo, 'aviso-tipologia');
        const listaDocs = campo(prefixo, 'docs');
        if (aviso) aviso.hidden = temTipologia;
        if (listaDocs) listaDocs.hidden = !temTipologia;
    }

    function montarModais() {
        const wrap = document.createElement('div');
        wrap.innerHTML = `
            <div class="modal-cadastro" id="modal-revisar-cadastro" role="dialog" aria-modal="true" aria-labelledby="titulo-revisar">
                <div class="modal-cadastro-caixa">
                    <h3 id="titulo-revisar">Revise antes de enviar</h3>
                    <p>Confira se todos os dados e documentos estão corretos. Depois de enviado, o cadastro vai para
                        análise da gestão.</p>
                    <div class="resumo-cadastro" id="resumo-cadastro"></div>
                    <div class="modal-cadastro-botoes">
                        <button type="button" class="btn-modal-sec" id="btn-voltar-revisar">Voltar e revisar</button>
                        <button type="button" class="btn-modal-pri" id="btn-confirmar-envio">Confirmar e enviar</button>
                    </div>
                </div>
            </div>
            <div class="modal-cadastro" id="modal-sucesso-cadastro" role="dialog" aria-modal="true" aria-labelledby="titulo-sucesso">
                <div class="modal-cadastro-caixa">
                    <div class="icone-sucesso">✓</div>
                    <h3 id="titulo-sucesso">Cadastro enviado!</h3>
                    <p id="texto-sucesso-cadastro">Cadastro enviado! O time de Cadastros da AJBorges vai conferir seus documentos e entrar em contato pelo celular informado.</p>
                    <div class="modal-cadastro-botoes">
                        <a class="btn-modal-pri" href="index.html">Página principal</a>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(wrap);
        const revisar = document.getElementById('modal-revisar-cadastro');
        const fechar = () => revisar.classList.remove('ativo');
        document.getElementById('btn-voltar-revisar').addEventListener('click', fechar);
        revisar.addEventListener('click', (e) => { if (e.target === revisar) fechar(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
    }

    // Primeiro problema nos anexos: { msg, doc } (doc = cartão onde mostrar o aviso)
    function validarArquivos(prefixo) {
        for (const d of documentosDe(prefixo)) {
            const msg = problemaArquivosDoc(prefixo, d);
            if (msg) return { msg, doc: d.doc };
        }
        return null;
    }

    function problemaArquivosDoc(prefixo, { doc, titulo, obrigatorio }) {
        const artigo = doc === 'cnh' ? 'a' : 'o';
        const input = anexoDe(prefixo, doc);
        if (input?.closest('.upload-dropzone')?.dataset.processando) {
            return 'Aguarde: as fotos ainda estão sendo preparadas.';
        }
        const arquivos = arquivosDe(prefixo, doc);
        if (obrigatorio && arquivos.length === 0) {
            return aceitaFoto(input) ? 'Anexe a selfie segurando a CNH ao lado do rosto.' : `Anexe o PDF ${artigo === 'a' ? 'da' : 'do'} ${titulo}.`;
        }
        if (aceitaFoto(input) && arquivos.length > maxDe(input)) return 'Envie só 1 foto: a selfie segurando a CNH.';
        if (arquivos.length > maxDe(input)) return `Envie no máximo ${maxDe(input)} arquivo(s) para ${artigo} ${titulo}.`;
        for (const f of arquivos) {
            const problema = conferirArquivo(f, input);
            if (problema) return problema;
            if (f.size > TAMANHO_MAX) return `O arquivo "${f.name}" passa de 10 MB.`;
        }
        return null;
    }

    function montarEnvio(prefixo) {
        const docs = documentosDe(prefixo);
        // Dados de acesso, da empresa e do rastreador: os dos documentos vêm no PDF
        const chaves = [...CAMPOS_ACESSO, ...(prefixo === 'pj' ? CAMPOS_EMPRESA : []), ...CAMPOS_RASTREADOR];
        const dados = {};
        chaves.forEach((s) => {
            const el = campo(prefixo, s);
            if (el && !el.disabled && el.value.trim()) dados[s] = el.value.trim();
        });
        const documentos = {};
        const arquivos = [];
        docs.forEach(({ doc }) => {
            const lista = arquivosDe(prefixo, doc);
            if (lista.length === 0) return; // comprovante de residência é opcional
            documentos[doc] = lista.map((f) => ({ nome: f.name, tipo: f.type, tamanho: f.size }));
            arquivos.push(...lista); // mesma ordem que o servidor usa em "indice"
        });
        return {
            corpo: {
                tipo: prefixo,
                tipologia: campo(prefixo, 'tipologia')?.value || '',
                email: (campo(prefixo, 'email')?.value || '').trim().toLowerCase() || null,
                dados,
                documentos,
                aceite_lgpd: campo(prefixo, 'aceite-lgpd')?.checked === true,
                versao_politica: VERSAO_POLITICA
            },
            arquivos
        };
    }

    // Aviso dentro do cartão do documento (ou da caixa de aceite), com a tela rolando até ele.
    // Some quando o motorista mexe naquele bloco.
    function avisarNoBloco(bloco, msg) {
        if (!bloco) return mostrarErro(msg);
        let aviso = bloco.querySelector(':scope > .aviso-bloco');
        if (!aviso) {
            aviso = document.createElement('p');
            aviso.className = 'aviso-bloco';
            aviso.setAttribute('role', 'alert');
            bloco.prepend(aviso);
            const limpar = () => { aviso.remove(); bloco.removeEventListener('change', limpar); };
            bloco.addEventListener('change', limpar);
        }
        aviso.textContent = msg;
        bloco.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function mostrarErro(msg, lista) {
        const extra = Array.isArray(lista) && lista.length ? `\n\nFaltando: ${lista.join(', ')}.` : '';
        alert(msg + extra);
    }

    async function enviarArquivo(caminho, token, arquivo) {
        for (let tentativa = 1; tentativa <= 3; tentativa++) {
            const { error } = await window.supabaseClient.storage
                .from('documentos-cadastro')
                .uploadToSignedUrl(caminho, token, arquivo, { contentType: arquivo.type });
            if (!error) return true;
            console.warn(`Falha no envio de ${arquivo.name} (tentativa ${tentativa}):`, error);
        }
        return false;
    }

    let envioEmAndamento = null;

    function prepararFormulario(form, prefixo) {
        if (!form) return;

        const select = campo(prefixo, 'tipologia');
        let tipologiaAnterior = select ? select.value : '';
        select?.addEventListener('change', () => {
            if (!montarCrlvs(prefixo)) {
                select.value = tipologiaAnterior;
                return;
            }
            tipologiaAnterior = select.value;
            atualizarDocs(prefixo);
        });
        montarCrlvs(prefixo);
        atualizarDocs(prefixo);

        // Enter num campo não envia o cadastro
        form.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.type !== 'submit') {
                e.preventDefault();
            }
        });

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            atualizarDocs(prefixo);
            conferirCelular(campo(prefixo, 'celular'));
            if (!form.reportValidity()) return;

            const problemaArquivo = validarArquivos(prefixo);
            if (problemaArquivo) return avisarNoBloco(cartaoDe(prefixo, problemaArquivo.doc), problemaArquivo.msg);

            const aceite = campo(prefixo, 'aceite-lgpd');
            if (!aceite?.checked) {
                avisarNoBloco(aceite?.closest('.aceite-lgpd-row'), 'Para enviar, marque que leu e concorda com a Política de Privacidade.');
                aceite?.focus({ preventScroll: true });
                return;
            }

            const { corpo } = montarEnvio(prefixo);
            const situacao = ({ doc, obrigatorio }) => {
                const lista = corpo.documentos[doc] || [];
                if (!lista.length) return obrigatorio ? 'Não anexado' : 'Não enviado (opcional)';
                const fotos = lista.filter((f) => TIPOS_FOTO.includes(f.tipo)).length;
                const pdfs = lista.length - fotos;
                const partes = [];
                if (fotos) partes.push(`${fotos} ${fotos === 1 ? 'foto' : 'fotos'}`);
                if (pdfs) partes.push(`${pdfs} ${pdfs === 1 ? 'PDF' : 'PDFs'}`);
                return `Anexado: ${partes.join(' + ')}`;
            };
            const nome = `${corpo.dados['motorista-nome'] || ''} ${corpo.dados['motorista-sobrenome'] || ''}`.trim();
            document.getElementById('resumo-cadastro').innerHTML = `
                <div>Tipo: <b>${prefixo === 'pj' ? 'Pessoa Jurídica' : 'Pessoa Física'}</b> · Veículo: <b>${esc(corpo.tipologia)}</b></div>
                <div>Motorista: <b>${esc(nome)}</b> · CPF <b>${esc(corpo.dados.cpf || '')}</b></div>
                <div>E-mail: <b>${esc(corpo.email || 'Não informado')}</b></div>
                <div>Rastreador: <b>${esc(corpo.dados['rastreador-marca'] || '')}</b> · ID <b>${esc(corpo.dados['rastreador-id'] || '')}</b></div>
                ${documentosDe(prefixo).map((d) => `<div>${esc(d.titulo)}: <b>${situacao(d)}</b></div>`).join('')}
                <div>Política de Privacidade: <b>aceita</b></div>`;
            envioEmAndamento = { form, prefixo };
            document.getElementById('modal-revisar-cadastro').classList.add('ativo');
        });
    }

    async function confirmarEnvio() {
        if (!envioEmAndamento) return;
        const { form, prefixo } = envioEmAndamento;
        const btn = document.getElementById('btn-confirmar-envio');
        const textoOriginal = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Enviando...';
        const restaurar = () => { btn.disabled = false; btn.textContent = textoOriginal; };

        try {
            const { corpo, arquivos } = montarEnvio(prefixo);
            const r = await window.solicitarCadastroAgregado(corpo);
            if (!r.sucesso) {
                restaurar();
                document.getElementById('modal-revisar-cadastro').classList.remove('ativo');
                return mostrarErro(r.erro, r.faltando);
            }

            btn.textContent = 'Enviando documentos...';
            let falhas = 0;
            for (const up of r.uploads || []) {
                const arquivo = arquivos[up.indice];
                if (!arquivo || !(await enviarArquivo(up.path, up.token, arquivo))) falhas++;
            }

            document.getElementById('modal-revisar-cadastro').classList.remove('ativo');
            if (falhas > 0) {
                document.getElementById('texto-sucesso-cadastro').textContent =
                    `Seu cadastro foi registrado, mas ${falhas} documento(s) não puderam ser enviados. ` +
                    'Entre em contato com a gestão da AJBorges para completar o envio.';
            }
            form.reset();
            form.querySelectorAll('.upload-dropzone input[type="file"]').forEach(limparArquivos);
            form.querySelectorAll('.file-preview-list').forEach((c) => { c.innerHTML = ''; });
            campo(prefixo, 'crlvs').innerHTML = '';
            atualizarDocs(prefixo);
            document.getElementById('modal-sucesso-cadastro').classList.add('ativo');
        } catch (err) {
            console.error('Erro ao enviar cadastro:', err);
            mostrarErro('Não foi possível conectar ao servidor. Verifique a internet e tente novamente.');
        } finally {
            restaurar();
            envioEmAndamento = null;
        }
    }

    montarModais();
    document.getElementById('btn-confirmar-envio').addEventListener('click', confirmarEnvio);
    prepararFormulario(formPJ, 'pj');
    prepararFormulario(formPF, 'pf');
});

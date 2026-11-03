/**
 * ==========================================================================
 * AJBorges - Rodapé da barra lateral padrão (Frota, Cadastro, Torre, RH)
 *
 * Preenche avatar (iniciais), e-mail e selo do perfil com o usuário que o
 * auth.js validou no servidor, e liga o botão "Sair" (#btn-logout) ao mesmo
 * logout da Frota: confirma e chama ajbAuth.sair (encerra a sessão no
 * Supabase e apaga os dados guardados neste navegador).
 * Só textContent: nada vindo do login vira HTML.
 *
 * Uso, depois do auth.js:  window.ajbSidebar.iniciar(usuarioDaSessao)
 * ==========================================================================
 */
(function () {
    const DESTINO_SAIR = '/HTML/Login.html#admin';
    const ROTULOS_PAPEL = {
        admin: 'ADMINISTRADOR',
        diretoria: 'DIRETORIA',
        rh: 'RECURSOS HUMANOS',
        rh_restrito: 'RH (CONSULTA)'
    };

    function usuarioDoCache() {
        try {
            return JSON.parse(localStorage.getItem('ajborges_usuario_ativo') || 'null') || {};
        } catch (e) {
            return {};
        }
    }

    // Iniciais: primeira letra do primeiro e do último nome; sem nome, 2 primeiras letras do e-mail
    function iniciais(nome, email) {
        const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
        if (partes.length >= 2) return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
        if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
        return String(email || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
    }

    function rotuloPapel(role) {
        return ROTULOS_PAPEL[role] || String(role || 'USUÁRIO').toUpperCase();
    }

    function preencherUsuario(usuario) {
        const u = usuario || usuarioDoCache();
        const elAvatar = document.getElementById('user-avatar-initials');
        const elEmail = document.getElementById('sidebar-user-email');
        const elPapel = document.getElementById('sidebar-user-role');
        const elSelo = document.getElementById('sidebar-user-badge');
        const email = u.email || '';

        if (elAvatar) elAvatar.textContent = iniciais(u.nome, email);
        if (elEmail) {
            elEmail.textContent = email;
            elEmail.title = u.nome ? `${u.nome} • ${email}` : email;
        }
        if (elPapel) elPapel.textContent = rotuloPapel(u.role);
        if (elSelo) elSelo.title = `${email} • ${rotuloPapel(u.role)}`;
    }

    function sair() {
        if (confirm('Deseja realmente encerrar a sessão?')) {
            window.ajbAuth.sair(DESTINO_SAIR);
        }
    }

    function iniciar(usuario) {
        preencherUsuario(usuario);
        const btn = document.getElementById('btn-logout');
        if (btn && !btn.hasAttribute('data-sair-ligado')) {
            btn.setAttribute('data-sair-ligado', '');
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                sair();
            });
        }
    }

    window.ajbSidebar = { iniciar, preencherUsuario, sair, rotuloPapel, iniciais };
})();

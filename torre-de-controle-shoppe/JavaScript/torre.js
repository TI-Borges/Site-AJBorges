/**
 * ==========================================================================
 * AJBorges - Torre de Controle - Shoppe (em construção)
 * Mesmo controle de sessão das páginas de gestão (JavaScript/auth.js).
 * ==========================================================================
 */
const TORRE_LOGIN = '/HTML/Login.html#admin';

ajbAoAutenticar(['admin', 'diretoria'], TORRE_LOGIN, () => {
    window.ajbAuth.vigiarSessao(TORRE_LOGIN);

    const sair = document.getElementById('torre-sair');
    if (sair) {
        sair.addEventListener('click', (e) => {
            e.preventDefault();
            window.ajbAuth.sair(TORRE_LOGIN);
        });
    }
});

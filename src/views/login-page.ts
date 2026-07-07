import type { Context } from 'hono'
import { baseLayout } from './layout'

export function renderLoginPage(c: Context) {
  const body = `
  <div id="login-root" class="min-h-screen flex items-center justify-center px-4">
    <div class="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-600 text-white text-2xl mb-4">
          <i class="fas fa-hand-holding-heart"></i>
        </div>
        <h1 class="text-2xl font-bold text-gray-800">NFP Gestão</h1>
        <p class="text-gray-500 text-sm mt-1">Sistema de Arrecadação · Nota Fiscal Paulista</p>
      </div>

      <form id="login-form" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1" for="email">E-mail</label>
          <input id="email" name="email" type="email" required autocomplete="username"
                 class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                 placeholder="seu@email.com" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1" for="senha">Senha</label>
          <input id="senha" name="senha" type="password" required autocomplete="current-password"
                 class="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                 placeholder="••••••••" />
        </div>

        <div id="login-error" class="hidden text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2"></div>

        <button type="submit" id="login-btn"
                class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 rounded-lg transition flex items-center justify-center gap-2">
          <i class="fas fa-right-to-bracket"></i>
          <span>Entrar</span>
        </button>
      </form>

      <p class="text-center text-xs text-gray-400 mt-6">
        Acesso restrito a Administradores, Coordenadores e Articuladores cadastrados.
      </p>
    </div>
  </div>`

  const scripts = `
  <script>
    const form = document.getElementById('login-form');
    const errorBox = document.getElementById('login-error');
    const btn = document.getElementById('login-btn');

    // Se já houver sessão válida, redireciona direto
    axios.get('/api/auth/me').then(() => { window.location.href = '/dashboard'; }).catch(() => {});

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.classList.add('hidden');
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Entrando...</span>';
      try {
        const email = document.getElementById('email').value;
        const senha = document.getElementById('senha').value;
        await axios.post('/api/auth/login', { email, senha });
        window.location.href = '/dashboard';
      } catch (err) {
        errorBox.textContent = err.response?.data?.error || 'Erro ao tentar fazer login.';
        errorBox.classList.remove('hidden');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-right-to-bracket"></i> <span>Entrar</span>';
      }
    });
  </script>`

  return c.html(baseLayout({ title: 'Login', bodyContent: body, bodyScripts: scripts }))
}

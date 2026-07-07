import type { Context } from 'hono'
import { baseLayout } from './layout'

export function renderLoginPage(c: Context) {
  const body = `
  <div id="login-root" class="min-h-screen flex">
    <!-- Lado esquerdo: branding (some em telas pequenas) -->
    <div class="hidden lg:flex lg:w-1/2 brand-gradient text-white flex-col justify-between p-12 relative overflow-hidden">
      <div class="absolute -top-24 -right-24 w-96 h-96 rounded-full bg-white/10"></div>
      <div class="absolute -bottom-32 -left-10 w-80 h-80 rounded-full bg-white/10"></div>

      <div class="relative z-10 flex items-center gap-3">
        <div class="w-11 h-11 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center text-xl">
          <i class="fas fa-people-roof"></i>
        </div>
        <span class="text-xl font-bold tracking-tight">Gestão Social</span>
      </div>

      <div class="relative z-10 max-w-md">
        <h2 class="text-3xl font-extrabold leading-tight mb-4">Transparência e organização para sua rede de núcleos e projetos sociais.</h2>
        <p class="text-white/80 text-sm leading-relaxed">Controle financeiro rastreável, aprovação de repasses, comprovantes obrigatórios e comunicação com colaboradores — tudo em um só lugar.</p>
        <div class="mt-8 space-y-3 text-sm">
          <div class="flex items-center gap-3"><i class="fas fa-circle-check text-emerald-200"></i> Ledger financeiro imutável e auditável</div>
          <div class="flex items-center gap-3"><i class="fas fa-circle-check text-emerald-200"></i> Painéis Geral, Núcleo e Projeto</div>
          <div class="flex items-center gap-3"><i class="fas fa-circle-check text-emerald-200"></i> Páginas públicas para captar colaboradores</div>
        </div>
      </div>

      <p class="relative z-10 text-xs text-white/60">© ${new Date().getFullYear()} Gestão Social · Programa Nota Fiscal Paulista</p>
    </div>

    <!-- Lado direito: formulário -->
    <div class="flex-1 flex items-center justify-center px-4 py-10 bg-gray-50">
      <div class="w-full max-w-md">
        <div class="text-center lg:text-left mb-8">
          <div class="inline-flex lg:hidden items-center justify-center w-14 h-14 rounded-2xl brand-gradient text-white text-2xl mb-4 shadow-soft">
            <i class="fas fa-people-roof"></i>
          </div>
          <h1 class="text-2xl font-extrabold text-gray-900">Bem-vindo(a) de volta</h1>
          <p class="text-gray-500 text-sm mt-1">Entre para acessar o painel do <span class="font-semibold brand-gradient-text">Gestão Social</span></p>
        </div>

        <div class="gs-card p-8">
          <form id="login-form" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1" for="email">E-mail</label>
              <div class="relative">
                <i class="fas fa-envelope absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
                <input id="email" name="email" type="email" required autocomplete="username"
                       class="w-full pl-9 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                       placeholder="seu@email.com" />
              </div>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1" for="senha">Senha</label>
              <div class="relative">
                <i class="fas fa-lock absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm"></i>
                <input id="senha" name="senha" type="password" required autocomplete="current-password"
                       class="w-full pl-9 pr-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"
                       placeholder="••••••••" />
              </div>
            </div>

            <div id="login-error" class="hidden text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2"></div>

            <button type="submit" id="login-btn"
                    class="w-full brand-gradient text-white font-semibold py-2.5 rounded-lg transition flex items-center justify-center gap-2 hover:opacity-90 shadow-soft">
              <i class="fas fa-right-to-bracket"></i>
              <span>Entrar</span>
            </button>
          </form>
        </div>

        <p class="text-center text-xs text-gray-400 mt-6">
          Acesso restrito a Administradores, Coordenadores e Articuladores cadastrados.
        </p>
      </div>
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

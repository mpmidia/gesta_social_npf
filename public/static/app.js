// ============================================================
// Gestão Social - Frontend SPA leve (Vanilla JS + Axios + Tailwind CDN)
// ============================================================

axios.defaults.withCredentials = true;

let CURRENT_USER = null;

const ROLE_LABELS = {
  admin: 'Administrador',
  coord_geral: 'Coordenador Geral',
  coord_nucleo: 'Coordenador de Núcleo',
  articulador: 'Articulador'
};

function hasRole(role) {
  return CURRENT_USER?.roles?.some(r => r.role === role);
}
function isGlobal() {
  return hasRole('admin') || hasRole('coord_geral');
}
function isAdmin() {
  return hasRole('admin');
}
function isCoordNucleo() {
  return hasRole('coord_nucleo');
}
function isArticulador() {
  return hasRole('articulador');
}
function scopedNucleoIds() {
  return (CURRENT_USER?.roles || []).filter(r => r.role === 'coord_nucleo').map(r => r.escopo_id);
}
// Pode gerir (lançar saída/gerir recursos) os recursos de um determinado núcleo:
// Admin sempre pode; Coordenador de Núcleo somente do seu próprio escopo.
function canManageNucleoFinance(nucleoId) {
  return isAdmin() || scopedNucleoIds().includes(Number(nucleoId));
}

function fmtMoney(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function fmtDate(d) {
  return d ? dayjs(d).format('DD/MM/YYYY HH:mm') : '-';
}
function statusBadge(status) {
  const map = {
    pendente: 'bg-amber-100 text-amber-700',
    aprovado: 'bg-blue-100 text-blue-700',
    executado: 'bg-emerald-100 text-emerald-700',
    rejeitado: 'bg-red-100 text-red-700'
  };
  return `<span class="text-xs font-semibold px-2 py-1 rounded-full ${map[status] || 'bg-gray-100 text-gray-700'}">${status}</span>`;
}

function toast(message, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `fixed bottom-5 right-5 z-50 px-4 py-3 rounded-lg shadow-lg text-white text-sm ${type === 'success' ? 'bg-emerald-600' : 'bg-red-600'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function openModal(html) {
  document.getElementById('modal-box').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-box').innerHTML = '';
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});

function apiErr(err) {
  return err.response?.data?.error || 'Ocorreu um erro inesperado.';
}

// ============================================================
// NAVEGAÇÃO / SIDEBAR
// ============================================================

function buildNav() {
  const nav = document.getElementById('sidebar-nav');
  const items = [];

  items.push({ href: '#/', icon: 'fa-chart-line', label: 'Visão Geral' });
  items.push({ href: '#/nucleos', icon: 'fa-people-group', label: 'Núcleos' });
  items.push({ href: '#/projetos', icon: 'fa-diagram-project', label: 'Projetos' });
  items.push({ href: '#/colaboradores', icon: 'fa-address-card', label: 'Colaboradores' });

  // Financeiro: Admin e Coordenador Geral têm o Painel Geral + Repasses (aprovação/execução).
  // Articulador NUNCA vê nada de financeiro (apenas leitura institucional em Núcleos/Projetos + Comunicação).
  if (isGlobal()) {
    items.push({ href: '#/financeiro-geral', icon: 'fa-sack-dollar', label: 'Financeiro Geral' });
    items.push({ href: '#/repasses', icon: 'fa-money-bill-transfer', label: 'Repasses' });
  }
  // Coordenador de Núcleo: gestor de recursos do(s) seu(s) núcleo(s) — atalho direto para o
  // painel financeiro do núcleo (entradas e saídas), sem acesso ao Painel Geral.
  if (isCoordNucleo() && !isGlobal()) {
    const meuNucleoId = scopedNucleoIds()[0];
    if (meuNucleoId) {
      items.push({ href: `#/nucleos/${meuNucleoId}`, icon: 'fa-wallet', label: 'Meu Financeiro (Núcleo)' });
    }
  }
  if (isAdmin()) {
    items.push({ href: '#/usuarios', icon: 'fa-users-gear', label: 'Usuários & Permissões' });
  }
  items.push({ href: '#/comunicacao', icon: 'fa-bullhorn', label: 'Comunicação' });

  nav.innerHTML = items.map(i => `
    <a href="${i.href}" class="nav-link flex items-center gap-3 px-3 py-2.5 rounded-lg transition text-[13.5px]" data-href="${i.href}">
      <i class="fas ${i.icon} w-4 text-center"></i> <span>${i.label}</span>
    </a>`).join('');

  highlightActiveNav();
}

function highlightActiveNav() {
  const hash = window.location.hash || '#/';
  document.querySelectorAll('.nav-link').forEach(a => {
    const base = a.dataset.href;
    const active = hash === base || (base !== '#/' && hash.startsWith(base));
    a.classList.toggle('active-nav', active);
  });
}

// ============================================================
// ROTEADOR
// ============================================================

const routes = [
  { pattern: /^#\/$/, handler: renderVisaoGeral, title: 'Visão Geral' },
  { pattern: /^#\/nucleos$/, handler: renderNucleos, title: 'Núcleos' },
  { pattern: /^#\/nucleos\/(\d+)$/, handler: renderNucleoDetalhe, title: 'Detalhe do Núcleo' },
  { pattern: /^#\/projetos$/, handler: renderProjetos, title: 'Projetos' },
  { pattern: /^#\/projetos\/(\d+)$/, handler: renderProjetoDetalhe, title: 'Detalhe do Projeto' },
  { pattern: /^#\/colaboradores$/, handler: renderColaboradores, title: 'Colaboradores' },
  { pattern: /^#\/financeiro-geral$/, handler: renderFinanceiroGeral, title: 'Financeiro Geral' },
  { pattern: /^#\/repasses$/, handler: renderRepasses, title: 'Repasses Pendentes' },
  { pattern: /^#\/usuarios$/, handler: renderUsuarios, title: 'Usuários & Permissões' },
  { pattern: /^#\/comunicacao$/, handler: renderComunicacao, title: 'Comunicação' }
];

async function router() {
  const hash = window.location.hash || '#/';
  highlightActiveNav();
  for (const route of routes) {
    const match = hash.match(route.pattern);
    if (match) {
      document.getElementById('page-title').textContent = route.title;
      document.getElementById('page-content').innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fas fa-spinner fa-spin text-2xl"></i></div>';
      try {
        await route.handler(...match.slice(1));
      } catch (err) {
        document.getElementById('page-content').innerHTML = `<div class="text-red-600">${apiErr(err)}</div>`;
      }
      return;
    }
  }
  document.getElementById('page-content').innerHTML = '<div class="text-gray-400">Página não encontrada.</div>';
}

window.addEventListener('hashchange', router);

// ============================================================
// VISÃO GERAL
// ============================================================

async function renderVisaoGeral() {
  const content = document.getElementById('page-content');
  let saldoGeralHtml = '';
  let saldoMeuNucleoHtml = '';

  if (isGlobal()) {
    const { data } = await axios.get('/api/financeiro/geral/saldo');
    saldoGeralHtml = `
      <div class="gs-card p-5">
        <div class="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3"><i class="fas fa-sack-dollar"></i></div>
        <p class="text-sm text-gray-500 mb-1">Saldo Geral (NFP)</p>
        <p class="text-3xl font-bold text-emerald-600">${fmtMoney(data.data.saldo)}</p>
      </div>`;
  } else if (isCoordNucleo()) {
    const meuNucleoId = scopedNucleoIds()[0];
    if (meuNucleoId) {
      try {
        const { data } = await axios.get(`/api/financeiro/nucleo/${meuNucleoId}/saldo`);
        saldoMeuNucleoHtml = `
          <a href="#/nucleos/${meuNucleoId}" class="gs-card gs-card-hover p-5 block">
            <div class="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3"><i class="fas fa-wallet"></i></div>
            <p class="text-sm text-gray-500 mb-1">Saldo do Meu Núcleo</p>
            <p class="text-3xl font-bold text-emerald-600">${fmtMoney(data.data.saldo)}</p>
          </a>`;
      } catch { /* sem acesso */ }
    }
  }

  const { data: nucleosData } = await axios.get('/api/nucleos');
  const { data: projetosData } = await axios.get('/api/projetos');

  content.innerHTML = `
    <div class="brand-gradient rounded-2xl p-6 sm:p-7 text-white mb-6 shadow-soft relative overflow-hidden">
      <div class="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-white/10"></div>
      <h3 class="text-xl font-bold relative z-10">Bem-vindo(a), ${CURRENT_USER.nome.split(' ')[0]} 👋</h3>
      <p class="text-white/85 text-sm mt-1 relative z-10">${CURRENT_USER.roles.map(r => ROLE_LABELS[r.role]).join(' · ')}</p>
    </div>
    <div class="grid sm:grid-cols-3 gap-4 mb-6">
      ${saldoGeralHtml}${saldoMeuNucleoHtml}
      <div class="gs-card p-5">
        <div class="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center mb-3"><i class="fas fa-people-group"></i></div>
        <p class="text-sm text-gray-500 mb-1">Núcleos ativos</p>
        <p class="text-3xl font-bold text-gray-800">${nucleosData.data.length}</p>
      </div>
      <div class="gs-card p-5">
        <div class="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center mb-3"><i class="fas fa-diagram-project"></i></div>
        <p class="text-sm text-gray-500 mb-1">Projetos ativos</p>
        <p class="text-3xl font-bold text-gray-800">${projetosData.data.length}</p>
      </div>
    </div>`;
}

// ============================================================
// NÚCLEOS
// ============================================================

async function renderNucleos() {
  const { data } = await axios.get('/api/nucleos');
  const nucleos = data.data;
  const canCreate = isGlobal();

  document.getElementById('page-content').innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <p class="text-sm text-gray-500">${nucleos.length} núcleo(s)</p>
      ${canCreate ? `<button onclick="openCreateNucleoModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition"><i class="fas fa-plus mr-1"></i> Novo Núcleo</button>` : ''}
    </div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      ${nucleos.map(n => `
        <a href="#/nucleos/${n.id}" class="block gs-card gs-card-hover p-5">
          <h3 class="font-semibold text-gray-800 mb-1">${n.nome}</h3>
          <p class="text-sm text-gray-500 line-clamp-2 mb-3">${n.descricao || ''}</p>
          <div class="flex items-center justify-between text-xs text-gray-400">
            <span><i class="fas fa-link mr-1"></i> /n/${n.slug_publico}</span>
            <span class="${n.ativo ? 'text-emerald-600' : 'text-red-500'}">${n.ativo ? 'Ativo' : 'Inativo'}</span>
          </div>
        </a>`).join('') || '<p class="text-gray-400">Nenhum núcleo cadastrado.</p>'}
    </div>`;
}

function openCreateNucleoModal() {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Novo Núcleo</h3>
    <form id="form-nucleo" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Nome</label>
        <input name="nome" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Descrição</label>
        <textarea name="descricao" rows="3" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Criar</button>
      </div>
    </form>`);

  document.getElementById('form-nucleo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await axios.post('/api/nucleos', body);
      closeModal();
      toast('Núcleo criado com sucesso.');
      renderNucleos();
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

async function renderNucleoDetalhe(id) {
  const { data } = await axios.get(`/api/nucleos/${id}`);
  const n = data.data;
  let saldoHtml = '';
  try {
    const { data: saldoData } = await axios.get(`/api/financeiro/nucleo/${id}/saldo`);
    saldoHtml = `<p class="text-2xl font-bold text-emerald-600">${fmtMoney(saldoData.data.saldo)}</p>`;
  } catch { saldoHtml = '<p class="text-gray-400 text-sm">Sem acesso ao saldo</p>'; }

  const canManage = isGlobal() || scopedNucleoIds().includes(Number(id));

  document.getElementById('page-content').innerHTML = `
    <a href="#/nucleos" class="text-sm text-brand-600 hover:underline font-medium mb-4 inline-block"><i class="fas fa-arrow-left mr-1"></i> Voltar</a>
    <div class="grid lg:grid-cols-3 gap-4 mb-6">
      <div class="lg:col-span-2 gs-card p-5">
        <h2 class="text-xl font-bold text-gray-800 mb-1">${n.nome}</h2>
        <p class="text-gray-500 text-sm mb-3">${n.descricao || ''}</p>
        <p class="text-xs text-gray-400"><i class="fas fa-link mr-1"></i> <a href="/n/${n.slug_publico}" target="_blank" class="text-brand-600 hover:underline font-medium">/n/${n.slug_publico}</a></p>
      </div>
      <div class="gs-card p-5">
        <p class="text-sm text-gray-500 mb-1">Saldo do Núcleo</p>
        ${saldoHtml}
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-6">
      <div class="gs-card p-5">
        <h3 class="font-semibold text-gray-700 mb-3">Coordenadores</h3>
        <ul class="text-sm space-y-1">
          ${(n.coordenadores || []).map(cd => `<li><i class="fas fa-user mr-1 text-gray-400"></i> ${cd.nome} (${cd.email})</li>`).join('') || '<li class="text-gray-400">Nenhum coordenador vinculado.</li>'}
        </ul>
        ${isGlobal() ? `<button onclick="openAddCoordenadorModal(${id})" class="mt-3 text-sm text-brand-600 hover:underline font-medium"><i class="fas fa-plus mr-1"></i>Vincular coordenador</button>` : ''}
      </div>
      <div class="gs-card p-5">
        <h3 class="font-semibold text-gray-700 mb-3">Projetos</h3>
        <ul class="text-sm space-y-1">
          ${(n.projetos || []).map(p => `<li><a href="#/projetos/${p.id}" class="text-brand-600 hover:underline font-medium">${p.nome}</a></li>`).join('') || '<li class="text-gray-400">Nenhum projeto cadastrado.</li>'}
        </ul>
        ${canManage ? `<button onclick="openCreateProjetoModal(${id})" class="mt-3 text-sm text-brand-600 hover:underline font-medium"><i class="fas fa-plus mr-1"></i>Novo projeto</button>` : ''}
      </div>
    </div>

    ${isGlobal() ? `
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3">Repassar recurso do Geral para este Núcleo</h3>
      <form id="form-repasse-nucleo" class="flex flex-wrap gap-3 items-end">
        <input type="hidden" name="nucleo_id" value="${id}" />
        <div>
          <label class="block text-xs text-gray-600 mb-1">Valor (R$)</label>
          <input name="valor" type="number" step="0.01" min="0.01" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-40" />
        </div>
        <div class="flex-1 min-w-[200px]">
          <label class="block text-xs text-gray-600 mb-1">Finalidade</label>
          <input name="finalidade" class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-full" />
        </div>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Solicitar repasse</button>
      </form>
    </div>` : ''}

    <div class="gs-card p-5 mt-6">
      <h3 class="font-semibold text-gray-700 mb-3">Histórico Financeiro do Núcleo</h3>
      <div id="nucleo-lancamentos">Carregando...</div>
    </div>`;

  if (isGlobal()) {
    document.getElementById('form-repasse-nucleo').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      body.valor = parseFloat(body.valor);
      try {
        await axios.post('/api/financeiro/repasses/geral-nucleo', body);
        toast('Solicitação de repasse criada (pendente de aprovação).');
        renderNucleoDetalhe(id);
      } catch (err) { toast(apiErr(err), 'error'); }
    });
  }

  try {
    const { data: lancamentos } = await axios.get(`/api/financeiro/nucleo/${id}/lancamentos`);
    document.getElementById('nucleo-lancamentos').innerHTML = renderLancamentosTable(lancamentos.data);
  } catch {
    document.getElementById('nucleo-lancamentos').innerHTML = '<p class="text-gray-400 text-sm">Sem acesso ao histórico financeiro.</p>';
  }
}

function openAddCoordenadorModal(nucleoId) {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Vincular Coordenador de Núcleo</h3>
    <p class="text-sm text-gray-500 mb-3">Informe o ID do usuário já cadastrado (crie o usuário em Usuários & Permissões antes, com papel coord_nucleo).</p>
    <form id="form-add-coord" class="space-y-3">
      <input name="user_id" type="number" required placeholder="ID do usuário" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Vincular</button>
      </div>
    </form>`);

  document.getElementById('form-add-coord').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.user_id = parseInt(body.user_id);
    try {
      await axios.post(`/api/nucleos/${nucleoId}/coordenadores`, body);
      closeModal();
      toast('Coordenador vinculado.');
      renderNucleoDetalhe(nucleoId);
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

// ============================================================
// PROJETOS
// ============================================================

async function renderProjetos() {
  const { data } = await axios.get('/api/projetos');
  const projetos = data.data;

  document.getElementById('page-content').innerHTML = `
    <p class="text-sm text-gray-500 mb-4">${projetos.length} projeto(s)</p>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      ${projetos.map(p => `
        <a href="#/projetos/${p.id}" class="block gs-card gs-card-hover p-5">
          <h3 class="font-semibold text-gray-800 mb-1">${p.nome}</h3>
          <p class="text-sm text-gray-500 line-clamp-2 mb-3">${p.descricao || ''}</p>
          <p class="text-xs text-gray-400"><i class="fas fa-link mr-1"></i> /p/${p.slug_publico}</p>
        </a>`).join('') || '<p class="text-gray-400">Nenhum projeto cadastrado.</p>'}
    </div>`;
}

function openCreateProjetoModal(nucleoId) {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Novo Projeto</h3>
    <form id="form-projeto" class="space-y-3">
      <input type="hidden" name="nucleo_id" value="${nucleoId}" />
      <div>
        <label class="block text-sm text-gray-600 mb-1">Nome</label>
        <input name="nome" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Descrição</label>
        <textarea name="descricao" rows="3" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Criar</button>
      </div>
    </form>`);

  document.getElementById('form-projeto').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.nucleo_id = parseInt(body.nucleo_id);
    try {
      await axios.post('/api/projetos', body);
      closeModal();
      toast('Projeto criado com sucesso.');
      renderNucleoDetalhe(nucleoId);
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

async function renderProjetoDetalhe(id) {
  const { data } = await axios.get(`/api/projetos/${id}`);
  const p = data.data;
  let saldoHtml = '';
  try {
    const { data: saldoData } = await axios.get(`/api/financeiro/projeto/${id}/saldo`);
    saldoHtml = `<p class="text-2xl font-bold text-emerald-600">${fmtMoney(saldoData.data.saldo)}</p>`;
  } catch { saldoHtml = '<p class="text-gray-400 text-sm">Sem acesso ao saldo</p>'; }

  const canRequestRepasse = isGlobal() || scopedNucleoIds().includes(p.nucleo_id);

  document.getElementById('page-content').innerHTML = `
    <a href="#/projetos" class="text-sm text-brand-600 hover:underline font-medium mb-4 inline-block"><i class="fas fa-arrow-left mr-1"></i> Voltar</a>
    <div class="grid lg:grid-cols-3 gap-4 mb-6">
      <div class="lg:col-span-2 gs-card p-5">
        <h2 class="text-xl font-bold text-gray-800 mb-1">${p.nome}</h2>
        <p class="text-gray-500 text-sm mb-3">${p.descricao || ''}</p>
        <p class="text-xs text-gray-400"><i class="fas fa-link mr-1"></i> <a href="/p/${p.slug_publico}" target="_blank" class="text-brand-600 hover:underline font-medium">/p/${p.slug_publico}</a></p>
      </div>
      <div class="gs-card p-5">
        <p class="text-sm text-gray-500 mb-1">Saldo do Projeto</p>
        ${saldoHtml}
      </div>
    </div>

    <div class="gs-card p-5 mb-6">
      <div class="flex justify-between items-center mb-3">
        <h3 class="font-semibold text-gray-700">Galeria de Imagens</h3>
        <button onclick="openUploadGaleriaModal(${id})" class="text-sm text-brand-600 hover:underline font-medium"><i class="fas fa-upload mr-1"></i>Enviar imagem</button>
      </div>
      <div class="grid grid-cols-3 sm:grid-cols-5 gap-2">
        ${(p.galeria || []).map(g => `<img src="/api/projetos/galeria/${g.id}/arquivo" class="rounded-lg h-24 w-full object-cover" />`).join('') || '<p class="text-gray-400 text-sm col-span-5">Nenhuma imagem.</p>'}
      </div>
    </div>

    ${canRequestRepasse ? `
    <div class="gs-card p-5 mb-6">
      <h3 class="font-semibold text-gray-700 mb-3">Solicitar repasse do Núcleo para este Projeto</h3>
      <form id="form-repasse-projeto" class="flex flex-wrap gap-3 items-end">
        <input type="hidden" name="projeto_id" value="${id}" />
        <div>
          <label class="block text-xs text-gray-600 mb-1">Valor (R$)</label>
          <input name="valor" type="number" step="0.01" min="0.01" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-40" />
        </div>
        <div class="flex-1 min-w-[200px]">
          <label class="block text-xs text-gray-600 mb-1">Finalidade (obrigatório)</label>
          <input name="finalidade" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-full" />
        </div>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Solicitar</button>
      </form>
    </div>` : ''}

    ${canManageNucleoFinance(p.nucleo_id) ? `
    <div class="gs-card p-5 mb-6 border-l-4 border-l-red-400">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-money-bill-wave mr-1 text-red-500"></i>Lançar Saída de Pagamento</h3>
      <p class="text-xs text-gray-500 mb-3">Obrigatório anexar comprovante bancário e comprovante fiscal.</p>
      <form id="form-saida-pagamento" enctype="multipart/form-data" class="space-y-3">
        <div class="flex gap-3">
          <div>
            <label class="block text-xs text-gray-600 mb-1">Valor (R$)</label>
            <input name="valor" type="number" step="0.01" min="0.01" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-40" />
          </div>
          <div class="flex-1">
            <label class="block text-xs text-gray-600 mb-1">Finalidade / Prestação de contas</label>
            <input name="finalidade" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-full" />
          </div>
        </div>
        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-xs text-gray-600 mb-1">Comprovante Bancário</label>
            <input name="comprovante_bancario" type="file" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-full" />
          </div>
          <div class="flex-1">
            <label class="block text-xs text-gray-600 mb-1">Comprovante Fiscal</label>
            <input name="comprovante_fiscal" type="file" required class="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-full" />
          </div>
        </div>
        <button type="submit" class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium">Lançar Saída</button>
      </form>
    </div>` : ''}

    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3">Histórico Financeiro do Projeto</h3>
      <div id="projeto-lancamentos">Carregando...</div>
    </div>`;

  document.getElementById('form-repasse-projeto')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    body.projeto_id = parseInt(body.projeto_id);
    try {
      await axios.post('/api/financeiro/repasses/nucleo-projeto', body);
      toast('Solicitação de repasse criada (pendente de aprovação).');
      renderProjetoDetalhe(id);
    } catch (err) { toast(apiErr(err), 'error'); }
  });

  document.getElementById('form-saida-pagamento')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    try {
      await axios.post(`/api/financeiro/projeto/${id}/saidas`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast('Saída de pagamento lançada com sucesso.');
      renderProjetoDetalhe(id);
    } catch (err) { toast(apiErr(err), 'error'); }
  });

  try {
    const { data: lancamentos } = await axios.get(`/api/financeiro/projeto/${id}/lancamentos`);
    document.getElementById('projeto-lancamentos').innerHTML = renderLancamentosTable(lancamentos.data);
  } catch {
    document.getElementById('projeto-lancamentos').innerHTML = '<p class="text-gray-400 text-sm">Sem acesso ao histórico financeiro.</p>';
  }
}

function openUploadGaleriaModal(projetoId) {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Enviar Imagem</h3>
    <form id="form-galeria" enctype="multipart/form-data" class="space-y-3">
      <input type="file" name="imagem" accept="image/*" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      <input type="text" name="legenda" placeholder="Legenda (opcional)" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Enviar</button>
      </div>
    </form>`);

  document.getElementById('form-galeria').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    try {
      await axios.post(`/api/projetos/${projetoId}/galeria`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      closeModal();
      toast('Imagem enviada.');
      renderProjetoDetalhe(projetoId);
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

// ============================================================
// TABELA GENÉRICA DE LANÇAMENTOS
// ============================================================

function renderLancamentosTable(lancamentos) {
  if (!lancamentos.length) return '<p class="text-gray-400 text-sm">Nenhum lançamento.</p>';
  return `
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left text-gray-500 border-b">
          <th class="py-2 pr-3">Tipo</th>
          <th class="py-2 pr-3">Valor</th>
          <th class="py-2 pr-3">Status</th>
          <th class="py-2 pr-3">Finalidade</th>
          <th class="py-2 pr-3">Data</th>
          <th class="py-2 pr-3">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${lancamentos.map(l => `
          <tr class="border-b last:border-0">
            <td class="py-2 pr-3">${l.tipo}</td>
            <td class="py-2 pr-3 font-medium">${fmtMoney(l.valor)}</td>
            <td class="py-2 pr-3">${statusBadge(l.status)}</td>
            <td class="py-2 pr-3 text-gray-500">${l.finalidade || '-'}</td>
            <td class="py-2 pr-3 text-gray-400">${fmtDate(l.created_at)}</td>
            <td class="py-2 pr-3">
              ${l.status === 'executado' ? `<button onclick="verComprovantes(${l.id})" class="text-brand-600 hover:underline text-xs font-medium">Comprovantes</button>` : '-'}
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function comprovanteStatusLabel(cp) {
  if (cp.expirado) {
    return '<span class="text-xs text-red-500"><i class="fas fa-ban mr-1"></i>Expirado (removido 30 dias após o download)</span>';
  }
  if (cp.baixado_em) {
    const expira = cp.expira_em ? new Date(cp.expira_em.replace(' ', 'T')) : null;
    const dias = expira ? Math.max(0, Math.ceil((expira - new Date()) / (24 * 60 * 60 * 1000))) : null;
    return `<span class="text-xs text-amber-600"><i class="fas fa-clock mr-1"></i>Baixado — expira em ${dias != null ? dias + ' dia(s)' : '30 dias'}</span>`;
  }
  return '<span class="text-xs text-emerald-600"><i class="fas fa-circle-check mr-1"></i>Disponível (ainda não baixado)</span>';
}

async function verComprovantes(lancamentoId) {
  try {
    const { data } = await axios.get(`/api/financeiro/lancamentos/${lancamentoId}/comprovantes`);
    const comprovantes = data.data;
    openModal(`
      <h3 class="text-lg font-bold text-gray-800 mb-4">Comprovantes</h3>
      <p class="text-xs text-gray-500 mb-3">O arquivo fica disponível até o primeiro download; depois disso é removido do armazenamento em 30 dias. O registro do comprovante é mantido para fins de auditoria.</p>
      <ul class="space-y-2">
        ${comprovantes.map(cp => `
          <li class="flex items-center justify-between border rounded-lg px-3 py-2 gap-3">
            <div class="min-w-0">
              <span class="text-sm block truncate"><i class="fas fa-file-invoice mr-1 text-gray-400"></i> ${cp.tipo} — ${cp.nome_arquivo || 'arquivo'}</span>
              ${comprovanteStatusLabel(cp)}
            </div>
            ${cp.expirado
              ? '<span class="text-xs text-gray-400 font-medium whitespace-nowrap">Indisponível</span>'
              : `<a href="/api/financeiro/comprovantes/${cp.id}/arquivo" class="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 text-xs font-medium whitespace-nowrap"><i class="fas fa-download"></i> Baixar</a>`}
          </li>`).join('') || '<li class="text-gray-400 text-sm">Nenhum comprovante.</li>'}
      </ul>
      <div class="flex justify-end pt-4"><button onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Fechar</button></div>`);
  } catch (err) { toast(apiErr(err), 'error'); }
}

// ============================================================
// FINANCEIRO GERAL
// ============================================================

async function renderFinanceiroGeral() {
  const [{ data: saldoData }, { data: lancamentosData }, { data: importacoesData }] = await Promise.all([
    axios.get('/api/financeiro/geral/saldo'),
    axios.get('/api/financeiro/geral/lancamentos'),
    axios.get('/api/financeiro/geral/importacoes')
  ]);
  const importacoes = importacoesData.data;

  document.getElementById('page-content').innerHTML = `
    <div class="gs-card p-5 mb-6 flex items-center justify-between flex-wrap gap-4">
      <div>
        <p class="text-sm text-gray-500 mb-1">Saldo Geral Disponível</p>
        <p class="text-3xl font-bold text-emerald-600">${fmtMoney(saldoData.data.saldo)}</p>
      </div>
      <button onclick="openImportarNfpModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">
        <i class="fas fa-file-import mr-1"></i> Importar planilha da NFP
      </button>
    </div>
    <div class="gs-card p-5 mb-6">
      <h3 class="font-semibold text-gray-700 mb-1">Importações da planilha NFP</h3>
      <p class="text-xs text-gray-500 mb-3">O Painel Geral só recebe entradas pela importação da planilha de créditos exportada do site da Nota Fiscal Paulista. Reimportar o mesmo arquivo atualizado não duplica lançamentos já processados.</p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Data</th><th class="py-2 pr-3">Arquivo</th><th class="py-2 pr-3">Linhas no arquivo</th>
            <th class="py-2 pr-3">Elegíveis</th><th class="py-2 pr-3">Novas</th><th class="py-2 pr-3">Duplicadas</th>
            <th class="py-2 pr-3">Ignoradas</th><th class="py-2 pr-3">Valor importado</th><th class="py-2 pr-3">Por</th>
          </tr></thead>
          <tbody>
            ${importacoes.map(i => `
              <tr class="border-b last:border-0">
                <td class="py-2 pr-3 whitespace-nowrap">${fmtDate(i.created_at)}</td>
                <td class="py-2 pr-3">${i.nome_arquivo}</td>
                <td class="py-2 pr-3">${i.total_linhas_arquivo}</td>
                <td class="py-2 pr-3">${i.linhas_elegiveis}</td>
                <td class="py-2 pr-3 text-emerald-600 font-medium">${i.linhas_novas}</td>
                <td class="py-2 pr-3 text-amber-600">${i.linhas_duplicadas}</td>
                <td class="py-2 pr-3 text-gray-400">${i.linhas_ignoradas_zero_ou_a_calcular}</td>
                <td class="py-2 pr-3 font-medium">${fmtMoney(i.valor_total_importado)}</td>
                <td class="py-2 pr-3">${i.importado_por_nome}</td>
              </tr>`).join('') || '<tr><td colspan="9" class="py-3 text-gray-400 text-sm">Nenhuma importação realizada ainda.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3">Histórico Geral</h3>
      ${renderLancamentosTable(lancamentosData.data)}
    </div>`;
}

function openImportarNfpModal() {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Importar planilha da Nota Fiscal Paulista</h3>
    <p class="text-sm text-gray-600 mb-3">Envie o arquivo <strong>.csv</strong> exportado da "Consulta de Créditos" no site da NFP. Linhas com situação "A Calcular" ou crédito zerado são ignoradas automaticamente. Linhas já importadas anteriormente (mesmo arquivo reexportado em outro mês) não são lançadas novamente.</p>
    <form id="form-importar-nfp" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Arquivo CSV</label>
        <input name="arquivo" type="file" accept=".csv,.txt" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" id="btn-importar-nfp" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Importar</button>
      </div>
    </form>`);

  document.getElementById('form-importar-nfp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-importar-nfp');
    const formData = new FormData(e.target);
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Importando...';
    try {
      const { data } = await axios.post('/api/financeiro/geral/importar-nfp', formData);
      closeModal();
      const r = data.data;
      openModal(`
        <h3 class="text-lg font-bold text-gray-800 mb-4"><i class="fas fa-circle-check text-emerald-500 mr-1"></i>Importação concluída</h3>
        <ul class="text-sm text-gray-700 space-y-1 mb-4">
          <li>Linhas no arquivo: <strong>${r.totalLinhasArquivo}</strong></li>
          <li>Linhas elegíveis (com crédito definido): <strong>${r.linhasElegiveis}</strong></li>
          <li class="text-emerald-600">Lançadas agora (novas): <strong>${r.linhasNovas}</strong></li>
          <li class="text-amber-600">Já existiam (duplicadas, ignoradas): <strong>${r.linhasDuplicadas}</strong></li>
          <li class="text-gray-400">Ignoradas (zeradas / "A Calcular"): <strong>${r.linhasIgnoradas}</strong></li>
          <li class="font-semibold pt-1">Valor total lançado: ${fmtMoney(r.valorTotalImportado)}</li>
        </ul>
        ${r.mensagem ? `<p class="text-sm text-gray-500 mb-4">${r.mensagem}</p>` : ''}
        <div class="flex justify-end"><button onclick="closeModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Fechar</button></div>`);
      renderFinanceiroGeral();
    } catch (err) {
      toast(apiErr(err), 'error');
      btn.disabled = false;
      btn.innerHTML = 'Importar';
    }
  });
}

// ============================================================
// REPASSES PENDENTES (aprovação/execução)
// ============================================================

async function renderRepasses() {
  const [{ data: nucleosData }, { data: projetosData }] = await Promise.all([
    axios.get('/api/nucleos'), axios.get('/api/projetos')
  ]);

  // Busca todos os lançamentos pendentes/aprovados agregando por núcleo/projeto
  const pendentes = [];
  for (const n of nucleosData.data) {
    const { data } = await axios.get(`/api/financeiro/nucleo/${n.id}/lancamentos`);
    data.data.filter(l => l.tipo === 'repasse_geral_nucleo' && ['pendente', 'aprovado'].includes(l.status))
      .forEach(l => pendentes.push({ ...l, contexto: `Núcleo: ${n.nome}` }));
  }
  for (const p of projetosData.data) {
    const { data } = await axios.get(`/api/financeiro/projeto/${p.id}/lancamentos`);
    data.data.filter(l => l.tipo === 'repasse_nucleo_projeto' && ['pendente', 'aprovado'].includes(l.status))
      .forEach(l => pendentes.push({ ...l, contexto: `Projeto: ${p.nome}` }));
  }

  // Regra de aprovação:
  // - repasse_geral_nucleo: SOMENTE o Administrador pode aprovar (Coord. Geral apenas solicitou).
  // - repasse_nucleo_projeto: Admin ou Coordenador Geral podem aprovar.
  function podeAprovar(l) {
    if (l.tipo === 'repasse_geral_nucleo') return isAdmin();
    return isGlobal();
  }
  const tipoLabel = { repasse_geral_nucleo: 'Geral → Núcleo', repasse_nucleo_projeto: 'Núcleo → Projeto' };

  document.getElementById('page-content').innerHTML = `
    <div class="gs-card p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-gray-700">Repasses Pendentes de Aprovação/Execução</h3>
        <p class="text-xs text-gray-400 max-w-sm text-right">Repasses do Geral para um Núcleo só podem ser autorizados pelo Administrador.</p>
      </div>
      ${pendentes.length ? `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Tipo</th><th class="py-2 pr-3">Contexto</th><th class="py-2 pr-3">Valor</th><th class="py-2 pr-3">Status</th>
            <th class="py-2 pr-3">Finalidade</th><th class="py-2 pr-3">Ações</th>
          </tr></thead>
          <tbody>
            ${pendentes.map(l => `
              <tr class="border-b last:border-0">
                <td class="py-2 pr-3 text-gray-500 text-xs">${tipoLabel[l.tipo] || l.tipo}</td>
                <td class="py-2 pr-3">${l.contexto}</td>
                <td class="py-2 pr-3 font-medium">${fmtMoney(l.valor)}</td>
                <td class="py-2 pr-3">${statusBadge(l.status)}</td>
                <td class="py-2 pr-3 text-gray-500">${l.finalidade || '-'}</td>
                <td class="py-2 pr-3 space-x-2">
                  ${l.status === 'pendente' && podeAprovar(l) ? `
                    <button onclick="aprovarRepasse(${l.id})" class="text-blue-600 hover:underline text-xs font-medium">Aprovar</button>
                    <button onclick="rejeitarRepasse(${l.id})" class="text-red-600 hover:underline text-xs font-medium">Rejeitar</button>
                  ` : ''}
                  ${l.status === 'pendente' && !podeAprovar(l) ? `<span class="text-xs text-gray-400 italic">Aguardando Admin</span>` : ''}
                  ${l.status === 'aprovado' && isAdmin() ? `<button onclick="openExecutarRepasseModal(${l.id})" class="text-brand-600 hover:underline text-xs font-medium">Executar</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<p class="text-gray-400 text-sm">Nenhum repasse pendente.</p>'}
    </div>`;
}

async function aprovarRepasse(id) {
  try {
    await axios.post(`/api/financeiro/repasses/${id}/aprovar`);
    toast('Repasse aprovado.');
    renderRepasses();
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function rejeitarRepasse(id) {
  const motivo = prompt('Motivo da rejeição:');
  if (motivo === null) return;
  try {
    await axios.post(`/api/financeiro/repasses/${id}/rejeitar`, { motivo });
    toast('Repasse rejeitado.');
    renderRepasses();
  } catch (err) { toast(apiErr(err), 'error'); }
}

function openExecutarRepasseModal(id) {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Executar Repasse</h3>
    <p class="text-xs text-gray-500 mb-3">Apenas o Administrador pode executar, anexando o comprovante bancário.</p>
    <form id="form-executar" enctype="multipart/form-data" class="space-y-3">
      <input type="file" name="comprovante_bancario" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Executar</button>
      </div>
    </form>`);

  document.getElementById('form-executar').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    try {
      await axios.post(`/api/financeiro/repasses/${id}/executar`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
      closeModal();
      toast('Repasse executado com sucesso.');
      renderRepasses();
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

// ============================================================
// COLABORADORES
// ============================================================

async function renderColaboradores() {
  const { data } = await axios.get('/api/colaboradores/gestao');
  const colaboradores = data.data;

  document.getElementById('page-content').innerHTML = `
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3">${colaboradores.length} colaborador(es) cadastrado(s)</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Nome</th><th class="py-2 pr-3">CPF</th><th class="py-2 pr-3">WhatsApp</th>
            <th class="py-2 pr-3">Status Fazenda</th><th class="py-2 pr-3">Validado</th><th class="py-2 pr-3">Ações</th>
          </tr></thead>
          <tbody>
            ${colaboradores.map(cl => `
              <tr class="border-b last:border-0">
                <td class="py-2 pr-3">${cl.nome}</td>
                <td class="py-2 pr-3">${cl.cpf}</td>
                <td class="py-2 pr-3">${cl.whatsapp}</td>
                <td class="py-2 pr-3">${cl.status_portal_fazenda === 'pleno' ? 'Pleno' : 'Não Pleno'}</td>
                <td class="py-2 pr-3">${cl.validado_em ? '<span class="text-emerald-600"><i class="fas fa-check"></i> Validado</span>' : '<span class="text-amber-600">Pendente</span>'}</td>
                <td class="py-2 pr-3">${!cl.validado_em ? `<button onclick="validarColaborador(${cl.id})" class="text-brand-600 hover:underline text-xs font-medium">Validar</button>` : '-'}</td>
              </tr>`).join('') || `<tr><td colspan="6" class="py-4 text-gray-400 text-center">Nenhum colaborador cadastrado ainda.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function validarColaborador(id) {
  try {
    await axios.post(`/api/colaboradores/gestao/${id}/validar`);
    toast('Colaborador validado.');
    renderColaboradores();
  } catch (err) { toast(apiErr(err), 'error'); }
}

// ============================================================
// USUÁRIOS & PERMISSÕES (admin/coord_geral)
// ============================================================

let USUARIOS_CACHE = [];

async function renderUsuarios() {
  const { data } = await axios.get('/api/auth/usuarios');
  const usuarios = data.data;
  USUARIOS_CACHE = usuarios;

  document.getElementById('page-content').innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <p class="text-sm text-gray-500">${usuarios.length} usuário(s)</p>
      <button onclick="openCreateUsuarioModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition"><i class="fas fa-plus mr-1"></i> Novo Usuário</button>
    </div>
    <div class="gs-card p-5">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Nome</th><th class="py-2 pr-3">E-mail</th><th class="py-2 pr-3">Papéis</th>
            <th class="py-2 pr-3">Status</th><th class="py-2 pr-3">Ações</th>
          </tr></thead>
          <tbody>
            ${usuarios.map(u => `
              <tr class="border-b last:border-0">
                <td class="py-2 pr-3">${u.nome} <span class="text-gray-400 text-xs">#${u.id}</span></td>
                <td class="py-2 pr-3">${u.email}</td>
                <td class="py-2 pr-3">${(u.roles || []).map(r => `<span class="text-xs bg-gray-100 px-2 py-0.5 rounded-full mr-1">${ROLE_LABELS[r.role]}${r.escopo_id ? ' #' + r.escopo_id : ''}</span>`).join('')}</td>
                <td class="py-2 pr-3">${u.ativo ? '<span class="text-emerald-600">Ativo</span>' : '<span class="text-red-500">Inativo</span>'}</td>
                <td class="py-2 pr-3 space-x-2 whitespace-nowrap">
                  ${isGlobal() ? `<button onclick="openEditUsuarioModal(${u.id})" class="text-gray-600 hover:underline text-xs"><i class="fas fa-pen mr-0.5"></i>Editar</button>` : ''}
                  ${isAdmin() ? `<button onclick="resetarSenhaUsuario(${u.id})" class="text-amber-600 hover:underline text-xs"><i class="fas fa-key mr-0.5"></i>Resetar senha</button>` : ''}
                  ${isAdmin() && !u.roles.some(r => r.role === 'admin') ? `<button onclick="promoverAdmin(${u.id})" class="text-blue-600 hover:underline text-xs">Promover a Admin</button>` : ''}
                  ${isAdmin() && u.ativo ? `<button onclick="desativarUsuario(${u.id})" class="text-orange-600 hover:underline text-xs">Desativar</button>` : ''}
                  ${isAdmin() && !u.ativo ? `<button onclick="reativarUsuario(${u.id})" class="text-emerald-600 hover:underline text-xs">Reativar</button>` : ''}
                  ${isAdmin() ? `<button onclick="excluirUsuario(${u.id})" class="text-red-600 hover:underline text-xs"><i class="fas fa-trash mr-0.5"></i>Excluir</button>` : ''}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function openCreateUsuarioModal() {
  const nucleoOptionsPromise = axios.get('/api/nucleos');
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Novo Usuário</h3>
    <form id="form-usuario" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Nome</label>
        <input name="nome" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">E-mail</label>
        <input name="email" type="email" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Senha</label>
        <input name="senha" type="password" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Papel</label>
        <select name="role" id="role-select" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          ${isAdmin() ? '<option value="admin">Administrador</option><option value="coord_geral">Coordenador Geral</option>' : ''}
          <option value="coord_nucleo">Coordenador de Núcleo</option>
          <option value="articulador">Articulador</option>
        </select>
      </div>
      <div id="nucleo-field" class="hidden">
        <label class="block text-sm text-gray-600 mb-1">Núcleo</label>
        <select name="nucleo_id" id="nucleo-select" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"></select>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Criar</button>
      </div>
    </form>`);

  const roleSelect = document.getElementById('role-select');
  const nucleoField = document.getElementById('nucleo-field');
  const nucleoSelect = document.getElementById('nucleo-select');

  nucleoOptionsPromise.then(({ data }) => {
    nucleoSelect.innerHTML = data.data.map(n => `<option value="${n.id}">${n.nome}</option>`).join('');
  });

  function toggleNucleoField() {
    nucleoField.classList.toggle('hidden', roleSelect.value !== 'coord_nucleo');
  }
  roleSelect.addEventListener('change', toggleNucleoField);
  toggleNucleoField();

  document.getElementById('form-usuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (body.nucleo_id) body.nucleo_id = parseInt(body.nucleo_id);
    try {
      await axios.post('/api/auth/usuarios', body);
      closeModal();
      toast('Usuário criado com sucesso.');
      renderUsuarios();
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

function openEditUsuarioModal(id) {
  const usuario = USUARIOS_CACHE.find(u => u.id === id);
  if (!usuario) return;
  const papelAtual = (usuario.roles || [])[0] || {};
  const nucleoOptionsPromise = axios.get('/api/nucleos');

  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Editar Usuário</h3>
    <form id="form-editar-usuario" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Nome</label>
        <input name="nome" required value="${usuario.nome}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">E-mail</label>
        <input name="email" type="email" required value="${usuario.email}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Papel</label>
        <select name="role" id="edit-role-select" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          ${isAdmin() ? `<option value="admin" ${papelAtual.role === 'admin' ? 'selected' : ''}>Administrador</option><option value="coord_geral" ${papelAtual.role === 'coord_geral' ? 'selected' : ''}>Coordenador Geral</option>` : ''}
          <option value="coord_nucleo" ${papelAtual.role === 'coord_nucleo' ? 'selected' : ''}>Coordenador de Núcleo</option>
          <option value="articulador" ${papelAtual.role === 'articulador' ? 'selected' : ''}>Articulador</option>
        </select>
      </div>
      <div id="edit-nucleo-field" class="hidden">
        <label class="block text-sm text-gray-600 mb-1">Núcleo</label>
        <select name="nucleo_id" id="edit-nucleo-select" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"></select>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Salvar</button>
      </div>
    </form>`);

  const roleSelect = document.getElementById('edit-role-select');
  const nucleoField = document.getElementById('edit-nucleo-field');
  const nucleoSelect = document.getElementById('edit-nucleo-select');

  nucleoOptionsPromise.then(({ data }) => {
    nucleoSelect.innerHTML = data.data.map(n => `<option value="${n.id}" ${papelAtual.escopo_id === n.id ? 'selected' : ''}>${n.nome}</option>`).join('');
  });

  function toggleNucleoField() {
    nucleoField.classList.toggle('hidden', roleSelect.value !== 'coord_nucleo');
  }
  roleSelect.addEventListener('change', toggleNucleoField);
  toggleNucleoField();

  document.getElementById('form-editar-usuario').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (body.nucleo_id) body.nucleo_id = parseInt(body.nucleo_id);
    try {
      await axios.put(`/api/auth/usuarios/${id}`, body);
      closeModal();
      toast('Usuário atualizado com sucesso.');
      renderUsuarios();
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

async function promoverAdmin(id) {
  if (!confirm('Confirma promover este usuário a Administrador?')) return;
  try {
    await axios.post(`/api/auth/usuarios/${id}/promover-admin`);
    toast('Usuário promovido a administrador.');
    renderUsuarios();
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function desativarUsuario(id) {
  if (!confirm('Confirma desativar este usuário?')) return;
  try {
    await axios.post(`/api/auth/usuarios/${id}/desativar`);
    toast('Usuário desativado.');
    renderUsuarios();
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function reativarUsuario(id) {
  if (!confirm('Confirma reativar este usuário?')) return;
  try {
    await axios.post(`/api/auth/usuarios/${id}/reativar`);
    toast('Usuário reativado.');
    renderUsuarios();
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function resetarSenhaUsuario(id) {
  const usuario = USUARIOS_CACHE.find(u => u.id === id);
  const novaSenha = prompt(`Digite a nova senha para ${usuario ? usuario.nome : 'o usuário'} (deixe em branco para gerar uma senha aleatória):`);
  if (novaSenha === null) return; // cancelou
  try {
    const { data } = await axios.post(`/api/auth/usuarios/${id}/resetar-senha`, { nova_senha: novaSenha || undefined });
    openModal(`
      <h3 class="text-lg font-bold text-gray-800 mb-4"><i class="fas fa-key mr-1 text-amber-500"></i>Senha redefinida</h3>
      <p class="text-sm text-gray-600 mb-3">${data.data.message}</p>
      <p class="text-sm text-gray-600 mb-1">Repasse esta senha ao usuário por um canal seguro — ela não ficará visível novamente:</p>
      <div class="bg-gray-100 rounded-lg px-3 py-2 font-mono text-sm select-all mb-4">${data.data.senha_temporaria}</div>
      <div class="flex justify-end"><button onclick="closeModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Entendi</button></div>`);
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function excluirUsuario(id) {
  const usuario = USUARIOS_CACHE.find(u => u.id === id);
  if (!confirm(`Confirma excluir o usuário "${usuario ? usuario.nome : ''}"? Se ele possuir histórico vinculado (lançamentos, auditoria etc.), o registro será mantido de forma inativa para preservar a rastreabilidade; caso contrário, será excluído permanentemente.`)) return;
  try {
    const { data } = await axios.delete(`/api/auth/usuarios/${id}`);
    toast(data.data.message);
    renderUsuarios();
  } catch (err) { toast(apiErr(err), 'error'); }
}

// ============================================================
// COMUNICAÇÃO
// ============================================================

async function renderComunicacao() {
  const [{ data: campanhasData }, { data: nucleosData }, { data: projetosData }] = await Promise.all([
    axios.get('/api/comunicacao/campanhas'), axios.get('/api/nucleos'), axios.get('/api/projetos')
  ]);
  const campanhas = campanhasData.data;

  document.getElementById('page-content').innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <p class="text-sm text-gray-500">${campanhas.length} campanha(s)</p>
      <button onclick="openCreateCampanhaModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition"><i class="fas fa-plus mr-1"></i> Nova Campanha</button>
    </div>
    <div class="gs-card p-5">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Título</th><th class="py-2 pr-3">Canal</th><th class="py-2 pr-3">Segmento</th><th class="py-2 pr-3">Ações</th>
          </tr></thead>
          <tbody>
            ${campanhas.map(cp => `
              <tr class="border-b last:border-0">
                <td class="py-2 pr-3">${cp.titulo}</td>
                <td class="py-2 pr-3">${cp.canal}</td>
                <td class="py-2 pr-3">${cp.segmento_tipo}${cp.segmento_id ? ' #' + cp.segmento_id : ''}</td>
                <td class="py-2 pr-3"><button onclick="enviarCampanha(${cp.id})" class="text-brand-600 hover:underline text-xs font-medium">Disparar (stub)</button></td>
              </tr>`).join('') || `<tr><td colspan="4" class="py-4 text-gray-400 text-center">Nenhuma campanha criada.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
    <p class="text-xs text-gray-400 mt-3"><i class="fas fa-circle-info mr-1"></i> Envio de e-mail/WhatsApp está em modo <strong>stub/simulação</strong> — nenhum provedor real configurado ainda.</p>`;

  window.__nucleosCache = nucleosData.data;
  window.__projetosCache = projetosData.data;
}

function openCreateCampanhaModal() {
  const nucleos = window.__nucleosCache || [];
  const projetos = window.__projetosCache || [];
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Nova Campanha</h3>
    <form id="form-campanha" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Título</label>
        <input name="titulo" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Canal</label>
        <select name="canal" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          <option value="whatsapp">WhatsApp</option>
          <option value="email">E-mail</option>
          <option value="ambos">Ambos</option>
        </select>
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Segmento</label>
        <select name="segmento_tipo" id="segmento-tipo" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          <option value="nucleo">Núcleo específico</option>
          <option value="projeto">Projeto específico</option>
          ${isGlobal() ? '<option value="todos">Todos os colaboradores</option>' : ''}
        </select>
      </div>
      <div id="segmento-id-field">
        <label class="block text-sm text-gray-600 mb-1">Selecione</label>
        <select name="segmento_id" id="segmento-id" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          ${nucleos.map(n => `<option value="${n.id}">${n.nome}</option>`).join('')}
        </select>
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Corpo da mensagem (use {{nome}} para personalizar)</label>
        <textarea name="corpo_template" rows="4" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" placeholder="Olá {{nome}}, participe da nossa campanha..."></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Criar</button>
      </div>
    </form>`);

  const segmentoTipo = document.getElementById('segmento-tipo');
  const segmentoIdField = document.getElementById('segmento-id-field');
  const segmentoIdSelect = document.getElementById('segmento-id');

  function updateSegmentoOptions() {
    if (segmentoTipo.value === 'nucleo') {
      segmentoIdField.classList.remove('hidden');
      segmentoIdSelect.innerHTML = nucleos.map(n => `<option value="${n.id}">${n.nome}</option>`).join('');
    } else if (segmentoTipo.value === 'projeto') {
      segmentoIdField.classList.remove('hidden');
      segmentoIdSelect.innerHTML = projetos.map(p => `<option value="${p.id}">${p.nome}</option>`).join('');
    } else {
      segmentoIdField.classList.add('hidden');
    }
  }
  segmentoTipo.addEventListener('change', updateSegmentoOptions);
  updateSegmentoOptions();

  document.getElementById('form-campanha').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (body.segmento_id) body.segmento_id = parseInt(body.segmento_id);
    if (body.segmento_tipo === 'todos') delete body.segmento_id;
    try {
      await axios.post('/api/comunicacao/campanhas', body);
      closeModal();
      toast('Campanha criada com sucesso.');
      renderComunicacao();
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

async function enviarCampanha(id) {
  try {
    const { data } = await axios.post(`/api/comunicacao/campanhas/${id}/enviar`);
    toast(data.data.message);
  } catch (err) { toast(apiErr(err), 'error'); }
}

// ============================================================
// BOOTSTRAP
// ============================================================

async function bootstrap() {
  try {
    const { data } = await axios.get('/api/auth/me');
    CURRENT_USER = data.data;
  } catch {
    window.location.href = '/login';
    return;
  }

  document.getElementById('user-info').innerHTML = `<span class="block text-white font-medium truncate max-w-[9.5rem]">${CURRENT_USER.nome}</span><span class="block text-[11px] text-gray-500 truncate max-w-[9.5rem]">${CURRENT_USER.roles.map(r => ROLE_LABELS[r.role]).join(', ')}</span>`;
  const initials = CURRENT_USER.nome.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  document.getElementById('user-avatar').textContent = initials || '?';
  buildNav();
  router();

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await axios.post('/api/auth/logout');
    window.location.href = '/login';
  });
}

bootstrap();

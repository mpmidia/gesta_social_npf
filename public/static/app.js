// ============================================================
// Gestão Social - Frontend SPA leve (Vanilla JS + Axios + Tailwind CDN)
// ============================================================

axios.defaults.withCredentials = true;

let CURRENT_USER = null;

const ROLE_LABELS = {
  admin: 'Administrador',
  coord_geral: 'Coordenador Geral',
  coord_nucleo: 'Coordenador de Núcleo',
  articulador: 'Articulador',
  financeiro: 'Financeiro'
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
function isFinanceiro() {
  return hasRole('financeiro');
}
// Visão 360° do financeiro: SOMENTE admin e o papel dedicado "financeiro"
// enxergam todos os saldos/lançamentos/comprovantes, independente de escopo.
// Coordenador Geral NÃO tem nenhum acesso ao módulo financeiro (regra de negócio
// explícita) — por isso NÃO usa isGlobal() aqui.
function hasFinanceiroFullAccess() {
  return isAdmin() || isFinanceiro();
}
function scopedNucleoIds() {
  return (CURRENT_USER?.roles || []).filter(r => r.role === 'coord_nucleo').map(r => r.escopo_id);
}
// Pode gerir (lançar saída/gerir recursos) os recursos de um determinado núcleo:
// Admin e Financeiro sempre podem; Coordenador de Núcleo somente do seu próprio escopo.
function canManageNucleoFinance(nucleoId) {
  return isAdmin() || isFinanceiro() || scopedNucleoIds().includes(Number(nucleoId));
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
    rejeitado: 'bg-red-100 text-red-700',
    cancelado: 'bg-gray-200 text-gray-500'
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
  if (!isFinanceiro()) {
    items.push({ href: '#/colaboradores', icon: 'fa-address-card', label: 'Colaboradores' });
  }

  // Financeiro: SOMENTE Admin e o papel dedicado Financeiro têm o Painel Geral +
  // Repasses (aprovação/execução) — visão 360° de todas as operações. Coordenador
  // Geral NÃO tem nenhum acesso ao financeiro (regra de negócio explícita).
  // Articulador também nunca vê financeiro (apenas leitura institucional + Comunicação).
  if (isAdmin() || isFinanceiro()) {
    items.push({ href: '#/financeiro-geral', icon: 'fa-sack-dollar', label: 'Financeiro Geral' });
    items.push({ href: '#/repasses', icon: 'fa-money-bill-transfer', label: 'Repasses' });
  }
  // Coordenador de Núcleo: NÃO tem menu financeiro dedicado — ele gerencia os
  // recursos do seu núcleo diretamente pelas páginas de Núcleos/Projetos
  // (solicitar repasse, lançar saída), que já aparecem acima.
  // Usuários & Permissões: visível SOMENTE para administradores.
  if (isAdmin()) {
    items.push({ href: '#/usuarios', icon: 'fa-users-gear', label: 'Usuários & Permissões' });
  }
  // Comunicação: NÃO disponível ao papel Financeiro (somente operações financeiras).
  if (!isFinanceiro()) {
    items.push({ href: '#/comunicacao', icon: 'fa-bullhorn', label: 'Comunicação' });
  }

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

function visaoGeralHeader() {
  return `
    <div class="brand-gradient rounded-2xl p-6 sm:p-7 text-white mb-6 shadow-soft relative overflow-hidden">
      <div class="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-white/10"></div>
      <h3 class="text-xl font-bold relative z-10">Bem-vindo(a), ${CURRENT_USER.nome.split(' ')[0]} 👋</h3>
      <p class="text-white/85 text-sm mt-1 relative z-10">${CURRENT_USER.roles.map(r => ROLE_LABELS[r.role]).join(' · ')}</p>
    </div>`;
}

function statCard(icon, label, value, colorClass = 'bg-brand-50 text-brand-600', href) {
  const inner = `
    <div class="w-10 h-10 rounded-lg ${colorClass} flex items-center justify-center mb-3"><i class="fas ${icon}"></i></div>
    <p class="text-sm text-gray-500 mb-1">${label}</p>
    <p class="text-3xl font-bold text-gray-800">${value}</p>`;
  return href
    ? `<a href="${href}" class="gs-card gs-card-hover p-5 block">${inner}</a>`
    : `<div class="gs-card p-5">${inner}</div>`;
}

// Painel por papel: cada papel vê um panorama diferente, de acordo com o seu
// escopo de atuação (ver requisitos do RBAC redesign).
async function renderVisaoGeral() {
  const content = document.getElementById('page-content');
  content.innerHTML = `${visaoGeralHeader()}<div class="text-center text-gray-400 py-10"><i class="fas fa-spinner fa-spin text-2xl"></i></div>`;

  if (isAdmin()) return renderVisaoGeralAdmin(content);
  if (isFinanceiro()) return renderVisaoGeralFinanceiro(content);
  if (isCoordNucleo()) return renderVisaoGeralCoordNucleo(content);
  if (isArticulador()) return renderVisaoGeralArticulador(content);
  if (hasRole('coord_geral')) return renderVisaoGeralCoordGeral(content);
  content.innerHTML = `${visaoGeralHeader()}<p class="text-gray-400">Nenhum painel disponível para o seu papel.</p>`;
}

// ---- ADMIN: visão completa (tudo) ----
async function renderVisaoGeralAdmin(content) {
  const [{ data: saldoData }, { data: nucleosData }, { data: projetosData }, { data: colabData }] = await Promise.all([
    axios.get('/api/financeiro/geral/saldo'),
    axios.get('/api/nucleos'),
    axios.get('/api/projetos'),
    axios.get('/api/colaboradores/gestao').catch(() => ({ data: { data: [] } }))
  ]);

  content.innerHTML = `
    ${visaoGeralHeader()}
    <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${statCard('fa-sack-dollar', 'Saldo Geral (NFP)', fmtMoney(saldoData.data.saldo), 'bg-emerald-50 text-emerald-600', '#/financeiro-geral')}
      ${statCard('fa-people-group', 'Núcleos ativos', nucleosData.data.length, 'bg-brand-50 text-brand-600', '#/nucleos')}
      ${statCard('fa-diagram-project', 'Projetos ativos', projetosData.data.length, 'bg-brand-50 text-brand-600', '#/projetos')}
      ${statCard('fa-address-card', 'Colaboradores', colabData.data.length, 'bg-amber-50 text-amber-600', '#/colaboradores')}
    </div>
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-bolt mr-1 text-brand-500"></i>Acesso rápido</h3>
      <div class="flex flex-wrap gap-2">
        <a href="#/repasses" class="text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"><i class="fas fa-money-bill-transfer mr-1"></i>Repasses pendentes</a>
        <a href="#/usuarios" class="text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"><i class="fas fa-users-gear mr-1"></i>Usuários & Permissões</a>
        <a href="#/comunicacao" class="text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"><i class="fas fa-bullhorn mr-1"></i>Comunicação</a>
      </div>
    </div>`;
}

// ---- COORDENADOR GERAL: panorama de núcleos/projetos (ZERO financeiro) ----
async function renderVisaoGeralCoordGeral(content) {
  const { data: nucleosData } = await axios.get('/api/nucleos');
  const { data: projetosData } = await axios.get('/api/projetos');
  const nucleos = nucleosData.data;
  const projetos = projetosData.data;

  const projetosPorNucleo = (nucleoId) => projetos.filter(p => p.nucleo_id === nucleoId).length;

  content.innerHTML = `
    ${visaoGeralHeader()}
    <div class="grid sm:grid-cols-2 gap-4 mb-6">
      ${statCard('fa-people-group', 'Núcleos ativos', nucleos.filter(n => n.ativo).length, 'bg-brand-50 text-brand-600', '#/nucleos')}
      ${statCard('fa-diagram-project', 'Projetos ativos', projetos.filter(p => p.ativo).length, 'bg-brand-50 text-brand-600', '#/projetos')}
    </div>
    <div class="gs-card p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-gray-700">Panorama dos Núcleos</h3>
        <button onclick="openCreateNucleoModal()" class="text-xs text-brand-600 hover:underline font-medium"><i class="fas fa-plus mr-1"></i>Novo núcleo</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Núcleo</th><th class="py-2 pr-3">Projetos</th><th class="py-2 pr-3">Coordenadores</th><th class="py-2 pr-3">Status</th>
          </tr></thead>
          <tbody>
            ${nucleos.map(n => `
              <tr class="border-b last:border-0">
                <td class="py-2 pr-3"><a href="#/nucleos/${n.id}" class="text-brand-600 hover:underline font-medium">${n.nome}</a></td>
                <td class="py-2 pr-3">${projetosPorNucleo(n.id)}</td>
                <td class="py-2 pr-3 text-gray-400">${n.ativo ? '-' : 'Inativo'}</td>
                <td class="py-2 pr-3">${n.arquivado_em ? '<span class="text-gray-400">Arquivado</span>' : (n.ativo ? '<span class="text-emerald-600">Ativo</span>' : '<span class="text-red-500">Inativo</span>')}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="py-4 text-gray-400 text-center">Nenhum núcleo cadastrado.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;
}

// ---- COORDENADOR DE NÚCLEO: panorama do seu núcleo + projetos ----
async function renderVisaoGeralCoordNucleo(content) {
  const meuNucleoId = scopedNucleoIds()[0];
  if (!meuNucleoId) {
    content.innerHTML = `${visaoGeralHeader()}<p class="text-gray-400">Você ainda não está vinculado a nenhum núcleo.</p>`;
    return;
  }

  const [{ data: nucleoData }, saldoResult] = await Promise.all([
    axios.get(`/api/nucleos/${meuNucleoId}`),
    axios.get(`/api/financeiro/nucleo/${meuNucleoId}/saldo`).catch(() => null)
  ]);
  const n = nucleoData.data;
  const projetos = n.projetos || [];
  const saldo = saldoResult ? saldoResult.data.data.saldo : null;

  content.innerHTML = `
    ${visaoGeralHeader()}
    <div class="grid sm:grid-cols-3 gap-4 mb-6">
      ${saldo !== null ? statCard('fa-wallet', 'Saldo do Meu Núcleo', fmtMoney(saldo), 'bg-emerald-50 text-emerald-600', `#/nucleos/${meuNucleoId}`) : ''}
      ${statCard('fa-diagram-project', 'Projetos do Núcleo', projetos.length, 'bg-brand-50 text-brand-600', `#/nucleos/${meuNucleoId}`)}
      ${statCard('fa-address-card', 'Colaboradores', '', 'bg-amber-50 text-amber-600', '#/colaboradores')}
    </div>
    <div class="gs-card p-5">
      <div class="flex items-center justify-between mb-3">
        <h3 class="font-semibold text-gray-700">Panorama de Projetos — ${n.nome}</h3>
        <button onclick="openCreateProjetoModal(${meuNucleoId})" class="text-xs text-brand-600 hover:underline font-medium"><i class="fas fa-plus mr-1"></i>Novo projeto</button>
      </div>
      <ul class="text-sm space-y-2">
        ${projetos.map(p => `
          <li class="flex items-center justify-between border-b last:border-0 pb-2">
            <a href="#/projetos/${p.id}" class="text-brand-600 hover:underline font-medium">${p.nome}</a>
            <span class="${p.ativo ? 'text-emerald-600' : 'text-red-500'} text-xs">${p.ativo ? 'Ativo' : 'Inativo'}</span>
          </li>`).join('') || '<li class="text-gray-400">Nenhum projeto cadastrado ainda.</li>'}
      </ul>
    </div>`;
}

// ---- FINANCEIRO: panorama financeiro + atalho de upload da planilha NFP ----
async function renderVisaoGeralFinanceiro(content) {
  const [{ data: saldoData }, { data: nucleosData }, { data: projetosData }] = await Promise.all([
    axios.get('/api/financeiro/geral/saldo'),
    axios.get('/api/nucleos'),
    axios.get('/api/projetos')
  ]);

  // Agrega repasses pendentes de aprovação (geral->núcleo e núcleo->projeto).
  let totalPendentes = 0;
  for (const n of nucleosData.data) {
    try {
      const { data } = await axios.get(`/api/financeiro/nucleo/${n.id}/lancamentos`);
      totalPendentes += data.data.filter(l => l.tipo === 'repasse_geral_nucleo' && l.status === 'pendente').length;
    } catch { /* sem acesso, ignora */ }
  }
  for (const p of projetosData.data) {
    try {
      const { data } = await axios.get(`/api/financeiro/projeto/${p.id}/lancamentos`);
      totalPendentes += data.data.filter(l => l.tipo === 'repasse_nucleo_projeto' && l.status === 'pendente').length;
    } catch { /* sem acesso, ignora */ }
  }

  content.innerHTML = `
    ${visaoGeralHeader()}
    <div class="grid sm:grid-cols-2 gap-4 mb-6">
      ${statCard('fa-sack-dollar', 'Saldo Geral (NFP)', fmtMoney(saldoData.data.saldo), 'bg-emerald-50 text-emerald-600', '#/financeiro-geral')}
      ${statCard('fa-money-bill-transfer', 'Repasses pendentes', totalPendentes, 'bg-amber-50 text-amber-600', '#/repasses')}
    </div>
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-bolt mr-1 text-brand-500"></i>Ações rápidas</h3>
      <div class="flex flex-wrap gap-2">
        <button onclick="window.location.hash='#/financeiro-geral'; setTimeout(openImportarNfpModal, 150)" class="text-xs font-medium px-3 py-2 rounded-lg bg-brand-600 text-white hover:opacity-90"><i class="fas fa-file-import mr-1"></i>Importar planilha da NFP</button>
        <a href="#/repasses" class="text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"><i class="fas fa-money-bill-transfer mr-1"></i>Aprovar/Executar repasses</a>
        <a href="#/financeiro-geral" class="text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"><i class="fas fa-sack-dollar mr-1"></i>Painel Financeiro Geral</a>
      </div>
    </div>`;
}

// ---- ARTICULADOR: panorama de colaboradores ----
async function renderVisaoGeralArticulador(content) {
  const { data: colabData } = await axios.get('/api/colaboradores/gestao');
  const colaboradores = colabData.data;
  const { data: nucleosData } = await axios.get('/api/nucleos');

  const validados = colaboradores.filter(c => c.validado_em).length;
  const pendentes = colaboradores.length - validados;
  const porNucleo = {};
  colaboradores.forEach(c => {
    const key = c.nucleo_id || 'sem_nucleo';
    porNucleo[key] = (porNucleo[key] || 0) + 1;
  });

  content.innerHTML = `
    ${visaoGeralHeader()}
    <div class="grid sm:grid-cols-3 gap-4 mb-6">
      ${statCard('fa-address-card', 'Colaboradores', colaboradores.length, 'bg-amber-50 text-amber-600', '#/colaboradores')}
      ${statCard('fa-circle-check', 'Validados', validados, 'bg-emerald-50 text-emerald-600', '#/colaboradores')}
      ${statCard('fa-clock', 'Pendentes de validação', pendentes, 'bg-gray-100 text-gray-500', '#/colaboradores')}
    </div>
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3">Colaboradores por Núcleo</h3>
      <ul class="text-sm space-y-1">
        ${nucleosData.data.map(n => `
          <li class="flex items-center justify-between border-b last:border-0 py-1.5">
            <span>${n.nome}</span>
            <span class="font-medium text-gray-700">${porNucleo[n.id] || 0}</span>
          </li>`).join('') || '<li class="text-gray-400">Nenhum núcleo cadastrado.</li>'}
      </ul>
      <div class="flex gap-2 mt-4">
        <a href="#/comunicacao" class="text-xs font-medium px-3 py-2 rounded-lg bg-brand-600 text-white hover:opacity-90"><i class="fas fa-bullhorn mr-1"></i>Nova campanha</a>
        <a href="#/colaboradores" class="text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50"><i class="fas fa-address-card mr-1"></i>Ver colaboradores</a>
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
  // Gestão de coordenadores do núcleo: Admin e Coordenador Geral (não o próprio
  // coord_nucleo, que não pode se auto-gerenciar).
  const canManageCoordenadores = isGlobal();
  // Solicitar repasse do Geral para este núcleo: Admin, Financeiro (visão 360°) ou
  // o Coordenador do próprio núcleo. Coordenador Geral NÃO vê nada de financeiro.
  const canRequestRepasseNucleo = isAdmin() || isFinanceiro() || scopedNucleoIds().includes(Number(id));

  document.getElementById('page-content').innerHTML = `
    <a href="#/nucleos" class="text-sm text-brand-600 hover:underline font-medium mb-4 inline-block"><i class="fas fa-arrow-left mr-1"></i> Voltar</a>
    <div class="grid lg:grid-cols-3 gap-4 mb-6">
      <div class="lg:col-span-2 gs-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-xl font-bold text-gray-800 mb-1">${n.nome} ${n.arquivado_em ? '<span class="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full align-middle">Arquivado</span>' : ''}</h2>
            <p class="text-gray-500 text-sm mb-3">${n.descricao || ''}</p>
            <p class="text-xs text-gray-400"><i class="fas fa-link mr-1"></i> <a href="/n/${n.slug_publico}" target="_blank" class="text-brand-600 hover:underline font-medium">/n/${n.slug_publico}</a></p>
          </div>
          ${canManage && !n.arquivado_em ? `
          <div class="flex gap-2 shrink-0">
            <button onclick="openEditNucleoModal(${id})" class="text-xs text-gray-600 hover:text-brand-600 border border-gray-300 rounded-lg px-3 py-1.5"><i class="fas fa-pen mr-1"></i>Editar</button>
            ${isGlobal() ? `<button onclick="excluirOuArquivarNucleo(${id})" class="text-xs text-red-600 hover:text-red-700 border border-red-200 rounded-lg px-3 py-1.5"><i class="fas fa-trash mr-1"></i>Excluir/Arquivar</button>` : ''}
          </div>` : ''}
        </div>
      </div>
      <div class="gs-card p-5">
        <p class="text-sm text-gray-500 mb-1">Saldo do Núcleo</p>
        ${saldoHtml}
      </div>
    </div>

    <div class="grid lg:grid-cols-2 gap-4 mb-6">
      ${canManageCoordenadores ? `
      <div class="gs-card p-5">
        <h3 class="font-semibold text-gray-700 mb-3">Coordenadores</h3>
        <ul class="text-sm space-y-1">
          ${(n.coordenadores || []).map(cd => `
            <li class="flex items-center justify-between gap-2">
              <span><i class="fas fa-user mr-1 text-gray-400"></i> ${cd.nome} (${cd.email})</span>
              <span class="shrink-0 space-x-2">
                <button onclick="openAddCoordenadorModal(${id}, ${cd.id}, '${cd.nome.replace(/'/g, "\\'")}')" class="text-xs text-amber-600 hover:underline"><i class="fas fa-retweet mr-0.5"></i>Substituir</button>
                <button onclick="removerCoordenador(${id}, ${cd.id}, '${cd.nome.replace(/'/g, "\\'")}')" class="text-xs text-red-500 hover:underline"><i class="fas fa-times mr-0.5"></i>Remover</button>
              </span>
            </li>`).join('') || '<li class="text-gray-400">Nenhum coordenador vinculado.</li>'}
        </ul>
        <button onclick="openAddCoordenadorModal(${id})" class="mt-3 text-sm text-brand-600 hover:underline font-medium"><i class="fas fa-plus mr-1"></i>Cadastrar coordenador</button>
      </div>` : ''}
      <div class="gs-card p-5 ${canManageCoordenadores ? '' : 'lg:col-span-2'}">
        <h3 class="font-semibold text-gray-700 mb-3">Projetos</h3>
        <ul class="text-sm space-y-1">
          ${(n.projetos || []).map(p => `<li><a href="#/projetos/${p.id}" class="text-brand-600 hover:underline font-medium">${p.nome}</a></li>`).join('') || '<li class="text-gray-400">Nenhum projeto cadastrado.</li>'}
        </ul>
        ${canManage ? `<button onclick="openCreateProjetoModal(${id})" class="mt-3 text-sm text-brand-600 hover:underline font-medium"><i class="fas fa-plus mr-1"></i>Novo projeto</button>` : ''}
      </div>
    </div>

    ${canRequestRepasseNucleo ? `
    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3">Solicitar repasse do Geral para este Núcleo</h3>
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

    ${hasFinanceiroFullAccess() ? `
    <div class="gs-card p-5 mt-6">
      <h3 class="font-semibold text-gray-700 mb-3">Histórico Financeiro do Núcleo</h3>
      <div id="nucleo-lancamentos">Carregando...</div>
    </div>` : ''}`;

  if (canRequestRepasseNucleo) {
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

function openEditNucleoModal(nucleoId) {
  axios.get(`/api/nucleos/${nucleoId}`).then(({ data }) => {
    const n = data.data;
    openModal(`
      <h3 class="text-lg font-bold text-gray-800 mb-4">Editar Núcleo</h3>
      <form id="form-edit-nucleo" class="space-y-3">
        <div>
          <label class="block text-sm text-gray-600 mb-1">Nome</label>
          <input name="nome" required value="${n.nome.replace(/"/g, '&quot;')}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">Descrição</label>
          <textarea name="descricao" rows="3" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">${n.descricao || ''}</textarea>
        </div>
        <label class="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" name="ativo" ${n.ativo ? 'checked' : ''} /> Ativo (visível na página pública)
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
          <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Salvar</button>
        </div>
      </form>`);

    document.getElementById('form-edit-nucleo').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { nome: fd.get('nome'), descricao: fd.get('descricao'), ativo: fd.get('ativo') === 'on' };
      try {
        await axios.put(`/api/nucleos/${nucleoId}`, body);
        closeModal();
        toast('Núcleo atualizado.');
        renderNucleoDetalhe(nucleoId);
      } catch (err) { toast(apiErr(err), 'error'); }
    });
  });
}

async function excluirOuArquivarNucleo(nucleoId) {
  if (!confirm('Confirma excluir este núcleo? Se possuir histórico financeiro (mesmo zerado), ele será ARQUIVADO em vez de excluído, para preservar a rastreabilidade.')) return;
  try {
    const { data } = await axios.delete(`/api/nucleos/${nucleoId}`);
    toast(data.data.message);
    window.location.hash = '#/nucleos';
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function removerCoordenador(nucleoId, userId, nome) {
  if (!confirm(`Remover ${nome} da coordenação deste núcleo?`)) return;
  try {
    await axios.delete(`/api/nucleos/${nucleoId}/coordenadores/${userId}`);
    toast('Coordenador removido.');
    renderNucleoDetalhe(nucleoId);
  } catch (err) { toast(apiErr(err), 'error'); }
}

// Cadastro de Coordenador de Núcleo diretamente pelo painel do núcleo — o
// Coordenador Geral NÃO tem mais acesso à tela global de Usuários & Permissões
// (exclusiva do Administrador), então este modal nunca consulta /api/auth/usuarios.
// Dois modos: "novo" (cria usuário do zero) ou "existente" (reaproveita um
// usuário já cadastrado pelo e-mail, reatribuindo o papel dele).
function openAddCoordenadorModal(nucleoId, substituirUserId, substituirNome) {
  const titulo = substituirUserId ? `Substituir Coordenador (${substituirNome})` : 'Cadastrar Coordenador de Núcleo';
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">${titulo}</h3>
    <div class="flex gap-2 mb-4 border-b border-gray-200">
      <button type="button" id="tab-novo" class="px-3 py-2 text-sm font-medium border-b-2 border-brand-600 text-brand-600">Novo usuário</button>
      <button type="button" id="tab-existente" class="px-3 py-2 text-sm font-medium border-b-2 border-transparent text-gray-500">Usuário existente</button>
    </div>
    <form id="form-add-coord" class="space-y-3">
      <input type="hidden" name="modo" id="coord-modo" value="novo" />
      <div id="campos-novo" class="space-y-3">
        <div>
          <label class="block text-sm text-gray-600 mb-1">Nome</label>
          <input name="nome" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">E-mail</label>
          <input name="email" type="email" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">Senha</label>
          <input name="senha" type="password" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
        </div>
      </div>
      <div id="campos-existente" class="space-y-3 hidden">
        <div>
          <label class="block text-sm text-gray-600 mb-1">E-mail do usuário já cadastrado</label>
          <input name="email_existente" type="email" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" placeholder="usuario@email.com" />
          <p class="text-xs text-gray-400 mt-1">O papel atual deste usuário será substituído por "Coordenador de Núcleo" deste núcleo.</p>
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">${substituirUserId ? 'Substituir' : 'Cadastrar'}</button>
      </div>
    </form>`);

  const tabNovo = document.getElementById('tab-novo');
  const tabExistente = document.getElementById('tab-existente');
  const camposNovo = document.getElementById('campos-novo');
  const camposExistente = document.getElementById('campos-existente');
  const modoInput = document.getElementById('coord-modo');

  function setModo(modo) {
    modoInput.value = modo;
    const ehNovo = modo === 'novo';
    camposNovo.classList.toggle('hidden', !ehNovo);
    camposExistente.classList.toggle('hidden', ehNovo);
    tabNovo.classList.toggle('border-brand-600', ehNovo);
    tabNovo.classList.toggle('text-brand-600', ehNovo);
    tabNovo.classList.toggle('border-transparent', !ehNovo);
    tabNovo.classList.toggle('text-gray-500', !ehNovo);
    tabExistente.classList.toggle('border-brand-600', !ehNovo);
    tabExistente.classList.toggle('text-brand-600', !ehNovo);
    tabExistente.classList.toggle('border-transparent', ehNovo);
    tabExistente.classList.toggle('text-gray-500', ehNovo);
  }
  tabNovo.addEventListener('click', () => setModo('novo'));
  tabExistente.addEventListener('click', () => setModo('existente'));

  document.getElementById('form-add-coord').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const modo = fd.get('modo');
    const body = modo === 'existente'
      ? { modo: 'existente', email: fd.get('email_existente') }
      : { modo: 'novo', nome: fd.get('nome'), email: fd.get('email'), senha: fd.get('senha') };
    try {
      await axios.post(`/api/nucleos/${nucleoId}/coordenadores`, body);
      closeModal();
      toast(substituirUserId ? 'Coordenador substituído.' : 'Coordenador cadastrado.');
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

function openEditProjetoModal(projetoId) {
  axios.get(`/api/projetos/${projetoId}`).then(({ data }) => {
    const p = data.data;
    openModal(`
      <h3 class="text-lg font-bold text-gray-800 mb-4">Editar Projeto</h3>
      <form id="form-edit-projeto" class="space-y-3">
        <div>
          <label class="block text-sm text-gray-600 mb-1">Nome</label>
          <input name="nome" required value="${p.nome.replace(/"/g, '&quot;')}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">Descrição</label>
          <textarea name="descricao" rows="3" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">${p.descricao || ''}</textarea>
        </div>
        <label class="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''} /> Ativo (visível na página pública)
        </label>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
          <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Salvar</button>
        </div>
      </form>`);

    document.getElementById('form-edit-projeto').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = { nome: fd.get('nome'), descricao: fd.get('descricao'), ativo: fd.get('ativo') === 'on' };
      try {
        await axios.put(`/api/projetos/${projetoId}`, body);
        closeModal();
        toast('Projeto atualizado.');
        renderProjetoDetalhe(projetoId);
      } catch (err) { toast(apiErr(err), 'error'); }
    });
  });
}

async function excluirOuArquivarProjeto(projetoId) {
  if (!confirm('Confirma excluir este projeto? Se possuir histórico financeiro (mesmo zerado), ele será ARQUIVADO em vez de excluído, para preservar a rastreabilidade.')) return;
  try {
    const { data } = await axios.delete(`/api/projetos/${projetoId}`);
    toast(data.data.message);
    window.location.hash = '#/projetos';
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function renderProjetoDetalhe(id) {
  const { data } = await axios.get(`/api/projetos/${id}`);
  const p = data.data;
  let saldoHtml = '';
  try {
    const { data: saldoData } = await axios.get(`/api/financeiro/projeto/${id}/saldo`);
    saldoHtml = `<p class="text-2xl font-bold text-emerald-600">${fmtMoney(saldoData.data.saldo)}</p>`;
  } catch { saldoHtml = '<p class="text-gray-400 text-sm">Sem acesso ao saldo</p>'; }

  let saldoNucleoHtml = '';
  try {
    const { data: saldoNucleoData } = await axios.get(`/api/financeiro/nucleo/${p.nucleo_id}/saldo`);
    saldoNucleoHtml = `<p class="text-2xl font-bold text-brand-600">${fmtMoney(saldoNucleoData.data.saldo)}</p>`;
  } catch { saldoNucleoHtml = '<p class="text-gray-400 text-sm">Sem acesso ao saldo</p>'; }

  // Solicitar repasse do Núcleo para este Projeto: Admin, Financeiro (visão 360°)
  // ou o Coordenador do núcleo dono do projeto. Coordenador Geral NÃO vê financeiro.
  const canRequestRepasse = isAdmin() || isFinanceiro() || scopedNucleoIds().includes(p.nucleo_id);

  // Editar/gerir o projeto em si (não financeiro): Admin e Coordenador Geral têm
  // gestão plena de núcleos/projetos; Coordenador de Núcleo gerencia o seu.
  const canEditProjeto = isGlobal() || scopedNucleoIds().includes(p.nucleo_id);

  document.getElementById('page-content').innerHTML = `
    <a href="#/projetos" class="text-sm text-brand-600 hover:underline font-medium mb-4 inline-block"><i class="fas fa-arrow-left mr-1"></i> Voltar</a>
    <div class="grid lg:grid-cols-3 gap-4 mb-6">
      <div class="lg:col-span-2 gs-card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-xl font-bold text-gray-800 mb-1">${p.nome} ${p.arquivado_em ? '<span class="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full align-middle">Arquivado</span>' : ''}</h2>
            <p class="text-gray-500 text-sm mb-3">${p.descricao || ''}</p>
            <p class="text-xs text-gray-400"><i class="fas fa-link mr-1"></i> <a href="/p/${p.slug_publico}" target="_blank" class="text-brand-600 hover:underline font-medium">/p/${p.slug_publico}</a></p>
          </div>
          ${canEditProjeto && !p.arquivado_em ? `
          <div class="flex gap-2 shrink-0">
            <button onclick="openEditProjetoModal(${id})" class="text-xs text-gray-600 hover:text-brand-600 border border-gray-300 rounded-lg px-3 py-1.5"><i class="fas fa-pen mr-1"></i>Editar</button>
            <button onclick="excluirOuArquivarProjeto(${id})" class="text-xs text-red-600 hover:text-red-700 border border-red-200 rounded-lg px-3 py-1.5"><i class="fas fa-trash mr-1"></i>Excluir/Arquivar</button>
          </div>` : ''}
        </div>
      </div>
      <div class="gs-card p-5 space-y-3">
        <div>
          <p class="text-sm text-gray-500 mb-1">Saldo do Núcleo</p>
          ${saldoNucleoHtml}
        </div>
        <div class="pt-2 border-t border-gray-100">
          <p class="text-sm text-gray-500 mb-1">Saldo do Projeto</p>
          ${saldoHtml}
        </div>
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

    <div class="gs-card p-5 mb-6">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-arrow-down mr-1 text-emerald-500"></i>Repasses Recebidos (Núcleo → Projeto)</h3>
      <div id="projeto-repasses">Carregando...</div>
    </div>

    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-3"><i class="fas fa-arrow-up mr-1 text-red-500"></i>Lançamentos de Saída (Pagamentos)</h3>
      <div id="projeto-saidas">Carregando...</div>
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
    const todos = lancamentos.data || [];
    const repasses = todos.filter(l => l.tipo === 'repasse_nucleo_projeto');
    const saidas = todos.filter(l => l.tipo === 'saida_pagamento' || l.tipo === 'saida_manual');
    document.getElementById('projeto-repasses').innerHTML = renderLancamentosTable(repasses);
    document.getElementById('projeto-saidas').innerHTML = renderLancamentosTable(saidas);
  } catch {
    document.getElementById('projeto-repasses').innerHTML = '<p class="text-gray-400 text-sm">Sem acesso ao histórico financeiro.</p>';
    document.getElementById('projeto-saidas').innerHTML = '<p class="text-gray-400 text-sm">Sem acesso ao histórico financeiro.</p>';
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

function renderLancamentosTable(lancamentos, opts = {}) {
  const permitirEdicaoManual = !!opts.permitirEdicaoManual;
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
        ${lancamentos.map(l => {
          const ehManual = l.tipo === 'entrada_manual' || l.tipo === 'saida_manual';
          const acoes = [];
          if (l.status === 'executado') acoes.push(`<button onclick="verComprovantes(${l.id})" class="text-brand-600 hover:underline text-xs font-medium">Comprovantes</button>`);
          if (permitirEdicaoManual && ehManual && l.status === 'executado') {
            acoes.push(`<button onclick="editarLancamentoManual(${l.id})" class="text-amber-600 hover:underline text-xs font-medium">Editar</button>`);
            if (isAdmin()) acoes.push(`<button onclick="excluirLancamentoManual(${l.id})" class="text-red-600 hover:underline text-xs font-medium">Excluir</button>`);
          }
          return `
          <tr class="border-b last:border-0">
            <td class="py-2 pr-3">${tipoLancamentoLabel(l.tipo)}</td>
            <td class="py-2 pr-3 font-medium ${l.tipo === 'saida_manual' ? 'text-red-600' : ''}">${fmtMoney(l.valor)}</td>
            <td class="py-2 pr-3">${statusBadge(l.status)}</td>
            <td class="py-2 pr-3 text-gray-500">${l.finalidade || '-'}</td>
            <td class="py-2 pr-3 text-gray-400">${fmtDate(l.created_at)}</td>
            <td class="py-2 pr-3 whitespace-nowrap space-x-2">${acoes.join('') || '-'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

function tipoLancamentoLabel(tipo) {
  const labels = {
    entrada_nfp: 'Entrada NFP (planilha)',
    entrada_manual: 'Entrada manual',
    saida_manual: 'Saída manual',
    repasse_geral_nucleo: 'Repasse Geral → Núcleo',
    repasse_nucleo_projeto: 'Repasse Núcleo → Projeto',
    saida_pagamento: 'Saída (pagamento)'
  };
  return labels[tipo] || tipo;
}

function comprovanteStatusLabel(cp) {
  if (cp.arquivado_em) {
    return '<span class="text-xs text-gray-500"><i class="fas fa-box-archive mr-1"></i>Arquivado manualmente</span>';
  }
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
    const podeBaixarEArquivar = isAdmin() || isFinanceiro();
    openModal(`
      <h3 class="text-lg font-bold text-gray-800 mb-4">Comprovantes</h3>
      <p class="text-xs text-gray-500 mb-3">Anexado pelo Coordenador do Núcleo e disponibilizado ao Administrador/Financeiro para download. O arquivo fica disponível até o primeiro download; depois disso é removido do armazenamento em 30 dias. O registro do comprovante é mantido para fins de auditoria.</p>
      <ul class="space-y-2">
        ${comprovantes.map(cp => `
          <li class="flex items-center justify-between border rounded-lg px-3 py-2 gap-3">
            <div class="min-w-0">
              <span class="text-sm block truncate"><i class="fas fa-file-invoice mr-1 text-gray-400"></i> ${cp.tipo} — ${cp.nome_arquivo || 'arquivo'}</span>
              ${comprovanteStatusLabel(cp)}
            </div>
            <span class="shrink-0 flex items-center gap-2">
              ${!podeBaixarEArquivar ? '<span class="text-xs text-gray-400 italic whitespace-nowrap">Apenas Admin/Financeiro baixam</span>' : ''}
              ${podeBaixarEArquivar && !cp.expirado && !cp.arquivado_em
                ? `<a href="/api/financeiro/comprovantes/${cp.id}/arquivo" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white hover:bg-brand-700 text-xs font-medium whitespace-nowrap"><i class="fas fa-download"></i> Baixar</a>`
                : ''}
              ${podeBaixarEArquivar && !cp.arquivado_em
                ? `<button onclick="arquivarComprovante(${cp.id}, ${lancamentoId})" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 text-xs font-medium whitespace-nowrap"><i class="fas fa-box-archive"></i> Arquivar</button>`
                : ''}
              ${(cp.expirado || cp.arquivado_em) && !podeBaixarEArquivar ? '<span class="text-xs text-gray-400 font-medium whitespace-nowrap">Indisponível</span>' : ''}
            </span>
          </li>`).join('') || '<li class="text-gray-400 text-sm">Nenhum comprovante.</li>'}
      </ul>
      <div class="flex justify-end pt-4"><button onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Fechar</button></div>`);
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function arquivarComprovante(comprovanteId, lancamentoId) {
  if (!confirm('Arquivar este comprovante? O arquivo será removido do armazenamento imediatamente (o registro permanece para auditoria).')) return;
  try {
    await axios.post(`/api/financeiro/comprovantes/${comprovanteId}/arquivar`);
    toast('Comprovante arquivado.');
    verComprovantes(lancamentoId);
  } catch (err) { toast(apiErr(err), 'error'); }
}

// ============================================================
// FINANCEIRO GERAL
// ============================================================

async function renderFinanceiroGeral() {
  const [{ data: saldoData }, { data: importacoesData }] = await Promise.all([
    axios.get('/api/financeiro/geral/saldo'),
    axios.get('/api/financeiro/geral/importacoes')
  ]);
  const importacoes = importacoesData.data;
  // Admin e Financeiro podem lançar manual/importar a planilha da NFP. Coordenador
  // Geral NÃO tem nenhum acesso ao financeiro (não deveria nem chegar nesta tela).
  const podeGerir = isAdmin() || isFinanceiro();

  document.getElementById('page-content').innerHTML = `
    <div class="gs-card p-5 mb-6 flex items-center justify-between flex-wrap gap-4">
      <div>
        <p class="text-sm text-gray-500 mb-1">Saldo Geral Disponível</p>
        <p class="text-3xl font-bold text-emerald-600">${fmtMoney(saldoData.data.saldo)}</p>
      </div>
      ${podeGerir ? `
      <div class="flex gap-2">
        <button onclick="openLancamentoManualModal('entrada')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">
          <i class="fas fa-plus mr-1"></i> Lançamento manual
        </button>
        <button onclick="openImportarNfpModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">
          <i class="fas fa-file-import mr-1"></i> Importar planilha da NFP
        </button>
      </div>` : ''}
    </div>

    <div class="gs-card p-5 mb-6">
      <h3 class="font-semibold text-gray-700 mb-2"><i class="fas fa-magnifying-glass mr-1 text-gray-400"></i>Buscar um registro específico</h3>
      <p class="text-xs text-gray-500 mb-3">Busque por CNPJ do emitente, nome do emitente ou número da nota fiscal — em vez de listar todos os lançamentos do Painel Geral.</p>
      <form id="form-busca-geral" class="flex gap-2">
        <input name="q" placeholder="CNPJ, emitente ou número da NF..." class="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Buscar</button>
      </form>
      <div id="resultado-busca-geral" class="mt-4"></div>
    </div>

    <div class="gs-card p-5">
      <h3 class="font-semibold text-gray-700 mb-1">Status das importações da planilha NFP</h3>
      <p class="text-xs text-gray-500 mb-3">O Painel Geral só recebe entradas pela importação da planilha de créditos exportada do site da Nota Fiscal Paulista. Reimportar o mesmo arquivo atualizado não duplica lançamentos já processados.</p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-gray-500 border-b">
            <th class="py-2 pr-3">Data</th><th class="py-2 pr-3">Arquivo</th><th class="py-2 pr-3">Linhas no arquivo</th>
            <th class="py-2 pr-3">Elegíveis</th><th class="py-2 pr-3">Novas</th><th class="py-2 pr-3">Duplicadas</th>
            <th class="py-2 pr-3">Ignoradas</th><th class="py-2 pr-3">Valor importado</th><th class="py-2 pr-3">Por</th><th class="py-2 pr-3">Planilha</th>
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
                <td class="py-2 pr-3">${i.arquivo_original_key ? `<a href="/api/financeiro/geral/importacoes/${i.id}/arquivo" class="text-brand-600 hover:underline text-xs font-medium"><i class="fas fa-download mr-1"></i>Baixar</a>` : '<span class="text-xs text-gray-300">-</span>'}</td>
              </tr>`).join('') || '<tr><td colspan="10" class="py-3 text-gray-400 text-sm">Nenhuma importação realizada ainda.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('form-busca-geral').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q');
    const container = document.getElementById('resultado-busca-geral');
    container.innerHTML = '<p class="text-gray-400 text-sm"><i class="fas fa-spinner fa-spin mr-1"></i>Buscando...</p>';
    try {
      const { data } = await axios.get('/api/financeiro/geral/buscar', { params: { q } });
      const { creditosNfp, lancamentosManuais } = data.data;
      if (!creditosNfp.length && !lancamentosManuais.length) {
        container.innerHTML = '<p class="text-gray-400 text-sm">Nenhum registro encontrado.</p>';
        return;
      }
      container.innerHTML = `
        ${creditosNfp.length ? `
        <div class="overflow-x-auto mb-3">
          <table class="w-full text-sm">
            <thead><tr class="text-left text-gray-500 border-b">
              <th class="py-2 pr-3">CNPJ</th><th class="py-2 pr-3">Emitente</th><th class="py-2 pr-3">NF</th>
              <th class="py-2 pr-3">Emissão</th><th class="py-2 pr-3">Crédito</th><th class="py-2 pr-3">Situação</th><th class="py-2 pr-3">Status</th>
            </tr></thead>
            <tbody>
              ${creditosNfp.map(cr => `
                <tr class="border-b last:border-0">
                  <td class="py-2 pr-3">${cr.cnpj_emitente}</td>
                  <td class="py-2 pr-3">${cr.emitente}</td>
                  <td class="py-2 pr-3">${cr.numero_nf}</td>
                  <td class="py-2 pr-3">${cr.data_emissao}</td>
                  <td class="py-2 pr-3 font-medium">${fmtMoney(cr.creditos)}</td>
                  <td class="py-2 pr-3 text-xs text-gray-500">${cr.situacao_credito}</td>
                  <td class="py-2 pr-3">${statusBadge(cr.lancamento_status)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
        ${lancamentosManuais.length ? `
        <h4 class="text-xs font-semibold text-gray-500 uppercase mt-2 mb-1">Lançamentos manuais</h4>
        ${renderLancamentosTable(lancamentosManuais, { permitirEdicaoManual: podeGerir })}` : ''}`;
    } catch (err) {
      container.innerHTML = `<p class="text-red-500 text-sm">${apiErr(err)}</p>`;
    }
  });
}

function openLancamentoManualModal(direcaoInicial) {
  openModal(`
    <h3 class="text-lg font-bold text-gray-800 mb-4">Novo lançamento manual</h3>
    <p class="text-sm text-gray-600 mb-3">Use para ajustes pontuais que não vêm da planilha da NFP (ex.: estorno, taxa bancária, correção de valor). Justificativa obrigatória — fica registrada na auditoria.</p>
    <form id="form-lancamento-manual" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Direção</label>
        <select name="direcao" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          <option value="entrada" ${direcaoInicial === 'entrada' ? 'selected' : ''}>Entrada (soma ao saldo)</option>
          <option value="saida" ${direcaoInicial === 'saida' ? 'selected' : ''}>Saída (subtrai do saldo)</option>
        </select>
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Valor (R$)</label>
        <input name="valor" type="number" step="0.01" min="0.01" required class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Finalidade / Justificativa</label>
        <textarea name="finalidade" required rows="2" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"></textarea>
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" id="btn-lancamento-manual" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Lançar</button>
      </div>
    </form>`);

  document.getElementById('form-lancamento-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btn-lancamento-manual');
    const fd = new FormData(e.target);
    btn.disabled = true;
    try {
      await axios.post('/api/financeiro/geral/lancamentos-manuais', {
        direcao: fd.get('direcao'),
        valor: parseFloat(fd.get('valor')),
        finalidade: fd.get('finalidade')
      });
      closeModal();
      toast('Lançamento manual registrado.');
      renderFinanceiroGeral();
    } catch (err) {
      toast(apiErr(err), 'error');
      btn.disabled = false;
    }
  });
}

async function editarLancamentoManual(id) {
  const valor = prompt('Novo valor (R$):');
  if (valor === null) return;
  const valorNum = parseFloat(valor.replace(',', '.'));
  if (!valorNum || valorNum <= 0) { toast('Valor inválido.', 'error'); return; }
  const finalidade = prompt('Finalidade / justificativa:');
  if (finalidade === null || !finalidade.trim()) { toast('Finalidade é obrigatória.', 'error'); return; }
  try {
    await axios.put(`/api/financeiro/geral/lancamentos-manuais/${id}`, { valor: valorNum, finalidade });
    toast('Lançamento atualizado.');
    renderFinanceiroGeral();
  } catch (err) { toast(apiErr(err), 'error'); }
}

async function excluirLancamentoManual(id) {
  if (!confirm('Excluir (cancelar) este lançamento manual? O registro é mantido para auditoria, mas deixa de contar no saldo.')) return;
  try {
    await axios.delete(`/api/financeiro/geral/lancamentos-manuais/${id}`);
    toast('Lançamento cancelado.');
    renderFinanceiroGeral();
  } catch (err) { toast(apiErr(err), 'error'); }
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

  // Regra de aprovação: Admin ou Financeiro aprovam qualquer tipo de repasse
  // (geral→núcleo ou núcleo→projeto). Coordenador Geral NÃO tem acesso ao
  // financeiro, portanto nunca aprova.
  function podeAprovar(l) {
    return isAdmin() || isFinanceiro();
  }
  const podeExecutar = isAdmin() || isFinanceiro();
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
                  ${l.status === 'aprovado' && podeExecutar ? `<button onclick="openExecutarRepasseModal(${l.id})" class="text-brand-600 hover:underline text-xs font-medium">Executar</button>` : ''}
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
    <p class="text-sm text-gray-600 mb-3">Não é mais necessário anexar comprovante bancário. Ao executar, o sistema gera automaticamente uma <strong>fatura</strong> para ser enviada ao coordenador do núcleo responsável.</p>
    <form id="form-executar" class="space-y-3">
      <div>
        <label class="block text-sm text-gray-600 mb-1">E-mail para envio da fatura (opcional)</label>
        <input type="email" name="enviar_para" placeholder="coordenador@email.com" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div class="flex justify-end gap-2 pt-2">
        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Cancelar</button>
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition"><i class="fas fa-file-invoice mr-1"></i>Executar e gerar fatura</button>
      </div>
    </form>`);

  document.getElementById('form-executar').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      const { data } = await axios.post(`/api/financeiro/repasses/${id}/executar`, body);
      closeModal();
      const faturaId = data.data.fatura_id;
      openModal(`
        <h3 class="text-lg font-bold text-gray-800 mb-4"><i class="fas fa-circle-check text-emerald-500 mr-1"></i>Repasse executado</h3>
        <p class="text-sm text-gray-600 mb-4">Fatura <strong>${data.data.numero}</strong> gerada com sucesso.</p>
        <div class="flex justify-end gap-2">
          ${faturaId ? `<a href="/api/financeiro/faturas/${faturaId}" target="_blank" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition"><i class="fas fa-eye mr-1"></i>Ver / Imprimir Fatura</a>` : ''}
          <button onclick="closeModal(); renderRepasses();" class="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg">Fechar</button>
        </div>`);
    } catch (err) { toast(apiErr(err), 'error'); }
  });
}

// ============================================================
// COLABORADORES
// ============================================================

// Para Admin/Coord_Geral/Coord_Nucleo: tabela completa com ação de validar.
// Para Articulador: visão mais CONCISA (cards agrupados por núcleo, sem colunas
// operacionais de CPF/validação) — ele precisa articular com colaboradores
// (campanhas de comunicação), não gerenciar cadastro/validação deles.
async function renderColaboradores() {
  const { data: nucleosData } = await axios.get('/api/nucleos').catch(() => ({ data: { data: [] } }));
  window.__nucleosCacheColab = nucleosData.data;

  if (isArticulador() && !isGlobal()) {
    return renderColaboradoresArticulador();
  }

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

// Visão concisa do Articulador: filtro por núcleo + cards simples (nome + whatsapp),
// focada em "quem articular", não em gestão de cadastro.
async function renderColaboradoresArticulador(nucleoFiltroId) {
  const nucleos = window.__nucleosCacheColab || [];
  const params = {};
  if (nucleoFiltroId) params.nucleo_id = nucleoFiltroId;
  const { data } = await axios.get('/api/colaboradores/gestao', { params });
  const colaboradores = data.data;

  document.getElementById('page-content').innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <p class="text-sm text-gray-500">${colaboradores.length} colaborador(es) ${nucleoFiltroId ? 'neste núcleo' : 'no total'}</p>
      <div class="flex items-center gap-2">
        <select id="filtro-nucleo-colab" class="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition">
          <option value="">Todos os núcleos</option>
          ${nucleos.map(n => `<option value="${n.id}" ${String(nucleoFiltroId) === String(n.id) ? 'selected' : ''}>${n.nome}</option>`).join('')}
        </select>
        <a href="#/comunicacao" class="text-xs font-medium px-3 py-2 rounded-lg bg-brand-600 text-white hover:opacity-90 whitespace-nowrap"><i class="fas fa-bullhorn mr-1"></i>Nova campanha</a>
      </div>
    </div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
      ${colaboradores.map(cl => `
        <div class="gs-card p-4">
          <p class="font-semibold text-gray-800 truncate">${cl.nome}</p>
          <p class="text-xs text-gray-400 mb-2"><i class="fab fa-whatsapp mr-1 text-emerald-500"></i>${cl.whatsapp}</p>
          <span class="text-xs font-medium px-2 py-0.5 rounded-full ${cl.validado_em ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}">${cl.validado_em ? 'Validado' : 'Pendente'}</span>
        </div>`).join('') || '<p class="text-gray-400 col-span-full text-center py-8">Nenhum colaborador encontrado.</p>'}
    </div>`;

  document.getElementById('filtro-nucleo-colab').addEventListener('change', (e) => {
    renderColaboradoresArticulador(e.target.value || undefined);
  });
}

async function validarColaborador(id) {
  try {
    await axios.post(`/api/colaboradores/gestao/${id}/validar`);
    toast('Colaborador validado.');
    renderColaboradores();
  } catch (err) { toast(apiErr(err), 'error'); }
}

// ============================================================
// USUÁRIOS & PERMISSÕES (somente admin)
// ============================================================
//
// Tela redesenhada: lista em CARDS (nome + papel + status) para leitura rápida;
// clicar em um card abre um modal de DETALHE/EDIÇÃO que consolida todas as
// ações sensíveis (trocar papel, promover a admin, resetar senha, ativar/
// desativar, excluir) em um único lugar, em vez de botões inline espalhados
// numa tabela densa.

let USUARIOS_CACHE = [];
let USUARIOS_FILTRO = '';

function roleBadgeColor(role) {
  const map = {
    admin: 'bg-purple-100 text-purple-700',
    coord_geral: 'bg-blue-100 text-blue-700',
    coord_nucleo: 'bg-teal-100 text-teal-700',
    financeiro: 'bg-emerald-100 text-emerald-700',
    articulador: 'bg-amber-100 text-amber-700'
  };
  return map[role] || 'bg-gray-100 text-gray-700';
}

function usuarioIniciais(nome) {
  return (nome || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
}

async function renderUsuarios() {
  const { data } = await axios.get('/api/auth/usuarios');
  USUARIOS_CACHE = data.data;
  renderUsuariosLista();
}

function renderUsuariosLista() {
  const termo = USUARIOS_FILTRO.trim().toLowerCase();
  const usuarios = USUARIOS_CACHE.filter(u =>
    !termo || u.nome.toLowerCase().includes(termo) || u.email.toLowerCase().includes(termo)
  );

  document.getElementById('page-content').innerHTML = `
    <div class="flex flex-wrap justify-between items-center gap-3 mb-4">
      <div class="flex items-center gap-3">
        <p class="text-sm text-gray-500">${USUARIOS_CACHE.length} usuário(s)</p>
        <input id="filtro-usuarios" type="text" placeholder="Buscar por nome ou e-mail..." value="${USUARIOS_FILTRO.replace(/"/g, '&quot;')}"
          class="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition w-64" />
      </div>
      <button onclick="openCreateUsuarioModal()" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition"><i class="fas fa-plus mr-1"></i> Novo Usuário</button>
    </div>
    <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      ${usuarios.map(u => {
        const papel = (u.roles || [])[0];
        return `
        <button onclick="openUsuarioDetalheModal(${u.id})" class="text-left gs-card gs-card-hover p-4 flex items-center gap-3">
          <div class="w-11 h-11 rounded-full ${u.ativo ? 'bg-brand-100 text-brand-700' : 'bg-gray-200 text-gray-400'} flex items-center justify-center font-bold shrink-0">${usuarioIniciais(u.nome)}</div>
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-gray-800 truncate">${u.nome}</p>
            <p class="text-xs text-gray-400 truncate mb-1">${u.email}</p>
            <div class="flex items-center gap-1.5 flex-wrap">
              ${papel ? `<span class="text-xs font-medium px-2 py-0.5 rounded-full ${roleBadgeColor(papel.role)}">${ROLE_LABELS[papel.role]}${papel.escopo_id ? ' #' + papel.escopo_id : ''}</span>` : '<span class="text-xs text-gray-400 italic">Sem papel</span>'}
              ${!u.ativo ? '<span class="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-600">Inativo</span>' : ''}
            </div>
          </div>
          <i class="fas fa-chevron-right text-gray-300"></i>
        </button>`;
      }).join('') || '<p class="text-gray-400 col-span-full text-center py-8">Nenhum usuário encontrado.</p>'}
    </div>`;

  document.getElementById('filtro-usuarios').addEventListener('input', (e) => {
    USUARIOS_FILTRO = e.target.value;
    renderUsuariosLista();
  });
}

// Modal único de detalhe/edição: consolida trocar nome/e-mail/papel, promover a
// admin, resetar senha e ativar/desativar/excluir — tudo no mesmo lugar.
function openUsuarioDetalheModal(id) {
  const usuario = USUARIOS_CACHE.find(u => u.id === id);
  if (!usuario) return;
  const papelAtual = (usuario.roles || [])[0] || {};
  const ehAdmin = papelAtual.role === 'admin';
  const nucleoOptionsPromise = axios.get('/api/nucleos');

  openModal(`
    <div class="flex items-center gap-3 mb-4">
      <div class="w-12 h-12 rounded-full ${usuario.ativo ? 'bg-brand-100 text-brand-700' : 'bg-gray-200 text-gray-400'} flex items-center justify-center font-bold text-lg shrink-0">${usuarioIniciais(usuario.nome)}</div>
      <div class="min-w-0">
        <h3 class="text-lg font-bold text-gray-800 truncate">${usuario.nome}</h3>
        <p class="text-xs text-gray-400">#${usuario.id} · ${usuario.ativo ? '<span class="text-emerald-600">Ativo</span>' : '<span class="text-red-500">Inativo</span>'}</p>
      </div>
    </div>

    <form id="form-usuario-detalhe" class="space-y-3 border-t border-gray-100 pt-4">
      <div>
        <label class="block text-sm text-gray-600 mb-1">Nome</label>
        <input name="nome" required value="${usuario.nome.replace(/"/g, '&quot;')}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">E-mail</label>
        <input name="email" type="email" required value="${usuario.email.replace(/"/g, '&quot;')}" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition" />
      </div>
      <div>
        <label class="block text-sm text-gray-600 mb-1">Papel ${ehAdmin ? '<span class="text-xs text-gray-400">(use "Promover a Admin" abaixo para transferir a função de admin — aqui a troca de papel é bloqueada para admins)</span>' : ''}</label>
        <select name="role" id="detalhe-role-select" ${ehAdmin ? 'disabled' : ''} class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition disabled:bg-gray-100 disabled:text-gray-400">
          <option value="admin" ${papelAtual.role === 'admin' ? 'selected' : ''}>Administrador</option>
          <option value="coord_geral" ${papelAtual.role === 'coord_geral' ? 'selected' : ''}>Coordenador Geral</option>
          <option value="financeiro" ${papelAtual.role === 'financeiro' ? 'selected' : ''}>Financeiro</option>
          <option value="coord_nucleo" ${papelAtual.role === 'coord_nucleo' ? 'selected' : ''}>Coordenador de Núcleo</option>
          <option value="articulador" ${papelAtual.role === 'articulador' ? 'selected' : ''}>Articulador</option>
        </select>
      </div>
      <div id="detalhe-nucleo-field" class="hidden">
        <label class="block text-sm text-gray-600 mb-1">Núcleo</label>
        <select name="nucleo_id" id="detalhe-nucleo-select" class="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none transition"></select>
      </div>
      <div class="flex justify-end pt-1">
        <button type="submit" class="brand-gradient hover:opacity-90 text-white px-4 py-2 rounded-lg text-sm font-semibold shadow-soft transition">Salvar alterações</button>
      </div>
    </form>

    <div class="border-t border-gray-100 mt-4 pt-4">
      <p class="text-xs font-semibold text-gray-400 uppercase mb-2">Ações</p>
      <div class="flex flex-wrap gap-2">
        <button onclick="resetarSenhaUsuario(${usuario.id})" class="text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-200 text-amber-600 hover:bg-amber-50"><i class="fas fa-key mr-1"></i>Resetar senha</button>
        ${!ehAdmin ? `<button onclick="promoverAdmin(${usuario.id})" class="text-xs font-medium px-3 py-1.5 rounded-lg border border-blue-200 text-blue-600 hover:bg-blue-50"><i class="fas fa-user-shield mr-1"></i>Promover a Admin</button>` : ''}
        ${usuario.ativo
          ? `<button onclick="desativarUsuario(${usuario.id})" class="text-xs font-medium px-3 py-1.5 rounded-lg border border-orange-200 text-orange-600 hover:bg-orange-50"><i class="fas fa-ban mr-1"></i>Desativar</button>`
          : `<button onclick="reativarUsuario(${usuario.id})" class="text-xs font-medium px-3 py-1.5 rounded-lg border border-emerald-200 text-emerald-600 hover:bg-emerald-50"><i class="fas fa-rotate-left mr-1"></i>Reativar</button>`}
        <button onclick="excluirUsuario(${usuario.id})" class="text-xs font-medium px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"><i class="fas fa-trash mr-1"></i>Excluir</button>
      </div>
    </div>

    <div class="flex justify-end pt-4">
      <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm text-gray-600">Fechar</button>
    </div>`);

  const roleSelect = document.getElementById('detalhe-role-select');
  const nucleoField = document.getElementById('detalhe-nucleo-field');
  const nucleoSelect = document.getElementById('detalhe-nucleo-select');

  nucleoOptionsPromise.then(({ data }) => {
    nucleoSelect.innerHTML = data.data.map(n => `<option value="${n.id}" ${papelAtual.escopo_id === n.id ? 'selected' : ''}>${n.nome}</option>`).join('');
  });

  function toggleNucleoField() {
    nucleoField.classList.toggle('hidden', roleSelect.value !== 'coord_nucleo');
  }
  roleSelect.addEventListener('change', toggleNucleoField);
  toggleNucleoField();

  document.getElementById('form-usuario-detalhe').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (ehAdmin) delete body.role; // papel de admin só muda via "Promover a Admin" de outro usuário
    if (body.nucleo_id) body.nucleo_id = parseInt(body.nucleo_id);
    try {
      await axios.put(`/api/auth/usuarios/${id}`, body);
      closeModal();
      toast('Usuário atualizado com sucesso.');
      renderUsuarios();
    } catch (err) { toast(apiErr(err), 'error'); }
  });
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
          ${isAdmin() ? '<option value="admin">Administrador</option><option value="coord_geral">Coordenador Geral</option><option value="financeiro">Financeiro</option>' : ''}
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

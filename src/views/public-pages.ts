import type { Context } from 'hono'
import { baseLayout } from './layout'
import type { AppEnv } from '../types/bindings'

function destaqueBadge(tipo: string): string {
  const map: Record<string, { label: string; color: string }> = {
    campanha: { label: 'Campanha', color: 'bg-blue-100 text-blue-700' },
    promocao: { label: 'Promoção', color: 'bg-purple-100 text-purple-700' },
    premiacao: { label: 'Premiação', color: 'bg-amber-100 text-amber-700' },
    chamada_colaborador: { label: 'Chamada', color: 'bg-emerald-100 text-emerald-700' }
  }
  const info = map[tipo] || { label: tipo, color: 'bg-gray-100 text-gray-700' }
  return `<span class="text-xs font-semibold px-2 py-1 rounded-full ${info.color}">${info.label}</span>`
}

export async function renderPublicNucleoPage(c: Context<AppEnv>, slug: string) {
  const nucleo = await c.env.DB.prepare(
    'SELECT id, nome, descricao, slug_publico FROM nucleos WHERE slug_publico = ? AND ativo = 1'
  )
    .bind(slug)
    .first<any>()

  if (!nucleo) {
    return c.html(baseLayout({ title: 'Não encontrado', bodyContent: `<div class="p-10 text-center text-gray-500">Núcleo não encontrado.</div>` }), 404)
  }

  const { results: projetos } = await c.env.DB.prepare(
    'SELECT id, nome, descricao, slug_publico FROM projetos WHERE nucleo_id = ? AND ativo = 1'
  ).bind(nucleo.id).all<any>()

  const { results: destaques } = await c.env.DB.prepare(
    'SELECT * FROM destaques_publicos WHERE nucleo_id = ? AND ativo = 1 ORDER BY created_at DESC'
  ).bind(nucleo.id).all<any>()

  const body = `
  <div class="max-w-5xl mx-auto px-4 py-10">
    <header class="text-center mb-10">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-600 text-white text-3xl mb-4">
        <i class="fas fa-people-group"></i>
      </div>
      <h1 class="text-3xl font-bold text-gray-800">${nucleo.nome}</h1>
      <p class="text-gray-500 mt-2 max-w-2xl mx-auto">${nucleo.descricao ?? ''}</p>
    </header>

    ${(destaques ?? []).length ? `
    <section class="mb-10">
      <h2 class="text-lg font-bold text-gray-700 mb-3"><i class="fas fa-bullhorn mr-2 text-emerald-600"></i>Destaques</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${(destaques ?? []).map((d: any) => `
          <div class="bg-white rounded-xl border p-4 shadow-sm">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-semibold text-gray-800">${d.titulo}</h3>
              ${destaqueBadge(d.tipo)}
            </div>
            <p class="text-sm text-gray-500">${d.descricao ?? ''}</p>
          </div>
        `).join('')}
      </div>
    </section>` : ''}

    <section class="mb-10">
      <h2 class="text-lg font-bold text-gray-700 mb-3"><i class="fas fa-diagram-project mr-2 text-emerald-600"></i>Projetos do Núcleo</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${(projetos ?? []).map((p: any) => `
          <a href="/p/${p.slug_publico}" class="block bg-white rounded-xl border p-4 shadow-sm hover:shadow-md transition">
            <h3 class="font-semibold text-gray-800 mb-1">${p.nome}</h3>
            <p class="text-sm text-gray-500 line-clamp-2">${p.descricao ?? ''}</p>
            <span class="text-emerald-600 text-sm font-medium mt-2 inline-block">Ver projeto <i class="fas fa-arrow-right ml-1"></i></span>
          </a>
        `).join('') || '<p class="text-gray-400 text-sm">Nenhum projeto público no momento.</p>'}
      </div>
    </section>

    <section class="bg-emerald-600 rounded-2xl p-8 text-center text-white">
      <h2 class="text-xl font-bold mb-2">Seja um colaborador!</h2>
      <p class="text-emerald-100 mb-5">Cadastre sua Nota Fiscal Paulista e ajude este núcleo a arrecadar mais recursos para projetos sociais.</p>
      <button onclick="document.getElementById('form-colaborador').scrollIntoView({behavior:'smooth'})"
              class="bg-white text-emerald-700 font-semibold px-6 py-2.5 rounded-lg hover:bg-emerald-50 transition">
        Quero colaborar
      </button>
    </section>

    <section id="form-colaborador" class="mt-10 bg-white rounded-xl border p-6 max-w-lg mx-auto">
      <h2 class="text-lg font-bold text-gray-800 mb-4">Cadastro de Colaborador</h2>
      <form id="colaborador-form" class="space-y-3">
        <input type="hidden" name="nucleo_slug" value="${nucleo.slug_publico}" />
        <div>
          <label class="block text-sm text-gray-600 mb-1">Nome completo</label>
          <input name="nome" required class="w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">CPF</label>
          <input name="cpf" required class="w-full border rounded-lg px-3 py-2 text-sm" placeholder="000.000.000-00" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">WhatsApp</label>
          <input name="whatsapp" required class="w-full border rounded-lg px-3 py-2 text-sm" placeholder="(11) 99999-9999" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">Status no Portal da Fazenda</label>
          <select name="status_portal_fazenda" required class="w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">Selecione...</option>
            <option value="pleno">Usuário Pleno</option>
            <option value="nao_pleno">Não Pleno</option>
          </select>
        </div>
        <div id="colab-msg" class="hidden text-sm rounded-lg px-3 py-2"></div>
        <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 rounded-lg transition">
          Enviar cadastro
        </button>
      </form>
    </section>
  </div>
  ${publicFormScript()}`

  return c.html(baseLayout({ title: nucleo.nome, bodyContent: body }))
}

export async function renderPublicProjetoPage(c: Context<AppEnv>, slug: string) {
  const projeto = await c.env.DB.prepare(
    `SELECT p.id, p.nome, p.descricao, p.slug_publico, n.nome as nucleo_nome, n.slug_publico as nucleo_slug
     FROM projetos p JOIN nucleos n ON n.id = p.nucleo_id
     WHERE p.slug_publico = ? AND p.ativo = 1`
  ).bind(slug).first<any>()

  if (!projeto) {
    return c.html(baseLayout({ title: 'Não encontrado', bodyContent: `<div class="p-10 text-center text-gray-500">Projeto não encontrado.</div>` }), 404)
  }

  const { results: galeria } = await c.env.DB.prepare(
    'SELECT id, legenda FROM projeto_galeria WHERE projeto_id = ? ORDER BY ordem ASC'
  ).bind(projeto.id).all<any>()

  const { results: destaques } = await c.env.DB.prepare(
    'SELECT * FROM destaques_publicos WHERE projeto_id = ? AND ativo = 1 ORDER BY created_at DESC'
  ).bind(projeto.id).all<any>()

  const body = `
  <div class="max-w-5xl mx-auto px-4 py-10">
    <a href="/n/${projeto.nucleo_slug}" class="text-sm text-emerald-600 hover:underline mb-4 inline-block">
      <i class="fas fa-arrow-left mr-1"></i> Voltar para ${projeto.nucleo_nome}
    </a>
    <header class="text-center mb-10">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-emerald-600 text-white text-3xl mb-4">
        <i class="fas fa-diagram-project"></i>
      </div>
      <h1 class="text-3xl font-bold text-gray-800">${projeto.nome}</h1>
      <p class="text-gray-500 mt-2 max-w-2xl mx-auto">${projeto.descricao ?? ''}</p>
    </header>

    ${(destaques ?? []).length ? `
    <section class="mb-10">
      <h2 class="text-lg font-bold text-gray-700 mb-3"><i class="fas fa-bullhorn mr-2 text-emerald-600"></i>Campanhas e Promoções</h2>
      <div class="grid sm:grid-cols-2 gap-4">
        ${(destaques ?? []).map((d: any) => `
          <div class="bg-white rounded-xl border p-4 shadow-sm">
            <div class="flex items-center justify-between mb-2">
              <h3 class="font-semibold text-gray-800">${d.titulo}</h3>
              ${destaqueBadge(d.tipo)}
            </div>
            <p class="text-sm text-gray-500">${d.descricao ?? ''}</p>
          </div>
        `).join('')}
      </div>
    </section>` : ''}

    ${(galeria ?? []).length ? `
    <section class="mb-10">
      <h2 class="text-lg font-bold text-gray-700 mb-3"><i class="fas fa-images mr-2 text-emerald-600"></i>Galeria</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
        ${(galeria ?? []).map((g: any) => `
          <img src="/api/public/galeria/${g.id}/arquivo" alt="${g.legenda ?? ''}" class="rounded-lg object-cover w-full h-40" />
        `).join('')}
      </div>
    </section>` : ''}

    <section class="bg-emerald-600 rounded-2xl p-8 text-center text-white">
      <h2 class="text-xl font-bold mb-2">Apoie este projeto!</h2>
      <p class="text-emerald-100 mb-5">Cadastre sua Nota Fiscal Paulista e ajude a manter este projeto ativo.</p>
      <button onclick="document.getElementById('form-colaborador').scrollIntoView({behavior:'smooth'})"
              class="bg-white text-emerald-700 font-semibold px-6 py-2.5 rounded-lg hover:bg-emerald-50 transition">
        Quero colaborar
      </button>
    </section>

    <section id="form-colaborador" class="mt-10 bg-white rounded-xl border p-6 max-w-lg mx-auto">
      <h2 class="text-lg font-bold text-gray-800 mb-4">Cadastro de Colaborador</h2>
      <form id="colaborador-form" class="space-y-3">
        <input type="hidden" name="projeto_slug" value="${projeto.slug_publico}" />
        <div>
          <label class="block text-sm text-gray-600 mb-1">Nome completo</label>
          <input name="nome" required class="w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">CPF</label>
          <input name="cpf" required class="w-full border rounded-lg px-3 py-2 text-sm" placeholder="000.000.000-00" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">WhatsApp</label>
          <input name="whatsapp" required class="w-full border rounded-lg px-3 py-2 text-sm" placeholder="(11) 99999-9999" />
        </div>
        <div>
          <label class="block text-sm text-gray-600 mb-1">Status no Portal da Fazenda</label>
          <select name="status_portal_fazenda" required class="w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">Selecione...</option>
            <option value="pleno">Usuário Pleno</option>
            <option value="nao_pleno">Não Pleno</option>
          </select>
        </div>
        <div id="colab-msg" class="hidden text-sm rounded-lg px-3 py-2"></div>
        <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2.5 rounded-lg transition">
          Enviar cadastro
        </button>
      </form>
    </section>
  </div>
  ${publicFormScript()}`

  return c.html(baseLayout({ title: projeto.nome, bodyContent: body }))
}

function publicFormScript(): string {
  return `
  <script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
  <script>
    const form = document.getElementById('colaborador-form');
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('colab-msg');
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const res = await axios.post('/api/public/colaborador', data);
        msg.textContent = res.data.data.message;
        msg.className = 'text-sm rounded-lg px-3 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200';
        msg.classList.remove('hidden');
        form.reset();
      } catch (err) {
        msg.textContent = err.response?.data?.error || 'Erro ao enviar cadastro.';
        msg.className = 'text-sm rounded-lg px-3 py-2 bg-red-50 text-red-700 border border-red-200';
        msg.classList.remove('hidden');
      }
    });
  </script>`
}

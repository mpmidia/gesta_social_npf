import type { Context } from 'hono'
import { baseLayout } from './layout'

export function renderDashboardPage(c: Context) {
  const body = `
  <div id="app" class="flex h-screen overflow-hidden">
    <!-- Sidebar -->
    <aside class="w-64 bg-gray-900 text-gray-200 flex flex-col shrink-0">
      <div class="px-5 py-5 border-b border-gray-800/80 flex items-center gap-3">
        <div class="w-9 h-9 rounded-lg brand-gradient flex items-center justify-center text-white text-base shrink-0">
          <i class="fas fa-people-roof"></i>
        </div>
        <div class="min-w-0">
          <h1 class="text-base font-bold text-white leading-tight truncate">Gestão Social</h1>
          <p class="text-[11px] text-gray-500 leading-tight">Nota Fiscal Paulista</p>
        </div>
      </div>
      <div class="px-4 py-3 border-b border-gray-800/80">
        <div class="flex items-center gap-2">
          <div id="user-avatar" class="w-8 h-8 rounded-full brand-gradient flex items-center justify-center text-white text-xs font-bold shrink-0">?</div>
          <p id="user-info" class="text-xs text-gray-400 leading-snug">Carregando...</p>
        </div>
      </div>
      <nav id="sidebar-nav" class="flex-1 overflow-y-auto py-3 space-y-1 px-3 text-sm"></nav>
      <div class="p-3 border-t border-gray-800/80">
        <button id="logout-btn" class="w-full flex items-center gap-2 text-gray-300 hover:text-white hover:bg-gray-800 px-3 py-2 rounded-lg transition text-sm">
          <i class="fas fa-arrow-right-from-bracket"></i> Sair
        </button>
      </div>
    </aside>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto bg-gray-50">
      <header class="bg-white/90 backdrop-blur border-b px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <h2 id="page-title" class="text-xl font-bold text-gray-800">Visão Geral</h2>
      </header>
      <div id="page-content" class="p-6"></div>
    </main>
  </div>

  <!-- Modal genérico -->
  <div id="modal-overlay" class="hidden fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
    <div id="modal-box" class="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"></div>
  </div>

  <!-- Toast -->
  <div id="toast" class="hidden fixed bottom-5 right-5 z-50 px-4 py-3 rounded-lg shadow-lg text-white text-sm"></div>
  `

  return c.html(
    baseLayout({
      title: 'Painel',
      bodyContent: body,
      bodyScripts: `<script src="/static/app.js"></script>`
    })
  )
}

(() => {
  if (document.getElementById('dsh-titlebar')) return
  const api = window.dshTitlebar
  if (!api) return

  const SVG_ICONS = {
    back: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M10.2 3.2 5.4 8l4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fwd: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M5.8 3.2 10.6 8l-4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    min: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2" y="7.4" width="12" height="1.6" rx="0.8" fill="currentColor"/></svg>',
    max: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2" y="2.6" width="11.4" height="11.4" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    restore: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="2.4" y="4.4" width="9.2" height="9.2" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.8 4.4 V3.2 a1.4 1.4 0 0 1 1.4-1.4 h6.4 a1.4 1.4 0 0 1 1.4 1.4 v6.4 a1.4 1.4 0 0 1-1.4 1.4 h-1.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="19" height="19" aria-hidden="true"><path d="M3.2 3.2l9.6 9.6M12.8 3.2l-9.6 9.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  }

  const bar = document.createElement('div')
  bar.id = 'dsh-titlebar'
  bar.innerHTML =
    '<button class="dsh-tb-nbtn" id="dsh-tb-back" title="后退" disabled>' + SVG_ICONS.back + '</button>' +
    '<button class="dsh-tb-nbtn" id="dsh-tb-fwd" title="前进" disabled>' + SVG_ICONS.fwd + '</button>' +
    '<span class="dsh-tb-sep"></span>' +
    '<button class="dsh-tb-mbtn" data-menu="file">文件</button>' +
    '<button class="dsh-tb-mbtn" data-menu="view">视图</button>' +
    '<button class="dsh-tb-mbtn" data-menu="help">帮助</button>' +
    '<span class="dsh-tb-spacer"></span>' +
    '<button class="dsh-tb-wbtn" id="dsh-tb-min" title="最小化">' + SVG_ICONS.min + '</button>' +
    '<button class="dsh-tb-wbtn" id="dsh-tb-max" title="最大化">' + SVG_ICONS.max + '</button>' +
    '<button class="dsh-tb-wbtn" id="dsh-tb-close" title="关闭">' + SVG_ICONS.close + '</button>'
  ;(document.body || document.documentElement).appendChild(bar)

  // 主题：无壁纸时按系统主题给毛玻璃配色（有壁纸时优先 --dsh-wallpaper-panel）
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  bar.style.setProperty('--dsh-tb-bg', dark ? 'rgba(12, 15, 22, 0.72)' : 'rgba(255, 255, 255, 0.65)')
  bar.style.setProperty('--dsh-tb-fg', dark ? '#f9fafb' : '#0f1115')
  bar.style.setProperty('--dsh-tb-border', dark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)')
  bar.style.setProperty('--dsh-tb-hover', dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)')

  document.getElementById('dsh-tb-back').addEventListener('click', () => api.back())
  document.getElementById('dsh-tb-fwd').addEventListener('click', () => api.forward())
  bar.querySelectorAll('.dsh-tb-mbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = btn.getBoundingClientRect()
      api.menu(btn.dataset.menu, Math.round(r.left), Math.round(r.bottom + 4))
    })
  })
  document.getElementById('dsh-tb-min').addEventListener('click', () => api.minimize())
  document.getElementById('dsh-tb-max').addEventListener('click', () => api.maximizeToggle())
  document.getElementById('dsh-tb-close').addEventListener('click', () => api.close())

  api.onNavState((state) => {
    document.getElementById('dsh-tb-back').disabled = !state.canBack
    document.getElementById('dsh-tb-fwd').disabled = !state.canForward
  })
  api.onMaxState((maximized) => {
    const btn = document.getElementById('dsh-tb-max')
    btn.title = maximized ? '还原' : '最大化'
    btn.innerHTML = maximized ? SVG_ICONS.restore : SVG_ICONS.max
  })

  // 轮询"选中会话索引"上报主进程：会话/项目切换时 aria-selected 变化，
  // 主进程据此维护后退/前进历史（后退按索引点击会话列表项）
  const selectedIndex = () => {
    const items = Array.from(document.querySelectorAll('[role=treeitem]'))
    return items.findIndex((el) => el.getAttribute('aria-selected') === 'true')
  }
  let lastIndex = selectedIndex()
  setInterval(() => {
    const i = selectedIndex()
    if (i !== lastIndex) {
      lastIndex = i
      api.notifyTitle(i)
    }
  }, 500)
})()

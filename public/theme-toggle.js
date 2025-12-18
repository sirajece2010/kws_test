(function () {
  const applyTheme = (theme) => {
    const root = document.documentElement;
    root.classList.remove('theme-dark', 'theme-light');
    root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');
    try { localStorage.setItem('theme', theme); } catch (e) {}
    const btn = document.getElementById('theme-toggle');
    if (btn) {
      const isDark = theme === 'dark';
      btn.setAttribute('aria-pressed', String(isDark));
      btn.textContent = isDark ? 'Light Mode' : 'Dark Mode';
      btn.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
      refresh();
    }
  };

  const init = () => {
    if (!document.getElementById('theme-style')) {
      const style = document.createElement('style');
      style.id = 'theme-style';
      style.textContent = `
:root.theme-light {
  --bg: #ffffff;
  --fg: #111111;
  --muted: #555555;
  --border: #dddddd;
  --th-bg: #f2f2f2;
  --th-fg: #111111;
  --available-bg: #e6ffed;
  --available-fg: #0a7a2f;
  --available-border: #a8e6b0;
  --allocated-bg: #fff4e5;
  --allocated-fg: #8a4b0f;
  --allocated-border: #f3cf9e;
  --error: #c62828;
  --success: #2e7d32;
}
:root.theme-dark {
  --bg: #0b0f14;
  --fg: #f1f5f9;
  --muted: #b6c0cc;
  --border: #3a4351;
  --th-bg: #1a2433;
  --th-fg: #f1f5f9;
  --available-bg: #0f2e1d;
  --available-fg: #a5efc6;
  --available-border: #2e5f42;
  --allocated-bg: #2a1e12;
  --allocated-fg: #ffd28a;
  --allocated-border: #5a4126;
  --error: #ff6b6b;
  --success: #7bd88f;
}
body { background: var(--bg); color: var(--fg); }
.muted { color: var(--muted); }
th { background: var(--th-bg) !important; color: var(--th-fg) !important; }
td, th { border-color: var(--border) !important; }
.available { background: var(--available-bg) !important; color: var(--available-fg) !important; border-color: var(--available-border) !important; }
.allocated { background: var(--allocated-bg) !important; color: var(--allocated-fg) !important; border-color: var(--allocated-border) !important; }
.error { color: var(--error) !important; }
.success { color: var(--success) !important; }
input, button, select { background: var(--th-bg); color: var(--th-fg); border: 1px solid var(--border); }
#theme-toggle { margin-left: auto; }
      `;
      document.head.appendChild(style);
    }

    const container = document.querySelector('.controls');
    if (container && !document.getElementById('theme-toggle')) {
      const btn = document.createElement('button');
      btn.id = 'theme-toggle';
      btn.type = 'button';
      btn.textContent = 'Dark Mode';
      btn.setAttribute('aria-pressed', 'false');
      btn.title = 'Switch to dark theme';
      btn.addEventListener('click', () => {
        const isDark = document.documentElement.classList.contains('theme-dark');
        applyTheme(isDark ? 'light' : 'dark');
      });
      container.appendChild(btn);
    }

    window.addEventListener('keydown', (e) => {
      if ((e.altKey || e.metaKey) && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        const isDark = document.documentElement.classList.contains('theme-dark');
        applyTheme(isDark ? 'light' : 'dark');
      }
    });

    let theme;
    try { theme = localStorage.getItem('theme'); } catch (e) {}
    if (theme !== 'dark' && theme !== 'light') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(theme);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
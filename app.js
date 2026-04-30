const root = document.documentElement;
const button = document.querySelector('[data-theme-toggle]');
const icon = document.querySelector('[data-theme-icon]');

function setTheme(nextTheme) {
  root.setAttribute('data-theme', nextTheme);
  if (icon) icon.textContent = nextTheme === 'dark' ? 'Light' : 'Dark';
  if (button) button.setAttribute('aria-label', `Switch to ${nextTheme === 'dark' ? 'light' : 'dark'} theme`);
}

const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
setTheme(prefersDark ? 'dark' : 'light');

button?.addEventListener('click', () => {
  const current = root.getAttribute('data-theme') || 'dark';
  setTheme(current === 'dark' ? 'light' : 'dark');
});

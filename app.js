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

const modelFinderLink = document.querySelector('[data-testid="link-model-finder"]');

function updateModelFinderAnchor() {
  if (!modelFinderLink) return;
  const desktopAnchor = 'https://www.stripmeister.com#shopify-section-template--18912940359751__sm_desktop_all_products_v2_QU9pWA';
  const mobileAnchor = 'https://www.stripmeister.com#shopify-section-template--18912940359751__sm_mobile_products_v3_Da6cGT';
  modelFinderLink.href = window.matchMedia('(max-width: 768px)').matches ? mobileAnchor : desktopAnchor;
}

updateModelFinderAnchor();
window.addEventListener('resize', updateModelFinderAnchor);

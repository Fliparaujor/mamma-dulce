try {
  if (localStorage.getItem('hp-theme') === 'light') document.documentElement.classList.remove('dark');
} catch {
  /* armazenamento indisponível: fica no tema escuro */
}

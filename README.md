# Mamma Dulce · site

Site de uma página da Mamma Dulce, confeitaria artística da Jaciara Simões em Aracruz (ES). Publicado em **https://fliparaujor.github.io/mamma-dulce/**.

É um site estático: HTML, CSS e JavaScript, sem build e sem servidor. Funciona direto no GitHub Pages (Settings → Pages → Deploy from a branch → `main` → `/ (root)`).

## Estrutura

```
index.html              conteúdo e seções
css/main.css            todos os estilos
js/main.js              todas as animações e interações
assets/                 fotos (versão grande e -sm para celular), logo e ícones
assets/logo.svg         logo vetorizada (usada também na abertura animada)
assets/fonts/           Cormorant Garamond e DM Sans (woff2) + licenças OFL
assets/vendor/          GSAP, ScrollTrigger, SplitText e Lenis, copiados localmente
```

## Seções

Abertura com a logo se desenhando, hero com a foto que cresce até ocupar a tela, manifesto que acende palavra por palavra, faixa em curva, criações em trilho horizontal, essência (Jaciara), sabores com foto que segue o cursor, processo em cartões empilhados, galeria em colunas com parallax, encomendas com rastro de fotos e formulário que abre o WhatsApp, rodapé.

O mapa de onde veio cada efeito está em [REFERENCES.md](REFERENCES.md).

## Editar

- WhatsApp: procure `5527997236993` em `index.html` e `js/main.js`.
- Instagram: procure `mamma.dulce`.
- Fotos novas: coloque em `assets/` a versão grande e uma `-sm.webp` com 820 px de largura.
- A abertura completa aparece uma vez por sessão do navegador. Para ver de novo, abra em aba anônima.

## Acessibilidade e desempenho

Quem ativa "reduzir movimento" no sistema recebe o site sem rolagem suave, sem travas e sem animações, com todo o conteúdo visível. Teclado funciona em menu, sabores, galeria ampliada (setas ← →, Esc) e formulário. Se algum script falhar, o conteúdo aparece em até 7 segundos.

## Licenças

Cormorant Garamond e DM Sans: SIL Open Font License (`assets/fonts/`). Lenis: MIT. GSAP: licença gratuita padrão da GreenSock (https://gsap.com/standard-license).

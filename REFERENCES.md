# Referências

Versão 4. O site foi reescrito do zero sobre GSAP + ScrollTrigger + SplitText e Lenis. Os componentes de bibliotecas React foram reescritos em JavaScript puro, porque o site precisa rodar estático no GitHub Pages.

Do React Bits (código aberto, https://github.com/DavidHDev/react-bits) li o código-fonte dos componentes abaixo e adaptei a lógica. Das outras bibliotecas usei só o padrão visual das demonstrações públicas, sem copiar código.

| Onde no site | Efeito | Referência |
|---|---|---|
| Abertura | Logo vetorizada que se desenha por traço, nome subindo letra a letra, cortina dupla | Spell (Signature), React Bits SplitText |
| Hero | Título revelado linha a linha | React Bits SplitText |
| Hero | Foto que cresce da moldura até a tela cheia durante a rolagem | React Bits ScrollExpand |
| Hero | Selo circular girando com o texto da marca | React Bits CircularText |
| Manifesto | Palavras acendem conforme a rolagem, com fotos em pílula no meio do texto | React Bits ScrollReveal |
| Faixa | Texto correndo numa curva, mais rápido e invertendo com a rolagem | React Bits CurvedLoop + ScrollVelocity |
| Criações | Trilho horizontal preso à tela, parallax dentro das fotos | padrão de galeria horizontal (Skiper UI, MotionSites) |
| Cabeçalho | Pílula que desliza até a seção ativa | Unlumen Motion Navigation |
| Menu do celular | Camadas rosa e verde entrando em sequência | React Bits StaggeredMenu |
| Essência | Fotos abrindo por recorte, assinatura escrita da esquerda para a direita | Details (Parallax Images), Spell |
| Sabores | Foto do sabor seguindo o cursor, linha com fundo que sobe | Skiper UI (Image Reveal), React Bits FlowingMenu |
| Processo | Cartões que se empilham e encolhem | React Bits ScrollStack |
| Galeria | Colunas em velocidades diferentes, fotos abrindo de baixo para cima | padrão de masonry com parallax |
| Encomendas | Rastro de fotos atrás do cursor | React Bits ImageTrail |
| Botões | Movimento magnético, preenchimento circular e texto que rola | MicroKit (Magnetic Fill), Uiverse |
| Fotos | Cursor "Ver" sobre imagens clicáveis | padrão comum em sites editoriais |

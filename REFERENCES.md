# Mamma Dulce — referências e aplicação

Revisão de 22/10/2026. Os 15 endereços enviados foram consultados. A seleção preserva a marca, as fotos e o texto da Jaciara. Cada seção e família de controles recebeu um tratamento coerente com essas referências.

As interações foram implementadas em HTML/CSS/JavaScript para manter o site estático e compatível com GitHub Pages. São adaptações dos padrões citados, não instalações dos componentes React originais. Catálogos com conteúdo pago ou acesso restrito foram usados somente pelas demonstrações públicas; nenhum código restrito foi copiado.

## Aplicação por seção

| Área | Elemento aplicado | Referência |
|---|---|---|
| Cabeçalho fixo | Indicador arredondado que desliza entre os links ativos e acompanha foco e hover | [Unlumen Motion Navigation Menu](https://ui.unlumen.com/components/motion-navigation-menu) |
| Abertura | Título revelado palavra por palavra, com recorte e desfoque discreto; foto com inclinação suave ao cursor | [Spell Words Stagger](https://spell.sh/docs/words-stagger), [Bencho Tilt Card](https://bencho.dev/) |
| Faixa de mensagens | Movimento contínuo horizontal, com pausa na interação | [Spell](https://spell.sh/) — padrão Marquee |
| Criações | Galeria arrastável com curva discreta, rotação lateral, setas e indicador; filtros com destaque deslizante | [React Bits Circular Gallery](https://reactbits.dev/components/circular-gallery), Unlumen |
| Nossa essência | Revelação da assinatura e traço desenhado; imagens com revelação e parallax contidos dentro da seção | [Spell Signature](https://spell.sh/docs/signature), [Details Free / Parallax Images](https://www.details.so/vault/category/free) |
| Sabores | Acordeão com altura animada, troca de imagem e realce do sabor aberto | [Unlumen Motion FAQs Accordion](https://ui.unlumen.com/components/motion-faqs-accordion) |
| Como criamos seu momento | Cartões que elevam e deslocam discretamente o título no hover, sem esconder o conteúdo | [Cult Shift Card](https://www.cult-ui.com/docs/components/shift-card) |
| Galeria de detalhes | Trilho lateral, inclinação sutil, luz no cursor e desvanecimento na borda | Bencho Tilt Card; [Unlumen](https://ui.unlumen.com/components) — referência visual de profundidade lateral |
| Encomendas | Campo de cor com luz suave que acompanha o cursor, arcos discretos e chamada com preenchimento animado | [MotionSites](https://motionsites.ai/) — referência pública de CTA; MicroKit |
| Rodapé | Separação tonal suave, links com feedback e retorno ao início com preenchimento circular | [Refero — editorial creme](https://styles.refero.design/style/031056ff-7af1-46db-8daa-115f731c5d26), MicroKit |

## Botões e controles

| Família de ação | Tratamento | Referência |
|---|---|---|
| Ação principal e conversar | Movimento magnético limitado e preenchimento que sobe | [MicroKit Magnetic Fill Button](https://microkit.co/components/magnetic-fill-button) |
| Pressionar ações principais | Onda no ponto do clique | [Bencho](https://bencho.dev/) — Ink Bloom / feedback de pressão |
| Enviar para WhatsApp | Ícone entra pela esquerda e o texto desliza no hover/foco; envio prepara mensagem para revisão | [MicroKit Sliding Send Button](https://microkit.co/components/sliding-send-button) |
| Setas de galerias e retorno ao início | Fundo circular cresce, com estado desabilitado preservado | [MicroKit Next Dot Fill Button](https://microkit.co/components/next-dot-fill-button) |
| Links de ação, Instagram e explorar | Traço animado e deslocamento/troca da seta | [Uiverse Animated Buttons](https://uiverse.io/ui/animated-buttons) e [Arrow Button](https://uiverse.io/satyamchaudharydev/rude-wolverine-24) |
| Filtros e navegação | Marcador compartilhado e móvel; seleção e foco visíveis | Unlumen Motion Navigation Menu |
| Fotos clicáveis | Zoom suave, indicação de ampliação e visualização em diálogo | React Bits / Details — adaptação às imagens reais da marca |
| Fechar diálogos e menu móvel | Ícone com transição, fundo de hover e abertura suave do menu | Uiverse — família de ícones e botões animados |
| Campos e seleção de sabores | Contorno de foco e painel com transição de altura | Unlumen Motion FAQs Accordion |
| Logo e links do rodapé | Realce sutil no foco/hover | Refero — hierarquia editorial e ações discretas |

Os tratamentos se repetem por função para que botões equivalentes se comportem da mesma forma. Mouse, teclado e toque continuam disponíveis. A preferência do sistema por movimento reduzido desativa os efeitos principais.

## Registro dos 15 sites consultados

| Site | O que foi examinado | Decisão |
|---|---|---|
| [React Bits](https://reactbits.dev/) | Catálogo de animações e Circular Gallery | Curva da galeria adaptada ao trilho nativo, sem WebGL |
| [21st.dev](https://21st.dev/) | Catálogo público de heróis, navegação e botões | Comparação de composição; sem dependência ou código importado |
| [Uiverse](https://uiverse.io/) | Botões animados e botões com seta | Feedback de links, setas e ícones |
| [Unlumen](https://ui.unlumen.com/) | Navegação compartilhada, acordeão Motion e demonstração de profundidade horizontal | Navegação, filtros, sabores e borda da galeria |
| [GetLayers](https://www.getlayers.ai/) | Prévia pública Herbier Blanc e catálogo de composições | Referência editorial de produto; sem copiar recursos pagos |
| [MotionSites](https://motionsites.ai/) | Catálogo público de hero, CTA e rodapé | Direção visual da chamada final e transições suaves |
| [Spell](https://spell.sh/) | Words Stagger, Signature e Marquee | Títulos, assinatura e faixa de mensagens |
| [Inspora](https://www.inspora.design/) | Catálogo e [Subtle text scale effect](https://www.inspora.design/posts/subtle-text-scale-effect) | Comparação de delicadeza do movimento; efeito de escala de parágrafos não aplicado para preservar leitura |
| [Refero Styles](https://styles.refero.design/) | Estilo público editorial creme ElevenLabs | Superfícies quentes, bordas finas e hierarquia de ações, adaptadas à paleta da marca |
| [Details](https://www.details.so/vault) | Categoria pública Free, Parallax Images e Progressive Blur | Revelação/parallax das fotos; sem acessar código restrito |
| [MicroKit](https://microkit.co/) | Magnetic Fill, Sliding Send e Next Dot Fill | Famílias de botões principais, envio e setas |
| [Bencho](https://bencho.dev/) | Catálogo de microinterações, Tilt Card, Ink Bloom e Tab Bar | Inclinação contida de fotos e feedback de pressão |
| [OriginKit](https://www.originkit.dev/) | Documentação pública de componentes e catálogo Animation | Comparação de abordagens; cópia exige acesso, nenhum código restrito usado |
| [Skiper UI](https://skiper-ui.com/) | Catálogo, Image Reveal e Things Drag and Scroll | Referência visual da revelação e dos trilhos; sem copiar componentes premium |
| [Cult UI](https://www.cult-ui.com/) | Documentação pública Shift Card | Adaptação dos cartões do processo |

## Funcionamento e limites

- Conteúdo, fotos, fontes e código acompanham o pacote GitHub Pages.
- Instagram e WhatsApp são os únicos destinos externos de atendimento.
- O formulário abre uma mensagem para o visitante revisar; não confirma nem armazena encomendas.
- A adaptação evita dependências React, servidores ou serviços pagos.
- Fontes Cormorant Garamond e DM Sans: SIL Open Font License, incluída em `assets/fonts/` no pacote exportado.

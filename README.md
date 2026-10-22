# Mamma Dulce — GitHub Pages

Site completo de uma página, pronto para publicar no GitHub Pages. Inclui fotos, logo transparente, fontes locais, animações, galerias laterais, filtros, visualização ampliada e o formulário que prepara uma conversa no WhatsApp.

## Como publicar

1. Crie um repositório no GitHub. Na conta gratuita, use um repositório público para habilitar o Pages.
2. Extraia o ZIP. Envie **o conteúdo extraído** para a raiz do repositório. O arquivo `index.html` deve aparecer diretamente na primeira tela do repositório, ao lado de `app.js`, dos arquivos CSS e da pasta `assets`.
3. Conclua o envio com **Commit changes**.
4. Abra **Settings → Pages**.
5. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
6. Selecione a branch **main** (ou a branch na qual enviou os arquivos), a pasta **/(root)** e clique em **Save**.
7. Aguarde a publicação. O GitHub mostrará o endereço do site na mesma tela.

O endereço de um site de projeto costuma ser `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`. Os caminhos das fotos, fontes e scripts são relativos, para funcionar também nesse tipo de subpasta.

Não envie apenas o ZIP ao repositório: o GitHub precisa dos arquivos extraídos. Não é preciso instalar dependências, executar compilação ou configurar um servidor.

## Arquivos principais

- `index.html`: conteúdo, seções, fotos e contatos.
- `styles.css`: identidade visual e adaptação às telas.
- `refinements.css`: ajustes das fotos, cantos arredondados e galerias laterais.
- `app.js`: menu, animações, galerias, filtros e preparação da mensagem de encomenda.
- `fonts.css` e `assets/fonts/`: fontes locais e suas licenças.
- `assets/`: fotos e logo.
- `.nojekyll`: indica que o conteúdo estático já está pronto para publicação.

## Contatos e funcionamento

O WhatsApp configurado é **+55 27 99723-6993**, e o Instagram é **@mamma.dulce**. Ambos foram obtidos do perfil da marca. Para alterar o telefone, procure por `5527997236993` em `index.html` e `app.js`.

O formulário monta a mensagem e abre o WhatsApp para o visitante revisar e enviar. Não recebe, confirma nem armazena encomendas por conta própria.

As fotos, as fontes e o código do site estão incluídos neste pacote. Os links para Instagram e WhatsApp levam aos respectivos serviços externos.

## Compartilhamento e domínio

O pacote não aponta para o antigo endereço de hospedagem. Depois de publicar, você pode incluir no `<head>` do `index.html` a imagem para prévias de compartilhamento usando o endereço absoluto final:

```html
<meta property="og:image" content="https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/assets/hero.webp">
```

Para usar um domínio próprio, configure-o em **Settings → Pages → Custom domain**, seguindo as instruções do GitHub.

## Referências

- [Configurar a publicação do GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Usar um domínio próprio](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)

As fontes Cormorant Garamond e DM Sans são distribuídas sob a SIL Open Font License. As licenças estão em `assets/fonts/`.

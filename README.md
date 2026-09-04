# Motor de Contestações (CIC)

Protótipo funcional de ingestão de petições iniciais, extração de dados, geração de
minuta de contestação e padrões de documento por cliente. Domínio de referência:
defesa de banco em ações sobre cartão de crédito consignado, RMC, RCC, empréstimo
consignado e refinanciamento (linha Agibank).

## Estrutura do repositório

```
index.html        a ferramenta inteira (interface, lógica de extração, geração e padrões)
api/anthropic.js  função serverless da Vercel, chama a API da Anthropic com a chave guardada no servidor
package.json      metadados mínimos do projeto
.env.example      modelo de variável de ambiente para rodar localmente
```

Não há passo de build. `index.html` é servido como está; `api/anthropic.js` é
detectado automaticamente pela Vercel como uma função serverless.

## Por que existe uma função serverless

A extração de dados da petição e a geração da seção "Regularidade dos descontos"
usam a API da Anthropic. Um navegador não pode chamar essa API diretamente com uma
chave secreta sem expor a chave a quem abrir a página, por isso `api/anthropic.js`
fica no servidor: guarda a chave em uma variável de ambiente e repassa a chamada.
O `index.html` chama sempre `/api/anthropic`, nunca a Anthropic diretamente.

Se a chave não estiver configurada, ou a função falhar por qualquer motivo, a
ferramenta cai automaticamente para a extração local por padrão de texto (regex) e
para o texto padrão do tema na geração da minuta. Isso já está implementado no
`index.html`, nenhum ajuste extra é necessário para esse comportamento de reserva
funcionar.

## Como publicar na Vercel

1. Suba este repositório para o GitHub (branch principal, sem alterações necessárias).
2. Em vercel.com, "Add New Project" e importe o repositório.
3. A Vercel detecta sozinha o `index.html` e a pasta `api/`, nenhuma configuração de
   build é necessária.
4. Antes do primeiro deploy (ou depois, redeployando), vá em
   Project Settings > Environment Variables e adicione:
   `ANTHROPIC_API_KEY` = a chave de API da Anthropic.
5. Deploy. A URL pública já sobe com a extração e a geração por IA funcionando.

## Como rodar localmente

Sem a função serverless (só a interface, extração cai para o modo local):
abra `index.html` direto no navegador.

Com a função serverless, usando a CLI da Vercel:
```
npm install -g vercel
cp .env.example .env.local   # edite .env.local com sua chave real
vercel dev
```

## Estado atual (o que já funciona)

- Upload de petição inicial em PDF ou TXT, com leitura de texto real via pdf.js.
- Extração de dados (número CNJ, autor, réu, valor da causa, tema, resumo, pedidos),
  com tentativa por IA e reserva local por padrão de texto.
- Detecção automática de pedido de tutela de urgência na petição.
- Biblioteca de teses validada a partir de três contestações reais (Cartão de
  crédito consignado, RMC, RCC, Empréstimo consignado, Refinanciamento, Seguro).
- Geração de minuta com numeração de seção sequencial garantida por código
  (elimina os bugs de numeração encontrados na validação: seção duplicada, título
  órfão, argumento repetido).
- Preliminares condicionais (ausência de comprovante de residência, ilegitimidade
  passiva, prescrição trienal, ausência de interesse de agir) selecionáveis por
  checkbox antes da geração.
- Portão de qualidade automático, com as regras derivadas da validação real.
- Aba de Análises: agrega os resultados do portão de qualidade de todas as
  gerações da sessão, aponta o campo ou regra que falha com mais frequência.
- Download da minuta em `.doc` (HTML compatível com Word) e opção de imprimir
  direto para PDF pelo navegador.
- Padrões de documento por cliente: cabeçalho "montado" no sistema (tarja
  colorida, pontinhos decorativos, logo) ou "anexado" como imagem pronta, mais
  margens personalizadas por cliente, aplicados de verdade no `.doc` gerado.
- Pré-visualização em escala real (folha A4, 21 cm) da minuta com o cabeçalho e a
  margem do cliente selecionado, antes do download.

## Limitação atual mais importante

Todo o estado (processos carregados, contestações geradas, análises, clientes
cadastrados) vive apenas na memória do navegador durante a sessão. Fechar a aba
apaga tudo. Não há banco de dados nem conta de usuário.

## Próximos passos sugeridos

1. Persistência real: mover `cases`, `analyses` e `clientes` para um banco (ex.:
   Postgres na própria Vercel, ou Supabase) em vez de variáveis em memória.
2. Autenticação básica, já que isso vai lidar com petições reais de clientes.
3. Ampliar a biblioteca de teses (`TEMA_PRODUTOS` em `index.html`) à medida que
   mais contestações reais forem validadas, seguindo o mesmo processo usado para
   os seis temas atuais: ler peças reais, extrair o padrão comum, e só então
   generalizar.
4. Avaliar suporte a upload de petição em `.docx`, hoje só PDF e TXT são aceitos.
5. Registrar o desfecho real de cada processo (procedente, improcedente, acordo)
   para fechar o ciclo de aprendizado por resultado, hoje a aba Análises só mede
   completude documental, não taxa de êxito.

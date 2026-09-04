# Motor de Contestações (CIC)

Protótipo funcional de ingestão de petições iniciais, extração de dados, geração de
minuta de contestação e padrões de documento por cliente. Domínio de referência:
defesa de banco em ações sobre cartão de crédito consignado, RMC, RCC, empréstimo
consignado e refinanciamento (linha Agibank).

## Estrutura do repositório

```
index.html          a ferramenta inteira (interface, lógica de extração, geração e padrões)
api/anthropic.js    função serverless da Vercel, chama a API da Anthropic com a chave guardada no servidor
middleware.js       middleware de borda da Vercel, restringe o acesso a IPs autorizados
tests/              suíte de regressão (Playwright Test), ver seção "Testes automatizados"
playwright.config.js configuração da suíte de testes
package.json        metadados do projeto e dependência de desenvolvimento dos testes
.env.example        modelo de variável de ambiente para rodar localmente
```

Não há passo de build. `index.html` é servido como está; `api/anthropic.js` é
detectado automaticamente pela Vercel como uma função serverless; `middleware.js`
é detectado automaticamente como middleware de borda.

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
3. A Vercel detecta sozinha o `index.html`, a pasta `api/` e o `middleware.js`,
   nenhuma configuração de build é necessária.
4. Antes do primeiro deploy (ou depois, redeployando), vá em
   Project Settings > Environment Variables e adicione:
   - `ANTHROPIC_API_KEY` = a chave de API da Anthropic.
   - `ALLOWED_IPS` (opcional) = lista de IPs autorizados a acessar o site, separados
     por vírgula. Sem essa variável, o sistema usa os dois IPs padrão configurados em
     `middleware.js` (ver seção "Restrição de acesso por IP" abaixo).
5. Deploy. A URL pública já sobe com a extração e a geração por IA funcionando, e o
   acesso já restrito aos IPs autorizados.

## Restrição de acesso por IP

Enquanto o sistema estiver em fase de teste, o acesso ao site inteiro (páginas e
função de IA) fica restrito por padrão a dois IPs, aplicado em `middleware.js`,
que roda na borda da Vercel antes de qualquer resposta:

- `186.193.236.194`
- `179.191.112.34`

Qualquer requisição de fora dessa lista recebe uma resposta 403 (acesso restrito).
Para alterar a lista sem editar código, configure a variável de ambiente
`ALLOWED_IPS` (lista separada por vírgula) em Project Settings > Environment
Variables na Vercel e refaça o deploy.

Ponto de atenção: bloqueio por IP é frágil para quem usa IP dinâmico, rede móvel
ou VPN corporativa — o próprio endereço autorizado pode mudar sem aviso e travar
o acesso de quem deveria ter. Serve como uma camada a mais de proteção enquanto o
uso é restrito a poucas pessoas em fase de teste, não substitui autenticação real.

## Ambiente de homologação separado de produção

Antes de testar com processo real de cliente, evite fazer isso direto na URL de
produção. A Vercel já cria automaticamente uma "Preview Deployment" com URL própria
para qualquer branch ou pull request diferente do branch de produção (normalmente
`main`) — use essa URL de preview para validar mudanças de código antes de
mesclar para produção.

Para separar de verdade o uso de teste do uso real (não só o código, mas o próprio
acesso), duas opções, da mais simples à mais completa:

1. Em Project Settings > Environment Variables, defina `ALLOWED_IPS` com escopo
   diferente por ambiente (a Vercel permite marcar cada variável como Production,
   Preview ou Development): um `ALLOWED_IPS` mais aberto (IPs de quem testa) no
   ambiente de Preview, e o `ALLOWED_IPS` restrito de verdade só em Production.
2. Para isolamento total (recomendado antes de processar o primeiro caso real),
   criar um segundo projeto na Vercel apontando para o mesmo repositório (ou um
   branch dedicado `homologacao`), com sua própria `ANTHROPIC_API_KEY` e seu
   próprio domínio/URL, para que teste nunca compartilhe o mesmo ambiente
   (nem a mesma chave de API, nem os mesmos usuários) que o uso real.

## Como rodar localmente

Sem a função serverless (só a interface, extração cai para o modo local):
abra `index.html` direto no navegador.

Com a função serverless, usando a CLI da Vercel:
```
npm install -g vercel
cp .env.example .env.local   # edite .env.local com sua chave real
vercel dev
```

## Testes automatizados

Suíte de regressão com Playwright Test (`tests/app.spec.js`), cobrindo login e troca
de senha obrigatória, administração de usuários, segregação de acesso por operador,
geração de minuta com prazo/revisão obrigatória/desfecho, e responsividade básica.
Roda contra o próprio `index.html`, sem precisar de `ANTHROPIC_API_KEY` (pdf.js e
mammoth.js são substituídos por um stub para o teste não depender de CDN externo).

```
npm install
npx playwright install chromium   # só na primeira vez, baixa o navegador de teste
npm test
```

Sempre rodar a suíte antes de subir uma mudança para produção. Ela já pegou bugs
reais durante o desenvolvimento (troca de usuário deixando dado da sessão anterior
na tela, e um estouro de layout em telas estreitas causado por um item de grid sem
`min-width:0`) que passariam despercebidos numa checagem manual rápida.

## Estado atual (o que já funciona)

- Upload de petição inicial em PDF, DOCX ou TXT, com leitura de texto real via
  pdf.js (PDF) e mammoth.js (DOCX).
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
- Login obrigatório antes de usar o sistema, com troca de senha forçada no
  primeiro acesso quando o usuário ainda está com senha temporária.
- Aba Admin (visível só para usuários com papel de administrador) para cadastrar
  novos usuários, redefinir senha e alternar papel entre operador e admin.
- Restrição de acesso por IP na borda da Vercel (`middleware.js`), aplicada ao
  site inteiro antes de qualquer página ou função ser servida.
- Segregação de fila por operador: quem não é admin só vê os processos que
  carregou; admin alterna entre "todos" e "só os meus" na aba Fila.
- Controle de prazo processual (estimativa): informando a data de citação e o
  prazo em dias úteis na aba Geração, o sistema calcula a data-limite e mostra
  quantos dias úteis faltam, com aviso visual quando o prazo está próximo ou
  vencido. É uma estimativa (só desconta sábado e domingo, sem calendário de
  feriados forenses por comarca) — sempre conferir o prazo real no processo.
- Revisão obrigatória antes do download: os botões de baixar e imprimir a
  minuta ficam bloqueados até marcar duas confirmações (revisão do advogado
  concluída, e citação do STJ sobre biometria facial conferida na fonte
  oficial). A confirmação registra quem confirmou e quando.
- Registro de quem gerou cada minuta (usuário logado, data e hora), visível no
  topo da minuta gerada e na aba Análises.
- Desfecho real do processo (pendente, procedente, improcedente, acordo)
  registrável na aba Geração; a aba Análises calcula a taxa de êxito real a
  partir dos desfechos já registrados, além do checklist de completude.
- Indicador de progresso (dados extraídos → minuta gerada → revisão confirmada →
  arquivo baixado) na aba Geração, refletindo o estado real de cada processo.
- Aviso visual claro nas abas "Casos similares" e "Portão de qualidade" de que são
  telas de protótipo com dados ilustrativos fixos, não conectadas aos processos
  reais da sessão.
- Alerta por campo quando a extração (IA ou local) não conseguiu localizar o dado,
  em vez de só mostrar o texto "não localizado" sem destaque.
- Contador de uso da API de IA na aba Análises (chamadas tentadas, quantas caíram
  para o modo local, tokens de entrada/saída somados), sem estimar custo em R$/US$
  no código (o preço por token muda; ver anthropic.com/pricing para calcular).
- Botão de exportar/imprimir um relatório da aba Análises.
- Aviso sobre envio de trechos da petição à API da Anthropic para extração/geração
  por IA, exibido perto do upload (ver seção de privacidade abaixo).
- Suíte de testes automatizados (Playwright Test) cobrindo os fluxos acima.

## Privacidade e dados enviados à IA

A leitura do arquivo (PDF/DOCX/TXT) acontece inteiramente no navegador. Para a
extração de campos e a adaptação da seção "Regularidade dos descontos", trechos de
texto da petição (até 7.000 caracteres para extração, até 3.000 para a adaptação de
texto) são enviados à API da Anthropic através de `api/anthropic.js`. Isso não é uma
análise de conformidade LGPD formal, apenas uma transparência operacional: revisar
com o time jurídico/DPO antes de processar petição com dado sensível de consumidor
em volume, e avaliar se algum campo precisa ser mascarado antes do envio.

## Limitação atual mais importante

Todo o estado (processos carregados, contestações geradas, análises, clientes
cadastrados) vive apenas na memória do navegador durante a sessão. Fechar a aba
apaga tudo. Não há banco de dados.

Os usuários são a única coisa que sobrevive ao fechar a aba: ficam gravados no
`localStorage` do navegador. Isso é suficiente para testar o fluxo de login,
mas **não é autenticação de produção**: a senha guardada usa apenas um hash
simples de ofuscação (não criptográfico), não há proteção contra força bruta,
e o cadastro de usuários não é sincronizado entre navegadores ou dispositivos
diferentes. Antes de usar com petições reais de clientes, mover a autenticação
para um backend de verdade é o próximo passo obrigatório.

Usuário administrador padrão, criado automaticamente no primeiro uso de cada
navegador: `marcos.oliveira`, senha temporária `1234` (o sistema exige a troca
dessa senha assim que o login é feito).

## Próximos passos sugeridos

1. Persistência real: mover `cases`, `analyses`, `clientes` e `usuários` para um
   banco (ex.: Postgres na própria Vercel, ou Supabase) em vez de variáveis em
   memória e `localStorage`.
2. Autenticação de produção: hash de senha criptográfico e verificação no
   servidor (hoje a checagem de senha roda inteiramente no navegador), já que
   isso vai lidar com petições reais de clientes.
3. Ampliar a biblioteca de teses (`TEMA_PRODUTOS` em `index.html`) à medida que
   mais contestações reais forem validadas, seguindo o mesmo processo usado para
   os seis temas atuais: ler peças reais, extrair o padrão comum, e só então
   generalizar. Não dá para simplesmente inventar tese nova sem validar contra
   peça real, sob risco de gerar defesa juridicamente incorreta.
4. Gerar o arquivo final como `.docx` nativo (biblioteca de geração no navegador
   ou no backend) em vez do truque de HTML compatível com Word usado hoje.
5. Calendário de feriados forenses por comarca/tribunal para o cálculo de prazo
   ficar mais próximo do prazo real (hoje só desconta sábado e domingo).
6. Log de auditoria persistente (hoje o histórico de quem gerou/confirmou cada
   minuta vive só em memória, como o restante do estado da sessão).
7. Revisão de conformidade LGPD formal com o time jurídico/DPO (hoje só existe um
   aviso operacional na interface, ver seção "Privacidade e dados enviados à IA").
8. Segundo projeto Vercel dedicado a homologação, isolado do de produção (hoje só
   existe a recomendação de uso das Preview Deployments da própria Vercel, ver
   seção "Ambiente de homologação separado de produção").
9. Rodar a suíte de testes automaticamente a cada push (CI, ex.: GitHub Actions),
   hoje ela só roda sob comando manual (`npm test`).

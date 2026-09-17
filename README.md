# Motor de Contestações (CIC)

Protótipo funcional de ingestão de petições iniciais, extração de dados, geração de
minuta de contestação e padrões de documento por cliente. Domínio de referência:
defesa de banco em ações sobre cartão de crédito consignado, RMC, RCC, empréstimo
consignado e refinanciamento (linha Agibank).

## Estrutura do repositório

```
index.html          a ferramenta inteira (interface, lógica de extração, geração e padrões)
api/anthropic.js    função serverless da Vercel, chama a API da Anthropic com a chave guardada no servidor
api/users.js        função serverless da Vercel, login e administração de usuários/empresas (banco Postgres/Neon)
api/dados.js        função serverless da Vercel, fila/análises/teses/padrões, segregados por empresa (mesmo banco)
api/package.json    marca a pasta api/ como módulos ES (api/users.js e api/dados.js usam import/export)
data/teses-sistema.json  286 teses padrão (matriz causa raiz x produto), arquivo estático, igual para todas as empresas
middleware.js       middleware de borda da Vercel, restringe o acesso a IPs autorizados
tests/              suíte de regressão (Playwright Test), ver seção "Testes automatizados"
playwright.config.js configuração da suíte de testes
package.json        metadados do projeto e dependências (driver Neon, Playwright Test)
.env.example        modelo de variável de ambiente para rodar localmente
```

Não há passo de build. `index.html` é servido como está; `api/anthropic.js`,
`api/users.js` e `api/dados.js` são detectados automaticamente pela Vercel como funções
serverless; `middleware.js` é detectado automaticamente como middleware de borda.

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
4. **Antes do primeiro deploy, crie o banco de usuários** — ver seção "Banco de
   usuários (login/admin)" logo abaixo. Sem isso, ninguém consegue fazer login,
   nem o admin padrão.
5. Em Project Settings > Environment Variables, adicione também:
   - `ANTHROPIC_API_KEY` = a chave de API da Anthropic.
   - `ALLOWED_IPS` (opcional) = lista de IPs autorizados a acessar o site, separados
     por vírgula. Sem essa variável, o sistema usa os dois IPs padrão configurados em
     `middleware.js` (ver seção "Restrição de acesso por IP" abaixo).
6. Deploy. A URL pública já sobe com login, extração e geração por IA funcionando,
   e o acesso já restrito aos IPs autorizados.

## Banco de usuários (login/admin)

Login, senha e papel (admin/operador) ficam em uma tabela Postgres compartilhada
(banco Neon, plano gratuito) — assim funcionam igual em qualquer máquina, não só na
de quem cadastrou. Passo a passo para criar:

1. No painel do projeto na Vercel, aba **Storage** > **Create Database**.
2. Escolha a integração **Neon** (Postgres). Na tela de instalação, **desligue o
   toggle "Auth"** (esse toggle liga o serviço de autenticação pronto do Neon, que
   este projeto não usa — o login já é feito pelo próprio `api/users.js`). Escolha
   o plano **Free**.
3. Confirme a criação e **conecte o banco a este projeto** quando a Vercel perguntar
   (isso já preenche `DATABASE_URL` — e algumas variáveis `POSTGRES_*` equivalentes
   — nas variáveis de ambiente do projeto automaticamente, não precisa copiar nada
   manualmente).
4. Em Project Settings > Environment Variables, adicione também `SESSION_SECRET`
   com uma string aleatória longa (ex.: gerada com `openssl rand -hex 32` no
   terminal, ou qualquer gerador de senha forte). Essa string assina o token de
   login — sem ela, ninguém consegue entrar.
5. Faça (ou refaça) o deploy depois de configurar essas variáveis.

A tabela `users` é criada automaticamente na primeira chamada à API (não precisa
rodar nenhum script de migração manual), e populada com o usuário administrador
padrão: `marcos.oliveira`, senha temporária `1234` (o sistema exige a troca dessa
senha assim que o login é feito). A partir daí, esse mesmo usuário — e qualquer
outro cadastrado na aba Admin — funciona identicamente em qualquer navegador ou
máquina, porque agora fica no banco, não mais no navegador de quem cadastrou.

Se essas variáveis não estiverem configuradas, `api/users.js` responde com um erro
claro ("Banco de usuários não configurado...") em vez de falhar silenciosamente.

## Multi-empresa (multi-tenant): cada empresa só vê os próprios dados

Pensado para o cenário de vender o sistema a mais de uma empresa/cliente: cada uma só
enxerga e edita os próprios processos, teses e padrões de cliente, nunca os de outra.
Dois papéis:

- **Admin master** (`papel = 'admin'`): enxerga e administra todas as empresas —
  cadastra empresas, cadastra usuários e escolhe a empresa de cada um, e pode alternar
  a própria visão entre uma empresa específica ou "todas as empresas" (agregado).
- **Usuário de empresa** (`papel = 'operador'`): só vê e só grava os dados da própria
  empresa (`empresa_id`, gravado no token de sessão assinado no login). Não existe hoje
  um papel intermediário de "admin da própria empresa" — só o admin master cadastra
  usuários e empresas (decisão explícita, para manter o modelo simples nesta fase).

Como funciona, tecnicamente:

- `api/users.js` ganhou a tabela `empresas` e a coluna `users.empresa_id`. O admin
  master tem sua própria empresa reservada ("Interno (admin master)"), criada
  automaticamente no primeiro uso — mesmo ele precisa de uma empresa "dona" dos
  próprios dados de teste.
- `api/dados.js` (nova função) passou a guardar fila, análises, Banco de teses e
  Padrões por cliente num Postgres compartilhado, numa tabela `estado_empresa` (uma
  linha por empresa, com todo o estado num campo JSONB). Antes, esses dados viviam só
  no `localStorage` do navegador — sem checagem alguma de quem podia ver o quê. Agora
  a segregação é aplicada no servidor, a partir do `empresa_id` do token de sessão, não
  apenas na tela.
- No topo da tela, o admin master vê um seletor de empresa (some para usuários
  comuns). Ao escolher "Todas as empresas", a tela vira **somente leitura**: dá para
  ver a fila, teses e padrões de todo mundo, com o nome da empresa em cada linha, mas
  não dá para enviar petição, gerar minuta, nem editar teses/padrões — porque não
  haveria uma única empresa dona da gravação. Para editar, escolha uma empresa
  específica no seletor.
- Limitação conhecida: o token de sessão é autocontido (ver seção de limitações mais
  abaixo) e carrega o `empresa_id` do momento do login. Se o admin master mudar a
  empresa de um usuário já logado, isso só passa a valer no próximo login dele.
- Migração seguro para bancos que já tinham usuários antes deste recurso existir:
  ao adicionar a coluna `empresa_id`, usuários antigos ficariam sem empresa (o que os
  bloquearia). `api/users.js` corrige isso sozinho, a cada chamada: garante que existe
  uma empresa "Interno (admin master)" e move para ela qualquer usuário sem empresa
  associada. Não é preciso rodar nada manualmente após o deploy; só reatribuir depois,
  pela aba Admin, quem precisar ficar numa empresa diferente.

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

Suíte de regressão com Playwright Test:

- `tests/app.spec.js`: fluxos de login e troca de senha obrigatória, administração
  de usuários e empresas, segregação de acesso por operador e por empresa (multi-tenant),
  geração de minuta com prazo, exclusão de processo, Banco de teses, direcionador
  Defesa/Acordo, tradução de referência, e responsividade básica. Roda contra o
  próprio `index.html` sem precisar de banco real nem `ANTHROPIC_API_KEY` (pdf.js e
  mammoth.js viram um stub; `/api/users` e `/api/dados` são simulados em memória, com
  o mesmo formato de request/resposta das funções de verdade).
- `tests/users-crypto.spec.js`: teste de unidade das partes de segurança de
  `api/users.js` de verdade (hash de senha com scrypt, token de sessão assinado por
  HMAC, rejeição de token adulterado/expirado) — sem precisar de Postgres para
  isso, são funções puras.

```
npm install
npx playwright install chromium   # só na primeira vez, baixa o navegador de teste
npm test
```

Sempre rodar a suíte antes de subir uma mudança para produção. Ela já pegou bugs
reais durante o desenvolvimento (troca de usuário deixando dado da sessão anterior
na tela, e um estouro de layout em telas estreitas causado por um item de grid sem
`min-width:0`) que passariam despercebidos numa checagem manual rápida.

## Identidade visual

A interface usa a marca **SBK IA** (Brand Book 2026, variação de produto digital):
fundo Off White `#ECEFF3`, tinta `#023631` (Verde Escuro), destaque `#075056`
(Ciano Escuro) no tema claro e `#2A7C79` (Ciano) no tema escuro, tipografia Plus
Jakarta Sans (Seminegrito nos títulos, Leve no corpo de texto). A prévia da minuta
gerada (`.page-preview`/`.doc-frame`) continua com fonte serifada de propósito:
ela simula um documento que vai a protocolo em juízo, não um material da SBK, e
segue a convenção tipográfica de peça jurídica, não a identidade de marca da
ferramenta que a gera — a mesma distinção vale para o `.doc` exportado, cuja fonte
padrão (Times New Roman, configurável por cliente em Padrões por cliente) segue
convenção de documento jurídico, não a marca.

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
- Checklist automático de qualidade da minuta (numeração sem duplicidade, título
  repetido, preliminares antes do mérito, tutela tratada quando identificada),
  com pontuação exibida logo abaixo da minuta gerada.
- Aba de Análises: agrega os resultados do checklist de todas as gerações da
  sessão, aponta o campo ou regra que falha com mais frequência, e cada linha
  reabre a minuta daquele processo com um clique.
- Aba "Banco de teses": cadastro de teses por produto (tema), causa raiz, pedido
  e modelo de texto; toda tese cadastrada para o produto de um processo entra
  automaticamente como seção extra na minuta gerada para aquele produto.
- Dentro da mesma aba, "Teses padrão do sistema": 286 teses reais (matriz causa
  raiz x produto, `data/teses-sistema.json`), iguais para todas as empresas,
  filtráveis por produto e causa raiz. É só leitura — o botão "usar como base"
  pré-preenche o formulário de tese própria da empresa para revisão e salvamento
  manual, porque a unidade de organização da planilha de origem (causa raiz) não
  é a mesma do campo "Pedido" usado hoje para casar automaticamente com os pedidos
  da petição (ver "Próximos passos" sobre a migração para as 15 seções do CPC).
  As citações de jurisprudência já embutidas no texto dessas 286 teses (Súmula 479,
  Tema 1061, EAREsp 676.608, Súmula 385, Súmulas 382 e 530, REsp 1.061.530, todas
  do STJ) foram verificadas em fontes independentes em 17/09/2026: todas existem e
  a tese bate com a descrição, com uma ressalva — o REsp 1.061.530/RS tem como
  núcleo juros remuneratórios/mora/comissão de permanência, não capitalização de
  juros; para citar capitalização especificamente, o precedente mais preciso é o
  REsp 973.827/RS. A Súmula 385 também tem uma mitigação conhecida: não afasta o
  dano moral quando as demais inscrições preexistentes também são indevidas/
  discutidas judicialmente. Reconferir sempre antes de um protocolo real.
- Painel "Defesa aplicada por pedido" na minuta gerada: para cada pedido
  identificado na petição (via IA), mostra se uma tese do Banco de teses foi
  aplicada ou se seguiu o modelo padrão do tema.
- Direcionador "Defesa ou Acordo" na tela de Geração: no caminho de acordo, o
  sistema não gera nenhuma minuta (os termos de um acordo dependem de negociação
  real, não são algo para a IA inventar), só registra o encaminhamento e uma
  observação do operador.
- Upload de documentos de apoio (contratos, comprovantes, telas de sistema) além
  da petição inicial, por processo; ficam disponíveis para reabrir enquanto a
  aba do navegador não é fechada (ver limitação abaixo).
- Opção de excluir um processo da fila, tanto na lista quanto dentro da tela de
  Geração.
- Fila, análises, clientes e Banco de teses ficam salvos num banco compartilhado
  (Postgres, `api/dados.js`), segregados por empresa — sobrevivem a uma atualização
  de página e a uma troca de máquina/navegador, e uma empresa nunca vê os dados de
  outra (ver seção "Multi-empresa").
- Opção de baixar a minuta traduzida por IA para inglês, espanhol ou francês,
  como cópia de referência: o arquivo carrega um aviso, no próprio `.doc`, de que
  não é peça válida para protocolo — a peça oficial é sempre a versão em
  português.
- Download da minuta em `.doc` (HTML compatível com Word) e opção de imprimir
  direto para PDF pelo navegador.
- Padrões de documento por cliente: cabeçalho "montado" no sistema (tarja
  colorida, pontinhos decorativos, logo) ou "anexado" como imagem pronta, mais
  margens personalizadas por cliente, aplicados de verdade no `.doc` gerado.
- Pré-visualização em escala real (folha A4, 21 cm) da minuta com o cabeçalho e a
  margem do cliente selecionado, antes do download.
- Login obrigatório antes de usar o sistema, com troca de senha forçada no
  primeiro acesso quando o usuário ainda está com senha temporária. Usuários,
  senha (hash com scrypt) e papel ficam numa tabela Postgres compartilhada (Neon,
  ver seção "Banco de usuários"), não mais no navegador — funciona igual em qualquer
  máquina.
  A verificação de senha e a checagem de papel de admin acontecem no servidor,
  com um token de sessão assinado por HMAC (expira em 12h).
- Aba Admin (visível só para o admin master) para cadastrar empresas, cadastrar
  novos usuários (atribuindo a empresa de cada um), redefinir senha e alternar
  papel entre usuário de empresa e admin master.
- Restrição de acesso por IP na borda da Vercel (`middleware.js`), aplicada ao
  site inteiro antes de qualquer página ou função ser servida.
- Segregação por empresa (multi-tenant): cada empresa só vê e edita os próprios
  processos, teses e padrões; o admin master alterna entre uma empresa específica
  e "todas as empresas" (agregado, só leitura) num seletor no topo da tela (ver
  seção "Multi-empresa").
- Segregação de fila por operador dentro da mesma empresa: quem não é admin master
  só vê os processos que carregou; admin master, quando dentro de uma empresa
  específica, alterna entre "todos" e "só os meus" na aba Fila.
- Controle de prazo processual (estimativa): informando a data de citação e o
  prazo em dias úteis na aba Geração, o sistema calcula a data-limite e mostra
  quantos dias úteis faltam, com aviso visual quando o prazo está próximo ou
  vencido. É uma estimativa (só desconta sábado e domingo, sem calendário de
  feriados forenses por comarca) — sempre conferir o prazo real no processo.
- Download e impressão liberados assim que a minuta é gerada, sem confirmação
  extra bloqueando o botão (decisão explícita do usuário, ver "Limitação atual
  mais importante" — o texto de aviso de que a revisão do advogado é
  obrigatória antes do protocolo continua na tela, só não trava mais nada).
- Registro de quem gerou cada minuta (usuário logado, data e hora), visível no
  topo da minuta gerada e na aba Análises.
- Indicador de progresso (dados extraídos → minuta gerada → arquivo baixado)
  na aba Geração, refletindo o estado real de cada processo.
- Citações de jurisprudência real do STJ: na seção de biometria/assinatura
  eletrônica (REsp 2.159.442/PR, Terceira Turma, Rel. Min. Nancy Andrighi,
  29/11/2024) e na tese de danos morais (AgInt no AREsp 2.157.547/SC e AgInt
  nos EDcl no AREsp 1.669.683/SP), pesquisadas e verificadas em múltiplas
  fontes, incluindo contestações reais fornecidas pelo cliente — ver
  comentário acima de `BLOCOS_FIXOS` no código para a data da verificação, o
  lembrete de reconferir na fonte oficial (stj.jus.br) antes de qualquer
  protocolo real, e o alerta sobre o Tema 1.435/STJ (repetitivo em
  julgamento sobre dano moral presumido por desconto indevido em benefício
  previdenciário), que pode exigir revisão da tese de danos morais.
- Alerta por campo quando a extração (IA ou local) não conseguiu localizar o dado,
  em vez de só mostrar o texto "não localizado" sem destaque.
- Painel "IA Aplicada" na aba Admin: mostra se a chave da Anthropic está
  configurada no servidor e o consumo de tokens da sessão (chamadas tentadas,
  quantas caíram para o modo local, tokens de entrada/saída somados), sem
  estimar custo em R$/US$ no código (o preço por token muda; ver
  anthropic.com/pricing para calcular) e sem expor a chave em nenhum campo de
  tela.
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

Usuários, empresas e o restante do estado de trabalho (processos, análises, clientes,
Banco de teses) já ficam num banco de verdade, segregado por empresa (ver seção
"Multi-empresa"). Os documentos de apoio anexados a um processo (aba Geração) são a
exceção que falta: o arquivo em si (blob) fica só em memória da aba, não é salvo no
banco (o formato JSONB usado hoje para o resto do estado não é adequado para arquivos
binários de qualquer tamanho), então precisam ser reanexados depois de um F5. Guardar
esses arquivos de verdade (ex.: Vercel Blob Storage ou similar) é o próximo passo
natural nessa frente.

Mesmo com o banco de usuários, isto ainda não é autenticação de nível bancário: não
há limite de tentativas de login (proteção contra força bruta), nem rotação/revogação
de token antes da expiração (12h). Para o volume de uso desta ferramenta (uso interno,
poucas dezenas de contas) é um risco aceitável; reavaliar se o uso crescer.

**Decisão explícita do usuário sobre a revisão antes do download.** Em uma versão
anterior, o sistema exigia marcar duas confirmações (revisão do advogado concluída e
citação do STJ conferida) antes de liberar o botão de baixar/imprimir a minuta. A
pedido do usuário, essa trava foi removida: o download/impressão fica liberado assim
que a minuta é gerada, sem clique extra. O aviso de que a revisão humana é obrigatória
antes do protocolo continua visível na tela, só deixou de ser uma trava técnica —
agora depende inteiramente do processo de trabalho de quem usa a ferramenta, o
sistema não impede mais o download de uma minuta não revisada.

## Próximos passos sugeridos

1. **Migrar a estrutura da minuta para as 15 seções do CPC** (arts. 335 a 342),
   com seções condicionais, três variações de modelo (completo, objetivo para
   Juizado Especial, bancário e consumerista) e o módulo de reconvenção — conforme
   o documento de referência recebido do cliente (`documento-completo-motor-
   contestacoesv5.docx`). É uma mudança grande na função `montarSecoes()` e no
   checklist de qualidade, por isso a proposta é em etapas, não de uma vez:
   1. Adicionar campo de causa raiz na extração por IA (hoje só extrai
      número/autor/réu/valor/tema/resumo/pedidos) — pré-requisito para o passo 3.
   2. Reescrever `montarSecoes()` para as 15 seções, mantendo o texto atual de
      `BLOCOS_FIXOS` realocado nas seções correspondentes (mérito, impugnação,
      provas), sem quebrar os testes existentes.
   3. Ligar as "teses padrão do sistema" (`data/teses-sistema.json`) e as teses
      próprias de cada empresa à seção de mérito por causa raiz, substituindo o
      casamento atual por produto/pedido.
   4. Adicionar o seletor de variação do modelo (completo/objetivo/bancário e
      consumerista) e o módulo de reconvenção, condicionados a informação real do
      caso, nunca inventados.
   Enquanto isso não acontece, o Banco de teses padrão do sistema fica disponível
   só como referência de leitura (ver "Teses padrão do sistema" acima).
2. Guardar de verdade os documentos de apoio anexados a um processo (hoje só ficam
   em memória da aba do navegador, ver "Limitação atual mais importante") — provavelmente
   um serviço de armazenamento de arquivos (ex.: Vercel Blob Storage), não o mesmo
   JSONB usado para o restante do estado.
   Um papel intermediário de "admin da própria empresa" (hoje só o admin master
   cadastra usuários/empresas) também fica para uma próxima rodada, se granularidade
   de administração por empresa vier a ser necessária.
3. Ampliar a biblioteca de teses (`TEMA_PRODUTOS` em `index.html`) à medida que
   mais contestações reais forem validadas, seguindo o mesmo processo usado para
   os seis temas atuais: ler peças reais, extrair o padrão comum, e só então
   generalizar. Não dá para simplesmente inventar tese nova sem validar contra
   peça real, sob risco de gerar defesa juridicamente incorreta. Um candidato já
   identificado nas contestações de referência fornecidas pelo cliente: "ação
   revisional de juros/taxa abusiva" é um tipo de caso bem diferente dos seis
   temas atuais (todos sobre desconto indevido em consignado), com jurisprudência
   própria (REsp 1.036.818, REsp 1.061.530/RS, REsp 271.214, REsp 971.853, Súmula
   530/STJ) — precisaria virar um tema novo, não ser misturado nos existentes. As
   286 teses padrão do sistema (ver acima) já cobrem 13 produtos e 43 causas raiz
   diferentes, incluindo "Revisão de Juros", e podem alimentar essa ampliação.
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
8. Rodar a suíte de testes automaticamente a cada push (CI, ex.: GitHub Actions),
   hoje ela só roda sob comando manual (`npm test`).
9. Limite de tentativas de login (proteção contra força bruta) e um jeito de
   revogar um token de sessão antes da expiração (hoje o token é autocontido e
   válido até expirar, sem lista de revogação).

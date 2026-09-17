// Suíte de regressão do Motor de Contestações.
//
// Cobre o que antes era validado manualmente durante o desenvolvimento: login e troca de
// senha obrigatória, administração de usuários, segregação de acesso por operador, geração
// de minuta com prazo/exclusão de processo/reabertura via Análises, e responsividade básica. Roda contra o
// próprio index.html, sem backend real (pdf.js e mammoth.js são substituídos por um stub —
// ver stubarBibliotecas abaixo — para o teste não depender de CDN externo nem gerar PDF/DOCX
// de verdade; a extração em si não é o que está sendo testado aqui).
const { test, expect } = require('@playwright/test');
const path = require('path');

const PETICAO_TESTE = path.join(__dirname, 'fixtures', 'peticao-teste.txt');
const PETICAO_SEM_TUTELA = path.join(__dirname, 'fixtures', 'peticao-sem-tutela.txt');

async function stubarBibliotecas(page) {
  await page.addInitScript(() => {
    window.pdfjsLib = {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 0,
          getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [] }) }),
        }),
      }),
    };
    window.mammoth = { extractRawText: async () => ({ value: '' }) };
  });
}

// api/users.js e api/dados.js precisam de um Postgres real (ver tests/users-crypto.spec.js
// para o teste de unidade do hash de senha e do token, que é a parte que realmente importa
// checar contra código de verdade). Aqui, para os testes de fluxo (login, admin, geração,
// segregação por empresa), simulamos as duas APIs — mesmo formato de request/response — com
// um "banco" em memória por teste, incluindo empresas e o estado de dados por empresa.
async function instalarMocksBackend(page) {
  let empresas = [{ id: 1, nome: 'Interno (admin master)' }];
  let proximoEmpresaId = 2;
  let usuarios = [
    { id: 1, usuario: 'marcos.oliveira', senha: '1234', papel: 'admin', trocarSenha: true, empresaId: 1 },
  ];
  let proximoId = 2;
  let estadoPorEmpresa = {}; // empresaId -> { cases, analyses, clientes, teses, ... }

  const tokenPara = u => `TESTE-TOKEN-${u.id}`;
  const usuarioDoToken = auth => {
    const m = /^Bearer TESTE-TOKEN-(\d+)$/.exec(auth || '');
    return m ? usuarios.find(u => u.id === parseInt(m[1])) || null : null;
  };
  const publico = u => ({ id: u.id, usuario: u.usuario, papel: u.papel, trocarSenha: u.trocarSenha, empresaId: u.empresaId });

  await page.route('**/api/users*', async route => {
    const req = route.request();
    const auth = req.headers()['authorization'];

    if (req.method() === 'GET') {
      const sessao = usuarioDoToken(auth);
      if (!sessao || sessao.papel !== 'admin') { await route.fulfill({ status: 401, json: { error: 'Sessão inválida ou sem permissão de administrador.' } }); return; }
      await route.fulfill({ status: 200, json: { usuarios: usuarios.map(publico), empresas } });
      return;
    }

    const body = req.postDataJSON() || {};

    if (body.action === 'login') {
      const u = usuarios.find(x => x.usuario.toLowerCase() === (body.usuario || '').toLowerCase());
      if (!u || u.senha !== body.senha) { await route.fulfill({ status: 401, json: { error: 'Usuário ou senha inválidos.' } }); return; }
      await route.fulfill({ status: 200, json: { token: tokenPara(u), usuario: publico(u) } });
      return;
    }

    const sessao = usuarioDoToken(auth);
    if (!sessao) { await route.fulfill({ status: 401, json: { error: 'Sessão inválida ou expirada, faça login novamente.' } }); return; }

    if (body.action === 'change-password') {
      sessao.senha = body.novaSenha;
      sessao.trocarSenha = false;
      await route.fulfill({ status: 200, json: { token: tokenPara(sessao), usuario: publico(sessao) } });
      return;
    }

    if (sessao.papel !== 'admin') { await route.fulfill({ status: 403, json: { error: 'Ação restrita a administradores.' } }); return; }

    if (body.action === 'criar-empresa') {
      if (!body.nome || !body.nome.trim()) { await route.fulfill({ status: 400, json: { error: 'Informe o nome da empresa.' } }); return; }
      if (empresas.some(e => e.nome.toLowerCase() === body.nome.trim().toLowerCase())) { await route.fulfill({ status: 409, json: { error: 'Já existe uma empresa com esse nome.' } }); return; }
      empresas.push({ id: proximoEmpresaId++, nome: body.nome.trim() });
      await route.fulfill({ status: 200, json: { empresas } });
      return;
    }
    if (body.action === 'create') {
      if (usuarios.some(u => u.usuario.toLowerCase() === body.usuario.toLowerCase())) { await route.fulfill({ status: 409, json: { error: 'Já existe um usuário com esse login.' } }); return; }
      if (!body.empresaId) { await route.fulfill({ status: 400, json: { error: 'Selecione a empresa do novo usuário.' } }); return; }
      usuarios.push({ id: proximoId++, usuario: body.usuario, senha: body.senha, papel: body.papel === 'admin' ? 'admin' : 'operador', trocarSenha: true, empresaId: body.empresaId });
      await route.fulfill({ status: 200, json: { usuarios: usuarios.map(publico) } });
      return;
    }
    if (body.action === 'set-empresa') {
      const u = usuarios.find(x => x.id === body.id);
      if (u) u.empresaId = body.empresaId;
      await route.fulfill({ status: 200, json: { usuarios: usuarios.map(publico) } });
      return;
    }
    if (body.action === 'reset-password') {
      const u = usuarios.find(x => x.id === body.id);
      if (u) { u.senha = body.novaSenha || '1234'; u.trocarSenha = true; }
      await route.fulfill({ status: 200, json: { usuarios: usuarios.map(publico) } });
      return;
    }
    if (body.action === 'set-role') {
      const u = usuarios.find(x => x.id === body.id);
      const admins = usuarios.filter(x => x.papel === 'admin');
      if (u && u.papel === 'admin' && body.papel !== 'admin' && admins.length <= 1) { await route.fulfill({ status: 400, json: { error: 'Não é possível remover o último administrador.' } }); return; }
      if (u) u.papel = body.papel === 'admin' ? 'admin' : 'operador';
      await route.fulfill({ status: 200, json: { usuarios: usuarios.map(publico) } });
      return;
    }
    if (body.action === 'delete') {
      usuarios = usuarios.filter(x => x.id !== body.id);
      await route.fulfill({ status: 200, json: { usuarios: usuarios.map(publico) } });
      return;
    }
    await route.fulfill({ status: 400, json: { error: 'ação desconhecida no mock' } });
  });

  await page.route('**/api/dados*', async route => {
    const req = route.request();
    const auth = req.headers()['authorization'];
    const sessao = usuarioDoToken(auth);
    if (!sessao) { await route.fulfill({ status: 401, json: { error: 'Sessão inválida ou expirada, faça login novamente.' } }); return; }

    if (req.method() === 'GET') {
      const url = new URL(req.url());
      const empresaIdQuery = url.searchParams.get('empresaId');
      const souAdmin = sessao.papel === 'admin';
      if (souAdmin && !empresaIdQuery) {
        await route.fulfill({ status: 200, json: { modo: 'todas', empresas: empresas.map(e => ({ empresaId: e.id, empresaNome: e.nome, dados: estadoPorEmpresa[e.id] || {} })) } });
        return;
      }
      const empresaId = souAdmin ? parseInt(empresaIdQuery) : sessao.empresaId;
      const empresa = empresas.find(e => e.id === empresaId);
      if (!empresa) { await route.fulfill({ status: 404, json: { error: 'Empresa não encontrada.' } }); return; }
      await route.fulfill({ status: 200, json: { modo: 'empresa', empresaId: empresa.id, empresaNome: empresa.nome, dados: estadoPorEmpresa[empresaId] || {} } });
      return;
    }

    const body = req.postDataJSON() || {};
    if (body.action !== 'salvar') { await route.fulfill({ status: 400, json: { error: 'ação inválida' } }); return; }
    const alvo = (sessao.papel === 'admin' && body.empresaId) ? body.empresaId : sessao.empresaId;
    estadoPorEmpresa[alvo] = body.dados;
    await route.fulfill({ status: 200, json: { ok: true } });
  });
}

async function login(page, usuario, senha) {
  await page.fill('#loginUsuario', usuario);
  await page.fill('#loginSenha', senha);
  await page.click('#loginBtn');
}

async function trocarSenha(page, novaSenha) {
  await page.fill('#novaSenha1', novaSenha);
  await page.fill('#novaSenha2', novaSenha);
  await page.click('#changePwBtn');
}

async function loginComoAdminPadrao(page, novaSenha = 'novaSenha123') {
  await login(page, 'marcos.oliveira', '1234');
  await expect(page.locator('#changePwScreen')).toBeVisible();
  await trocarSenha(page, novaSenha);
  await expect(page.locator('#appShell')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // Bloqueia CDN externo (fonte, pdf.js, mammoth.js): o stub acima já cobre pdf.js/mammoth.js,
  // e a fonte não importa para o teste. Sem isso, o teste fica lento/instável em ambientes
  // sem acesso a esses domínios específicos.
  await page.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/, route => route.abort());
  await stubarBibliotecas(page);
  await instalarMocksBackend(page);
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' });
});

test.describe('login e troca de senha', () => {
  test('tela de login aparece antes de qualquer outra coisa', async ({ page }) => {
    await expect(page.locator('#loginScreen')).toBeVisible();
    await expect(page.locator('#appShell')).toBeHidden();
  });

  test('senha errada mostra erro e não libera acesso', async ({ page }) => {
    await login(page, 'marcos.oliveira', 'senha-errada');
    await expect(page.locator('#loginError')).toHaveText('Usuário ou senha inválidos.');
    await expect(page.locator('#appShell')).toBeHidden();
  });

  test('senha temporária padrão força troca antes de liberar o sistema', async ({ page }) => {
    await login(page, 'marcos.oliveira', '1234');
    await expect(page.locator('#changePwScreen')).toBeVisible();
    await expect(page.locator('#appShell')).toBeHidden();
  });

  test('nova senha exige confirmação igual e mínimo de caracteres', async ({ page }) => {
    await login(page, 'marcos.oliveira', '1234');
    await page.fill('#novaSenha1', 'abcdef');
    await page.fill('#novaSenha2', 'diferente');
    await page.click('#changePwBtn');
    await expect(page.locator('#changePwError')).toHaveText('As senhas não coincidem.');
    await expect(page.locator('#appShell')).toBeHidden();
  });

  test('depois de trocar a senha, login seguinte não força troca de novo', async ({ page }) => {
    await loginComoAdminPadrao(page, 'novaSenha123');
    await page.click('#logoutBtn');
    await login(page, 'marcos.oliveira', 'novaSenha123');
    await expect(page.locator('#appShell')).toBeVisible();
    await expect(page.locator('#changePwScreen')).toBeHidden();
  });
});

test.describe('admin e segregação de acesso', () => {
  test('painel IA Aplicada aparece no Admin mesmo quando o status da IA não pode ser consultado', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.click('#tabAdmin');
    await expect(page.locator('#adminBody')).toContainText('IA Aplicada');
    await expect(page.locator('#adminBody')).toContainText('chamadas de IA tentadas');
  });

  test('operador criado pelo admin é forçado a trocar senha e não vê a aba Admin', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.click('#tabAdmin');
    await page.fill('#novoUsuario', 'operador.teste');
    await page.fill('#novaSenhaUsuario', '1234');
    await page.selectOption('#novoPapel', 'operador');
    await page.click('#addUserBtn');
    await expect(page.locator('#adminBody')).toContainText('operador.teste');

    await page.click('#logoutBtn');
    await login(page, 'operador.teste', '1234');
    await expect(page.locator('#changePwScreen')).toBeVisible();
    await trocarSenha(page, 'opSenha123');

    await expect(page.locator('#tabAdmin')).toBeHidden();
    await expect(page.locator('#filtroTodos')).toBeHidden();
  });

  test('operador só vê os processos que carregou; admin alterna entre todos e só os seus', async ({ page }) => {
    await loginComoAdminPadrao(page);

    const [fc1] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc1.setFiles(PETICAO_TESTE);
    await expect(page.locator('.q-row[data-id]')).toHaveCount(1);

    await page.click('#tabAdmin');
    await page.fill('#novoUsuario', 'operador.segregacao');
    await page.fill('#novaSenhaUsuario', '1234');
    await page.selectOption('#novoPapel', 'operador');
    await page.click('#addUserBtn');

    await page.click('#logoutBtn');
    await login(page, 'operador.segregacao', '1234');
    await trocarSenha(page, 'opSenha123');

    // Regressão: trocar de usuário sem recarregar a página não pode deixar visível o
    // processo da sessão anterior (bug real encontrado e corrigido durante o desenvolvimento).
    await expect(page.locator('#filaBody')).not.toContainText('peticao-teste');
    await expect(page.locator('.q-row[data-id]')).toHaveCount(0);

    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc2.setFiles(PETICAO_TESTE);
    await expect(page.locator('.q-row[data-id]')).toHaveCount(1);

    await page.click('#logoutBtn');
    await login(page, 'marcos.oliveira', 'novaSenha123');
    await expect(page.locator('#filtroTodos')).toContainText('Todos os processos (2)');
    await expect(page.locator('#filtroMeus')).toContainText('Só os meus (1)');

    await page.click('#filtroMeus');
    await expect(page.locator('#filaBody')).not.toContainText('operador.segregacao');
  });
});

test.describe('segregação por empresa (multi-tenant)', () => {
  test('uma empresa não vê os processos da outra; admin master vê todas em modo agregado, só leitura', async ({ page }) => {
    await loginComoAdminPadrao(page);

    // Processo na própria empresa do admin master ("Interno").
    const [fc1] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc1.setFiles(PETICAO_TESTE);
    await expect(page.locator('.q-row[data-id]')).toHaveCount(1);

    // Cria uma segunda empresa e um usuário para ela.
    await page.click('#tabAdmin');
    await page.fill('#novaEmpresaNome', 'Empresa B');
    await page.click('#addEmpresaBtn');
    await expect(page.locator('#adminBody')).toContainText('Empresa B');

    await page.fill('#novoUsuario', 'usuario.empresab');
    await page.fill('#novaSenhaUsuario', '1234');
    await page.selectOption('#novaEmpresaUsuario', { label: 'Empresa B' });
    await page.click('#addUserBtn');
    await expect(page.locator('#adminBody')).toContainText('usuario.empresab');

    // O usuário da Empresa B não vê o processo da empresa do admin master.
    await page.click('#logoutBtn');
    await login(page, 'usuario.empresab', '1234');
    await trocarSenha(page, 'empresaBSenha123');
    await expect(page.locator('.q-row[data-id]')).toHaveCount(0);

    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc2.setFiles(PETICAO_TESTE);
    await expect(page.locator('.q-row[data-id]')).toHaveCount(1);

    // De volta como admin master: a própria empresa continua vendo só o processo dela.
    await page.click('#logoutBtn');
    await login(page, 'marcos.oliveira', 'novaSenha123');
    await expect(page.locator('.q-row[data-id]')).toHaveCount(1);

    // Selecionando "todas as empresas": vê os dois processos, cada um com o nome da empresa.
    await page.selectOption('#empresaSeletor', 'todas');
    await expect(page.locator('.q-row[data-id]')).toHaveCount(2);
    await expect(page.locator('#filaBody')).toContainText('Interno (admin master)');
    await expect(page.locator('#filaBody')).toContainText('Empresa B');

    // Modo agregado é só leitura: não abre o dropzone de upload.
    page.on('dialog', dialog => dialog.accept());
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 1500 }).catch(() => null);
    await page.click('#dropzone');
    const fc = await fileChooserPromise;
    expect(fc).toBeNull();

    // Selecionando a Empresa B especificamente: só o processo dela aparece, e edita normalmente.
    await page.selectOption('#empresaSeletor', { label: 'Empresa B' });
    await expect(page.locator('.q-row[data-id]')).toHaveCount(1);
    await expect(page.locator('#filaBody')).not.toContainText('Interno (admin master)');
  });
});

test.describe('geração de contestação', () => {
  async function gerarContestacao(page) {
    await loginComoAdminPadrao(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_TESTE);
    await page.click('.q-row[data-id]');
    await expect(page.locator('#view-geracao')).toHaveClass(/active/);
    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
  }

  test('download e impressão ficam liberados assim que a minuta é gerada', async ({ page }) => {
    await gerarContestacao(page);
    await expect(page.locator('#downloadDocBtn')).toBeEnabled();
    await expect(page.locator('#printDocBtn')).toBeEnabled();
  });

  test('minuta segue a estrutura das 15 seções do CPC (as que a ferramenta já cobre)', async ({ page }) => {
    await gerarContestacao(page);
    const corpo = page.locator('#geracaoBody');
    await expect(corpo).toContainText('Apresentação e tempestividade');
    await expect(corpo).toContainText('ainda não informada nesta ferramenta');
    await expect(corpo).toContainText('Síntese da demanda');
    await expect(corpo).toContainText('Realidade dos fatos');
    await expect(corpo).toContainText('Preliminares processuais');
    await expect(corpo).toContainText('Mérito: enquadramento da controvérsia');
    await expect(corpo).toContainText('Impugnação específica dos pedidos: repetição dos descontos');
    await expect(corpo).toContainText('Jurisprudência aplicável');
    await expect(corpo).toContainText('Provas');
    await expect(corpo).toContainText('Pedidos e conclusão da defesa');
  });

  test('data de citação informada antes da geração aparece na tempestividade da minuta', async ({ page }) => {
    await loginComoAdminPadrao(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_TESTE);
    await page.click('.q-row[data-id]');
    await page.fill('#dataCitacaoInput', '2026-09-01');
    await page.dispatchEvent('#dataCitacaoInput', 'change');
    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
    await expect(page.locator('#geracaoBody')).toContainText('tempestiva');
    await expect(page.locator('#geracaoBody')).toContainText('01/09/2026');
  });

  test('variação "Completo" mostra a nota de ausência de preliminares quando não há tutela', async ({ page }) => {
    await loginComoAdminPadrao(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_SEM_TUTELA);
    await page.click('.q-row[data-id]');
    await expect(page.locator('#variacaoModeloSelect')).toHaveValue('completo');
    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
    await expect(page.locator('.page-preview')).toContainText('Preliminares processuais');
    await expect(page.locator('.page-preview')).toContainText('Não foram identificadas questões processuais preliminares');
  });

  test('variação "Objetivo" omite a seção de preliminares quando não há tutela', async ({ page }) => {
    await loginComoAdminPadrao(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_SEM_TUTELA);
    await page.click('.q-row[data-id]');
    await page.selectOption('#variacaoModeloSelect', 'objetivo');
    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
    await expect(page.locator('.page-preview')).not.toContainText('Preliminares processuais');
  });

  test('reconvenção só entra como seção quando o operador escreve o texto', async ({ page }) => {
    await loginComoAdminPadrao(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_TESTE);
    await page.click('.q-row[data-id]');
    await page.fill('#reconvencaoInput', 'Pedido de reconvenção redigido pelo advogado responsável.');
    await page.dispatchEvent('#reconvencaoInput', 'change');
    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
    await expect(page.locator('#geracaoBody')).toContainText('Reconvenção');
    await expect(page.locator('#geracaoBody')).toContainText('Pedido de reconvenção redigido pelo advogado responsável.');
  });

  test('sem texto de reconvenção, a seção não aparece na minuta', async ({ page }) => {
    await gerarContestacao(page);
    await expect(page.locator('#geracaoBody')).not.toContainText('Reconvenção');
  });

  test('prazo processual calcula a data-limite e os dias úteis restantes', async ({ page }) => {
    await gerarContestacao(page);
    await page.fill('#dataCitacaoInput', '2026-09-01');
    await page.dispatchEvent('#dataCitacaoInput', 'change');
    await expect(page.locator('#prazoResultado')).toContainText('d úteis');
  });

  test('causa raiz extraída por IA aparece nos campos extraídos', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.route('**/api/anthropic', async route => {
      const body = route.request().postDataJSON();
      if (body.task === 'extract') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          text: JSON.stringify({
            numeroCNJ: '1002793-96.2026.8.13.0016', autor: 'João da Silva', reu: 'Banco Agibank S.A.',
            valorCausa: 'R$ 12.500,00', tema: 'Empréstimo consignado', causaRaiz: 'Cobrança indevida',
            resumo: 'Resumo de teste.', pedidos: ['Repetição de indébito'],
          }),
          usage: { input_tokens: 50, output_tokens: 30 },
        }) });
      } else {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) });
      }
    });
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_TESTE);
    await page.click('.q-row[data-id]');
    await expect(page.locator('#geracaoBody')).toContainText('Cobrança indevida');
  });

  test('minuta gerada inclui automaticamente a tese padrão do sistema correspondente à causa raiz identificada', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.route('**/api/anthropic', async route => {
      const body = route.request().postDataJSON();
      if (body.task === 'extract') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          text: JSON.stringify({
            numeroCNJ: '1002793-96.2026.8.13.0016', autor: 'João da Silva', reu: 'Banco Agibank S.A.',
            valorCausa: 'R$ 12.500,00', tema: 'Empréstimo consignado', causaRaiz: 'Cobrança indevida',
            resumo: 'Resumo de teste.', pedidos: ['Repetição de indébito'],
          }),
          usage: { input_tokens: 50, output_tokens: 30 },
        }) });
      } else {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) });
      }
    });
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#dropzone')]);
    await fc.setFiles(PETICAO_TESTE);
    await page.click('.q-row[data-id]');
    await page.click('#genBtn');
    await expect(page.locator('#geracaoBody')).toContainText('Tese padrão do sistema: Cobrança indevida');
    await expect(page.locator('#geracaoBody')).toContainText('Provas mínimas recomendadas');
  });

  test('clicar em uma linha de Análises reabre a minuta gerada daquele processo', async ({ page }) => {
    await gerarContestacao(page);
    await page.click('[data-view="analises"]');
    await expect(page.locator('#analisesBody')).toContainText('marcos.oliveira');
    await page.click('.case-row[data-case-id]');
    await expect(page.locator('#view-geracao')).toHaveClass(/active/);
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
  });

  test('excluir processo remove da fila e das análises', async ({ page }) => {
    await gerarContestacao(page);
    page.once('dialog', dialog => dialog.accept());
    await page.click('#excluirProcessoBtn');
    await expect(page.locator('#view-fila')).toHaveClass(/active/);
    await expect(page.locator('#filaBody')).toContainText('Nenhum processo carregado');
  });

  test('nova versão da minuta reseta o passo "arquivo baixado" do indicador de progresso', async ({ page }) => {
    await gerarContestacao(page);
    await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadDocBtn'),
    ]);
    await expect(page.locator('.stepper .step').last()).toHaveClass(/done/);

    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
    await expect(page.locator('.stepper .step').last()).not.toHaveClass(/done/);
  });

  test('tese cadastrada no Banco de teses entra como seção extra na minuta do mesmo produto', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.click('[data-view="teses"]');
    await page.selectOption('#teseProduto', 'Empréstimo consignado');
    await page.fill('#tesePedido', 'pedido de teste automatizado');
    await page.fill('#teseModelo', 'Texto da tese cadastrada para teste automatizado.');
    await page.click('#saveTeseBtn');
    await expect(page.locator('#tesesBody')).toContainText('pedido de teste automatizado');

    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-view="fila"]').then(()=>page.click('#dropzone'))]);
    await fc.setFiles(PETICAO_TESTE);
    await page.click('.q-row[data-id]');
    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeVisible();
    await expect(page.locator('.page-preview')).toContainText('Tese cadastrada: pedido de teste automatizado');
  });

  test('teses padrão do sistema: filtra por produto e "usar como base" pré-preenche o formulário', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.click('[data-view="teses"]');
    await expect(page.locator('#tesesSistemaWrap')).toContainText('Escolha um produto ou uma causa raiz');

    await page.selectOption('#tsFiltroProduto', 'Cartão Consignado');
    await expect(page.locator('#tsFiltroCausa')).toBeVisible();
    const primeiraCard = page.locator('#tesesSistemaWrap .client-card').first();
    await expect(primeiraCard).toBeVisible();

    await primeiraCard.locator('[data-usar]').click();
    await expect(page.locator('#teseFormTitle')).toHaveText('Nova tese (a partir do padrão do sistema)');
    await expect(page.locator('#teseProduto')).toHaveValue('__outro__');
    await expect(page.locator('#teseProdutoOutro')).toHaveValue('Cartão Consignado');
    const modelo = await page.locator('#teseModelo').inputValue();
    expect(modelo.length).toBeGreaterThan(20);
  });

  test('baixar tradução de referência gera o arquivo e mantém o aviso de que não vale para protocolo', async ({ page }) => {
    await page.route('**/api/anthropic', async route => {
      const body = route.request().postDataJSON();
      if (body.task === 'traduzir') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '1. Title\nTranslated paragraph.', usage: { input_tokens: 10, output_tokens: 5 } }) });
      } else {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'not mocked' }) });
      }
    });
    await gerarContestacao(page);
    page.on('dialog', dialog => dialog.accept());
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#baixarTraducaoBtn'),
    ]);
    expect(download.suggestedFilename()).toContain('REFERENCIA');
    await expect(page.locator('#baixarTraducaoBtn')).toBeEnabled();
  });

  test('falha da IA ao traduzir avisa o usuário e não trava o botão', async ({ page }) => {
    await gerarContestacao(page);
    page.on('dialog', dialog => dialog.accept());
    await page.click('#baixarTraducaoBtn');
    await expect(page.locator('#baixarTraducaoBtn')).toBeEnabled();
    await expect(page.locator('#baixarTraducaoBtn')).toHaveText('Baixar tradução (.doc)');
  });
});

test.describe('padrões por cliente', () => {
  test('abas Aparência/Conteúdo/Avançado alternam os campos do formulário', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.click('[data-view="padroes"]');
    await expect(page.locator('#padPanelAparencia')).toBeVisible();
    await expect(page.locator('#padPanelConteudo')).toBeHidden();

    await page.click('.pad-tab[data-tab="conteudo"]');
    await expect(page.locator('#padPanelConteudo')).toBeVisible();
    await expect(page.locator('#padPanelAparencia')).toBeHidden();

    await page.click('.pad-tab[data-tab="avancado"]');
    await expect(page.locator('#padPanelAvancado')).toBeVisible();
    await expect(page.locator('#padPanelConteudo')).toBeHidden();
  });

  test('rodapé, marca d\'água, fonte e numeração de página ficam salvos e aparecem na prévia e na listagem', async ({ page }) => {
    await loginComoAdminPadrao(page);
    await page.click('[data-view="padroes"]');
    await page.fill('#clientNome', 'Cliente Teste Visual');

    await page.click('.pad-tab[data-tab="conteudo"]');
    await page.check('#rodapeAtivo');
    await page.fill('#rodapeTexto', 'Rodapé de teste automatizado');
    await page.check('#marcaDaguaAtiva');
    await page.fill('#marcaDaguaTexto', 'CONFIDENCIAL');

    await page.click('.pad-tab[data-tab="avancado"]');
    await page.selectOption('#fonteSelect', 'Arial');
    await page.selectOption('#fonteTamanho', '11');
    await page.selectOption('#numeracaoSelect', 'rodape-direita');

    await expect(page.locator('#docPreviewPanel')).toContainText('Rodapé de teste automatizado');
    await expect(page.locator('#docPreviewPanel')).toContainText('CONFIDENCIAL');

    await page.click('#saveClientBtn');
    await expect(page.locator('.client-list')).toContainText('Cliente Teste Visual');
    await expect(page.locator('.client-list')).toContainText('Rodapé ativo');
    await expect(page.locator('.client-list')).toContainText('CONFIDENCIAL');
    await expect(page.locator('.client-list')).toContainText('Arial, 11pt');
    await expect(page.locator('.client-list')).toContainText('Rodapé, à direita');
  });
});

test.describe('layout responsivo', () => {
  test('telas de duas colunas empilham em largura de tablet (768px)', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1000 });
    await loginComoAdminPadrao(page);

    await page.click('[data-view="padroes"]');
    const larguraJanela = 768;
    const larguraShell = await page.locator('.client-shell').evaluate(el => el.scrollWidth);
    expect(larguraShell).toBeLessThanOrEqual(larguraJanela + 1);

    await page.click('#tabAdmin');
    const larguraAdmin = await page.locator('.admin-shell').evaluate(el => el.scrollWidth);
    expect(larguraAdmin).toBeLessThanOrEqual(larguraJanela + 1);

    const corpoTemScrollHorizontal = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(corpoTemScrollHorizontal).toBe(false);
  });
});

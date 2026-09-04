// Suíte de regressão do Motor de Contestações.
//
// Cobre o que antes era validado manualmente durante o desenvolvimento: login e troca de
// senha obrigatória, administração de usuários, segregação de acesso por operador, geração
// de minuta com prazo/revisão obrigatória/desfecho, e responsividade básica. Roda contra o
// próprio index.html, sem backend real (pdf.js e mammoth.js são substituídos por um stub —
// ver stubarBibliotecas abaixo — para o teste não depender de CDN externo nem gerar PDF/DOCX
// de verdade; a extração em si não é o que está sendo testado aqui).
const { test, expect } = require('@playwright/test');
const path = require('path');

const PETICAO_TESTE = path.join(__dirname, 'fixtures', 'peticao-teste.txt');

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

  test('download e impressão ficam bloqueados até confirmar as duas revisões', async ({ page }) => {
    await gerarContestacao(page);
    await expect(page.locator('#downloadDocBtn')).toBeDisabled();
    await expect(page.locator('#printDocBtn')).toBeDisabled();

    await page.check('#revisaoAdvogadoCheck');
    await expect(page.locator('#downloadDocBtn')).toBeDisabled();

    await page.check('#revisaoStjCheck');
    await expect(page.locator('#downloadDocBtn')).toBeEnabled();
    await expect(page.locator('#printDocBtn')).toBeEnabled();
    await expect(page.locator('#confirmadoInfo')).toContainText('marcos.oliveira');
  });

  test('prazo processual calcula a data-limite e os dias úteis restantes', async ({ page }) => {
    await gerarContestacao(page);
    await page.fill('#dataCitacaoInput', '2026-09-01');
    await page.dispatchEvent('#dataCitacaoInput', 'change');
    await expect(page.locator('#prazoResultado')).toContainText('d úteis');
  });

  test('registrar desfecho alimenta a taxa de êxito real na aba Análises', async ({ page }) => {
    await gerarContestacao(page);
    await page.selectOption('#desfechoSelect', 'improcedente');

    await page.click('[data-view="analises"]');
    await expect(page.locator('#analisesBody')).toContainText('marcos.oliveira');
    await expect(page.locator('#analisesBody')).toContainText('taxa de êxito real');
    await expect(page.locator('#analisesBody')).toContainText('100%');
  });

  test('nova versão da minuta reabre a revisão obrigatória', async ({ page }) => {
    await gerarContestacao(page);
    await page.check('#revisaoAdvogadoCheck');
    await page.check('#revisaoStjCheck');
    await expect(page.locator('#downloadDocBtn')).toBeEnabled();

    await page.click('#genBtn');
    await expect(page.locator('#downloadDocBtn')).toBeDisabled();
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

// Teste de unidade das partes de segurança de api/users.js (hash de senha com scrypt e
// token de sessão assinado por HMAC), sem precisar de um Redis real — são funções puras.
// Roda em Node puro (sem navegador), por isso não usa a fixture "page" do Playwright Test.
const { test, expect } = require('@playwright/test');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'segredo-de-teste-nao-use-em-producao';

async function carregarModulo() {
  return import('../api/users.js');
}

test.describe('hash de senha', () => {
  test('senha correta confere, senha errada não', async () => {
    const { gerarSenhaHash, senhaConfere } = await carregarModulo();
    const hash = gerarSenhaHash('minhaSenha123');
    expect(senhaConfere('minhaSenha123', hash)).toBe(true);
    expect(senhaConfere('senhaErrada', hash)).toBe(false);
  });

  test('duas senhas iguais geram hashes diferentes (salt aleatório por usuário)', async () => {
    const { gerarSenhaHash } = await carregarModulo();
    const hash1 = gerarSenhaHash('1234');
    const hash2 = gerarSenhaHash('1234');
    expect(hash1).not.toBe(hash2);
  });

  test('nunca guarda a senha em texto puro dentro do hash salvo', async () => {
    const { gerarSenhaHash } = await carregarModulo();
    const hash = gerarSenhaHash('senha-secreta-123');
    expect(hash).not.toContain('senha-secreta-123');
  });
});

test.describe('token de sessão', () => {
  test('token gerado é aceito pela própria verificação', async () => {
    const { criarToken, verificarToken } = await carregarModulo();
    const token = criarToken({ id: 7, usuario: 'joao.silva', papel: 'operador' });
    const payload = verificarToken(token);
    expect(payload).not.toBeNull();
    expect(payload.id).toBe(7);
    expect(payload.papel).toBe('operador');
  });

  test('token adulterado (payload trocado) é rejeitado', async () => {
    const { criarToken, verificarToken } = await carregarModulo();
    const token = criarToken({ id: 1, usuario: 'marcos.oliveira', papel: 'operador' });
    const [payloadB64, assinatura] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    payload.papel = 'admin'; // tentativa de virar admin sem a assinatura válida
    const payloadFalsoB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tokenAdulterado = `${payloadFalsoB64}.${assinatura}`;
    expect(verificarToken(tokenAdulterado)).toBeNull();
  });

  test('token expirado é rejeitado', async () => {
    const crypto = require('crypto');
    const { verificarToken } = await carregarModulo();
    const payload = { id: 1, usuario: 'marcos.oliveira', papel: 'admin', exp: Date.now() - 1000 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const assinatura = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payloadB64).digest('base64url');
    expect(verificarToken(`${payloadB64}.${assinatura}`)).toBeNull();
  });

  test('token com formato inválido não derruba a verificação', async () => {
    const { verificarToken } = await carregarModulo();
    expect(verificarToken('isso-nao-e-um-token')).toBeNull();
    expect(verificarToken('')).toBeNull();
    expect(verificarToken(undefined)).toBeNull();
  });
});

// Função serverless da Vercel. Guarda os usuários do sistema num banco Postgres
// compartilhado (Neon, via Vercel Marketplace), em vez de localStorage no navegador —
// assim login e administração de usuários funcionam igual em qualquer máquina, não só
// na de quem cadastrou.
//
// Configuração necessária no painel da Vercel (Project Settings > Environment Variables,
// já preenchidas automaticamente ao instalar a integração Neon e conectar ao projeto):
//   DATABASE_URL ou POSTGRES_URL  = string de conexão do Postgres
//   SESSION_SECRET  = uma string aleatória longa, só para assinar o token de sessão
//
// Senha nunca é guardada em texto puro: usa scrypt (nativo do Node) com salt por usuário.
// A verificação de senha e a checagem de papel (admin) acontecem aqui, no servidor —
// o navegador nunca vê hash de senha nem decide sozinho se alguém é admin.

import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function getSql() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) return null;
  return neon(connectionString);
}

// Multi-empresa: cada usuário pertence a exatamente uma empresa (inclusive o admin master —
// ele fica numa empresa própria "Interno", só para ter um dono para os dados que ele mesmo
// cria). O papel 'admin' é quem enxerga e administra TODAS as empresas; 'operador' só enxerga
// a própria. Isso é o que garante, no servidor (não só na tela), que uma empresa não veja o
// que a outra fez — ver também api/dados.js, onde essa mesma regra é aplicada aos dados de
// processos/teses/padrões.
async function garantirTabela(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      nome TEXT UNIQUE NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      usuario TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL DEFAULT 'operador',
      trocar_senha BOOLEAN NOT NULL DEFAULT true,
      empresa_id INTEGER REFERENCES empresas(id),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // ALTER idempotente: cobre bancos criados antes desta coluna existir.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id)`;
}

function gerarSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function hashComSalt(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}
function gerarSenhaHash(senha) {
  const salt = gerarSalt();
  return `${salt}:${hashComSalt(senha, salt)}`;
}
function senhaConfere(senha, senhaHashSalvo) {
  const [salt, hashSalvo] = (senhaHashSalvo || '').split(':');
  if (!salt || !hashSalvo) return false;
  const hashTentativa = hashComSalt(senha, salt);
  const a = Buffer.from(hashTentativa, 'hex');
  const b = Buffer.from(hashSalvo, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}
function criarToken(user) {
  const secret = process.env.SESSION_SECRET;
  const payload = { id: user.id, usuario: user.usuario, papel: user.papel, empresaId: user.empresaId, exp: Date.now() + TOKEN_TTL_MS };
  const payloadB64 = base64url(JSON.stringify(payload));
  const assinatura = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${assinatura}`;
}
function verificarToken(token) {
  const secret = process.env.SESSION_SECRET;
  if (!token || !secret) return null;
  const partes = token.split('.');
  if (partes.length !== 2) return null;
  const [payloadB64, assinatura] = partes;
  const esperada = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
function tokenDaRequisicao(req) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer (.+)$/);
  return m ? verificarToken(m[1]) : null;
}

function paraCampo(row) {
  return {
    id: row.id,
    usuario: row.usuario,
    senhaHash: row.senha_hash,
    papel: row.papel,
    trocarSenha: row.trocar_senha,
    empresaId: row.empresa_id,
    criadoEm: row.criado_em,
  };
}
function usuarioPublico(row) {
  const u = paraCampo(row);
  return { id: u.id, usuario: u.usuario, papel: u.papel, trocarSenha: u.trocarSenha, empresaId: u.empresaId, criadoEm: u.criadoEm };
}

async function garantirSeed(sql) {
  const existentes = await sql`SELECT COUNT(*)::int AS n FROM users`;
  if (existentes[0].n > 0) return;
  const [interno] = await sql`
    INSERT INTO empresas (nome) VALUES ('Interno (admin master)')
    ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
    RETURNING id
  `;
  // Primeiro uso: cria o admin padrão com senha temporária, igual para todo mundo.
  await sql`
    INSERT INTO users (usuario, senha_hash, papel, trocar_senha, empresa_id)
    VALUES ('marcos.oliveira', ${gerarSenhaHash('1234')}, 'admin', true, ${interno.id})
    ON CONFLICT (usuario) DO NOTHING
  `;
}

export default async function handler(req, res) {
  // Tudo dentro de um único try/catch, incluindo a leitura das variáveis de ambiente
  // e a criação do cliente do banco: sem isso, um erro nessa etapa (ex.: DATABASE_URL
  // malformada) derruba a função inteira (FUNCTION_INVOCATION_FAILED da Vercel) em vez
  // de responder com uma mensagem de erro em JSON que o navegador consegue mostrar.
  try {
    const sql = getSql();
    if (!sql) {
      res.status(500).json({ error: 'Banco de usuários não configurado. Configure DATABASE_URL (ou POSTGRES_URL) e SESSION_SECRET nas variáveis de ambiente do projeto na Vercel.' });
      return;
    }
    if (!process.env.SESSION_SECRET) {
      res.status(500).json({ error: 'SESSION_SECRET não configurada nas variáveis de ambiente do projeto.' });
      return;
    }

    await garantirTabela(sql);
    await garantirSeed(sql);

    if (req.method === 'GET') {
      const sessao = tokenDaRequisicao(req);
      if (!sessao || sessao.papel !== 'admin') { res.status(401).json({ error: 'Sessão inválida ou sem permissão de administrador.' }); return; }
      const linhas = await sql`SELECT * FROM users ORDER BY id`;
      const empresas = await sql`SELECT * FROM empresas ORDER BY nome`;
      res.status(200).json({ usuarios: linhas.map(usuarioPublico), empresas });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método não permitido.' });
      return;
    }

    const { action } = req.body || {};

    if (action === 'login') {
      const { usuario, senha } = req.body || {};
      const linhas = await sql`SELECT * FROM users WHERE lower(usuario) = lower(${usuario || ''})`;
      const u = linhas[0] ? paraCampo(linhas[0]) : null;
      if (!u || !senhaConfere(senha, u.senhaHash)) {
        res.status(401).json({ error: 'Usuário ou senha inválidos.' });
        return;
      }
      const token = criarToken(u);
      res.status(200).json({ token, usuario: usuarioPublico(linhas[0]) });
      return;
    }

    // Todas as ações abaixo exigem sessão válida.
    const sessao = tokenDaRequisicao(req);
    if (!sessao) { res.status(401).json({ error: 'Sessão inválida ou expirada, faça login novamente.' }); return; }

    if (action === 'change-password') {
      const { novaSenha } = req.body || {};
      if (!novaSenha || novaSenha.length < 4) { res.status(400).json({ error: 'A nova senha precisa ter ao menos 4 caracteres.' }); return; }
      const linhas = await sql`
        UPDATE users SET senha_hash = ${gerarSenhaHash(novaSenha)}, trocar_senha = false
        WHERE id = ${sessao.id}
        RETURNING *
      `;
      if (!linhas[0]) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      const u = paraCampo(linhas[0]);
      const token = criarToken(u);
      res.status(200).json({ token, usuario: usuarioPublico(linhas[0]) });
      return;
    }

    // Demais ações são administrativas.
    if (sessao.papel !== 'admin') { res.status(403).json({ error: 'Ação restrita a administradores.' }); return; }

    if (action === 'criar-empresa') {
      const { nome } = req.body || {};
      if (!nome || !nome.trim()) { res.status(400).json({ error: 'Informe o nome da empresa.' }); return; }
      const existente = await sql`SELECT id FROM empresas WHERE lower(nome) = lower(${nome.trim()})`;
      if (existente.length > 0) { res.status(409).json({ error: 'Já existe uma empresa com esse nome.' }); return; }
      await sql`INSERT INTO empresas (nome) VALUES (${nome.trim()})`;
      const empresas = await sql`SELECT * FROM empresas ORDER BY nome`;
      res.status(200).json({ empresas });
      return;
    }

    if (action === 'create') {
      const { usuario, senha, papel, empresaId } = req.body || {};
      if (!usuario || !senha) { res.status(400).json({ error: 'Informe usuário e senha temporária.' }); return; }
      if (!empresaId) { res.status(400).json({ error: 'Selecione a empresa do novo usuário.' }); return; }
      const empresa = (await sql`SELECT id FROM empresas WHERE id = ${empresaId}`)[0];
      if (!empresa) { res.status(400).json({ error: 'Empresa inválida.' }); return; }
      const existente = await sql`SELECT id FROM users WHERE lower(usuario) = lower(${usuario})`;
      if (existente.length > 0) { res.status(409).json({ error: 'Já existe um usuário com esse login.' }); return; }
      await sql`
        INSERT INTO users (usuario, senha_hash, papel, trocar_senha, empresa_id)
        VALUES (${usuario}, ${gerarSenhaHash(senha)}, ${papel === 'admin' ? 'admin' : 'operador'}, true, ${empresaId})
      `;
      const todos = await sql`SELECT * FROM users ORDER BY id`;
      res.status(200).json({ usuarios: todos.map(usuarioPublico) });
      return;
    }

    if (action === 'set-empresa') {
      const { id, empresaId } = req.body || {};
      if (!empresaId) { res.status(400).json({ error: 'Selecione a empresa.' }); return; }
      const empresa = (await sql`SELECT id FROM empresas WHERE id = ${empresaId}`)[0];
      if (!empresa) { res.status(400).json({ error: 'Empresa inválida.' }); return; }
      const alvo = (await sql`SELECT id FROM users WHERE id = ${id}`)[0];
      if (!alvo) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      await sql`UPDATE users SET empresa_id = ${empresaId} WHERE id = ${id}`;
      const todos = await sql`SELECT * FROM users ORDER BY id`;
      res.status(200).json({ usuarios: todos.map(usuarioPublico) });
      return;
    }

    if (action === 'reset-password') {
      const { id, novaSenha } = req.body || {};
      const linhas = await sql`
        UPDATE users SET senha_hash = ${gerarSenhaHash(novaSenha || '1234')}, trocar_senha = true
        WHERE id = ${id}
        RETURNING id
      `;
      if (!linhas[0]) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      const todos = await sql`SELECT * FROM users ORDER BY id`;
      res.status(200).json({ usuarios: todos.map(usuarioPublico) });
      return;
    }

    if (action === 'set-role') {
      const { id, papel } = req.body || {};
      const alvo = (await sql`SELECT * FROM users WHERE id = ${id}`)[0];
      if (!alvo) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      const admins = await sql`SELECT COUNT(*)::int AS n FROM users WHERE papel = 'admin'`;
      if (alvo.papel === 'admin' && papel !== 'admin' && admins[0].n <= 1) {
        res.status(400).json({ error: 'Não é possível remover o último administrador.' });
        return;
      }
      await sql`UPDATE users SET papel = ${papel === 'admin' ? 'admin' : 'operador'} WHERE id = ${id}`;
      const todos = await sql`SELECT * FROM users ORDER BY id`;
      res.status(200).json({ usuarios: todos.map(usuarioPublico) });
      return;
    }

    if (action === 'delete') {
      const { id } = req.body || {};
      if (id === sessao.id) { res.status(400).json({ error: 'Você não pode remover o próprio usuário logado.' }); return; }
      const alvo = (await sql`SELECT * FROM users WHERE id = ${id}`)[0];
      const admins = await sql`SELECT COUNT(*)::int AS n FROM users WHERE papel = 'admin'`;
      if (alvo && alvo.papel === 'admin' && admins[0].n <= 1) { res.status(400).json({ error: 'Não é possível remover o último administrador.' }); return; }
      await sql`DELETE FROM users WHERE id = ${id}`;
      const todos = await sql`SELECT * FROM users ORDER BY id`;
      res.status(200).json({ usuarios: todos.map(usuarioPublico) });
      return;
    }

    res.status(400).json({ error: 'Campo "action" inválido ou ausente.' });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao acessar o banco de usuários.', detail: String(err) });
  }
}

// gerarSenhaHash/senhaConfere/criarToken/verificarToken: exportados para o teste de unidade
// em tests/users-crypto.spec.js (sem precisar de um Postgres real para isso).
// tokenDaRequisicao: reaproveitado por api/dados.js, para não duplicar a leitura do header
// Authorization e a verificação de token em dois arquivos.
export { gerarSenhaHash, senhaConfere, criarToken, verificarToken, tokenDaRequisicao };

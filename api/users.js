// Função serverless da Vercel. Guarda os usuários do sistema em um banco Redis
// compartilhado (Upstash, via integração de "Redis"/"KV" do Vercel Marketplace), em vez
// de localStorage no navegador — assim login e administração de usuários funcionam
// igual em qualquer máquina, não só na de quem cadastrou.
//
// Configuração necessária no painel da Vercel (Project Settings > Environment Variables):
//   KV_REST_API_URL / KV_REST_API_TOKEN  (nome usado por integrações de Redis mais antigas)
//   ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (nome do Upstash Marketplace atual)
//   SESSION_SECRET  = uma string aleatória longa, só para assinar o token de sessão
//
// Senha nunca é guardada em texto puro: usa scrypt (nativo do Node) com salt por usuário.
// A verificação de senha e a checagem de papel (admin) acontecem aqui, no servidor —
// o navegador nunca vê hash de senha nem decide sozinho se alguém é admin.

import crypto from 'crypto';
import { Redis } from '@upstash/redis';

const USERS_KEY = 'motor_contestacoes:users';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas

function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
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
  const payload = { id: user.id, usuario: user.usuario, papel: user.papel, exp: Date.now() + TOKEN_TTL_MS };
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

async function carregarUsuarios(redis) {
  const dados = await redis.get(USERS_KEY);
  if (dados && Array.isArray(dados) && dados.length > 0) return dados;
  if (dados && typeof dados === 'string') {
    try { const arr = JSON.parse(dados); if (Array.isArray(arr) && arr.length > 0) return arr; } catch (e) { /* segue para o seed */ }
  }
  // Primeiro uso: cria o admin padrão com senha temporária, igual para todo mundo.
  const seed = [{
    id: 1,
    usuario: 'marcos.oliveira',
    senhaHash: gerarSenhaHash('1234'),
    papel: 'admin',
    trocarSenha: true,
    criadoEm: new Date().toISOString(),
  }];
  await redis.set(USERS_KEY, seed);
  return seed;
}
async function salvarUsuarios(redis, usuarios) {
  await redis.set(USERS_KEY, usuarios);
}

function usuarioPublico(u) {
  return { id: u.id, usuario: u.usuario, papel: u.papel, trocarSenha: u.trocarSenha, criadoEm: u.criadoEm };
}

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) {
    res.status(500).json({ error: 'Banco de usuários não configurado. Configure KV_REST_API_URL/KV_REST_API_TOKEN (ou UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN) e SESSION_SECRET nas variáveis de ambiente do projeto na Vercel.' });
    return;
  }
  if (!process.env.SESSION_SECRET) {
    res.status(500).json({ error: 'SESSION_SECRET não configurada nas variáveis de ambiente do projeto.' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const sessao = tokenDaRequisicao(req);
      if (!sessao || sessao.papel !== 'admin') { res.status(401).json({ error: 'Sessão inválida ou sem permissão de administrador.' }); return; }
      const usuarios = await carregarUsuarios(redis);
      res.status(200).json({ usuarios: usuarios.map(usuarioPublico) });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método não permitido.' });
      return;
    }

    const { action } = req.body || {};
    const usuarios = await carregarUsuarios(redis);

    if (action === 'login') {
      const { usuario, senha } = req.body || {};
      const u = usuarios.find(x => (x.usuario || '').toLowerCase() === (usuario || '').toLowerCase());
      if (!u || !senhaConfere(senha, u.senhaHash)) {
        res.status(401).json({ error: 'Usuário ou senha inválidos.' });
        return;
      }
      const token = criarToken(u);
      res.status(200).json({ token, usuario: usuarioPublico(u) });
      return;
    }

    // Todas as ações abaixo exigem sessão válida.
    const sessao = tokenDaRequisicao(req);
    if (!sessao) { res.status(401).json({ error: 'Sessão inválida ou expirada, faça login novamente.' }); return; }

    if (action === 'change-password') {
      const { novaSenha } = req.body || {};
      if (!novaSenha || novaSenha.length < 4) { res.status(400).json({ error: 'A nova senha precisa ter ao menos 4 caracteres.' }); return; }
      const u = usuarios.find(x => x.id === sessao.id);
      if (!u) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      u.senhaHash = gerarSenhaHash(novaSenha);
      u.trocarSenha = false;
      await salvarUsuarios(redis, usuarios);
      const token = criarToken(u);
      res.status(200).json({ token, usuario: usuarioPublico(u) });
      return;
    }

    // Demais ações são administrativas.
    if (sessao.papel !== 'admin') { res.status(403).json({ error: 'Ação restrita a administradores.' }); return; }

    if (action === 'create') {
      const { usuario, senha, papel } = req.body || {};
      if (!usuario || !senha) { res.status(400).json({ error: 'Informe usuário e senha temporária.' }); return; }
      if (usuarios.some(x => x.usuario.toLowerCase() === usuario.toLowerCase())) { res.status(409).json({ error: 'Já existe um usuário com esse login.' }); return; }
      const novoId = usuarios.reduce((max, x) => Math.max(max, x.id), 0) + 1;
      usuarios.push({
        id: novoId, usuario, senhaHash: gerarSenhaHash(senha),
        papel: papel === 'admin' ? 'admin' : 'operador', trocarSenha: true, criadoEm: new Date().toISOString(),
      });
      await salvarUsuarios(redis, usuarios);
      res.status(200).json({ usuarios: usuarios.map(usuarioPublico) });
      return;
    }

    if (action === 'reset-password') {
      const { id, novaSenha } = req.body || {};
      const u = usuarios.find(x => x.id === id);
      if (!u) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      u.senhaHash = gerarSenhaHash(novaSenha || '1234');
      u.trocarSenha = true;
      await salvarUsuarios(redis, usuarios);
      res.status(200).json({ usuarios: usuarios.map(usuarioPublico) });
      return;
    }

    if (action === 'set-role') {
      const { id, papel } = req.body || {};
      const u = usuarios.find(x => x.id === id);
      if (!u) { res.status(404).json({ error: 'Usuário não encontrado.' }); return; }
      const admins = usuarios.filter(x => x.papel === 'admin');
      if (u.papel === 'admin' && papel !== 'admin' && admins.length <= 1) {
        res.status(400).json({ error: 'Não é possível remover o último administrador.' });
        return;
      }
      u.papel = papel === 'admin' ? 'admin' : 'operador';
      await salvarUsuarios(redis, usuarios);
      res.status(200).json({ usuarios: usuarios.map(usuarioPublico) });
      return;
    }

    if (action === 'delete') {
      const { id } = req.body || {};
      if (id === sessao.id) { res.status(400).json({ error: 'Você não pode remover o próprio usuário logado.' }); return; }
      const alvo = usuarios.find(x => x.id === id);
      const admins = usuarios.filter(x => x.papel === 'admin');
      if (alvo && alvo.papel === 'admin' && admins.length <= 1) { res.status(400).json({ error: 'Não é possível remover o último administrador.' }); return; }
      const restantes = usuarios.filter(x => x.id !== id);
      await salvarUsuarios(redis, restantes);
      res.status(200).json({ usuarios: restantes.map(usuarioPublico) });
      return;
    }

    res.status(400).json({ error: 'Campo "action" inválido ou ausente.' });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao acessar o banco de usuários.', detail: String(err) });
  }
}

// Exportado só para o teste de unidade em tests/users-crypto.spec.js checar o hash de
// senha e o token de sessão de verdade (sem precisar de um Redis real para isso).
export { gerarSenhaHash, senhaConfere, criarToken, verificarToken };

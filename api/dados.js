// Função serverless da Vercel. Guarda os dados de trabalho (fila de processos, análises,
// padrões de cliente, Banco de teses) num banco Postgres compartilhado, segregado por
// empresa — cada empresa só lê e escreve o próprio blob de dados, nunca o de outra.
//
// Antes desta função existir, esses dados viviam em localStorage no navegador: nada disso
// era protegido de verdade (cada navegador só via os próprios dados por acaso, não por
// checagem alguma). Com múltiplas empresas usando o mesmo sistema, essa separação passa a
// ser checada aqui, no servidor, a partir do token de sessão assinado (o mesmo emitido por
// api/users.js) — o navegador nunca escolhe sozinho de qual empresa ele é.
//
// Formato simples de propósito: uma linha por empresa, com todo o estado (cases, analyses,
// clientes, teses) num único campo JSONB. Evita um redesenho relacional grande agora; o
// custo é que duas pessoas da mesma empresa editando ao mesmo tempo podem sobrescrever a
// alteração uma da outra (last-write-wins) — aceitável para o volume de uso atual, mesma
// limitação que já existia (implicitamente) quando isso vivia no navegador.

import { neon } from '@neondatabase/serverless';
import { tokenDaRequisicao } from './users.js';

function getSql() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) return null;
  return neon(connectionString);
}

async function garantirTabela(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS estado_empresa (
      empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id),
      dados JSONB NOT NULL DEFAULT '{}'::jsonb,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_por TEXT
    )
  `;
}

const ESTADO_VAZIO = { cases: [], analyses: [], clientes: [], teses: [], idSeq: 1, clienteSeq: 1, teseSeq: 1 };

export default async function handler(req, res) {
  try {
    const sql = getSql();
    if (!sql) {
      res.status(500).json({ error: 'Banco de dados não configurado. Configure DATABASE_URL (ou POSTGRES_URL) nas variáveis de ambiente do projeto na Vercel.' });
      return;
    }
    if (!process.env.SESSION_SECRET) {
      res.status(500).json({ error: 'SESSION_SECRET não configurada nas variáveis de ambiente do projeto.' });
      return;
    }

    const sessao = tokenDaRequisicao(req);
    if (!sessao) { res.status(401).json({ error: 'Sessão inválida ou expirada, faça login novamente.' }); return; }
    if (!sessao.empresaId) { res.status(400).json({ error: 'Usuário sem empresa associada. Peça para um administrador corrigir seu cadastro.' }); return; }

    await garantirTabela(sql);

    if (req.method === 'GET') {
      const souAdmin = sessao.papel === 'admin';
      const empresaIdQuery = req.query && req.query.empresaId ? parseInt(req.query.empresaId) : null;

      if (souAdmin && !empresaIdQuery) {
        // Admin master sem filtro: visão agregada de todas as empresas.
        const linhas = await sql`
          SELECT e.id AS empresa_id, e.nome AS empresa_nome, coalesce(x.dados, '{}'::jsonb) AS dados
          FROM empresas e
          LEFT JOIN estado_empresa x ON x.empresa_id = e.id
          ORDER BY e.nome
        `;
        res.status(200).json({
          modo: 'todas',
          empresas: linhas.map(l => ({ empresaId: l.empresa_id, empresaNome: l.empresa_nome, dados: { ...ESTADO_VAZIO, ...(l.dados || {}) } })),
        });
        return;
      }

      const empresaId = souAdmin ? empresaIdQuery : sessao.empresaId;
      const linha = (await sql`
        SELECT e.id AS empresa_id, e.nome AS empresa_nome, x.dados AS dados
        FROM empresas e
        LEFT JOIN estado_empresa x ON x.empresa_id = e.id
        WHERE e.id = ${empresaId}
      `)[0];
      if (!linha) { res.status(404).json({ error: 'Empresa não encontrada.' }); return; }
      res.status(200).json({
        modo: 'empresa',
        empresaId: linha.empresa_id,
        empresaNome: linha.empresa_nome,
        dados: { ...ESTADO_VAZIO, ...(linha.dados || {}) },
      });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método não permitido, use GET ou POST.' });
      return;
    }

    const { action, dados, empresaId: empresaIdBody } = req.body || {};
    if (action !== 'salvar') { res.status(400).json({ error: 'Campo "action" inválido ou ausente. Use "salvar".' }); return; }
    if (!dados || typeof dados !== 'object') { res.status(400).json({ error: 'Campo "dados" ausente ou inválido.' }); return; }

    // Um usuário comum só grava na própria empresa, mesmo que tente informar outra no corpo
    // da requisição — só o admin master pode direcionar a gravação a uma empresa específica.
    const empresaAlvo = (sessao.papel === 'admin' && empresaIdBody) ? empresaIdBody : sessao.empresaId;
    if (sessao.papel !== 'admin' && empresaIdBody && empresaIdBody !== sessao.empresaId) {
      res.status(403).json({ error: 'Você só pode salvar dados da sua própria empresa.' });
      return;
    }

    await sql`
      INSERT INTO estado_empresa (empresa_id, dados, atualizado_por)
      VALUES (${empresaAlvo}, ${JSON.stringify(dados)}::jsonb, ${sessao.usuario})
      ON CONFLICT (empresa_id) DO UPDATE SET dados = EXCLUDED.dados, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por
    `;
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao acessar o banco de dados compartilhado.', detail: String(err) });
  }
}

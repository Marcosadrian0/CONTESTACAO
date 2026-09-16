// Função serverless da Vercel. Roda no servidor, nunca no navegador do usuário,
// por isso pode guardar a chave da API com segurança em uma variável de ambiente.
//
// Configuração necessária no painel da Vercel:
//   Project Settings > Environment Variables > ANTHROPIC_API_KEY = sk-ant-...
//
// O index.html chama esta função em /api/anthropic, nunca a API da Anthropic direto.

export default async function handler(req, res) {
  // GET só informa se a chave está configurada no servidor, sem chamar a API da Anthropic
  // (sem custo de tokens). Usado pela aba Admin > IA Aplicada para mostrar o status.
  if (req.method === 'GET') {
    res.status(200).json({ configured: !!process.env.ANTHROPIC_API_KEY });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido, use GET ou POST.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada nas variáveis de ambiente do projeto.' });
    return;
  }

  const { task } = req.body || {};
  let prompt = '';
  let maxTokens = 600;

  if (task === 'extract') {
    const texto = (req.body.texto || '').slice(0, 7000);
    maxTokens = 900;
    prompt =
      'Você é um assistente jurídico interno. Leia o trecho de petição inicial abaixo e responda SOMENTE com um JSON válido, sem markdown e sem texto fora do JSON, no formato exato: ' +
      '{"numeroCNJ":"","autor":"","reu":"","valorCausa":"","tema":"","resumo":"","pedidos":["",""]}. ' +
      'O campo "tema" deve ser exatamente uma destas opções, a que melhor descrever o produto financeiro questionado: "Cartão de crédito consignado", "RMC (Reserva de Margem Consignável)", "RCC (Reserva de Cartão Consignado)", "Empréstimo consignado", "Refinanciamento de empréstimo consignado", "Seguro (prestamista ou de vida)". Se nenhuma se aplicar claramente, use "Tema não identificado automaticamente, revisar manualmente". ' +
      'Se um campo não existir no texto, use a string "não localizado". O resumo deve ter no máximo 3 frases, em português. ' +
      'Texto da petição: ' + texto;

  } else if (task === 'regularidade') {
    const { tema, resumo, textoModelo, trecho } = req.body || {};
    maxTokens = 400;
    prompt =
      'Você é um assistente jurídico interno de um escritório de contencioso de massa. Redija UM ÚNICO PARÁGRAFO, em português, tom formal, para a seção "Regularidade dos descontos impugnados" de uma contestação bancária, adaptando o texto modelo abaixo aos fatos do caso descrito, sem inventar fatos que não constem no resumo. ' +
      'Responda SOMENTE com o parágrafo de texto puro, sem markdown, sem aspas, sem título. ' +
      'Texto modelo (adapte, não copie literalmente): ' + (textoModelo || '') + ' ' +
      'Tema: ' + (tema || '') + '. Resumo do caso: ' + (resumo || '') + '. ' +
      'Trecho da petição original, para checagem de fatos: ' + ((trecho || '').slice(0, 3000));

  } else if (task === 'traduzir') {
    // Tradução de referência da minuta já gerada (não é peça oficial, ver aviso no index.html
    // e no próprio arquivo baixado). Texto de entrada já é a minuta inteira, com títulos de
    // seção numerados; pedimos para preservar essa estrutura para o documento traduzido ficar
    // legível e com a mesma numeração da versão em português.
    const { idioma, texto } = req.body || {};
    maxTokens = 4000;
    prompt =
      'Você é um tradutor jurídico. Traduza fielmente o texto abaixo, que é uma minuta de contestação em português, para ' + (idioma || 'inglês') + '. ' +
      'Mantenha a estrutura de seções: cada título numerado (ex.: "1. Título") deve continuar numerado e traduzido, seguido do texto traduzido do parágrafo correspondente. ' +
      'Não adicione, remova ou explique nada além da tradução; não inclua nenhum aviso ou nota sua no meio do texto (o aviso de que é uma tradução de referência já é adicionado separadamente, fora desta tradução). ' +
      'Responda SOMENTE com o texto traduzido, sem markdown, sem comentários. ' +
      'Texto original: ' + (texto || '').slice(0, 20000);

  } else {
    res.status(400).json({ error: 'Campo "task" inválido ou ausente. Use "extract", "regularidade" ou "traduzir".' });
    return;
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      res.status(502).json({ error: 'A API da Anthropic recusou a requisição.', detail });
      return;
    }

    const data = await resp.json();
    const bloco = (data.content || []).find(c => c.type === 'text');
    // data.usage vem direto da resposta da Anthropic (tokens de entrada/saída da própria
    // chamada). Repassado ao navegador só para alimentar o contador de uso de IA da
    // interface, não é usado para nenhuma outra finalidade aqui no servidor.
    res.status(200).json({ text: bloco ? bloco.text : '', usage: data.usage || null });

  } catch (err) {
    res.status(500).json({ error: 'Falha ao chamar a API da Anthropic.', detail: String(err) });
  }
}

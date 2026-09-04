// Função serverless da Vercel. Roda no servidor, nunca no navegador do usuário,
// por isso pode guardar a chave da API com segurança em uma variável de ambiente.
//
// Configuração necessária no painel da Vercel:
//   Project Settings > Environment Variables > ANTHROPIC_API_KEY = sk-ant-...
//
// O index.html chama esta função em /api/anthropic, nunca a API da Anthropic direto.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido, use POST.' });
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

  } else {
    res.status(400).json({ error: 'Campo "task" inválido ou ausente. Use "extract" ou "regularidade".' });
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

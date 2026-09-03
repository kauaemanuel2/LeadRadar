// api/overpass.js
export default async function handler(req, res) {
  // Apenas aceita POST (para enviar a query)
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Query não fornecida' });
  }

  // Lista de espelhos do Overpass
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
  ];

  let lastError = null;

  // Tenta cada espelho com timeout de 60 segundos
  for (const mirror of mirrors) {
    try {
      const url = mirror + '?data=' + encodeURIComponent(query);
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(60000), // 60s timeout
      });

      if (!response.ok) {
        lastError = new Error(`Erro ${response.status} de ${mirror}`);
        continue;
      }

      const data = await response.json();
      // Retorna os elementos
      return res.status(200).json({ elements: data.elements || [] });
    } catch (err) {
      lastError = err;
      console.warn(`Falha com ${mirror}:`, err.message);
      // Continua para o próximo espelho
    }
  }

  // Se todos falharam
  return res.status(500).json({
    error: 'Todos os servidores do Overpass falharam. Tente novamente mais tarde.',
    detail: lastError?.message || 'Erro desconhecido',
  });
}
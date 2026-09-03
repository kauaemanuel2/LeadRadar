// api/overpass.js
export default async function handler(req, res) {
  // Apenas aceita POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query inválida ou não fornecida' });
  }

  // Lista de espelhos do Overpass (incluindo mais opções)
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.ru/api/interpreter',
    'https://overpass-turbo.eu/api/interpreter', // mirror alternativo
  ];

  // Configuração
  const TIMEOUT_MS = 90000; // 90 segundos
  const RETRIES_PER_MIRROR = 2;

  let lastError = null;

  // Tenta cada mirror com retries
  for (const mirror of mirrors) {
    for (let attempt = 0; attempt <= RETRIES_PER_MIRROR; attempt++) {
      try {
        const url = mirror + '?data=' + encodeURIComponent(query);
        console.log(`Tentando ${mirror} (tentativa ${attempt+1})`);

        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!response.ok) {
          const errMsg = `${mirror} respondeu ${response.status} - ${response.statusText}`;
          console.warn(errMsg);
          lastError = new Error(errMsg);
          continue;
        }

        const data = await response.json();
        console.log(`Sucesso com ${mirror}`);
        return res.status(200).json({ elements: data.elements || [] });
      } catch (err) {
        if (err.name === 'AbortError') {
          lastError = new Error(`Timeout após ${TIMEOUT_MS}ms com ${mirror}`);
        } else {
          lastError = err;
        }
        console.warn(`Falha com ${mirror} (tentativa ${attempt+1}):`, err.message);
        // Aguarda antes de tentar novamente (backoff)
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  // Se todos falharam
  console.error('Todos os mirrors falharam. Último erro:', lastError?.message);
  return res.status(500).json({
    error: 'Todos os servidores do Overpass falharam. Tente novamente mais tarde.',
    detail: lastError?.message || 'Erro desconhecido',
  });
}
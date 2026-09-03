// api/overpass.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query inválida' });
  }

  const mirror = 'https://overpass-api.de/api/interpreter';
  const TIMEOUT = 58000; // 58 segundos (limite da Vercel Hobby: 60s)

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    // Overpass aceita POST com body: data=QUERY (form-urlencoded)
    const response = await fetch(mirror, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `Overpass respondeu ${response.status}: ${text.substring(0, 100)}`,
      });
    }

    const data = await response.json();
    return res.status(200).json({ elements: data.elements || [] });
  } catch (err) {
    console.error('Erro no proxy Overpass:', err.message);
    return res.status(500).json({ error: 'Falha ao consultar o Overpass: ' + err.message });
  }
}
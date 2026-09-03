// api/overpass.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query inválida' });
  }

  // Apenas o mirror mais rápido (overpass-api.de)
  const mirror = 'https://overpass-api.de/api/interpreter';
  const TIMEOUT = 58000; // 58 segundos (Vercel Hobby = 60s)

  try {
    const url = mirror + '?data=' + encodeURIComponent(query);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Overpass respondeu ${response.status}`);
    }

    const data = await response.json();
    return res.status(200).json({ elements: data.elements || [] });
  } catch (err) {
    console.error('Erro no proxy Overpass:', err.message);
    return res.status(500).json({ error: 'Falha ao consultar o Overpass: ' + err.message });
  }
}
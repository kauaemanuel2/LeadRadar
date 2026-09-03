// api/overpass.js
export default async function handler(req, res) {
  // Aceita GET e POST (GET é mais simples)
  if (req.method === 'GET') {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter "data" is required' });
    }
    return await proxyRequest(query, res);
  } else if (req.method === 'POST') {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Query body is required' });
    }
    return await proxyRequest(query, res);
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }
}

async function proxyRequest(query, res) {
  const mirror = 'https://overpass-api.de/api/interpreter';
  const TIMEOUT = 30000; // 30 segundos

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    // Usa GET com data na URL
    const url = mirror + '?data=' + encodeURIComponent(query);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'LeadRadar/1.0 (https://lead-radar.vercel.app)',
      },
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
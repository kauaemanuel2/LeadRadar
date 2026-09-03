// ============================================================
// LEAD RADAR — app.js (com API própria Vercel)
// ============================================================

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;
let currentResults = [];   // resultados da última busca (não salvos ainda)
let savedOsmIds = new Set(); // ids já salvos nesta sessão (feedback visual)
let searchAbort = null;
let searchMode = 'local';  // 'local' | 'brasil'

// ------------------------------------------------------------
// Helpers de UI
// ------------------------------------------------------------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function toast(msg, type = '') {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------
// Autenticação
// ------------------------------------------------------------
function showAuthMsg(text, type) {
  const box = $('#authMsg');
  box.textContent = text;
  box.className = `auth-msg show ${type}`;
}
function clearAuthMsg() {
  const box = $('#authMsg');
  box.className = 'auth-msg';
}

let authMode = 'login'; // 'login' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  clearAuthMsg();
  $('#authTitle').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('#authSubmitBtn').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('#authSwitchText').innerHTML = mode === 'login'
    ? `Ainda não tem conta? <button id="authSwitchBtn" type="button">Criar conta</button>`
    : `Já tem conta? <button id="authSwitchBtn" type="button">Entrar</button>`;
  $('#authSwitchBtn').addEventListener('click', () => setAuthMode(mode === 'login' ? 'signup' : 'login'));
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  clearAuthMsg();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const btn = $('#authSubmitBtn');
  btn.disabled = true;

  try {
    if (authMode === 'login') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } else {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      if (data.user && !data.session) {
        showAuthMsg('Conta criada! Verifique seu e-mail para confirmar o acesso.', 'success');
        btn.disabled = false;
        return;
      }
    }
  } catch (err) {
    showAuthMsg(traduzErroAuth(err.message), 'error');
    btn.disabled = false;
  }
}

function traduzErroAuth(msg) {
  if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/already registered/i.test(msg) || /already exists/i.test(msg)) return 'Este e-mail já está cadastrado.';
  if (/password should be/i.test(msg)) return 'A senha precisa ter pelo menos 6 caracteres.';
  return msg;
}

async function handleLogout() {
  await sb.auth.signOut();
}

function traduzErroSupabase(err) {
  if (!err) return 'Erro desconhecido.';
  const msg = err.message || String(err);
  if (err.code === '42P01' || /relation .* does not exist/i.test(msg)) {
    return 'As tabelas do banco ainda não foram criadas. Rode o arquivo schema.sql no SQL Editor do Supabase.';
  }
  if (err.code === 'PGRST301' || /JWT expired/i.test(msg)) {
    return 'Sua sessão expirou. Saia e entre novamente.';
  }
  if (/401/.test(msg) || /invalid api key/i.test(msg)) {
    return 'Falha de autenticação com o Supabase. Saia e entre novamente.';
  }
  return msg;
}

async function ensureSession() {
  const { data, error } = await sb.auth.getSession();
  if (error || !data.session) return null;
  return data.session;
}

sb.auth.onAuthStateChange((_event, session) => {
  currentUser = session ? session.user : null;
  renderAuthState();
});

function renderAuthState() {
  const authWrap = $('#authWrap');
  const appShell = $('#appShell');
  if (currentUser) {
    authWrap.style.display = 'none';
    appShell.classList.add('active');
    $('#userEmail').textContent = currentUser.email;
    loadMeusLeads();
    loadLogs();
  } else {
    authWrap.style.display = 'flex';
    appShell.classList.remove('active');
  }
}

// ------------------------------------------------------------
// Navegação entre views
// ------------------------------------------------------------
function switchView(name) {
  $all('.view').forEach(v => v.classList.remove('active'));
  $all('.nav-btn').forEach(b => b.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  $(`#nav-${name}`).classList.add('active');
  if (name === 'leads') loadMeusLeads();
  if (name === 'logs') loadLogs();
}

// ------------------------------------------------------------
// Busca — OpenStreetMap (Nominatim + Overpass)
// ------------------------------------------------------------
function buildWhatsappLink(raw) {
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (!digits.startsWith('55') && digits.length <= 11) digits = '55' + digits;
  return `https://wa.me/${digits}`;
}

function getTagsForTermo(termo) {
  const key = termo.trim().toLowerCase();
  return TAG_MAP[key] || null;
}

// Consulta só por TAG (rápida, usa índice do Overpass)
function buildTagQuery(tagClauses, bbox, limit = 500) {
  const [s, w, n, e] = bbox;
  const bboxStr = `${s},${w},${n},${e}`;
  const clauses = tagClauses.map(tc => {
    const [k, v] = tc.split('=');
    return `nwr["${k}"="${v}"](${bboxStr});`;
  });
  return `[out:json][timeout:60];(${clauses.join('')});out ${limit} center tags;`;
}

// Consulta por NOME (regex) — mais pesada
function buildNameQuery(termo, bbox, limit = 500) {
  const [s, w, n, e] = bbox;
  const bboxStr = `${s},${w},${n},${e}`;
  const safeTerm = termo.trim().replace(/["\\]/g, '');
  return `[out:json][timeout:60];(nwr["name"~"${safeTerm}",i](${bboxStr}););out ${limit} center tags;`;
}

function normalizeText(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function findBrazilState(input) {
  const n = normalizeText(input);
  return BRAZIL_STATES.find(st => normalizeText(st.nome) === n || st.uf.toLowerCase() === n);
}

const UF_TO_NOME = Object.fromEntries(BRAZIL_STATES.map(st => [st.uf, st.nome]));

async function geocodeLocation(input) {
  const raw = input.trim();

  // 1) Usuário digitou um estado inteiro (nome ou sigla) -> usa a bbox já conhecida
  const stateMatch = findBrazilState(raw);
  if (stateMatch) return stateMatch.bbox;

  // 2) Formato "Cidade, UF" ou "Cidade, Estado"
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  let url;
  if (parts.length === 2) {
    const [cidade, ufOuEstado] = parts;
    const st = findBrazilState(ufOuEstado);
    const estadoNome = st ? st.nome : (UF_TO_NOME[ufOuEstado.toUpperCase()] || ufOuEstado);
    url = `https://nominatim.openstreetmap.org/search?format=json&city=${encodeURIComponent(cidade)}&state=${encodeURIComponent(estadoNome)}&country=Brazil&limit=1`;
  } else {
    // 3) Texto livre -> busca simples, restrita ao Brasil
    url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=br&q=${encodeURIComponent(raw + ', Brasil')}&limit=1`;
  }

  const res = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } });
  if (!res.ok) throw new Error('Falha ao localizar essa região.');
  const data = await res.json();
  if (!data.length) throw new Error('Não encontrei essa cidade/região. Tente escrever "Cidade, UF" ou o nome de um estado.');
  const bb = data[0].boundingbox.map(Number); // [minLat, maxLat, minLon, maxLon]
  return [bb[0], bb[2], bb[1], bb[3]]; // -> [south, west, north, east]
}

// ------------------------------------------------------------
// Chamada à API interna (Vercel) em vez de proxies
// ------------------------------------------------------------
async function fetchOverpass(query, signal) {
  try {
    const response = await fetch('/api/overpass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal, // suporta cancelamento via AbortController
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Erro ${response.status} na API`);
    }

    const data = await response.json();
    return data.elements || [];
  } catch (err) {
    if (err.name === 'AbortError') {
      // Re-lança para ser tratado como cancelamento
      throw err;
    }
    console.error('Erro na API Overpass:', err);
    throw new Error('Falha ao consultar o Overpass via API. Tente novamente.');
  }
}

// Busca combinando tag + nome, dentro de UM bloco
async function searchElementsInTile(termo, bbox, signal, tryNameOnly = false) {
  const tagClauses = getTagsForTermo(termo);
  const seen = new Map();

  // Tenta primeiro a estratégia principal (tag ou nome)
  if (tagClauses && !tryNameOnly) {
    try {
      const tagResults = await fetchOverpass(buildTagQuery(tagClauses, bbox), signal);
      tagResults.forEach(el => seen.set(`${el.type}/${el.id}`, el));
      // Se a busca por tag retornou muitos resultados, talvez não precise buscar nome
      if (seen.size < 200) {
        // Busca por nome complementar
        try {
          const nameResults = await fetchOverpass(buildNameQuery(termo, bbox), signal);
          nameResults.forEach(el => seen.set(`${el.type}/${el.id}`, el));
        } catch (nameErr) {
          // Ignora erro na busca por nome
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Busca por tag falhou, tentando apenas nome:', err.message);
      try {
        const nameResults = await fetchOverpass(buildNameQuery(termo, bbox), signal);
        nameResults.forEach(el => seen.set(`${el.type}/${el.id}`, el));
      } catch (nameErr) {
        if (nameErr.name === 'AbortError') throw nameErr;
        console.warn('Busca por nome também falhou:', nameErr.message);
      }
    }
  } else {
    // Busca apenas por nome
    try {
      const nameResults = await fetchOverpass(buildNameQuery(termo, bbox), signal);
      nameResults.forEach(el => seen.set(`${el.type}/${el.id}`, el));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.warn('Busca por nome falhou:', err.message);
    }
  }

  return Array.from(seen.values());
}

// Divide o bloco recursivamente até um tamanho mínimo (0.1 grau)
function splitBboxRecursively(bbox, maxSpan, minSpan = 0.1) {
  const [s, w, n, e] = bbox;
  const latSpan = n - s;
  const lonSpan = e - w;
  if (latSpan <= maxSpan && lonSpan <= maxSpan) return [bbox];
  if (latSpan <= minSpan && lonSpan <= minSpan) return [bbox]; // não subdivide mais

  // Subdivide em 4
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return [
    [s, w, midLat, midLon],
    [s, midLon, midLat, e],
    [midLat, w, n, midLon],
    [midLat, midLon, n, e]
  ].flatMap(sub => splitBboxRecursively(sub, maxSpan, minSpan));
}

// Busca principal com subdivisão adaptativa
async function searchElements(termo, bbox, signal, onTileProgress) {
  const hasTags = !!getTagsForTermo(termo);
  // Tamanho do bloco: menor para nichos sem tags (busca textual pesada)
  const initialSpan = hasTags ? 0.6 : 0.3;
  let tiles = splitBboxRecursively(bbox, initialSpan, 0.1);
  const seen = new Map();

  for (let i = 0; i < tiles.length; i++) {
    if (signal && signal.aborted) {
      const e = new Error('Busca cancelada');
      e.name = 'AbortError';
      throw e;
    }

    let elements = [];
    let success = false;

    // Tenta o bloco atual, com fallback para subdivisão se falhar
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        elements = await searchElementsInTile(termo, tiles[i], signal);
        success = true;
        break;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn(`Falha no bloco ${i+1} (tentativa ${attempt+1}):`, err.message);
        if (attempt === 0) {
          // Subdivide o bloco em 4 menores (recursivamente) e os insere na fila
          const subTiles = splitBboxRecursively(tiles[i], 0.2, 0.05);
          tiles.splice(i + 1, 0, ...subTiles);
          // Processa o primeiro sub-bloco agora
          tiles[i] = subTiles[0];
          // Os outros serão processados na sequência
        } else {
          // Falhou também na subdivisão, pula
          success = false;
        }
      }
    }

    if (success) {
      elements.forEach(el => seen.set(`${el.type}/${el.id}`, el));
    } else {
      console.warn(`Bloco ${i + 1}/${tiles.length} ignorado após tentativas.`);
    }

    if (onTileProgress) onTileProgress(i + 1, tiles.length);
    if (tiles.length > 1) await new Promise(r => setTimeout(r, 500));
  }

  return Array.from(seen.values());
}

// ------------------------------------------------------------
// Parse de elementos do Overpass para lead
// ------------------------------------------------------------
function parseElement(el, termo) {
  const tags = el.tags || {};
  const nome = tags.name;
  if (!nome) return null;

  const website = tags.website || tags['contact:website'] || tags.url;
  if (website) return null; // já tem site -> não é lead

  const phone = tags.phone || tags['contact:phone'] || tags['phone:mobile'];
  const whatsappRaw = tags['contact:whatsapp'] || tags.whatsapp;
  const email = tags.email || tags['contact:email'];
  if (!phone && !whatsappRaw && !email) return null; // sem nenhum contato

  const lat = el.lat ?? (el.center ? el.center.lat : null);
  const lon = el.lon ?? (el.center ? el.center.lon : null);
  const endereco = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(', ') || null;

  return {
    osm_id: `${el.type}/${el.id}`,
    nome,
    tipo_negocio: termo,
    telefone: phone || null,
    whatsapp_link: buildWhatsappLink(whatsappRaw || phone),
    email: email || null,
    endereco,
    cidade: tags['addr:city'] || null,
    estado: tags['addr:state'] || null,
    latitude: lat,
    longitude: lon,
    tem_website: false,
    fonte: 'openstreetmap',
    status: 'novo'
  };
}

// ------------------------------------------------------------
// UI de scan e progresso
// ------------------------------------------------------------
function setScanUI(active, text) {
  $('#scanBox').classList.toggle('active', active);
  if (text) $('#scanText').textContent = text;
  $('#searchBtn').disabled = active;
  $('#cancelSearchBtn').style.display = active ? 'inline-flex' : 'none';
}

function setProgress(pct) {
  $('#progressFill').style.width = `${pct}%`;
}

// ------------------------------------------------------------
// Busca principal (performSearch)
// ------------------------------------------------------------
async function performSearch(e) {
  e.preventDefault();
  const termo = $('#termoInput').value.trim();
  if (!termo) { toast('Digite o tipo de negócio.', 'error'); return; }

  currentResults = [];
  savedOsmIds = new Set();
  renderResults([]);
  searchAbort = new AbortController();

  const seenIds = new Set();
  let totalBrutos = 0;

  try {
    if (searchMode === 'local') {
      const localizacao = $('#localizacaoInput').value.trim();
      if (!localizacao) { toast('Informe uma cidade/estado, ex: "Natal, RN".', 'error'); return; }

      setScanUI(true, `Localizando "${localizacao}"...`);
      setProgress(15);
      const bbox = await geocodeLocation(localizacao);

      setScanUI(true, `Vasculhando estabelecimentos em ${localizacao}...`);
      setProgress(30);
      const elements = await searchElements(termo, bbox, searchAbort.signal, (done, total) => {
        if (total > 1) {
          setScanUI(true, `Vasculhando ${localizacao} — bloco ${done}/${total}...`);
          setProgress(30 + Math.round((done / total) * 60));
        }
      });
      totalBrutos += elements.length;

      setProgress(85);
      elements.forEach(el => {
        const key = `${el.type}/${el.id}`;
        if (seenIds.has(key)) return;
        seenIds.add(key);
        const lead = parseElement(el, termo);
        if (lead) currentResults.push(lead);
      });

      await logSearch(termo, localizacao, 'local', totalBrutos, currentResults.length, 0);
      setProgress(100);
    } else {
      // Modo Brasil inteiro
      for (let i = 0; i < BRAZIL_STATES.length; i++) {
        if (searchAbort.signal.aborted) break;
        const st = BRAZIL_STATES[i];
        setScanUI(true, `Vasculhando ${st.nome} (${i + 1}/${BRAZIL_STATES.length})...`);
        setProgress(Math.round(((i + 1) / BRAZIL_STATES.length) * 100));

        try {
          const elements = await searchElements(termo, st.bbox, searchAbort.signal, (done, total) => {
            if (total > 1) {
              setScanUI(true, `Vasculhando ${st.nome} — bloco ${done}/${total} (estado ${i + 1}/${BRAZIL_STATES.length})...`);
            }
          });
          totalBrutos += elements.length;
          elements.forEach(el => {
            const key = `${el.type}/${el.id}`;
            if (seenIds.has(key)) return;
            seenIds.add(key);
            const lead = parseElement(el, termo);
            if (lead) { lead.estado = lead.estado || st.uf; currentResults.push(lead); }
          });
          renderResults(currentResults); // atualiza a tabela progressivamente
        } catch (stErr) {
          console.warn(`Falha ao buscar em ${st.nome}:`, stErr.message);
        }
        await new Promise(r => setTimeout(r, 1200));
      }
      await logSearch(termo, 'Brasil inteiro', 'brasil', totalBrutos, currentResults.length, 0);
    }

    renderResults(currentResults);
    if (currentResults.length === 0) {
      toast('Nenhum estabelecimento sem site foi encontrado com esses critérios.', '');
    } else {
      toast(`${currentResults.length} leads encontrados.`, 'success');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      toast('Busca cancelada.', '');
    } else {
      console.error(err);
      toast(err.message || 'Erro ao buscar.', 'error');
    }
  } finally {
    setScanUI(false);
  }
}

function cancelSearch() {
  if (searchAbort) searchAbort.abort();
}

// ------------------------------------------------------------
// Log de busca
// ------------------------------------------------------------
async function logSearch(termo, localizacao, modo, totalEncontrados, totalSemSite, totalSalvos) {
  if (!currentUser) return;
  try {
    await sb.from('search_logs').insert({
      user_id: currentUser.id,
      termo_busca: termo,
      localizacao,
      modo,
      total_encontrados: totalEncontrados,
      total_sem_site: totalSemSite,
      total_salvos: totalSalvos,
      status: 'concluido'
    });
  } catch (err) {
    console.warn('Falha ao gravar log:', err.message);
  }
}

// ------------------------------------------------------------
// Renderização dos resultados da busca
// ------------------------------------------------------------
function renderResults(results) {
  const tbody = $('#resultsBody');
  const countEl = $('#resultsCount');
  countEl.innerHTML = results.length
    ? `<span class="found">${results.length}</span> leads sem site encontrados`
    : '';

  if (!results.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Nenhum resultado ainda. Faça uma busca acima.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = results.map((lead, idx) => {
    const isSaved = savedOsmIds.has(lead.osm_id);
    return `
      <tr>
        <td>${escapeHtml(lead.nome)}<br><span class="muted">${escapeHtml(lead.tipo_negocio)}</span></td>
        <td class="mono">${lead.telefone ? escapeHtml(lead.telefone) : '<span class="muted">—</span>'}</td>
        <td>${lead.whatsapp_link ? `<a class="wa-link" href="${escapeHtml(lead.whatsapp_link)}" target="_blank" rel="noopener">WhatsApp ↗</a>` : '<span class="muted">—</span>'}</td>
        <td>${lead.email ? escapeHtml(lead.email) : '<span class="muted">—</span>'}</td>
        <td>${[lead.endereco, lead.cidade, lead.estado].filter(Boolean).map(escapeHtml).join(', ') || '<span class="muted">—</span>'}</td>
        <td><span class="badge badge-site">sem site</span></td>
        <td>
          <button class="row-save-btn ${isSaved ? 'saved' : ''}" data-idx="${idx}" ${isSaved ? 'disabled' : ''}>
            ${isSaved ? 'Salvo ✓' : 'Salvar'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  $all('.row-save-btn').forEach(btn => {
    btn.addEventListener('click', () => saveSingleLead(parseInt(btn.dataset.idx, 10)));
  });
}

// ------------------------------------------------------------
// Salvar leads no Supabase
// ------------------------------------------------------------
async function saveSingleLead(idx) {
  const lead = currentResults[idx];
  if (!lead || !currentUser) return;
  try {
    const { error } = await sb.from('leads').upsert(
      { ...lead, user_id: currentUser.id },
      { onConflict: 'user_id,osm_id' }
    );
    if (error) throw error;
    savedOsmIds.add(lead.osm_id);
    renderResults(currentResults);
    toast(`"${lead.nome}" salvo.`, 'success');
    loadMeusLeads();
  } catch (err) {
    console.error('Erro ao salvar lead:', err);
    toast('Erro ao salvar: ' + traduzErroSupabase(err), 'error');
  }
}

async function saveAllLeads() {
  if (!currentResults.length || !currentUser) return;
  const toSave = currentResults.filter(l => !savedOsmIds.has(l.osm_id));
  if (!toSave.length) { toast('Todos os leads já foram salvos.', ''); return; }

  const payload = toSave.map(l => ({ ...l, user_id: currentUser.id }));
  try {
    const { error } = await sb.from('leads').upsert(payload, { onConflict: 'user_id,osm_id' });
    if (error) throw error;
    toSave.forEach(l => savedOsmIds.add(l.osm_id));
    renderResults(currentResults);
    toast(`${toSave.length} leads salvos com sucesso.`, 'success');
    loadMeusLeads();
  } catch (err) {
    console.error('Erro ao salvar em lote:', err);
    toast('Erro ao salvar em lote: ' + traduzErroSupabase(err), 'error');
  }
}

// ------------------------------------------------------------
// Meus Leads
// ------------------------------------------------------------
async function loadMeusLeads() {
  if (!currentUser) return;
  const tbody = $('#leadsBody');
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Carregando...</div></td></tr>`;

  const session = await ensureSession();
  if (!session) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Sessão não encontrada. Saia e entre novamente.</div></td></tr>`;
    return;
  }

  const statusFilter = $('#leadsStatusFilter').value;
  let query = sb.from('leads').select('*').order('created_at', { ascending: false }).limit(500);
  if (statusFilter) query = query.eq('status', statusFilter);

  const { data, error } = await query;
  if (error) {
    console.error('Erro ao carregar leads:', error);
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">${escapeHtml(traduzErroSupabase(error))}</div></td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Nenhum lead salvo ainda. Vá em "Buscar leads" para começar.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(lead => `
    <tr>
      <td>${escapeHtml(lead.nome)}<br><span class="muted">${escapeHtml(lead.tipo_negocio || '')}</span></td>
      <td class="mono">${lead.telefone ? escapeHtml(lead.telefone) : '<span class="muted">—</span>'}</td>
      <td>${lead.whatsapp_link ? `<a class="wa-link" href="${escapeHtml(lead.whatsapp_link)}" target="_blank" rel="noopener">WhatsApp ↗</a>` : '<span class="muted">—</span>'}</td>
      <td>${lead.email ? escapeHtml(lead.email) : '<span class="muted">—</span>'}</td>
      <td>${[lead.endereco, lead.cidade, lead.estado].filter(Boolean).map(escapeHtml).join(', ') || '<span class="muted">—</span>'}</td>
      <td>
        <select class="status-select" data-id="${lead.id}">
          ${['novo','contatado','respondeu','fechado','descartado'].map(s =>
            `<option value="${s}" ${s === lead.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </td>
      <td class="muted">${new Date(lead.created_at).toLocaleDateString('pt-BR')}</td>
    </tr>
  `).join('');

  $all('.status-select').forEach(sel => {
    sel.addEventListener('change', () => updateLeadStatus(sel.dataset.id, sel.value));
  });
}

async function updateLeadStatus(id, status) {
  const { error } = await sb.from('leads').update({ status }).eq('id', id);
  if (error) {
    console.error('Erro ao atualizar status:', error);
    toast('Erro ao atualizar status: ' + traduzErroSupabase(error), 'error');
  } else {
    toast('Status atualizado.', 'success');
  }
}

// ------------------------------------------------------------
// Logs de busca
// ------------------------------------------------------------
async function loadLogs() {
  if (!currentUser) return;
  const tbody = $('#logsBody');
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Carregando...</div></td></tr>`;

  const session = await ensureSession();
  if (!session) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Sessão não encontrada. Saia e entre novamente.</div></td></tr>`;
    return;
  }

  const { data, error } = await sb.from('search_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('Erro ao carregar logs:', error);
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">${escapeHtml(traduzErroSupabase(error))}</div></td></tr>`;
    return;
  }
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Nenhuma busca registrada ainda.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(log => `
    <tr>
      <td>${escapeHtml(log.termo_busca)}</td>
      <td>${escapeHtml(log.localizacao || '—')} <span class="badge badge-status">${escapeHtml(log.modo || '')}</span></td>
      <td>${log.total_encontrados}</td>
      <td><span class="found">${log.total_sem_site}</span> sem site</td>
      <td class="muted">${new Date(log.created_at).toLocaleString('pt-BR')}</td>
    </tr>
  `).join('');
}

// ------------------------------------------------------------
// Inicialização
// ------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Autocomplete de tipos de negócio
  const datalist = $('#termoSuggestions');
  datalist.innerHTML = Object.keys(TAG_MAP).map(k => `<option value="${escapeHtml(k)}">`).join('');

  setAuthMode('login');
  $('#authForm').addEventListener('submit', handleAuthSubmit);
  $('#logoutBtn').addEventListener('click', handleLogout);

  $all('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  $('#searchForm').addEventListener('submit', performSearch);
  $('#cancelSearchBtn').addEventListener('click', cancelSearch);
  $('#saveAllBtn').addEventListener('click', saveAllLeads);
  $('#leadsStatusFilter').addEventListener('change', loadMeusLeads);
  $('#refreshLeadsBtn').addEventListener('click', loadMeusLeads);
  $('#refreshLogsBtn').addEventListener('click', loadLogs);

  $all('.mode-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      searchMode = btn.dataset.mode;
      $all('.mode-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('#localizacaoField').style.display = searchMode === 'local' ? 'block' : 'none';
    });
  });
});
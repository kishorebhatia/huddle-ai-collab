const MAX_FILE_BYTES = 25 * 1024 * 1024;
export function safeMediaURL(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}
export function fileKind(type = '') {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}
export function validateUpload(file) {
  if (!file || typeof file.size !== 'number') throw new Error('Choose a file to add.');
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: choose a file under 25 MB.`);
  if (!file.size) throw new Error(`${file.name}: this file is empty.`);
  return fileKind(file.type);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function openColumn(id) {
  document.querySelectorAll('#mobileTabs button').forEach(button => button.classList.toggle('on', button.dataset.col === id));
  document.querySelectorAll('.col').forEach(column => column.classList.toggle('show', column.id === id));
}
function viewEvent(eventNode) {
  openColumn('feed');
  eventNode.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
  eventNode.classList.add('flash');
  setTimeout(() => eventNode.classList.remove('flash'), 1400);
}
function readRooms(room) {
  let rooms = [];
  try { const data = JSON.parse(localStorage.getItem('huddle:visited-rooms') || '[]'); if (Array.isArray(data)) rooms = data.filter(value => typeof value === 'string').slice(0, 19); } catch {}
  rooms = [room, ...rooms.filter(value => value !== room)];
  try { localStorage.setItem('huddle:visited-rooms', JSON.stringify(rooms)); } catch {}
  return rooms;
}
function initRooms(api) {
  const rooms = readRooms(api.room);
  document.getElementById('studioTitle').textContent = 'Shared workspace';
  for (const id of rooms) {
    const url = new URL(location.href); url.searchParams.set('room', id);
    for (const [target, className] of [['recentRooms', 'recent-room'], ['roomMap', 'map-room']]) {
      const link = element('a', className, `Room ${id}`); link.href = url.href;
      if (id === api.room) link.setAttribute('aria-current', 'page');
      link.append(element('span', '', id === api.room ? 'You are here' : 'Open shared table ↗'));
      link.onclick = () => api.stopMic();
      document.getElementById(target).append(link);
    }
  }
  document.getElementById('roomsBtn').onclick = () => document.getElementById('roomsDialog').showModal();
  document.getElementById('roomsClose').onclick = () => document.getElementById('roomsDialog').close();
  document.getElementById('newRoomBtn').onclick = () => {
    api.stopMic(); const url = new URL(location.href); url.searchParams.set('room', crypto.randomUUID().slice(0, 8)); location.assign(url.href);
  };
}
function cardForEvent(eventNode) {
  const card = element('article', 'table-item');
  const author = eventNode.querySelector('.ev-head strong')?.textContent || 'Teammate';
  const kind = eventNode.querySelector('.kind')?.textContent || 'note';
  const body = eventNode.querySelector('.ev-body')?.textContent || '';
  card.append(element('h3', '', kind === 'said' ? 'From the conversation' : kind));
  for (const media of eventNode.querySelectorAll('img, audio, video')) {
    const url = safeMediaURL(media.src); if (!url) continue;
    const copy = element(media.tagName.toLowerCase()); copy.src = url;
    if (media.tagName === 'IMG') { copy.alt = media.alt || 'Shared image'; copy.loading = 'lazy'; }
    else { copy.controls = true; copy.preload = 'metadata'; }
    card.append(copy);
  }
  const url = kind === 'link' ? safeMediaURL(body.trim()) : null;
  if (url) { const link = element('a', '', body); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); }
  else card.append(element('p', '', body));
  for (const attachment of eventNode.querySelectorAll('a[data-file]')) card.append(attachment.cloneNode(true));
  card.append(element('small', '', author));
  const discuss = element('button', '', 'Discuss in chat ↗'); discuss.onclick = () => viewEvent(eventNode); card.append(discuss);
  return card;
}
function syncBoard() {
  const events = [...document.querySelectorAll('#events .ev')].filter(event => !event.classList.contains('kind-system'));
  const table = document.getElementById('tableItems');
  const existing = new Map([...table.children].map(card => [card.dataset.source, card]));
  const seen = new Set();
  for (const event of events) {
    seen.add(event.id);
    const signature = event.innerHTML;
    const previous = existing.get(event.id);
    if (previous?.dataset.signature === signature) continue;
    const card = cardForEvent(event); card.dataset.source = event.id; card.dataset.signature = signature;
    if (previous) previous.replaceWith(card); else table.append(card);
  }
  existing.forEach((card, id) => { if (!seen.has(id) && !id.startsWith('job-')) card.remove(); });
  document.getElementById('tableEmpty').hidden = table.children.length > 0;
  document.getElementById('tableCount').textContent = `${table.children.length} items · drop anything here`;
}
function syncOutputs() {
  const table = document.getElementById('tableItems');
  table.querySelectorAll('[data-output-card]').forEach(card => card.remove());
  document.querySelectorAll('#jobs .job.s-done').forEach((job, index) => {
    const card = element('article', 'table-item'); card.dataset.source = `job-${index}`; card.dataset.outputCard = 'true';
    card.append(element('h3', '', 'Agent output'), element('p', '', job.querySelector('.job-title')?.textContent || 'Completed work'));
    const open = [...job.querySelectorAll('button')].find(button => /open|view/i.test(button.textContent));
    if (open) { const button = element('button', '', 'Open output & give feedback ↗'); button.onclick = () => open.click(); card.append(button); }
    else { const button = element('button', '', 'View agent work ↗'); button.onclick = () => { openColumn('work'); job.scrollIntoView({block:'center'}); }; card.append(button); }
    table.append(card);
  });
  document.getElementById('tableEmpty').hidden = table.children.length > 0;
  document.getElementById('tableCount').textContent = `${table.children.length} items · drop anything here`;
}
async function uploadMedia(file, api) {
  const path = `${api.room}/${crypto.randomUUID()}`;
  const mime = file.type || 'application/octet-stream';
  const upload = await api.sb.storage.from('board').upload(path, file, { contentType: mime });
  if (upload.error) throw upload.error;
  const { data } = api.sb.storage.from('board').getPublicUrl(path);
  const { error } = await api.sb.from('events').insert({ room_id: api.room, author: api.getAuthor(), kind: 'note',
    text: `Shared ${fileKind(mime)}: ${file.name}`, meta: { media_url: data.publicUrl, media_type: mime, file_name: file.name } });
  if (error) throw error;
}
async function receiveFiles(files, api) {
  const status = document.getElementById('tableStatus');
  for (const file of files) {
    try {
      const kind = validateUpload(file); status.textContent = `Adding ${file.name}…`;
      if (kind === 'image') await api.shareImage(file, document.getElementById('tableNote').value.trim());
      else await uploadMedia(file, api);
    } catch (error) { api.toast(`Could not add file: ${error.message}`, 6000); }
  }
  status.textContent = '';
}
function initCapture(api) {
  const input = document.getElementById('tableFiles');
  document.querySelectorAll('[data-attach]').forEach(button => button.onclick = () => {
    input.accept = ({ image: 'image/*', video: 'video/*', audio: 'audio/*', all: '' })[button.dataset.attach]; input.click();
  });
  document.getElementById('tableAdd').onclick = () => { input.accept = ''; input.click(); };
  input.onchange = async () => { await receiveFiles([...input.files], api); input.value = ''; };
  document.getElementById('tableComposer').onsubmit = async event => {
    event.preventDefault(); const note = document.getElementById('tableNote'); const text = note.value.trim(); if (!text) return;
    await api.postNote(text); note.value = '';
  };
  document.getElementById('tableSketch').onclick = () => {
    document.querySelector('[data-view="boardView"]').click(); openColumn('center');
    document.getElementById('boardView').scrollIntoView({ block: 'center' });
  };
}
function initDrop(api) {
  const table = document.getElementById('sharedTable'); let depth = 0;
  table.addEventListener('dragenter', event => { event.preventDefault(); depth++; table.classList.add('dragging'); });
  table.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
  table.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) table.classList.remove('dragging'); });
  table.addEventListener('drop', async event => {
    event.preventDefault(); depth = 0; table.classList.remove('dragging');
    if (event.dataTransfer.files.length) await receiveFiles([...event.dataTransfer.files], api);
    else { const text = event.dataTransfer.getData('text/uri-list').split('\n').find(line => line && !line.startsWith('#')) || event.dataTransfer.getData('text/plain'); if (text?.trim()) await api.postNote(text.trim()); }
  });
  table.addEventListener('paste', event => {
    if ([...(event.clipboardData?.items || [])].some(item => item.type.startsWith('image/'))) return;
    const text = event.clipboardData?.getData('text/plain'); if (text?.trim()) { event.preventDefault(); api.postNote(text.trim()); }
  });
  document.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
}
export function renderAttachment(event, container) {
  const url = safeMediaURL(event.meta?.media_url); if (!url) return;
  const kind = fileKind(event.meta?.media_type);
  if (kind === 'audio' || kind === 'video') {
    const media = element(kind); media.src = url; media.controls = true; media.preload = 'metadata';
    media.style.maxWidth = '100%'; media.setAttribute('aria-label', event.meta.file_name || 'Shared media'); container.append(media);
  } else {
    const link = element('a', '', event.meta?.file_name || 'Download attachment'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.file = 'true'; link.download = event.meta?.file_name || 'attachment'; container.append(link);
  }
}
export function initStudio(api) {
  document.getElementById('studioTools').append(document.getElementById('connectBtn'));
  initRooms(api); initCapture(api); initDrop(api); openColumn('tableCol');
  let eventQueued = false; let jobQueued = false;
  new MutationObserver(() => { if (eventQueued) return; eventQueued = true; queueMicrotask(() => { eventQueued = false; syncBoard(); }); }).observe(document.getElementById('events'), {childList:true,subtree:true,characterData:true});
  new MutationObserver(() => { if (jobQueued) return; jobQueued = true; queueMicrotask(() => { jobQueued = false; syncOutputs(); }); }).observe(document.getElementById('jobs'), {childList:true,subtree:true,characterData:true});
  syncBoard(); syncOutputs();
}

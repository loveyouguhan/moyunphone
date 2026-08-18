export const manifest = {
  protocolVersion: 1,
  id: 'memo-notebook',
  name: '备忘录',
  version: '1.1.0',
  author: '墨韵手机示例',
  description: '按聊天隔离保存备忘录，并从 API 配置库选择模型整理当前草稿。',
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%235b6ee1'/%3E%3Cpath d='M18 14h28a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z' fill='white'/%3E%3Cpath d='M23 25h18M23 32h18M23 39h11' stroke='%235b6ee1' stroke-width='4' stroke-linecap='round'/%3E%3C/svg%3E",
  entry: 'self',
  permissions: ['generation', 'moduleStorage'],
  api: { mode: 'profile' },
};

const NOTES_KEY = 'notes';
const NOTES_VERSION = 1;
const MAX_NOTE_COUNT = 200;
const MAX_TITLE_LENGTH = 80;
const MAX_BODY_LENGTH = 8_000;
const MAX_TAG_LENGTH = 24;

const MEMO_SYSTEM_PROMPT = [
  '你是一个严谨的备忘录整理助手。',
  '你的任务是把用户提供的草稿整理成一条可长期查阅的备忘录。',
  '保留原文中的人名、日期、数字、专有名词和不确定性；不要凭空补充事实。',
  '标题简洁明确，正文使用纯文本短段落，不使用 Markdown、HTML 或代码围栏。',
  '只输出 JSON，不输出解释。JSON 必须严格符合：',
  '{"title":"string","body":"string","tags":["string"],"priority":"low|normal|high"}',
  'title 最多 80 字，body 最多 8000 字，tags 最多 8 个且每个最多 24 字。',
].join('\n');

export default function createModule(api) {
  let notes = [];
  let loaded = false;
  let dirtyBeforeLoad = false;
  let disposed = false;
  let activePage = null;
  let apiRef = api;
  let selectedProfileName = '';
  let query = '';
  let showArchived = false;
  let editingId = null;
  let saveChain = Promise.resolve();
  let generating = false;

  const render = (hostApi) => {
    apiRef = hostApi;
    selectedProfileName = String(hostApi.api.binding.profileName ?? '');
    activePage = buildPage();
    if (!loaded) void loadNotes();
    return activePage;
  };

  const refresh = () => {
    if (disposed || !activePage || !activePage.isConnected) return;
    const next = buildPage();
    activePage.replaceWith(next);
    activePage = next;
  };

  const loadNotes = async () => {
    try {
      const stored = await apiRef.storage.get(NOTES_KEY);
      const storedNotes = normalizeNotes(stored);
      notes = dirtyBeforeLoad ? mergeNotes(notes, storedNotes) : storedNotes;
      if (dirtyBeforeLoad) void persist();
    } catch (error) {
      apiRef.notify(`备忘录读取失败：${safeError(error)}`, 'error');
      notes = [];
    } finally {
      loaded = true;
      refresh();
    }
  };

  const persist = () => {
    const snapshot = { version: NOTES_VERSION, notes };
    saveChain = saveChain
      .then(() => apiRef.storage.set(NOTES_KEY, snapshot))
      .catch((error) => apiRef.notify(`备忘录保存失败：${safeError(error)}`, 'error'));
    return saveChain;
  };

  const updateNotes = (nextNotes) => {
    notes = nextNotes.slice(0, MAX_NOTE_COUNT);
    if (!loaded) {
      dirtyBeforeLoad = true;
      refresh();
      return;
    }
    refresh();
    void persist();
  };

  const saveNote = (form) => {
    const title = readField(form, 'title').value.trim().slice(0, MAX_TITLE_LENGTH);
    const body = readField(form, 'body').value.trim().slice(0, MAX_BODY_LENGTH);
    if (!title && !body) {
      apiRef.notify('请至少填写标题或内容。', 'info');
      return;
    }
    const now = Date.now();
    const tags = parseTags(readField(form, 'tags').value);
    const priority = normalizePriority(readField(form, 'priority').value);
    if (editingId) {
      updateNotes(notes.map((note) => note.id === editingId
        ? { ...note, title: title || '未命名备忘录', body, tags, priority, updatedAt: now }
        : note));
      apiRef.notify('备忘录已更新。', 'success');
    } else {
      updateNotes([{
        id: createId(),
        title: title || '未命名备忘录',
        body,
        tags,
        priority,
        pinned: false,
        archived: false,
        createdAt: now,
        updatedAt: now,
      }, ...notes]);
      apiRef.notify('备忘录已保存。', 'success');
    }
    editingId = null;
  };

  const generateFromDraft = async (form, buttonElement) => {
    const draft = readField(form, 'body').value.trim();
    if (!draft) {
      apiRef.notify('请先在内容框中写下草稿。', 'info');
      return;
    }
    generating = true;
    buttonElement.disabled = true;
    buttonElement.textContent = '整理中…';
    try {
      const result = await apiRef.generation.generateJson({
        system: MEMO_SYSTEM_PROMPT,
        user: buildMemoUserPrompt(readField(form, 'title').value, readField(form, 'tags').value, draft),
        temperature: 0.2,
        maxTokens: 900,
        validate: isMemoDraft,
      });
      readField(form, 'title').value = result.title;
      readField(form, 'body').value = result.body;
      readField(form, 'tags').value = result.tags.join(', ');
      readField(form, 'priority').value = result.priority;
      apiRef.notify('草稿已整理，请检查后保存。', 'success');
    } catch (error) {
      apiRef.notify(`AI 整理失败：${safeError(error)}`, 'error');
    } finally {
      generating = false;
      buttonElement.disabled = false;
      buttonElement.textContent = 'AI 整理草稿';
    }
  };

  const buildPage = () => {
    const page = node('section', 'memo-module');
    page.append(styleNode());

    const header = node('header', 'memo-header');
    const heading = node('div', 'memo-heading');
    heading.append(node('span', 'memo-kicker', 'PRIVATE NOTES'), node('h3', '', '备忘录'));
    heading.append(node('p', 'memo-subtitle', '当前聊天独立保存，AI 只在你点击时整理草稿。'));
    header.append(heading, profileStatus());
    page.append(header);

    const toolbar = node('div', 'memo-toolbar');
    const search = node('input', 'memo-search');
    search.type = 'search';
    search.placeholder = '搜索标题、内容或标签';
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value;
      renderList(list, editor);
    });
    const archiveToggle = actionButton(showArchived ? '查看未归档' : '查看归档', 'memo-button memo-button-quiet', () => {
      showArchived = !showArchived;
      refresh();
    });
    const newButton = actionButton('新建备忘录', 'memo-button memo-button-primary', () => {
      editingId = null;
      refresh();
    });
    toolbar.append(search, archiveToggle, newButton);
    page.append(toolbar);

    const editor = buildEditor();
    page.append(editor);

    const list = node('div', 'memo-list');
    renderList(list, editor);
    page.append(list);
    return page;
  };

  const buildEditor = () => {
    const note = notes.find((item) => item.id === editingId);
    const editor = node('form', 'memo-editor');
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      saveNote(editor);
    });

    const title = node('input', 'memo-input');
    title.name = 'title';
    title.placeholder = '标题';
    title.maxLength = MAX_TITLE_LENGTH;
    title.value = note?.title ?? '';

    const body = node('textarea', 'memo-textarea');
    body.name = 'body';
    body.placeholder = '写下需要记住的内容…';
    body.maxLength = MAX_BODY_LENGTH;
    body.value = note?.body ?? '';

    const tags = node('input', 'memo-input');
    tags.name = 'tags';
    tags.placeholder = '标签，用逗号分隔';
    tags.maxLength = MAX_TAG_LENGTH * 8;
    tags.value = note?.tags.join(', ') ?? '';

    const priority = document.createElement('select');
    priority.className = 'memo-select';
    priority.name = 'priority';
    for (const [value, label] of [['low', '低优先级'], ['normal', '普通'], ['high', '高优先级']]) {
      const option = node('option', '', label);
      option.value = value;
      priority.append(option);
    }
    priority.value = note?.priority ?? 'normal';

    const fields = node('div', 'memo-editor-fields');
    fields.append(title, body, tags, priority);
    const actions = node('div', 'memo-editor-actions');
    const save = actionButton(note ? '保存修改' : '保存备忘录', 'memo-button memo-button-primary', () => editor.requestSubmit());
    const ai = actionButton('AI 整理草稿', 'memo-button memo-button-ai', () => {
      void generateFromDraft(editor, ai);
    });
    ai.disabled = generating;
    actions.append(ai);
    if (note) actions.append(actionButton('取消编辑', 'memo-button memo-button-quiet', () => {
      editingId = null;
      refresh();
    }));
    actions.append(save);
    editor.append(fields, actions);
    return editor;
  };

  const renderList = (list, editor) => {
    const normalizedQuery = query.trim().toLowerCase();
    const visible = notes
      .filter((note) => note.archived === showArchived)
      .filter((note) => {
        if (!normalizedQuery) return true;
        return [note.title, note.body, ...note.tags]
          .join('\n')
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);

    if (visible.length === 0) {
      const empty = node('div', 'memo-empty');
      empty.append(node('strong', '', showArchived ? '还没有归档备忘录' : '还没有备忘录'), node('span', '', showArchived ? '归档的内容会显示在这里。' : '先写下一条需要记住的内容。'));
      list.append(empty);
      return;
    }
    for (const note of visible) list.append(noteCard(note, editor));
  };

  const noteCard = (note, editor) => {
    const card = node('article', `memo-card${note.pinned ? ' is-pinned' : ''}`);
    const top = node('div', 'memo-card-top');
    const title = node('h4', '', note.title);
    const badges = node('div', 'memo-badges');
    if (note.pinned) badges.append(node('span', 'memo-badge memo-badge-pin', '置顶'));
    if (note.priority === 'high') badges.append(node('span', 'memo-badge memo-badge-high', '重要'));
    top.append(title, badges);
    const body = node('p', 'memo-card-body', note.body || '（无正文）');
    const footer = node('div', 'memo-card-footer');
    const metadata = node('div', 'memo-card-meta', formatDate(note.updatedAt));
    for (const tag of note.tags) metadata.append(node('span', 'memo-tag', `#${tag}`));
    const actions = node('div', 'memo-card-actions');
    actions.append(
      actionButton('编辑', 'memo-link-button', () => {
        editingId = note.id;
        refresh();
      }),
      actionButton(note.pinned ? '取消置顶' : '置顶', 'memo-link-button', () => {
        updateNotes(notes.map((item) => item.id === note.id ? { ...item, pinned: !item.pinned, updatedAt: Date.now() } : item));
      }),
      actionButton(note.archived ? '取消归档' : '归档', 'memo-link-button', () => {
        updateNotes(notes.map((item) => item.id === note.id ? { ...item, archived: !item.archived, updatedAt: Date.now() } : item));
      }),
      actionButton('删除', 'memo-link-button memo-link-danger', () => {
        if (!window.confirm(`确定删除「${note.title}」吗？`)) return;
        updateNotes(notes.filter((item) => item.id !== note.id));
        if (editingId === note.id) editingId = null;
      }),
    );
    footer.append(metadata, actions);
    card.append(top, body, footer);
    return card;
  };

  const profileStatus = () => {
    const binding = apiRef.api.binding;
    const status = node('div', 'memo-profile');
    status.append(node('span', 'memo-profile-label', '生成配置'));
    if (binding.mode !== 'profile') {
      status.append(node('strong', '', binding.mode === 'shared' ? '跟随统一生成' : '模块配置'));
      return status;
    }

    const profiles = apiRef.api.profiles;
    const selectedProfile = profiles.find((profile) => profile.name === selectedProfileName);
    if (selectedProfileName && !selectedProfile) status.classList.add('is-missing');
    const select = document.createElement('select');
    select.className = 'memo-profile-select';
    select.setAttribute('aria-label', '选择备忘录生成 API 配置');
    const placeholder = node('option', '', '选择 API 配置');
    placeholder.value = '';
    select.append(placeholder);
    for (const profile of profiles) {
      const option = node('option', '', `${profile.name}（${profile.model || '未填模型'}）`);
      option.value = profile.name;
      select.append(option);
    }
    select.value = selectedProfileName;
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        selectedProfileName = select.value;
        await apiRef.module.updateSettings({ apiProfileName: selectedProfileName });
        apiRef.notify(selectedProfileName ? `已选择 API 配置「${selectedProfileName}」。` : '已清除 API 配置选择。', 'success');
        refresh();
      } catch (error) {
        apiRef.notify(`保存 API 配置选择失败：${safeError(error)}`, 'error');
        select.disabled = false;
      }
    });
    status.append(select);
    if (profiles.length === 0) {
      status.append(node('small', '', '配置库为空，请到设置 → API 配置库新增配置。'));
    } else if (selectedProfileName && !selectedProfile) {
      status.append(node('small', '', `已保存的配置「${selectedProfileName}」不存在，请重新选择。`));
    } else if (!selectedProfileName) {
      status.append(node('small', '', '请选择一个已保存的配置，模块不会读取或保存 API Key。'));
    }
    return status;
  };

  return {
    manifest: api.module.manifest,
    render,
    dispose() {
      disposed = true;
      activePage = null;
    },
  };
}

function buildMemoUserPrompt(title, tags, body) {
  return [
    '请整理下面这条备忘录草稿。',
    `用户给出的标题：${title.trim().slice(0, MAX_TITLE_LENGTH) || '（未提供）'}`,
    `用户给出的标签：${tags.trim().slice(0, MAX_TAG_LENGTH * 8) || '（未提供）'}`,
    '备忘录草稿开始',
    body.slice(0, MAX_BODY_LENGTH),
    '备忘录草稿结束',
  ].join('\n');
}

function isMemoDraft(value) {
  if (!isRecord(value)) return false;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  const tags = Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string');
  return Boolean(title && body && title.length <= MAX_TITLE_LENGTH && body.length <= MAX_BODY_LENGTH && tags
    && value.tags.length <= 8 && value.tags.every((tag) => tag.trim().length <= MAX_TAG_LENGTH)
    && ['low', 'normal', 'high'].includes(value.priority));
}

function mergeNotes(localNotes, storedNotes) {
  const localIds = new Set(localNotes.map((note) => note.id));
  return [...localNotes, ...storedNotes.filter((note) => !localIds.has(note.id))].slice(0, MAX_NOTE_COUNT);
}

function normalizeNotes(value) {
  const rawNotes = isRecord(value) && Array.isArray(value.notes) ? value.notes : Array.isArray(value) ? value : [];
  return rawNotes.slice(0, MAX_NOTE_COUNT).map(normalizeNote).filter(Boolean);
}

function normalizeNote(value) {
  if (!isRecord(value)) return null;
  const body = String(value.body ?? '').trim().slice(0, MAX_BODY_LENGTH);
  const title = String(value.title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
  if (!title && !body) return null;
  const now = Date.now();
  return {
    id: String(value.id ?? createId()),
    title: title || '未命名备忘录',
    body,
    tags: parseTags(Array.isArray(value.tags) ? value.tags.join(',') : String(value.tags ?? '')),
    priority: normalizePriority(value.priority),
    pinned: value.pinned === true,
    archived: value.archived === true,
    createdAt: finiteTime(value.createdAt, now),
    updatedAt: finiteTime(value.updatedAt, now),
  };
}

function parseTags(value) {
  return [...new Set(String(value).split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))]
    .slice(0, 8)
    .map((tag) => tag.slice(0, MAX_TAG_LENGTH));
}

function normalizePriority(value) {
  return ['low', 'high'].includes(value) ? value : 'normal';
}

function finiteTime(value, fallback) {
  const time = Number(value);
  return Number.isFinite(time) ? time : fallback;
}

function createId() {
  return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readField(form, name) {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) {
    throw new Error(`找不到表单字段：${name}`);
  }
  return field;
}

function node(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionButton(label, className, onClick) {
  const button = node('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function styleNode() {
  const style = document.createElement('style');
  style.textContent = `
    .memo-module { display: grid; gap: 14px; padding: 2px 0 18px; color: var(--phone-text-primary, #24242b); }
    .memo-header, .memo-toolbar, .memo-card-top, .memo-card-footer, .memo-editor-actions { display: flex; align-items: center; gap: 10px; }
    .memo-header { justify-content: space-between; align-items: flex-start; gap: 14px; }
    .memo-heading { min-width: 0; }
    .memo-kicker { color: var(--phone-accent, #5b6ee1); font-size: 10px; font-weight: 800; letter-spacing: .14em; }
    .memo-heading h3 { margin: 3px 0 0; font-size: 24px; }
    .memo-subtitle { margin: 4px 0 0; color: var(--phone-text-secondary, #73747f); font-size: 12px; line-height: 1.5; }
    .memo-profile { display: grid; gap: 2px; flex: 0 0 auto; max-width: 42%; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--phone-accent, #5b6ee1) 20%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--phone-accent, #5b6ee1) 8%, transparent); font-size: 11px; }
    .memo-profile.is-missing { border-color: #d77979; background: #fff2f2; }
    .memo-profile-label, .memo-profile small { color: var(--phone-text-secondary, #73747f); }
    .memo-profile strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .memo-profile small { line-height: 1.35; }
    .memo-toolbar { align-items: stretch; }
    .memo-search, .memo-input, .memo-textarea, .memo-select { box-sizing: border-box; width: 100%; border: 1px solid color-mix(in srgb, var(--phone-text-secondary, #73747f) 24%, transparent); border-radius: 10px; background: var(--phone-fill, #f5f5f7); color: inherit; font: inherit; }
    .memo-search, .memo-input, .memo-select { min-height: 36px; padding: 7px 10px; }
    .memo-search { flex: 1 1 auto; min-width: 100px; }
    .memo-textarea { min-height: 130px; padding: 10px; resize: vertical; line-height: 1.55; }
    .memo-input:focus, .memo-textarea:focus, .memo-search:focus, .memo-select:focus { outline: 2px solid color-mix(in srgb, var(--phone-accent, #5b6ee1) 40%, transparent); outline-offset: 1px; }
    .memo-editor { display: grid; gap: 9px; padding: 13px; border: 1px solid color-mix(in srgb, var(--phone-accent, #5b6ee1) 18%, transparent); border-radius: 15px; background: color-mix(in srgb, var(--phone-accent, #5b6ee1) 5%, var(--phone-card, #fff)); }
    .memo-editor-fields { display: grid; gap: 9px; }
    .memo-editor-fields .memo-select { width: auto; }
    .memo-editor-actions { justify-content: flex-end; flex-wrap: wrap; }
    .memo-button { min-height: 34px; padding: 7px 11px; border: 0; border-radius: 9px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 700; }
    .memo-button:disabled { cursor: wait; opacity: .55; }
    .memo-button-primary { background: var(--phone-accent, #5b6ee1); color: #fff; }
    .memo-button-ai { background: #e7ddff; color: #533295; }
    .memo-button-quiet { border: 1px solid color-mix(in srgb, var(--phone-text-secondary, #73747f) 22%, transparent); background: transparent; color: inherit; }
    .memo-list { display: grid; gap: 10px; }
    .memo-card { display: grid; gap: 9px; padding: 13px; border: 1px solid color-mix(in srgb, var(--phone-text-secondary, #73747f) 16%, transparent); border-radius: 14px; background: var(--phone-card, #fff); }
    .memo-card.is-pinned { border-color: color-mix(in srgb, var(--phone-accent, #5b6ee1) 42%, transparent); }
    .memo-card-top { justify-content: space-between; align-items: flex-start; }
    .memo-card h4 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
    .memo-badges, .memo-card-meta { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
    .memo-badge, .memo-tag { padding: 2px 6px; border-radius: 999px; font-size: 10px; }
    .memo-badge-pin { background: #e9edff; color: #5363bd; }
    .memo-badge-high { background: #ffe5e2; color: #b44940; }
    .memo-tag { background: var(--phone-fill, #f3f3f5); color: var(--phone-text-secondary, #73747f); }
    .memo-card-body { margin: 0; color: var(--phone-text-secondary, #73747f); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
    .memo-card-footer { justify-content: space-between; align-items: flex-end; gap: 8px; }
    .memo-card-meta { color: var(--phone-text-secondary, #73747f); font-size: 10px; }
    .memo-card-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
    .memo-link-button { padding: 0; border: 0; background: transparent; color: var(--phone-accent, #5b6ee1); cursor: pointer; font: inherit; font-size: 11px; }
    .memo-link-danger { color: #b44940; }
    .memo-empty { display: grid; justify-items: center; gap: 4px; padding: 28px 12px; border: 1px dashed color-mix(in srgb, var(--phone-text-secondary, #73747f) 28%, transparent); border-radius: 14px; color: var(--phone-text-secondary, #73747f); text-align: center; }
    .memo-empty strong { color: var(--phone-text-primary, #24242b); }
    @media (max-width: 420px) { .memo-header, .memo-toolbar { align-items: stretch; flex-direction: column; } .memo-profile { max-width: none; } .memo-card-footer { align-items: stretch; flex-direction: column; } }
  `;
  return style;
}
export const manifest = {
  protocolVersion: 1,
  id: 'weibo',
  name: '微博',
  version: '1.0.0',
  author: '墨韵手机示例',
  description: '模拟微博首页、热搜、发现和个人主页，使用统一生成补充公开信息流。',
  icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23ff8200'/%3E%3Cpath d='M18 28c-2-7 9-13 18-10 7 2 13 8 12 16-1 11-12 18-25 16-12-2-18-10-15-16 2-4 6-5 10-6Z' fill='white'/%3E%3Ccircle cx='33' cy='39' r='8' fill='%23ff8200'/%3E%3Cpath d='M40 23c5-2 8 1 7 5' fill='none' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E",
  entry: 'self',
  permissions: ['generation', 'moduleStorage'],
  api: { mode: 'shared' },
};

const DATA_KEY = 'weibo-data';
const DATA_VERSION = 1;
const MAX_POSTS = 120;
const MAX_HOT_SEARCHES = 30;
const MAX_NOTIFICATIONS = 60;
const MAX_POST_LENGTH = 1_000;
const MAX_TAG_LENGTH = 24;
const MAX_TAGS = 6;

const WEIBO_SYSTEM_PROMPT = [
  '你是一个微博公开信息流编剧，负责根据当前统一生成上下文，生成一批像真实微博一样的公开动态。',
  '微博内容应贴合当前世界观、人物关系、剧情进展和人物说话风格；不要凭空泄露不存在的事实。',
  '动态可以来自角色、熟人、机构媒体或虚构路人，但必须明确区分已知角色与虚构网友。',
  '内容要有微博感：短句、话题标签、轻微口语化、转发讨论、围观和情绪反应，但不要堆砌网络热梗。',
  '只输出 JSON，不要输出 Markdown、解释、代码围栏、HTML、图片地址或外部链接。',
  'JSON 必须符合以下结构：',
  '{"posts":[{"authorName":"string","handle":"@string","verified":false,"content":"string","timeLabel":"刚刚","tags":["string"],"likes":0,"comments":0,"reposts":0}],"hotSearches":[{"title":"string","heat":"string"}],"notifications":[{"actorName":"string","action":"string","content":"string"}]}',
  '最多生成 8 条 posts、8 条 hotSearches、6 条 notifications。单条微博正文最多 1000 字，标签最多 6 个。',
  '不要生成用户本人已经发布的重复内容；不要替用户做出未明确表达的现实决定。',
].join('\n');

export default function createModule(api) {
  let apiRef = api;
  let data = emptyData();
  let loaded = false;
  let localEditsBeforeLoad = false;
  let disposed = false;
  let activePage = null;
  let generating = false;
  let query = '';
  let timelineMode = 'home';
  let saveChain = Promise.resolve();

  const render = (hostApi) => {
    apiRef = hostApi;
    activePage = buildPage();
    if (!loaded) void loadData();
    return activePage;
  };

  const refresh = () => {
    if (disposed || !activePage || !activePage.isConnected) return;
    const next = buildPage();
    activePage.replaceWith(next);
    activePage = next;
  };

  const loadData = async () => {
    try {
      const stored = await apiRef.storage.get(DATA_KEY);
      const storedData = normalizeData(stored);
      data = localEditsBeforeLoad ? mergeData(data, storedData) : storedData;
      if (localEditsBeforeLoad) await persist();
    } catch (error) {
      apiRef.notify(`微博数据读取失败：${safeError(error)}`, 'error');
      data = emptyData();
    } finally {
      loaded = true;
      if (localEditsBeforeLoad) await persist();
      refresh();
    }
  };

  const persist = () => {
    if (!loaded) return saveChain;
    const snapshot = structuredClone(data);
    saveChain = saveChain
      .then(() => apiRef.storage.set(DATA_KEY, snapshot))
      .catch((error) => apiRef.notify(`微博数据保存失败：${safeError(error)}`, 'error'));
    return saveChain;
  };

  const updateData = (nextData) => {
    data = normalizeData(nextData);
    if (!loaded) localEditsBeforeLoad = true;
    refresh();
    void persist();
  };

  const generateFeed = async (buttonElement) => {
    if (generating) return;
    generating = true;
    buttonElement.disabled = true;
    buttonElement.textContent = '刷新中…';
    try {
      const result = await apiRef.generation.generateJson({
        system: WEIBO_SYSTEM_PROMPT,
        user: buildGenerationUserPrompt(),
        temperature: 0.85,
        maxTokens: 1_800,
        validate: isWeiboResponse,
      });
      const generatedPosts = result.posts.map((post) => normalizeGeneratedPost(post)).filter(Boolean);
      const currentUserHandles = new Set(data.posts.filter((post) => post.isUser).map((post) => post.handle));
      const posts = [
        ...generatedPosts.filter((post) => !currentUserHandles.has(post.handle)),
        ...data.posts.filter((post) => post.isUser),
      ].slice(0, MAX_POSTS);
      updateData({
        ...data,
        posts,
        hotSearches: result.hotSearches.map(normalizeHotSearch),
        notifications: result.notifications.map(normalizeNotification),
        generatedAt: Date.now(),
      });
      apiRef.notify(`微博信息流已更新，生成了 ${generatedPosts.length} 条动态。`, 'success');
    } catch (error) {
      apiRef.notify(`微博统一生成失败：${safeError(error)}`, 'error');
    } finally {
      generating = false;
      buttonElement.disabled = false;
      buttonElement.textContent = '刷新信息流';
    }
  };

  const composePost = async () => {
    const values = await apiRef.modal('发布微博', [
      { name: 'content', label: '正文', type: 'textarea', required: true, placeholder: '有什么新鲜事？' },
      { name: 'tags', label: '话题（可选）', placeholder: '例如：旅行, 今日份快乐' },
    ]);
    if (!values) return;
    const content = values.content.trim().slice(0, MAX_POST_LENGTH);
    if (!content) return;
    const self = getSelfProfile();
    const post = {
      ...createPostBase(),
      authorName: self.name,
      handle: self.handle,
      verified: false,
      content,
      tags: parseTags(values.tags),
      isUser: true,
      source: 'user',
    };
    updateData({ ...data, posts: [post, ...data.posts].slice(0, MAX_POSTS) });
    apiRef.notify('微博已发布。', 'success');
  };

  const toggleLike = (postId) => {
    updateData({
      ...data,
      posts: data.posts.map((post) => post.id !== postId
        ? post
        : { ...post, liked: !post.liked, likes: Math.max(0, post.likes + (post.liked ? -1 : 1)) }),
    });
  };

  const commentPost = async (postId) => {
    const post = data.posts.find((item) => item.id === postId);
    if (!post) return;
    const values = await apiRef.modal('评论微博', [
      { name: 'content', label: `回复 ${post.authorName}`, type: 'textarea', required: true, placeholder: '说点什么…' },
    ]);
    if (!values?.content.trim()) return;
    updateData({
      ...data,
      posts: data.posts.map((item) => item.id === postId ? { ...item, comments: item.comments + 1 } : item),
      notifications: prependNotification(data.notifications, {
        actorName: getSelfProfile().name,
        action: '评论了微博',
        content: values.content.trim().slice(0, 180),
      }),
    });
    apiRef.notify('评论已发布。', 'success');
  };

  const repostPost = async (postId) => {
    const post = data.posts.find((item) => item.id === postId);
    if (!post) return;
    const values = await apiRef.modal('转发微博', [
      { name: 'content', label: '转发理由（可选）', type: 'textarea', placeholder: '说说你的看法…' },
    ]);
    if (!values) return;
    const repost = {
      ...createPostBase(),
      authorName: getSelfProfile().name,
      handle: getSelfProfile().handle,
      verified: false,
      content: values.content.trim().slice(0, MAX_POST_LENGTH) || `转发 @${post.handle.replace(/^@/, '')}：${post.content}`.slice(0, MAX_POST_LENGTH),
      tags: post.tags,
      isUser: true,
      source: 'user',
      repostOf: post.id,
    };
    updateData({
      ...data,
      posts: [repost, ...data.posts].slice(0, MAX_POSTS),
      notifications: prependNotification(data.notifications, {
        actorName: getSelfProfile().name,
        action: '转发了微博',
        content: post.content.slice(0, 180),
      }),
    });
    apiRef.notify('转发已发布。', 'success');
  };

  const toggleFollow = (handle) => {
    const following = data.following.includes(handle)
      ? data.following.filter((item) => item !== handle)
      : [...data.following, handle];
    updateData({ ...data, following });
  };

  const buildPage = () => {
    const page = node('section', 'weibo-module');
    page.append(styleNode());
    page.append(buildHeader());
    if (!loaded) {
      page.append(node('div', 'weibo-loading', '正在加载微博…'));
      return page;
    }
    if (timelineMode === 'hot') page.append(buildHotPage());
    else if (timelineMode === 'discover') page.append(buildDiscoverPage());
    else if (timelineMode === 'me') page.append(buildMePage());
    else page.append(buildHomePage());
    return page;
  };

  const buildHeader = () => {
    const header = node('header', 'weibo-header');
    const brand = node('div', 'weibo-brand');
    brand.append(node('span', 'weibo-logo', '微'), node('div', '', '微博'));
    brand.append(node('small', '', '公开信息流 · 统一生成')); 
    const self = getSelfProfile();
    const identity = node('div', 'weibo-header-identity');
    identity.append(avatarNode(self.name, 'weibo-header-avatar'), node('span', '', self.name));
    header.append(brand, identity);

    const nav = node('nav', 'weibo-nav');
    for (const [mode, label] of [['home', '首页'], ['hot', '热搜'], ['discover', '发现'], ['me', '我']]) {
      const item = actionButton(label, `weibo-nav-item${timelineMode === mode ? ' is-active' : ''}`, () => {
        timelineMode = mode;
        query = '';
        refresh();
      });
      nav.append(item);
    }
    header.append(nav);
    return header;
  };

  const buildHomePage = () => {
    const page = node('div', 'weibo-page');
    const toolbar = node('div', 'weibo-toolbar');
    const heading = node('div', 'weibo-page-heading');
    heading.append(node('h2', '', '首页'), node('small', '', data.generatedAt ? `上次更新 ${formatDate(data.generatedAt)}` : '还没有统一生成的信息流'));
    const actions = node('div', 'weibo-toolbar-actions');
    const refreshButton = actionButton('刷新信息流', 'weibo-button weibo-button-orange', () => void generateFeed(refreshButton));
    refreshButton.disabled = generating;
    actions.append(actionButton('发布微博', 'weibo-button weibo-button-primary', () => void composePost()), refreshButton);
    toolbar.append(heading, actions);
    page.append(toolbar);

    const subnav = node('div', 'weibo-timeline-tabs');
    const recommended = actionButton('为你推荐', `weibo-timeline-tab${timelineMode === 'home' && query === '' ? ' is-active' : ''}`, () => {
      query = '';
      refresh();
    });
    const following = actionButton('关注', 'weibo-timeline-tab', () => {
      query = 'following';
      refresh();
    });
    subnav.append(recommended, following);
    page.append(subnav);

    const search = buildSearchInput('搜索微博内容', (value) => {
      query = value;
      const feed = page.querySelector('.weibo-feed');
      if (feed) feed.replaceWith(buildFeed(query === 'following' ? selectFollowingPosts() : selectPosts(query)));
    });
    page.append(search);
    const posts = query === 'following' ? selectFollowingPosts() : selectPosts(query);
    page.append(buildFeed(posts));
    return page;
  };

  const buildHotPage = () => {
    const page = node('div', 'weibo-page');
    page.append(pageTitle('微博热搜', '实时热点与剧情相关话题'));
    page.append(buildSearchInput('搜索热搜', (value) => {
      query = value;
      const list = page.querySelector('.weibo-hot-list');
      if (list) list.replaceWith(buildHotList());
    }));
    page.append(buildHotList());
    return page;
  };

  const buildHotList = () => {
    const list = node('div', 'weibo-hot-list');
    const hotSearches = data.hotSearches.filter((item) => !query || `${item.title} ${item.heat}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    if (hotSearches.length === 0) list.append(emptyState('暂时没有热搜', '点击首页的“刷新信息流”生成当前世界的公开热点。'));
    for (const [index, item] of hotSearches.entries()) {
      const row = node('article', 'weibo-hot-row');
      row.append(node('strong', `weibo-hot-rank${index < 3 ? ' is-top' : ''}`, String(index + 1)));
      const copy = node('div', 'weibo-hot-copy');
      copy.append(node('strong', '', item.title), node('small', '', `${item.heat} 热度`));
      row.append(copy, actionButton('查看相关', 'weibo-link-button', () => {
        timelineMode = 'home';
        query = item.title;
        refresh();
      }));
      list.append(row);
    }
    return list;
  };

  const buildDiscoverPage = () => {
    const page = node('div', 'weibo-page');
    page.append(pageTitle('发现', '看看当前世界正在讨论什么'));
    const notices = node('div', 'weibo-discover-card');
    notices.append(node('div', 'weibo-discover-icon', '#'), node('div', '', '微博通知'));
    notices.addEventListener('click', () => {
      const list = data.notifications.length ? data.notifications : [];
      if (list.length === 0) apiRef.notify('暂时没有新的微博通知。', 'info');
      else apiRef.notify(`你有 ${list.length} 条微博通知。`, 'info');
    });
    page.append(notices);
    const notificationTitle = node('h3', 'weibo-section-title', '互动通知');
    page.append(notificationTitle);
    const notifications = node('div', 'weibo-notification-list');
    if (data.notifications.length === 0) notifications.append(emptyState('还没有通知', '统一生成或互动后，通知会显示在这里。'));
    for (const item of data.notifications.slice(0, 20)) {
      const row = node('article', 'weibo-notification-row');
      row.append(avatarNode(item.actorName, 'weibo-notification-avatar'));
      const copy = node('div', 'weibo-notification-copy');
      copy.append(node('strong', '', item.actorName), node('span', '', ` ${item.action}`), node('p', '', item.content || ''));
      row.append(copy);
      notifications.append(row);
    }
    page.append(notifications);
    return page;
  };

  const buildMePage = () => {
    const page = node('div', 'weibo-page');
    const self = getSelfProfile();
    const posts = data.posts.filter((post) => post.isUser);
    const profile = node('section', 'weibo-profile-card');
    const cover = node('div', 'weibo-profile-cover');
    const profileMain = node('div', 'weibo-profile-main');
    profileMain.append(avatarNode(self.name, 'weibo-profile-avatar'), node('div', '', self.name));
    profile.append(cover, profileMain);
    const stats = node('div', 'weibo-profile-stats');
    stats.append(stat('微博', posts.length), stat('关注', data.following.length), stat('粉丝', 0));
    profile.append(stats);
    page.append(profile);
    const actions = node('div', 'weibo-toolbar-actions weibo-me-actions');
    actions.append(actionButton('发布微博', 'weibo-button weibo-button-primary', () => void composePost()));
    page.append(actions, node('h3', 'weibo-section-title', '我的微博'));
    page.append(buildFeed(posts));
    return page;
  };

  const buildFeed = (posts) => {
    const feed = node('div', 'weibo-feed');
    if (posts.length === 0) {
      feed.append(emptyState('这里还没有微博', '发布一条微博，或在首页刷新统一生成信息流。'));
      return feed;
    }
    for (const post of posts) feed.append(buildPostCard(post));
    return feed;
  };

  const buildPostCard = (post) => {
    const card = node('article', 'weibo-post-card');
    const top = node('div', 'weibo-post-top');
    const author = node('div', 'weibo-post-author');
    author.append(avatarNode(post.authorName, 'weibo-post-avatar'));
    const authorCopy = node('div', 'weibo-post-author-copy');
    const nameLine = node('div', 'weibo-name-line');
    nameLine.append(node('strong', '', post.authorName));
    if (post.verified) nameLine.append(node('span', 'weibo-verified', 'V'));
    nameLine.append(node('small', '', post.handle));
    authorCopy.append(nameLine, node('time', '', `${post.timeLabel} · 公开`));
    author.append(authorCopy);
    top.append(author);
    if (!post.isUser) top.append(actionButton(data.following.includes(post.handle) ? '已关注' : '关注', `weibo-follow-button${data.following.includes(post.handle) ? ' is-following' : ''}`, () => toggleFollow(post.handle)));
    card.append(top);
    const content = node('p', 'weibo-post-content', post.content);
    card.append(content);
    if (post.tags.length) {
      const tags = node('div', 'weibo-post-tags');
      for (const tag of post.tags) tags.append(actionButton(`#${tag}`, 'weibo-tag', () => {
        timelineMode = 'home';
        query = tag;
        refresh();
      }));
      card.append(tags);
    }
    const stats = node('div', 'weibo-post-stats');
    stats.append(
      actionButton(`转发 ${post.reposts}`, 'weibo-post-action', () => void repostPost(post.id)),
      actionButton(`评论 ${post.comments}`, 'weibo-post-action', () => void commentPost(post.id)),
      actionButton(`${post.liked ? '已赞' : '赞'} ${post.likes}`, `weibo-post-action${post.liked ? ' is-liked' : ''}`, () => toggleLike(post.id)),
    );
    card.append(stats);
    return card;
  };

  return {
    manifest: api.module.manifest,
    render,
    dispose() {
      disposed = true;
      activePage = null;
    },
  };

  function selectPosts(keyword) {
    const normalized = keyword.trim().toLocaleLowerCase('zh-CN');
    return data.posts
      .filter((post) => !normalized || [post.authorName, post.handle, post.content, ...post.tags].join('\n').toLocaleLowerCase('zh-CN').includes(normalized))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  function selectFollowingPosts() {
    return data.posts
      .filter((post) => post.isUser || data.following.includes(post.handle))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  function buildGenerationUserPrompt() {
    const snapshot = safeSnapshot();
    const people = Object.values(snapshot?.profiles ?? {}).slice(0, 20).map((profile) => ({
      name: profile.displayName,
      character: profile.boundCharacter ?? '',
      personality: String(profile.personality ?? '').slice(0, 120),
      weiboName: profile.twitterName ?? '',
      handle: profile.aliases?.twitter ?? '',
    }));
    const existing = data.posts.slice(0, 12).map((post) => ({
      author: post.authorName,
      handle: post.handle,
      content: post.content,
      tags: post.tags,
    }));
    return [
      '请刷新微博公开信息流。',
      `当前微博用户：${getSelfProfile().name}（${getSelfProfile().handle}）`,
      `可参考的角色和联系人：${JSON.stringify(people).slice(0, 5_000)}`,
      `已有微博（避免重复）：${JSON.stringify(existing).slice(0, 5_000)}`,
      '请生成角色公开动态、合理的热搜话题和少量通知；如果没有足够依据，宁可生成较少内容，也不要凭空推进主线剧情。',
    ].join('\n');
  }

  function safeSnapshot() {
    try {
      return apiRef.state.snapshot();
    } catch {
      return null;
    }
  }

  function getSelfProfile() {
    const self = safeSnapshot()?.profiles?.['profile:self'];
    const name = self?.displayName?.trim() || '微博用户';
    return { name, handle: self?.aliases?.twitter?.trim() || `@${name}` };
  }

  function buildSearchInput(placeholder, onInput) {
    const wrapper = node('label', 'weibo-search');
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = placeholder;
    input.value = query === 'following' ? '' : query;
    input.addEventListener('input', () => onInput(input.value));
    wrapper.append(node('span', '', '⌕'), input);
    return wrapper;
  }

  function pageTitle(title, subtitle) {
    const heading = node('div', 'weibo-page-heading');
    heading.append(node('h2', '', title), node('small', '', subtitle));
    return heading;
  }

  function stat(label, value) {
    const item = node('div', 'weibo-profile-stat');
    item.append(node('strong', '', String(value)), node('small', '', label));
    return item;
  }

  function createPostBase() {
    return {
      id: createId('post'),
      timeLabel: '刚刚',
      likes: 0,
      comments: 0,
      reposts: 0,
      liked: false,
      createdAt: Date.now(),
    };
  }
}

function emptyData() {
  return {
    version: DATA_VERSION,
    posts: [],
    hotSearches: [],
    notifications: [],
    following: [],
    generatedAt: 0,
  };
}

function normalizeData(value) {
  if (!isRecord(value)) return emptyData();
  return {
    version: DATA_VERSION,
    posts: Array.isArray(value.posts) ? value.posts.map(normalizePost).filter(Boolean).slice(0, MAX_POSTS) : [],
    hotSearches: Array.isArray(value.hotSearches) ? value.hotSearches.map(normalizeHotSearch).filter(Boolean).slice(0, MAX_HOT_SEARCHES) : [],
    notifications: Array.isArray(value.notifications) ? value.notifications.map(normalizeNotification).filter(Boolean).slice(0, MAX_NOTIFICATIONS) : [],
    following: Array.isArray(value.following) ? [...new Set(value.following.map((item) => String(item).trim()).filter(Boolean))].slice(0, 100) : [],
    generatedAt: finiteTime(value.generatedAt, 0),
  };
}

function normalizePost(value) {
  if (!isRecord(value)) return null;
  const content = String(value.content ?? '').trim().slice(0, MAX_POST_LENGTH);
  const authorName = String(value.authorName ?? '').trim().slice(0, 40);
  if (!content || !authorName) return null;
  return {
    id: String(value.id ?? createId('post')),
    authorName,
    handle: normalizeHandle(value.handle, authorName),
    verified: value.verified === true,
    content,
    timeLabel: String(value.timeLabel ?? '刚刚').trim().slice(0, 32) || '刚刚',
    tags: parseTags(Array.isArray(value.tags) ? value.tags.join(',') : value.tags),
    likes: nonNegativeInt(value.likes),
    comments: nonNegativeInt(value.comments),
    reposts: nonNegativeInt(value.reposts),
    liked: value.liked === true,
    isUser: value.isUser === true,
    source: value.source === 'user' ? 'user' : 'generated',
    repostOf: value.repostOf ? String(value.repostOf) : undefined,
    createdAt: finiteTime(value.createdAt, Date.now()),
  };
}

function normalizeGeneratedPost(value) {
  return normalizePost({ ...value, id: createId('generated'), source: 'generated', isUser: false });
}

function normalizeHotSearch(value) {
  if (!isRecord(value)) return null;
  const title = String(value.title ?? '').trim().slice(0, 80);
  if (!title) return null;
  return { title, heat: String(value.heat ?? '新') .trim().slice(0, 20) || '新' };
}

function normalizeNotification(value) {
  if (!isRecord(value)) return null;
  const actorName = String(value.actorName ?? '').trim().slice(0, 40);
  const action = String(value.action ?? '').trim().slice(0, 80);
  if (!actorName || !action) return null;
  return { actorName, action, content: String(value.content ?? '').trim().slice(0, 180) };
}

function prependNotification(notifications, notification) {
  return [notification, ...notifications].slice(0, MAX_NOTIFICATIONS);
}

function mergeData(local, stored) {
  const localIds = new Set(local.posts.map((post) => post.id));
  return {
    ...stored,
    ...local,
    posts: [...local.posts, ...stored.posts.filter((post) => !localIds.has(post.id))].slice(0, MAX_POSTS),
    notifications: [...local.notifications, ...stored.notifications].slice(0, MAX_NOTIFICATIONS),
    hotSearches: local.hotSearches.length ? local.hotSearches : stored.hotSearches,
    following: [...new Set([...local.following, ...stored.following])].slice(0, 100),
  };
}

function parseTags(value) {
  return [...new Set(String(value ?? '').split(/[,，#]/).map((tag) => tag.trim()).filter(Boolean))]
    .slice(0, MAX_TAGS)
    .map((tag) => tag.slice(0, MAX_TAG_LENGTH));
}

function normalizeHandle(value, fallback) {
  const handle = String(value ?? '').trim();
  return (handle.startsWith('@') ? handle : `@${handle || fallback}`).slice(0, 40);
}

function isWeiboResponse(value) {
  if (!isRecord(value) || !Array.isArray(value.posts) || !Array.isArray(value.hotSearches) || !Array.isArray(value.notifications)) return false;
  return value.posts.length <= 8 && value.hotSearches.length <= 8 && value.notifications.length <= 6
    && value.posts.every((post) => isRecord(post) && typeof post.authorName === 'string' && typeof post.handle === 'string' && typeof post.content === 'string' && post.content.trim().length > 0)
    && value.hotSearches.every((item) => isRecord(item) && typeof item.title === 'string' && typeof item.heat === 'string')
    && value.notifications.every((item) => isRecord(item) && typeof item.actorName === 'string' && typeof item.action === 'string');
}

function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(9_999_999, Math.floor(number))) : 0;
}

function finiteTime(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function avatarNode(name, className) {
  const avatar = node('span', className, name.trim().slice(0, 1) || '微');
  avatar.setAttribute('aria-hidden', 'true');
  return avatar;
}

function emptyState(title, subtitle) {
  const empty = node('div', 'weibo-empty');
  empty.append(node('strong', '', title), node('span', '', subtitle));
  return empty;
}

function styleNode() {
  const style = document.createElement('style');
  style.textContent = `
    .weibo-module { --weibo-orange: #ff8200; --weibo-red: #f04f4f; --weibo-ink: var(--phone-text-primary, #262626); --weibo-muted: var(--phone-text-secondary, #8b8b8b); display: grid; gap: 0; min-height: 100%; color: var(--weibo-ink); background: var(--phone-canvas, #f5f5f5); }
    .weibo-header { position: sticky; top: 0; z-index: 2; display: grid; gap: 10px; padding: 13px 14px 0; border-bottom: 1px solid color-mix(in srgb, var(--weibo-muted) 16%, transparent); background: color-mix(in srgb, var(--phone-card, #fff) 94%, transparent); backdrop-filter: blur(12px); }
    .weibo-brand, .weibo-header-identity, .weibo-nav, .weibo-toolbar, .weibo-toolbar-actions, .weibo-timeline-tabs, .weibo-post-top, .weibo-post-author, .weibo-name-line, .weibo-post-stats, .weibo-hot-row, .weibo-discover-card, .weibo-profile-main, .weibo-profile-stats, .weibo-notification-row { display: flex; align-items: center; }
    .weibo-brand { gap: 8px; font-size: 19px; font-weight: 800; }
    .weibo-brand small { color: var(--weibo-muted); font-size: 10px; font-weight: 500; }
    .weibo-logo { display: grid; width: 27px; height: 27px; place-items: center; border-radius: 50%; background: var(--weibo-orange); color: white; font-size: 15px; font-weight: 900; }
    .weibo-header-identity { justify-self: end; gap: 6px; color: var(--weibo-muted); font-size: 11px; }
    .weibo-header-avatar, .weibo-notification-avatar { width: 25px; height: 25px; }
    .weibo-nav { gap: 22px; margin-top: 2px; overflow-x: auto; }
    .weibo-nav-item, .weibo-timeline-tab { position: relative; padding: 8px 1px 10px; border: 0; background: none; color: var(--weibo-muted); cursor: pointer; font: inherit; font-size: 13px; }
    .weibo-nav-item.is-active, .weibo-timeline-tab.is-active { color: var(--weibo-ink); font-weight: 800; }
    .weibo-nav-item.is-active::after, .weibo-timeline-tab.is-active::after { position: absolute; right: 3px; bottom: 0; left: 3px; height: 3px; border-radius: 3px; background: var(--weibo-orange); content: ''; }
    .weibo-page { display: grid; gap: 12px; padding: 14px 12px 24px; }
    .weibo-toolbar { justify-content: space-between; align-items: flex-start; gap: 10px; }
    .weibo-page-heading { min-width: 0; }
    .weibo-page-heading h2 { margin: 0; font-size: 21px; }
    .weibo-page-heading small { display: block; margin-top: 4px; color: var(--weibo-muted); font-size: 10px; }
    .weibo-toolbar-actions { justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
    .weibo-button { min-height: 32px; padding: 7px 10px; border: 0; border-radius: 8px; cursor: pointer; font: inherit; font-size: 11px; font-weight: 700; }
    .weibo-button:disabled { cursor: wait; opacity: .55; }
    .weibo-button-primary { background: var(--weibo-orange); color: white; }
    .weibo-button-orange { border: 1px solid color-mix(in srgb, var(--weibo-orange) 35%, transparent); background: color-mix(in srgb, var(--weibo-orange) 10%, transparent); color: var(--weibo-orange); }
    .weibo-search { display: flex; align-items: center; gap: 7px; min-height: 35px; padding: 0 10px; border-radius: 18px; background: color-mix(in srgb, var(--weibo-muted) 11%, transparent); color: var(--weibo-muted); }
    .weibo-search input { width: 100%; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; }
    .weibo-timeline-tabs { gap: 20px; border-bottom: 1px solid color-mix(in srgb, var(--weibo-muted) 13%, transparent); }
    .weibo-feed { display: grid; gap: 9px; }
    .weibo-post-card { display: grid; gap: 9px; padding: 13px; border-radius: 12px; background: var(--phone-card, #fff); box-shadow: 0 1px 5px color-mix(in srgb, #000 5%, transparent); }
    .weibo-post-top { justify-content: space-between; align-items: flex-start; gap: 8px; }
    .weibo-post-author { min-width: 0; align-items: flex-start; gap: 8px; }
    .weibo-post-author-copy { min-width: 0; }
    .weibo-name-line { gap: 5px; min-width: 0; flex-wrap: wrap; }
    .weibo-name-line strong { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .weibo-name-line small { color: var(--weibo-muted); font-size: 10px; }
    .weibo-post-author-copy time { display: block; margin-top: 3px; color: var(--weibo-muted); font-size: 10px; }
    .weibo-post-avatar, .weibo-profile-avatar { width: 38px; height: 38px; }
    .weibo-post-avatar, .weibo-profile-avatar, .weibo-header-avatar, .weibo-notification-avatar { display: grid; flex: 0 0 auto; place-items: center; border-radius: 50%; background: linear-gradient(135deg, #ffad66, #ee5b62); color: white; font-weight: 800; }
    .weibo-profile-avatar { width: 58px; height: 58px; border: 3px solid white; box-shadow: 0 2px 8px #0002; }
    .weibo-verified { display: inline-grid; width: 14px; height: 14px; place-items: center; border-radius: 50%; background: #ffb400; color: white; font-size: 8px; }
    .weibo-follow-button { padding: 4px 9px; border: 1px solid var(--weibo-orange); border-radius: 12px; background: transparent; color: var(--weibo-orange); cursor: pointer; font: inherit; font-size: 10px; }
    .weibo-follow-button.is-following { border-color: var(--weibo-muted); color: var(--weibo-muted); }
    .weibo-post-content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.65; }
    .weibo-post-tags { display: flex; gap: 5px; flex-wrap: wrap; }
    .weibo-tag { padding: 0; border: 0; background: none; color: #4d83c3; cursor: pointer; font: inherit; font-size: 11px; }
    .weibo-post-stats { justify-content: space-around; padding-top: 5px; border-top: 1px solid color-mix(in srgb, var(--weibo-muted) 12%, transparent); }
    .weibo-post-action, .weibo-link-button { border: 0; background: none; color: var(--weibo-muted); cursor: pointer; font: inherit; font-size: 10px; }
    .weibo-post-action.is-liked { color: var(--weibo-red); }
    .weibo-hot-list, .weibo-notification-list { display: grid; gap: 1px; overflow: hidden; border-radius: 12px; background: color-mix(in srgb, var(--weibo-muted) 12%, transparent); }
    .weibo-hot-row { gap: 12px; min-height: 52px; padding: 0 12px; background: var(--phone-card, #fff); }
    .weibo-hot-rank { width: 18px; color: var(--weibo-muted); text-align: center; font-size: 13px; }
    .weibo-hot-rank.is-top { color: var(--weibo-red); }
    .weibo-hot-copy { display: grid; flex: 1; gap: 3px; min-width: 0; }
    .weibo-hot-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .weibo-hot-copy small { color: var(--weibo-muted); font-size: 10px; }
    .weibo-discover-card { gap: 10px; padding: 14px; border-radius: 12px; background: linear-gradient(110deg, #ff9239, #ff5d67); color: white; cursor: pointer; font-weight: 800; }
    .weibo-discover-icon { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: #fff4; font-size: 22px; }
    .weibo-section-title { margin: 3px 0 0; font-size: 15px; }
    .weibo-notification-row { gap: 9px; align-items: flex-start; padding: 12px; background: var(--phone-card, #fff); }
    .weibo-notification-copy { min-width: 0; font-size: 12px; line-height: 1.45; }
    .weibo-notification-copy strong { color: var(--weibo-orange); }
    .weibo-notification-copy p { margin: 4px 0 0; color: var(--weibo-muted); font-size: 11px; }
    .weibo-profile-card { overflow: hidden; border-radius: 13px; background: var(--phone-card, #fff); }
    .weibo-profile-cover { height: 74px; background: linear-gradient(120deg, #ffb16b, #f36a69 54%, #8a79d9); }
    .weibo-profile-main { gap: 10px; margin-top: -30px; padding: 0 14px; font-size: 16px; font-weight: 800; }
    .weibo-profile-stats { justify-content: space-around; margin-top: 12px; padding: 10px; border-top: 1px solid color-mix(in srgb, var(--weibo-muted) 12%, transparent); }
    .weibo-profile-stat { display: grid; justify-items: center; gap: 3px; }
    .weibo-profile-stat strong { font-size: 15px; }
    .weibo-profile-stat small { color: var(--weibo-muted); font-size: 10px; }
    .weibo-me-actions { justify-content: flex-start; }
    .weibo-empty, .weibo-loading { display: grid; justify-items: center; gap: 5px; padding: 34px 16px; border: 1px dashed color-mix(in srgb, var(--weibo-muted) 28%, transparent); border-radius: 12px; color: var(--weibo-muted); text-align: center; }
    .weibo-empty strong { color: var(--weibo-ink); }
    @media (max-width: 420px) { .weibo-toolbar { align-items: stretch; flex-direction: column; } .weibo-toolbar-actions { justify-content: flex-start; } .weibo-brand small { display: none; } }
  `;
  return style;
}
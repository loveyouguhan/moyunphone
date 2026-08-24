export const manifest = {
  protocolVersion: 1,
  id: 'hello-phone',
  name: '你好手机',
  version: '1.0.0',
  author: '你的名字',
  description: '最小可运行模块：读取当前手机状态。',
  entry: 'self',
};

export default function createModule(api) {
  const root = document.createElement('section');
  const title = document.createElement('strong');
  const output = document.createElement('p');
  const refresh = document.createElement('button');
  title.textContent = '你好，' + api.module.manifest.name;
  refresh.type = 'button';
  refresh.className = 'phone-button phone-button-primary';
  refresh.textContent = '读取当前状态';
  refresh.addEventListener('click', () => {
    const state = api.state.snapshot();
    output.textContent = '作用域 ' + api.state.scopeId
      + ' · 联系人 ' + Object.keys(state.profiles).length
      + ' · 会话 ' + Object.keys(state.conversations).length
      + ' · 剧情时间 ' + api.time.format();
  });
  root.append(title, refresh, output);
  return { manifest, render: () => root };
}

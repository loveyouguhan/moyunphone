export const manifest = {
  protocolVersion: 1,
  id: 'wechat-avatar-kit',
  name: '微信头像助手',
  version: '1.0.0',
  author: '你的名字',
  description: '读取微信联系人，逐个查看与设置微信头像。',
  entry: 'self',
};

export default function createModule(api) {
  const root = document.createElement('section');
  const list = document.createElement('div');
  const notice = document.createElement('p');

  function draw() {
    list.replaceChildren();
    for (const profile of api.wechat.profiles()) {
      const row = document.createElement('div');
      const avatar = document.createElement('img');
      const name = document.createElement('span');
      const pick = document.createElement('button');
      avatar.width = 36;
      avatar.height = 36;
      avatar.alt = '';
      avatar.src = api.wechat.getAvatar(profile.id) || '';
      name.textContent = profile.displayName;
      pick.type = 'button';
      pick.className = 'phone-button phone-button-secondary';
      pick.textContent = '设置头像';
      pick.addEventListener('click', async () => {
        const values = await api.modal('设置微信头像', [
          { name: 'url', label: '头像地址（https 或 data:image/*，留空清除）' },
        ]);
        if (!values) return;
        try {
          await api.wechat.setAvatar(profile.id, values.url);
          notice.textContent = '已更新 ' + profile.displayName + ' 的微信头像。';
          draw();
        } catch (error) {
          notice.textContent = '设置失败：' + (error instanceof Error ? error.message : String(error));
        }
      });
      row.append(avatar, name, pick);
      list.append(row);
    }
  }

  draw();
  root.append(list, notice);
  return { manifest, render: () => root };
}

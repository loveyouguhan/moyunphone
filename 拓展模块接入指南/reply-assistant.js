export const manifest = {
  protocolVersion: 1,
  id: 'reply-assistant',
  name: '回复助手',
  version: '1.0.0',
  author: '你的名字',
  description: '按最近若干条微信消息生成回复草稿，确认后再发送。',
  entry: 'self',
  api: { mode: 'shared' },
};

export default function createModule(api) {
  const root = document.createElement('section');
  const picker = document.createElement('select');
  const draft = document.createElement('textarea');
  const generate = document.createElement('button');
  const send = document.createElement('button');
  const notice = document.createElement('p');

  for (const conversation of api.wechat.conversations()) {
    const option = document.createElement('option');
    option.value = conversation.id;
    option.textContent = conversation.title;
    picker.append(option);
  }
  generate.type = 'button';
  generate.className = 'phone-button phone-button-primary';
  generate.textContent = '生成草稿';
  send.type = 'button';
  send.className = 'phone-button phone-button-secondary';
  send.textContent = '发送到会话';

  generate.addEventListener('click', async () => {
    notice.textContent = '正在生成…';
    try {
      const messages = api.wechat.messages(picker.value, 20).map((message) => ({
        role: message.direction === 'outgoing' ? 'user' : 'assistant',
        content: message.content,
      }));
      draft.value = await api.generation.reply({ messages, waitFor: 20 });
      notice.textContent = '草稿已生成，可编辑后发送。';
    } catch (error) {
      notice.textContent = '生成失败：' + (error instanceof Error ? error.message : String(error));
    }
  });

  send.addEventListener('click', async () => {
    try {
      await api.wechat.send(picker.value, draft.value.trim());
      draft.value = '';
      notice.textContent = '已发送，并加入统一回复队列。';
    } catch (error) {
      notice.textContent = '发送失败：' + (error instanceof Error ? error.message : String(error));
    }
  });

  root.append(picker, generate, draft, send, notice);
  return { manifest, render: () => root };
}

export const manifest = {
  protocolVersion: 1,
  id: 'delivery-tracker',
  name: '快递追踪',
  version: '1.0.0',
  author: '你的名字',
  description: '正文出现快递状态时自动记录，并注入模型上下文。',
  entry: 'self',
  generationContext: { includeStorage: true },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['courier', 'status'],
  properties: {
    courier: { type: 'string', minLength: 1, maxLength: 40 },
    status: { type: 'string', minLength: 1, maxLength: 80 },
    note: { type: 'string', maxLength: 200 },
  },
};

export default function createModule(api) {
  const root = document.createElement('section');
  const list = document.createElement('ul');

  async function draw() {
    const records = (await api.storage.get('records')) || [];
    list.replaceChildren();
    for (const record of records) {
      const item = document.createElement('li');
      item.textContent = record.courier + ' · ' + record.status
        + (record.note ? ' · ' + record.note : '');
      list.append(item);
    }
  }

  void draw();
  root.append(list);

  return {
    manifest,
    render: () => root,
    autoParse: {
      description: '正文明确写出快递公司和最新状态时提取一条记录。',
      prompt: '只提取正文已经发生的快递状态变化，不要预测后续配送。',
      schema: SCHEMA,
      validate: (value) => typeof value.status === 'string' && value.status.length > 0,
      apply: async (value, context) => {
        const records = (await api.storage.get('records')) || [];
        const floor = context.sourceFloors.length > 0
          ? context.sourceFloors[context.sourceFloors.length - 1]
          : 0;
        await api.storage.set('records', records.concat([{
          courier: value.courier,
          status: value.status,
          note: value.note || '',
          floor,
        }]));
        api.notify('已记录一条快递状态。', 'success');
        await draw();
      },
    },
  };
}

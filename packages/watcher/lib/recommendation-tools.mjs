const LABELS = { pending: '待听', listened: '已听过', skipped: '已跳过' };

/** 供宿主与 MCP 共用的工具定义；hub 只需提供 get/post 方法。 */
export function createRecommendationTools(hub, inboxUrl) {
  return [
    {
      name: 'music_recommendations',
      description:
        '查看推荐收件箱，了解哪些歌还没听、哪些已经听过、哪些被主人跳过及反馈。推歌前先看，避免反复推荐已跳过的歌。只读；默认查待听。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'listened', 'skipped', 'all'],
            description: '默认 pending',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: '默认 20',
          },
          query: {
            type: 'string',
            description: '按歌名、歌手、推荐理由或反馈搜索',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args = {}) {
        const status = args.status || 'pending';
        if (![...Object.keys(LABELS), 'all'].includes(status))
          throw new Error('无效的推荐状态');
        const limit = Math.min(
          Math.max(Math.trunc(Number(args.limit) || 20), 1),
          100,
        );
        const params = new URLSearchParams({
          status,
          limit: String(limit),
          order: 'newest',
        });
        if (args.query) params.set('q', String(args.query));
        const { items, total } = await hub.get(`/v1/recommendations?${params}`);
        const lines = [`推荐收件箱：${inboxUrl}`];
        if (!items.length)
          return [...lines, '这个筛选条件下还没有推荐。'].join('\n');
        lines.push(`共 ${total} 首，显示 ${items.length} 首：`);
        for (const item of items) {
          lines.push(
            `- [${LABELS[item.status] || item.status}] 《${item.title}》— ${item.artist || '未知歌手'}（推荐 ID：${item.id}）`,
          );
          if (item.reason) lines.push(`  推荐理由：${item.reason}`);
          if (item.feedback) lines.push(`  主人反馈：${item.feedback}`);
          if (item.songUrl) lines.push(`  歌曲页：${item.songUrl}`);
        }
        return lines.join('\n');
      },
    },
    {
      name: 'music_recommendation_feedback',
      description:
        '按推荐 ID 更新推荐收件箱的状态和反馈。仅在主人明确表示听过、不感兴趣或想重新加入待听时使用；不能把打开链接或自己的猜测当成听过。不会自动修改 music_taste。',
      parameters: {
        type: 'object',
        properties: {
          recommendationId: {
            type: 'string',
            description: 'music_recommendations 返回的推荐 ID，不是歌曲 ID',
          },
          status: { type: 'string', enum: ['pending', 'listened', 'skipped'] },
          note: {
            type: 'string',
            maxLength: 500,
            description: '主人原话或简短反馈，可选；空字符串清除反馈',
          },
        },
        required: ['recommendationId', 'status'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args = {}) {
        if (!args.recommendationId || !Object.hasOwn(LABELS, args.status))
          throw new Error('请提供推荐 ID 和有效状态');
        const { item } = await hub.post(
          `/v1/recommendations/${encodeURIComponent(args.recommendationId)}/feedback`,
          {
            status: args.status,
            ...(args.note !== undefined ? { note: args.note } : {}),
          },
        );
        return `已将《${item.title}》标为${LABELS[item.status]}。${item.feedback ? `反馈：${item.feedback}` : ''}`;
      },
    },
  ];
}

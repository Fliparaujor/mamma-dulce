// Buffer falso para testes. Responde às mesmas operações GraphQL que o app usa, com o
// comportamento documentado: limite de 10 posts agendados por canal (LimitReachedError),
// erros tipados em `data`, erros de sistema em `errors`, 429 com Retry-After e cabeçalhos RateLimit.
// NÃO é integração real: serve para exercitar o cliente HTTP e o agendador sem credenciais.

export interface FakePost {
  id: string;
  channelId: string;
  text: string;
  status: 'scheduled' | 'sending' | 'sent' | 'error' | 'draft' | 'needs_approval';
  dueAt: string;
  sentAt: string | null;
  createdAt: string;
  schedulingType: 'automatic' | 'notification';
  notificationStatus: 'notified' | 'markedAsPublished' | null;
  externalLink: string | null;
  via: 'api' | 'buffer';
  error: { message: string; supportUrl: string | null } | null;
  input: Record<string, unknown>;
}

export type FailureMode =
  | 'network' // falha antes de chegar ao Buffer
  | 'server500'
  | 'rate429'
  | 'lostResponse' // o Buffer aplica a mutation, mas a resposta se perde
  | 'unauthorized';

export const FAKE_CHANNELS = [
  { id: 'ch_ig', name: 'istoriasbrasileiras', displayName: 'Histórias Brasileiras', service: 'instagram', type: 'business' },
  { id: 'ch_tt', name: 'istoriasbrasileiras', displayName: 'Histórias Brasileiras', service: 'tiktok', type: 'business' },
  { id: 'ch_yt', name: 'Histórias Brasileiras', displayName: 'Histórias Brasileiras', service: 'youtube', type: 'channel' },
];

export class FakeBuffer {
  posts: FakePost[] = [];
  calls: { operation: string; variables: Record<string, unknown> }[] = [];
  queueLimit = 10;
  private failures: { mode: FailureMode; operation?: string }[] = [];
  private seq = 0;
  /** Tipo de agendamento que o falso devolve em createPost (simula canais configurados como lembrete). */
  schedulingTypeFor: Record<string, 'automatic' | 'notification'> = {};
  now: () => Date = () => new Date();

  failNext(mode: FailureMode, operation?: string): void {
    this.failures.push({ mode, operation });
  }

  callsOf(operation: string): number {
    return this.calls.filter((c) => c.operation === operation).length;
  }

  activeCount(channelId: string): number {
    return this.posts.filter((p) => p.channelId === channelId && ['scheduled', 'sending', 'needs_approval'].includes(p.status)).length;
  }

  addExternalPost(channelId: string, dueAt: string, status: FakePost['status'] = 'scheduled'): FakePost {
    const post = this.makePost(channelId, `Post criado fora do app ${++this.seq}`, dueAt, 'automatic', {});
    post.via = 'buffer';
    post.status = status;
    this.posts.push(post);
    return post;
  }

  /** Simula o Buffer publicando tudo que venceu até `until`. */
  publishDue(until: Date): FakePost[] {
    const sent: FakePost[] = [];
    for (const p of this.posts) {
      if (p.status === 'scheduled' && p.schedulingType === 'automatic' && new Date(p.dueAt) <= until) {
        p.status = 'sent';
        p.sentAt = p.dueAt;
        p.externalLink = `https://social.example.com/${p.id}`;
        sent.push(p);
      }
    }
    return sent;
  }

  private makePost(channelId: string, text: string, dueAt: string, schedulingType: 'automatic' | 'notification', input: Record<string, unknown>): FakePost {
    return {
      id: `post_${++this.seq}`,
      channelId,
      text,
      status: 'scheduled',
      dueAt,
      sentAt: null,
      createdAt: this.now().toISOString(),
      schedulingType,
      notificationStatus: null,
      externalLink: null,
      via: 'api',
      error: null,
      input,
    };
  }

  private headers(): Headers {
    const used = this.calls.length;
    return new Headers({
      'content-type': 'application/json',
      ratelimit: `"150-in-15min"; r=${Math.max(0, 150 - used)}; t=600, "600-in-1day"; r=${Math.max(0, 600 - used)}; t=80000, "3000-in-30days"; r=${Math.max(0, 3000 - used)}; t=2000000`,
      'ratelimit-policy': '"150-in-15min"; q=150; w=900, "600-in-1day"; q=600; w=86400, "3000-in-30days"; q=3000; w=2592000',
    });
  }

  private json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
    const headers = this.headers();
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return new Response(JSON.stringify(body), { status, headers });
  }

  private postNode(p: FakePost) {
    return {
      id: p.id,
      status: p.status,
      dueAt: p.dueAt,
      sentAt: p.sentAt,
      createdAt: p.createdAt,
      channelId: p.channelId,
      schedulingType: p.schedulingType,
      notificationStatus: p.notificationStatus,
      externalLink: p.externalLink,
      via: p.via,
      error: p.error,
    };
  }

  readonly fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const auth = new Headers(init?.headers).get('authorization');
    const body = JSON.parse(String(init?.body ?? '{}')) as { operationName: string; variables: Record<string, unknown> };
    const failureIdx = this.failures.findIndex((f) => !f.operation || f.operation === body.operationName);
    const failure = failureIdx >= 0 ? this.failures.splice(failureIdx, 1)[0] : undefined;

    if (failure?.mode === 'network') throw new TypeError('fetch failed (simulado)');
    this.calls.push({ operation: body.operationName, variables: body.variables });
    if (failure?.mode === 'rate429') {
      return this.json(
        { errors: [{ message: 'Too many requests from this client. Please try again later.', extensions: { code: 'RATE_LIMIT_EXCEEDED', window: '15m' } }] },
        429,
        { 'retry-after': '753' },
      );
    }
    if (failure?.mode === 'server500') return this.json({ message: 'boom' }, 500);
    if (failure?.mode === 'unauthorized' || auth !== 'Bearer chave-falsa-de-teste') {
      return this.json({ data: null, errors: [{ message: 'Not authorized', extensions: { code: 'UNAUTHORIZED' } }] });
    }

    const response = this.handle(body.operationName, body.variables);
    if (failure?.mode === 'lostResponse') throw new TypeError('conexão encerrada antes da resposta (simulado)');
    return response;
  };

  private handle(op: string, v: Record<string, unknown>): Response {
    switch (op) {
      case 'GetAccount':
        return this.json({
          data: {
            account: {
              id: 'acc_1',
              organizations: [{ id: 'org_1', name: 'Histórias', channelCount: 3, limits: { channels: 3, scheduledPosts: 10 } }],
            },
          },
        });
      case 'GetChannels':
        return this.json({
          data: {
            channels: FAKE_CHANNELS.map((c) => ({
              ...c,
              avatar: 'https://example.com/a.png',
              isQueuePaused: false,
              isLocked: false,
              isDisconnected: false,
              timezone: 'America/Belem',
              externalLink: null,
              metadata: { __typename: `${c.service}Metadata`, defaultToReminders: false },
            })),
          },
        });
      case 'GetPosts': {
        const filter = (v.filter ?? {}) as {
          channelIds?: string[];
          status?: string[];
          dueAt?: { start?: string; end?: string };
          createdAt?: { start?: string; end?: string };
        };
        let list = this.posts.filter(
          (p) =>
            (!filter.channelIds || filter.channelIds.includes(p.channelId)) &&
            (!filter.status || filter.status.includes(p.status)) &&
            (!filter.dueAt?.start || p.dueAt >= filter.dueAt.start) &&
            (!filter.dueAt?.end || p.dueAt <= filter.dueAt.end) &&
            (!filter.createdAt?.start || p.createdAt >= filter.createdAt.start),
        );
        list = list.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        const first = Number(v.first ?? 20);
        const start = v.after ? Number(v.after) : 0;
        const page = list.slice(start, start + first);
        const hasNextPage = start + first < list.length;
        return this.json({
          data: {
            posts: {
              edges: page.map((p) => ({ node: this.postNode(p) })),
              pageInfo: { hasNextPage, endCursor: hasNextPage ? String(start + first) : null },
            },
          },
        });
      }
      case 'GetPost': {
        const p = this.posts.find((x) => x.id === v.id);
        if (!p) return this.json({ data: null, errors: [{ message: 'Post not found', extensions: { code: 'NOT_FOUND' } }] });
        return this.json({ data: { post: this.postNode(p) } });
      }
      case 'CreatePost': {
        const input = v.input as Record<string, unknown>;
        const channelId = String(input.channelId);
        if (!FAKE_CHANNELS.some((c) => c.id === channelId)) {
          return this.json({ data: { createPost: { __typename: 'NotFoundError', message: 'Channel not found' } } });
        }
        if (input.mode !== 'customScheduled' || typeof input.dueAt !== 'string') {
          return this.json({ data: { createPost: { __typename: 'InvalidInputError', message: 'dueAt is required for customScheduled' } } });
        }
        const assets = input.assets as { video?: { url?: string } }[];
        if (!assets?.[0]?.video?.url?.startsWith('https://')) {
          return this.json({ data: { createPost: { __typename: 'InvalidInputError', message: 'Failed to fetch video: Not Found' } } });
        }
        const service = FAKE_CHANNELS.find((c) => c.id === channelId)!.service;
        const meta = (input.metadata ?? {}) as Record<string, Record<string, unknown>>;
        if (service === 'youtube' && (!meta.youtube?.title || !meta.youtube?.categoryId)) {
          return this.json({ data: { createPost: { __typename: 'InvalidInputError', message: 'YouTube title and categoryId are required' } } });
        }
        if (service === 'instagram' && meta.instagram?.type !== 'reel') {
          return this.json({ data: { createPost: { __typename: 'InvalidInputError', message: 'Instagram post type required' } } });
        }
        if (this.activeCount(channelId) >= this.queueLimit) {
          return this.json({
            data: { createPost: { __typename: 'LimitReachedError', message: 'You have reached the limit of scheduled posts for this channel.' } },
          });
        }
        const post = this.makePost(channelId, String(input.text ?? ''), input.dueAt, this.schedulingTypeFor[channelId] ?? 'automatic', input);
        this.posts.push(post);
        return this.json({ data: { createPost: { __typename: 'PostActionSuccess', post: this.postNode(post) } } });
      }
      case 'EditPost': {
        const input = v.input as { id: string; dueAt?: string; text?: string; assets?: unknown[] };
        const p = this.posts.find((x) => x.id === input.id);
        if (!p) return this.json({ data: { editPost: { __typename: 'NotFoundError', message: 'Post not found' } } });
        // Como o Buffer real: o editPost revalida o post inteiro.
        if (!input.text && !input.assets?.length) {
          return this.json({ data: { editPost: { __typename: 'InvalidInputError', message: 'Invalid post: Post must have either text or media.' } } });
        }
        if (p.status !== 'scheduled') return this.json({ data: { editPost: { __typename: 'InvalidInputError', message: 'Post cannot be edited' } } });
        if (input.dueAt) p.dueAt = input.dueAt;
        return this.json({ data: { editPost: { __typename: 'PostActionSuccess', post: this.postNode(p) } } });
      }
      case 'DeletePost': {
        const input = v.input as { id: string };
        const p = this.posts.find((x) => x.id === input.id);
        if (!p) return this.json({ data: null, errors: [{ message: 'Post not found', extensions: { code: 'NOT_FOUND' } }] });
        if (p.status === 'sent' || p.status === 'sending') {
          return this.json({ data: { deletePost: { __typename: 'VoidMutationError', message: 'Post is publishing or already published' } } });
        }
        this.posts = this.posts.filter((x) => x.id !== p.id);
        return this.json({ data: { deletePost: { __typename: 'DeletePostSuccess', id: p.id } } });
      }
      default:
        return this.json({ data: null, errors: [{ message: `Operação desconhecida ${op}`, extensions: { code: 'UNEXPECTED' } }] });
    }
  }
}

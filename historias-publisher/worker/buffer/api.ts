// Operações usadas pelo app, escritas a partir da referência oficial
// (https://developers.buffer.com/reference.html). Nenhum campo fora da referência.
import { BufferClient, BufferError } from './client';

export type BufferService = 'instagram' | 'tiktok' | 'youtube' | string;
export type BufferPostStatus = 'draft' | 'error' | 'needs_approval' | 'scheduled' | 'sending' | 'sent';

export interface BufferOrganization {
  id: string;
  name: string;
  channelCount: number;
  limits: { channels: number; scheduledPosts: number } | null;
}

export interface BufferChannel {
  id: string;
  name: string;
  displayName: string | null;
  service: BufferService;
  type: string;
  avatar: string;
  isQueuePaused: boolean;
  isLocked: boolean;
  isDisconnected: boolean;
  timezone: string;
  externalLink: string | null;
  metadata: { __typename?: string; defaultToReminders?: boolean } | null;
}

export interface BufferPost {
  id: string;
  status: BufferPostStatus;
  dueAt: string | null;
  sentAt: string | null;
  createdAt: string;
  channelId: string;
  schedulingType: 'automatic' | 'notification' | null;
  notificationStatus: 'notified' | 'markedAsPublished' | null;
  externalLink: string | null;
  via: string;
  error: { message: string; supportUrl: string | null } | null;
}

const POST_FIELDS = `
  id
  status
  dueAt
  sentAt
  createdAt
  channelId
  schedulingType
  notificationStatus
  externalLink
  via
  error { message supportUrl }
`;

export const Q_ACCOUNT = `
query GetAccount {
  account {
    id
    organizations {
      id
      name
      channelCount
      limits { channels scheduledPosts }
    }
  }
}`;

export const Q_CHANNELS = `
query GetChannels($organizationId: OrganizationId!) {
  channels(input: { organizationId: $organizationId }) {
    id
    name
    displayName
    service
    type
    avatar
    isQueuePaused
    isLocked
    isDisconnected
    timezone
    externalLink
    metadata {
      __typename
      ... on InstagramMetadata { defaultToReminders }
      ... on TiktokMetadata { defaultToReminders }
      ... on YoutubeMetadata { defaultToReminders }
    }
  }
}`;

export const Q_POSTS = `
query GetPosts($organizationId: OrganizationId!, $first: Int, $after: String, $filter: PostsFiltersInput) {
  posts(first: $first, after: $after, input: {
    organizationId: $organizationId
    filter: $filter
    sort: [{ field: dueAt, direction: asc }]
  }) {
    edges { node { ${POST_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export const Q_POST = `
query GetPost($id: PostId!) {
  post(input: { id: $id }) { ${POST_FIELDS} }
}`;

export const M_CREATE_POST = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { ${POST_FIELDS} } }
    ... on MutationError { message }
  }
}`;

export const M_EDIT_POST = `
mutation EditPost($input: EditPostInput!) {
  editPost(input: $input) {
    __typename
    ... on PostActionSuccess { post { ${POST_FIELDS} } }
    ... on MutationError { message }
  }
}`;

export const M_DELETE_POST = `
mutation DeletePost($input: DeletePostInput!) {
  deletePost(input: $input) {
    __typename
    ... on DeletePostSuccess { id }
    ... on MutationError { message }
  }
}`;

export interface PostsFilter {
  channelIds?: string[];
  status?: BufferPostStatus[];
  dueAt?: { start?: string; end?: string };
  createdAt?: { start?: string; end?: string };
}

export type MutationResult =
  | { ok: true; post: BufferPost }
  | { ok: false; typename: string; message: string; limitReached: boolean; invalidInput: boolean };

interface MutationPayload {
  __typename: string;
  post?: BufferPost;
  message?: string;
}

function toMutationResult(payload: MutationPayload | undefined): MutationResult {
  if (payload?.__typename === 'PostActionSuccess' && payload.post) return { ok: true, post: payload.post };
  const typename = payload?.__typename ?? 'Desconhecido';
  return {
    ok: false,
    typename,
    message: payload?.message ?? 'O Buffer recusou a operação sem mensagem.',
    limitReached: typename === 'LimitReachedError',
    invalidInput: typename === 'InvalidInputError',
  };
}

export interface CreatePostInput {
  channelId: string;
  text: string;
  schedulingType: 'automatic' | 'notification';
  mode: 'customScheduled';
  dueAt: string;
  assets: { video: { url: string; metadata?: { thumbnailOffset?: number; title?: string } } }[];
  metadata?: Record<string, unknown>;
}

/** O que o editPost precisa receber de novo: o Buffer revalida o post inteiro, mesmo só mudando o horário. */
export type EditPostContent = Pick<CreatePostInput, 'text' | 'assets' | 'metadata'>;

export class BufferApi {
  constructor(public readonly client: BufferClient) {}

  async organizations(): Promise<BufferOrganization[]> {
    const data = await this.client.request<{ account: { organizations: BufferOrganization[] } }>('GetAccount', Q_ACCOUNT, {}, true);
    return data.account.organizations;
  }

  async channels(organizationId: string): Promise<BufferChannel[]> {
    const data = await this.client.request<{ channels: BufferChannel[] }>('GetChannels', Q_CHANNELS, { organizationId }, true);
    return data.channels;
  }

  /** Lista posts paginando (50 por página, conforme recomendação da documentação). */
  async posts(organizationId: string, filter: PostsFilter, maxPages = 3): Promise<{ posts: BufferPost[]; complete: boolean }> {
    const out: BufferPost[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const data: {
        posts: { edges: { node: BufferPost }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await this.client.request('GetPosts', Q_POSTS, { organizationId, first: 50, after, filter }, true);
      for (const e of data.posts.edges) out.push(e.node);
      if (!data.posts.pageInfo.hasNextPage || !data.posts.pageInfo.endCursor) return { posts: out, complete: true };
      after = data.posts.pageInfo.endCursor;
    }
    return { posts: out, complete: false };
  }

  /** Busca um post; devolve null se o Buffer responder NOT_FOUND. */
  async post(id: string): Promise<BufferPost | null> {
    try {
      const data = await this.client.request<{ post: BufferPost }>('GetPost', Q_POST, { id }, true);
      return data.post;
    } catch (e) {
      if (e instanceof BufferError && e.kind === 'not_found') return null;
      throw e;
    }
  }

  async createPost(input: CreatePostInput): Promise<MutationResult> {
    const data = await this.client.request<{ createPost: MutationPayload }>('CreatePost', M_CREATE_POST, { input }, false);
    return toMutationResult(data.createPost);
  }

  async reschedulePost(id: string, dueAt: string, content?: EditPostContent): Promise<MutationResult> {
    const data = await this.client.request<{ editPost: MutationPayload }>(
      'EditPost',
      M_EDIT_POST,
      { input: { id, dueAt, mode: 'customScheduled', ...content } },
      false,
    );
    return toMutationResult(data.editPost);
  }

  async deletePost(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const data = await this.client.request<{ deletePost: { __typename: string; id?: string; message?: string } }>(
      'DeletePost',
      M_DELETE_POST,
      { input: { id } },
      false,
    );
    if (data.deletePost.__typename === 'DeletePostSuccess') return { ok: true };
    return { ok: false, message: data.deletePost.message ?? 'O Buffer não removeu o post.' };
  }
}

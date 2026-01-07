import { CliPublishRequestSchema, parseArk } from 'clawdhub-schema'
import { api, internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { ActionCtx } from './_generated/server'
import { httpAction } from './_generated/server'
import { requireApiTokenUser } from './lib/apiTokenAuth'
import { hashToken } from './lib/tokens'
import { publishVersionForUser } from './skills'

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMITS = {
  read: { ip: 120, key: 600 },
  write: { ip: 30, key: 120 },
} as const
const MAX_RAW_FILE_BYTES = 200 * 1024

type SearchSkillEntry = {
  score: number
  skill: {
    slug?: string
    displayName?: string
    summary?: string | null
    updatedAt?: number
  } | null
  version: { version?: string; createdAt?: number } | null
}

type ListSkillsResult = {
  items: Array<{
    skill: {
      _id: Id<'skills'>
      slug: string
      displayName: string
      summary?: string
      tags: Record<string, Id<'skillVersions'>>
      stats: unknown
      createdAt: number
      updatedAt: number
      latestVersionId?: Id<'skillVersions'>
    }
    latestVersion: { version: string; createdAt: number; changelog: string } | null
  }>
  nextCursor: string | null
}

type GetBySlugResult = {
  skill: {
    _id: Id<'skills'>
    slug: string
    displayName: string
    summary?: string
    tags: Record<string, Id<'skillVersions'>>
    stats: unknown
    createdAt: number
    updatedAt: number
  } | null
  latestVersion: Doc<'skillVersions'> | null
  owner: { handle?: string; displayName?: string; image?: string } | null
} | null

type ListVersionsResult = {
  items: Array<{
    version: string
    createdAt: number
    changelog: string
    changelogSource?: 'auto' | 'user'
    files: Array<{
      path: string
      size: number
      storageId: Id<'_storage'>
      sha256: string
      contentType?: string
    }>
    softDeletedAt?: number
  }>
  nextCursor: string | null
}

async function searchSkillsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'read')
  if (!rate.ok) return rate.response

  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() ?? ''
  const limit = toOptionalNumber(url.searchParams.get('limit'))
  const highlightedOnly = url.searchParams.get('highlightedOnly') === 'true'

  if (!query) return json({ results: [] }, 200, rate.headers)

  const results = (await ctx.runAction(api.search.searchSkills, {
    query,
    limit,
    highlightedOnly: highlightedOnly || undefined,
  })) as SearchSkillEntry[]

  return json(
    {
      results: results.map((result) => ({
        score: result.score,
        slug: result.skill?.slug,
        displayName: result.skill?.displayName,
        summary: result.skill?.summary ?? null,
        version: result.version?.version ?? null,
        updatedAt: result.skill?.updatedAt,
      })),
    },
    200,
    rate.headers,
  )
}

export const searchSkillsV1Http = httpAction(searchSkillsV1Handler)

async function resolveSkillVersionV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'read')
  if (!rate.ok) return rate.response

  const url = new URL(request.url)
  const slug = url.searchParams.get('slug')?.trim().toLowerCase()
  const hash = url.searchParams.get('hash')?.trim().toLowerCase()
  if (!slug || !hash) return text('Missing slug or hash', 400, rate.headers)
  if (!/^[a-f0-9]{64}$/.test(hash)) return text('Invalid hash', 400, rate.headers)

  const resolved = await ctx.runQuery(api.skills.resolveVersionByHash, { slug, hash })
  if (!resolved) return text('Skill not found', 404, rate.headers)

  return json(
    { slug, match: resolved.match, latestVersion: resolved.latestVersion },
    200,
    rate.headers,
  )
}

export const resolveSkillVersionV1Http = httpAction(resolveSkillVersionV1Handler)

async function listSkillsV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'read')
  if (!rate.ok) return rate.response

  const url = new URL(request.url)
  const limit = toOptionalNumber(url.searchParams.get('limit'))
  const cursor = url.searchParams.get('cursor')?.trim() || undefined

  const result = (await ctx.runQuery(api.skills.listPublicPage, {
    limit,
    cursor,
  })) as ListSkillsResult

  const items = await Promise.all(
    result.items.map(async (item) => {
      const tags = await resolveTags(ctx, item.skill.tags)
      return {
        slug: item.skill.slug,
        displayName: item.skill.displayName,
        summary: item.skill.summary ?? null,
        tags,
        stats: item.skill.stats,
        createdAt: item.skill.createdAt,
        updatedAt: item.skill.updatedAt,
        latestVersion: item.latestVersion
          ? {
              version: item.latestVersion.version,
              createdAt: item.latestVersion.createdAt,
              changelog: item.latestVersion.changelog,
            }
          : null,
      }
    }),
  )

  return json({ items, nextCursor: result.nextCursor ?? null }, 200, rate.headers)
}

export const listSkillsV1Http = httpAction(listSkillsV1Handler)

async function skillsGetRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'read')
  if (!rate.ok) return rate.response

  const segments = getPathSegments(request, '/api/v1/skills/')
  if (segments.length === 0) return text('Missing slug', 400, rate.headers)
  const slug = segments[0]?.trim().toLowerCase() ?? ''
  const second = segments[1]
  const third = segments[2]

  if (segments.length === 1) {
    const result = (await ctx.runQuery(api.skills.getBySlug, { slug })) as GetBySlugResult
    if (!result?.skill) return text('Skill not found', 404, rate.headers)

    const tags = await resolveTags(ctx, result.skill.tags)
    return json(
      {
        skill: {
          slug: result.skill.slug,
          displayName: result.skill.displayName,
          summary: result.skill.summary ?? null,
          tags,
          stats: result.skill.stats,
          createdAt: result.skill.createdAt,
          updatedAt: result.skill.updatedAt,
        },
        latestVersion: result.latestVersion
          ? {
              version: result.latestVersion.version,
              createdAt: result.latestVersion.createdAt,
              changelog: result.latestVersion.changelog,
            }
          : null,
        owner: result.owner
          ? {
              handle: result.owner.handle ?? null,
              displayName: result.owner.displayName ?? null,
              image: result.owner.image ?? null,
            }
          : null,
      },
      200,
      rate.headers,
    )
  }

  if (second === 'versions' && segments.length === 2) {
    const skill = await ctx.runQuery(internal.skills.getSkillBySlugInternal, { slug })
    if (!skill || skill.softDeletedAt) return text('Skill not found', 404, rate.headers)

    const url = new URL(request.url)
    const limit = toOptionalNumber(url.searchParams.get('limit'))
    const cursor = url.searchParams.get('cursor')?.trim() || undefined
    const result = (await ctx.runQuery(api.skills.listVersionsPage, {
      skillId: skill._id,
      limit,
      cursor,
    })) as ListVersionsResult

    const items = result.items
      .filter((version) => !version.softDeletedAt)
      .map((version) => ({
        version: version.version,
        createdAt: version.createdAt,
        changelog: version.changelog,
        changelogSource: version.changelogSource ?? null,
      }))

    return json({ items, nextCursor: result.nextCursor ?? null }, 200, rate.headers)
  }

  if (second === 'versions' && third && segments.length === 3) {
    const skill = await ctx.runQuery(internal.skills.getSkillBySlugInternal, { slug })
    if (!skill || skill.softDeletedAt) return text('Skill not found', 404, rate.headers)

    const version = await ctx.runQuery(api.skills.getVersionBySkillAndVersion, {
      skillId: skill._id,
      version: third,
    })
    if (!version) return text('Version not found', 404, rate.headers)
    if (version.softDeletedAt) return text('Version not available', 410, rate.headers)

    return json(
      {
        skill: { slug: skill.slug, displayName: skill.displayName },
        version: {
          version: version.version,
          createdAt: version.createdAt,
          changelog: version.changelog,
          changelogSource: version.changelogSource ?? null,
          files: version.files.map((file) => ({
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            contentType: file.contentType ?? null,
          })),
        },
      },
      200,
      rate.headers,
    )
  }

  if (second === 'file' && segments.length === 2) {
    const url = new URL(request.url)
    const path = url.searchParams.get('path')?.trim()
    if (!path) return text('Missing path', 400, rate.headers)
    const versionParam = url.searchParams.get('version')?.trim()
    const tagParam = url.searchParams.get('tag')?.trim()

    const skillResult = (await ctx.runQuery(api.skills.getBySlug, {
      slug,
    })) as GetBySlugResult
    if (!skillResult?.skill) return text('Skill not found', 404, rate.headers)

    let version = skillResult.latestVersion
    if (versionParam) {
      version = await ctx.runQuery(api.skills.getVersionBySkillAndVersion, {
        skillId: skillResult.skill._id,
        version: versionParam,
      })
    } else if (tagParam) {
      const versionId = skillResult.skill.tags[tagParam]
      if (versionId) {
        version = await ctx.runQuery(api.skills.getVersionById, { versionId })
      }
    }

    if (!version) return text('Version not found', 404, rate.headers)
    if (version.softDeletedAt) return text('Version not available', 410, rate.headers)

    const normalized = path.trim()
    const normalizedLower = normalized.toLowerCase()
    const file =
      version.files.find((entry) => entry.path === normalized) ??
      version.files.find((entry) => entry.path.toLowerCase() === normalizedLower)
    if (!file) return text('File not found', 404, rate.headers)
    if (file.size > MAX_RAW_FILE_BYTES) return text('File exceeds 200KB limit', 413, rate.headers)

    const blob = await ctx.storage.get(file.storageId)
    if (!blob) return text('File missing in storage', 410, rate.headers)
    const textContent = await blob.text()

    const headers = mergeHeaders(rate.headers, {
      'Content-Type': file.contentType
        ? `${file.contentType}; charset=utf-8`
        : 'text/plain; charset=utf-8',
      'Cache-Control': 'private, max-age=60',
      ETag: file.sha256,
      'X-Content-SHA256': file.sha256,
      'X-Content-Size': String(file.size),
    })
    return new Response(textContent, { status: 200, headers })
  }

  return text('Not found', 404, rate.headers)
}

export const skillsGetRouterV1Http = httpAction(skillsGetRouterV1Handler)

async function publishSkillV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'write')
  if (!rate.ok) return rate.response

  try {
    if (!parseBearerToken(request)) return text('Unauthorized', 401, rate.headers)
  } catch {
    return text('Unauthorized', 401, rate.headers)
  }
  const { userId } = await requireApiTokenUser(ctx, request)

  const contentType = request.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      const body = await request.json()
      const payload = parsePublishBody(body)
      const result = await publishVersionForUser(ctx, userId, payload)
      return json({ ok: true, ...result }, 200, rate.headers)
    }

    if (contentType.includes('multipart/form-data')) {
      const payload = await parseMultipartPublish(ctx, request)
      const result = await publishVersionForUser(ctx, userId, payload)
      return json({ ok: true, ...result }, 200, rate.headers)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publish failed'
    return text(message, 400, rate.headers)
  }

  return text('Unsupported content type', 415, rate.headers)
}

export const publishSkillV1Http = httpAction(publishSkillV1Handler)

type FileLike = {
  name: string
  size: number
  type: string
  arrayBuffer: () => Promise<ArrayBuffer>
}

function isFileLike(entry: FormDataEntryValue): entry is FileLike {
  if (typeof entry === 'string') return false
  if (typeof File !== 'undefined' && entry instanceof File) return true
  const candidate = entry as Partial<FileLike>
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.size === 'number' &&
    typeof candidate.type === 'string' &&
    typeof candidate.arrayBuffer === 'function'
  )
}

async function skillsPostRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'write')
  if (!rate.ok) return rate.response

  const segments = getPathSegments(request, '/api/v1/skills/')
  if (segments.length !== 2 || segments[1] !== 'undelete') {
    return text('Not found', 404, rate.headers)
  }
  const slug = segments[0]?.trim().toLowerCase() ?? ''
  try {
    const { userId } = await requireApiTokenUser(ctx, request)
    await ctx.runMutation(internal.skills.setSkillSoftDeletedInternal, {
      userId,
      slug,
      deleted: false,
    })
    return json({ ok: true }, 200, rate.headers)
  } catch {
    return text('Unauthorized', 401, rate.headers)
  }
}

export const skillsPostRouterV1Http = httpAction(skillsPostRouterV1Handler)

async function skillsDeleteRouterV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'write')
  if (!rate.ok) return rate.response

  const segments = getPathSegments(request, '/api/v1/skills/')
  if (segments.length !== 1) return text('Not found', 404, rate.headers)
  const slug = segments[0]?.trim().toLowerCase() ?? ''
  try {
    const { userId } = await requireApiTokenUser(ctx, request)
    await ctx.runMutation(internal.skills.setSkillSoftDeletedInternal, {
      userId,
      slug,
      deleted: true,
    })
    return json({ ok: true }, 200, rate.headers)
  } catch {
    return text('Unauthorized', 401, rate.headers)
  }
}

export const skillsDeleteRouterV1Http = httpAction(skillsDeleteRouterV1Handler)

async function whoamiV1Handler(ctx: ActionCtx, request: Request) {
  const rate = await applyRateLimit(ctx, request, 'read')
  if (!rate.ok) return rate.response

  try {
    const { user } = await requireApiTokenUser(ctx, request)
    return json(
      {
        user: {
          handle: user.handle ?? null,
          displayName: user.displayName ?? null,
          image: user.image ?? null,
        },
      },
      200,
      rate.headers,
    )
  } catch {
    return text('Unauthorized', 401, rate.headers)
  }
}

export const whoamiV1Http = httpAction(whoamiV1Handler)

async function parseMultipartPublish(
  ctx: ActionCtx,
  request: Request,
): Promise<{
  slug: string
  displayName: string
  version: string
  changelog: string
  tags?: string[]
  forkOf?: { slug: string; version?: string }
  files: Array<{
    path: string
    size: number
    storageId: Id<'_storage'>
    sha256: string
    contentType?: string
  }>
}> {
  const form = await request.formData()
  const payloadRaw = form.get('payload')
  if (!payloadRaw || typeof payloadRaw !== 'string') {
    throw new Error('Missing payload')
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>
  } catch {
    throw new Error('Invalid JSON payload')
  }

  const files: Array<{
    path: string
    size: number
    storageId: Id<'_storage'>
    sha256: string
    contentType?: string
  }> = []

  for (const entry of form.getAll('files')) {
    if (!isFileLike(entry)) continue
    const path = entry.name
    const size = entry.size
    const contentType = entry.type || undefined
    const buffer = new Uint8Array(await entry.arrayBuffer())
    const sha256 = await sha256Hex(buffer)
    const storageId = await ctx.storage.store(entry)
    files.push({ path, size, storageId, sha256, contentType })
  }

  const body = {
    slug: payload.slug,
    displayName: payload.displayName,
    version: payload.version,
    changelog: typeof payload.changelog === 'string' ? payload.changelog : '',
    tags: Array.isArray(payload.tags) ? payload.tags : undefined,
    files,
    ...(payload.forkOf === undefined ? {} : { forkOf: payload.forkOf }),
  }

  return parsePublishBody(body)
}

function parsePublishBody(body: unknown) {
  const parsed = parseArk(CliPublishRequestSchema, body, 'Publish payload')
  if (parsed.files.length === 0) throw new Error('files required')
  const tags = parsed.tags && parsed.tags.length > 0 ? parsed.tags : undefined
  return {
    slug: parsed.slug,
    displayName: parsed.displayName,
    version: parsed.version,
    changelog: parsed.changelog,
    tags,
    forkOf: parsed.forkOf
      ? {
          slug: parsed.forkOf.slug,
          version: parsed.forkOf.version ?? undefined,
        }
      : undefined,
    files: parsed.files.map((file) => ({
      ...file,
      storageId: file.storageId as Id<'_storage'>,
    })),
  }
}

async function resolveTags(
  ctx: ActionCtx,
  tags: Record<string, Id<'skillVersions'>>,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {}
  for (const [tag, versionId] of Object.entries(tags)) {
    const version = await ctx.runQuery(api.skills.getVersionById, { versionId })
    if (version && !version.softDeletedAt) {
      resolved[tag] = version.version
    }
  }
  return resolved
}

async function applyRateLimit(
  ctx: ActionCtx,
  request: Request,
  kind: 'read' | 'write',
): Promise<{ ok: true; headers: HeadersInit } | { ok: false; response: Response }> {
  const ip = getClientIp(request) ?? 'unknown'
  const ipResult = await checkRateLimit(ctx, `ip:${ip}`, RATE_LIMITS[kind].ip)
  const token = parseBearerToken(request)
  const keyResult = token
    ? await checkRateLimit(ctx, `key:${await hashToken(token)}`, RATE_LIMITS[kind].key)
    : null

  const chosen = pickMostRestrictive(ipResult, keyResult)
  const headers = rateHeaders(chosen)

  if (!ipResult.allowed || (keyResult && !keyResult.allowed)) {
    return {
      ok: false,
      response: text('Rate limit exceeded', 429, headers),
    }
  }

  return { ok: true, headers }
}

type RateLimitResult = {
  allowed: boolean
  remaining: number
  limit: number
  resetAt: number
}

async function checkRateLimit(
  ctx: ActionCtx,
  key: string,
  limit: number,
): Promise<RateLimitResult> {
  return (await ctx.runMutation(internal.rateLimits.checkRateLimitInternal, {
    key,
    limit,
    windowMs: RATE_LIMIT_WINDOW_MS,
  })) as RateLimitResult
}

function pickMostRestrictive(primary: RateLimitResult, secondary: RateLimitResult | null) {
  if (!secondary) return primary
  if (!primary.allowed) return primary
  if (!secondary.allowed) return secondary
  return secondary.remaining < primary.remaining ? secondary : primary
}

function rateHeaders(result: RateLimitResult): HeadersInit {
  const resetSeconds = Math.ceil(result.resetAt / 1000)
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(resetSeconds),
    ...(result.allowed ? {} : { 'Retry-After': String(resetSeconds) }),
  }
}

function getClientIp(request: Request) {
  const header =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for') ??
    request.headers.get('fly-client-ip')
  if (!header) return null
  if (header.includes(',')) return header.split(',')[0]?.trim() || null
  return header.trim()
}

function parseBearerToken(request: Request) {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null
  const token = trimmed.slice(7).trim()
  return token || null
}

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: mergeHeaders(
      {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      headers,
    ),
  })
}

function text(value: string, status: number, headers?: HeadersInit) {
  return new Response(value, {
    status,
    headers: mergeHeaders(
      {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      headers,
    ),
  })
}

function mergeHeaders(base: HeadersInit, extra?: HeadersInit) {
  return { ...(base as Record<string, string>), ...(extra as Record<string, string>) }
}

function getPathSegments(request: Request, prefix: string) {
  const pathname = new URL(request.url).pathname
  if (!pathname.startsWith(prefix)) return []
  const rest = pathname.slice(prefix.length)
  return rest
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
}

function toOptionalNumber(value: string | null) {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function sha256Hex(bytes: Uint8Array) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return toHex(new Uint8Array(digest))
}

function toHex(bytes: Uint8Array) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export const __handlers = {
  searchSkillsV1Handler,
  resolveSkillVersionV1Handler,
  listSkillsV1Handler,
  skillsGetRouterV1Handler,
  publishSkillV1Handler,
  skillsPostRouterV1Handler,
  skillsDeleteRouterV1Handler,
  whoamiV1Handler,
}
